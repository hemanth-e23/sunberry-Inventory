"""Shared maintenance for ``receipt.raw_material_row_allocations``.

That column is a JSON list of ``{rowId, cases?, pallets?, areaId?, rowName?,
areaName?}`` describing how much of a raw-material / packaging lot sits in each
storage row. Historically many mutation paths updated storage rows and
``receipt.quantity`` but left this JSON stale, and the two paths that DID update
it disagreed (one edited only ``pallets``, the other only ``cases``), so per-row
availability drifted.

IMPORTANT — real data shape: the receipt form and the IWT assign-storage modal
write entries as ``{rowId, pallets}`` with NO ``cases`` key, and legacy rows may
carry either field alone. Every helper therefore NORMALIZES an entry's
effective cases on read (explicit ``cases`` when present, else
``pallets × cases_per_pallet``) instead of assuming the key exists. After a
helper touches an entry it writes BOTH fields consistently; entries it does not
touch are preserved verbatim, and pruning applies only to touched entries that
reach zero — so an untouched legacy entry can never be wiped.
"""
import copy
from sqlalchemy.orm import Session

from app.models import Receipt
from app.models.location import StorageRow, StorageArea
from app.constants import DEFAULT_CASES_PER_PALLET


def parse_breakdown(breakdown) -> dict:
    """Turn a ``[{id: 'row-X', quantity}]`` breakdown into ``{row_id: cases}``.

    Non-row entries (e.g. floor/location ids) and non-positive quantities are
    ignored. Quantities for the same row are summed.
    """
    out: dict = {}
    for entry in (breakdown or []):
        sid = (entry or {}).get("id", "")
        if not isinstance(sid, str) or not sid.startswith("row-"):
            continue
        qty = float(entry.get("quantity", 0) or 0)
        if qty <= 0:
            continue
        rid = sid.removeprefix("row-")
        out[rid] = out.get(rid, 0.0) + qty
    return out


def _cpp(receipt: Receipt) -> float:
    """Cases-per-pallet conversion, falling back to the system default the same
    way the legacy paths did (``receipt.cases_per_pallet or 40``)."""
    return float(receipt.cases_per_pallet or DEFAULT_CASES_PER_PALLET)


def _entry_cases(alloc: dict, cpp: float) -> float:
    """Effective cases of an allocation entry, regardless of which field the
    writer recorded. Explicit cases win; otherwise derive from pallets."""
    cases = float(alloc.get("cases", 0) or 0)
    if cases > 0:
        return cases
    pallets = float(alloc.get("pallets", 0) or 0)
    return pallets * cpp if pallets > 0 else 0.0


def _write_entry(alloc: dict, cases: float, cpp: float) -> None:
    """Write a touched entry with both fields consistent (cases is the source
    of truth; pallets derived)."""
    cases = max(0.0, cases)
    alloc["cases"] = cases
    alloc["pallets"] = (cases / cpp) if cpp > 0 else 0


def deduct_rm_rows(db: Session, receipt: Receipt, deductions_by_row: dict, *, update_rows: bool = True) -> None:
    """Free ``cases`` from specific rows of an RM/packaging lot.

    ``deductions_by_row``: ``{storage_row_id: cases_to_free}``. Updates the
    allocation JSON; when ``update_rows`` is True also decrements the
    ``StorageRow.occupied_*`` counters. Pass ``update_rows=False`` when the
    caller already adjusted the rows itself.
    """
    if not deductions_by_row:
        return
    cpp = _cpp(receipt)

    if update_rows:
        for row_id, cases in deductions_by_row.items():
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if not row:
                continue
            pallets = (cases / cpp) if cpp > 0 else 0
            row.occupied_cases = max(0.0, float(row.occupied_cases or 0) - cases)
            row.occupied_pallets = max(0.0, float(row.occupied_pallets or 0) - pallets)
            if row.occupied_pallets <= 0:
                row.product_id = None

    allocs = receipt.raw_material_row_allocations
    if allocs and isinstance(allocs, list):
        new_allocs = copy.deepcopy(allocs)
        survivors = []
        for alloc in new_allocs:
            rid = alloc.get("rowId")
            if rid in deductions_by_row:
                remaining = _entry_cases(alloc, cpp) - deductions_by_row[rid]
                _write_entry(alloc, remaining, cpp)
                # Prune only entries THIS deduction emptied.
                if remaining <= 0:
                    continue
            survivors.append(alloc)
        receipt.raw_material_row_allocations = survivors


def add_rm_rows(db: Session, receipt: Receipt, additions_by_row: dict, *, update_rows: bool = True) -> None:
    """Add ``cases`` to specific rows of an RM/packaging lot (e.g. the
    destination side of an internal row-to-row transfer, or an IWT cancel
    restore). Creates allocation entries for rows not already present."""
    if not additions_by_row:
        return
    cpp = _cpp(receipt)

    if update_rows:
        for row_id, cases in additions_by_row.items():
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if not row:
                continue
            pallets = (cases / cpp) if cpp > 0 else 0
            row.occupied_cases = float(row.occupied_cases or 0) + cases
            row.occupied_pallets = float(row.occupied_pallets or 0) + pallets
            if not row.product_id:
                row.product_id = receipt.product_id

    allocs = receipt.raw_material_row_allocations
    new_allocs = copy.deepcopy(allocs) if isinstance(allocs, list) else []
    by_id = {a.get("rowId"): a for a in new_allocs}
    for row_id, cases in additions_by_row.items():
        if row_id in by_id:
            _write_entry(by_id[row_id], _entry_cases(by_id[row_id], cpp) + cases, cpp)
        else:
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            area = (
                db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                if row and row.storage_area_id else None
            )
            entry = {
                "rowId": row_id,
                "rowName": row.name if row else "",
                "areaId": row.storage_area_id if row else None,
                "areaName": area.name if area else "",
            }
            _write_entry(entry, cases, cpp)
            new_allocs.append(entry)
    receipt.raw_material_row_allocations = new_allocs


def deduct_rm_total(db: Session, receipt: Receipt, total_cases: float, *, update_rows: bool = True) -> None:
    """Deduct a lot total with no per-row breakdown by prorating across the
    receipt's current allocations (used by ship-out, staging and production
    consumption, which free a proportional slice of the whole lot)."""
    allocs = receipt.raw_material_row_allocations
    if not (allocs and isinstance(allocs, list)) or total_cases <= 0:
        return
    cpp = _cpp(receipt)
    current_total = sum(_entry_cases(a, cpp) for a in allocs)
    if current_total <= 0:
        return
    proportion = min(1.0, total_cases / current_total)
    deductions = {
        a.get("rowId"): _entry_cases(a, cpp) * proportion
        for a in allocs if a.get("rowId") and _entry_cases(a, cpp) > 0
    }
    deduct_rm_rows(db, receipt, deductions, update_rows=update_rows)
