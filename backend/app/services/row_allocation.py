"""Shared maintenance for ``receipt.raw_material_row_allocations``.

That column is a JSON list of ``{rowId, cases?, pallets?, areaId?, rowName?,
areaName?}`` describing how much of a raw-material / packaging lot sits in each
storage row.

PALLETS ARE FIRST-CLASS. Content (``cases`` = the storage unit, e.g. lbs) and
physical footprint (``pallets``) are INDEPENDENT — there is no fixed ratio
between them (a single barrel can occupy a whole pallet; consolidation frees a
pallet without changing content). Every mutation therefore carries BOTH a cases
delta and a pallets delta per row, supplied by whoever physically handled the
pallets, and applies each independently to ``StorageRow.occupied_cases`` /
``occupied_pallets`` and to the allocation JSON entry.

``cases_per_pallet`` is used ONLY as a legacy fallback for callers that do not
(yet) supply an explicit pallet delta — it must never be the source of truth for
footprint, because for weight/drum lots with no cases-per-pallet it produces
nonsense (e.g. 4500 lbs / 40 = 112.5 "pallets").

Entries a helper does not touch are preserved verbatim; pruning applies only to
touched entries whose content reaches zero.
"""
import copy
from sqlalchemy.orm import Session

from app.exceptions import ConflictError
from app.models import Receipt
from app.models.location import StorageRow, StorageArea
from app.constants import DEFAULT_CASES_PER_PALLET


def _guard_counted_lot(db: Session, receipt: Receipt, action: str) -> None:
    """Refuse to hand-edit the allocation JSON for a COUNTED ingredient lot.

    For a counted lot (one with at least one ``lot_placement``) this JSON is a
    PROJECTION — ``lot_placement_service`` overwrites it from the placements
    after every mutation, in the same transaction. A caller that edits it here
    would have its edit silently reverted by the next projection, and in the
    window before that it would disagree with the placements. Neither failure
    raises anything on its own; the wrong number just wins, depending on which
    reader you ask. That is the exact class of bug the projection exists to
    remove, so the second writer is refused rather than tolerated.

    Raising rather than no-op'ing is deliberate and matches the codebase's
    doctrine elsewhere: a silent no-op leaves the caller believing its
    deduction landed.

    Cheap by construction: for the RM and packaging lots that dominate this
    module's traffic ``material_lot_id`` is NULL and it returns before touching
    the database.
    """
    if receipt is None or getattr(receipt, "material_lot_id", None) is None:
        return

    # Imported here, not at module scope: lot_placement_service imports
    # row_allocation's siblings, and a top-level import would close the cycle.
    from app.models import LotPlacement

    counted = (
        db.query(LotPlacement.id)
        .filter(LotPlacement.material_lot_id == receipt.material_lot_id)
        .first()
    )
    if counted:
        raise ConflictError(
            f"Receipt {receipt.id} belongs to a counted lot, so its row allocations "
            f"are derived from unit counts and cannot be changed by {action}. "
            "Record the movement through lot_placement_service instead."
        )


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


def parse_pallet_breakdown(breakdown) -> dict:
    """Turn a ``[{id: 'row-X', pallets}]`` breakdown into ``{row_id: pallets}``,
    including ONLY entries that carry an explicit ``pallets`` key. Entries without
    one are omitted, so the caller can tell "explicit pallet count given" apart
    from "no pallet info" (the latter falls back to the cpp estimate)."""
    out: dict = {}
    for entry in (breakdown or []):
        sid = (entry or {}).get("id", "")
        if not isinstance(sid, str) or not sid.startswith("row-"):
            continue
        if "pallets" not in (entry or {}):
            continue
        p = float(entry.get("pallets", 0) or 0)
        rid = sid.removeprefix("row-")
        out[rid] = out.get(rid, 0.0) + p
    return out


def _cpp(receipt: Receipt) -> float:
    """Cases-per-pallet conversion, used ONLY as the legacy fallback when a
    caller supplies no explicit pallet delta (``receipt.cases_per_pallet or 40``)."""
    return float(receipt.cases_per_pallet or DEFAULT_CASES_PER_PALLET)


def _entry_cases(alloc: dict, cpp: float) -> float:
    """Effective cases of an allocation entry, regardless of which field the
    writer recorded. Explicit cases win; otherwise derive from pallets."""
    cases = float(alloc.get("cases", 0) or 0)
    if cases > 0:
        return cases
    pallets = float(alloc.get("pallets", 0) or 0)
    return pallets * cpp if pallets > 0 else 0.0


def _entry_pallets(alloc: dict) -> float:
    """Current pallet footprint recorded on an allocation entry."""
    return float(alloc.get("pallets", 0) or 0)


def _write_entry(alloc: dict, cases: float, cpp: float, *, pallets: float = None) -> None:
    """Write a touched entry. ``cases`` is always set. When an explicit
    ``pallets`` is given it is written as-is (independent of cases); otherwise
    pallets fall back to the cpp estimate (legacy callers only)."""
    cases = max(0.0, cases)
    alloc["cases"] = cases
    if pallets is not None:
        alloc["pallets"] = max(0.0, pallets)
    else:
        alloc["pallets"] = (cases / cpp) if cpp > 0 else 0


def deduct_rm_rows(
    db: Session,
    receipt: Receipt,
    deductions_by_row: dict,
    *,
    pallets_by_row: dict = None,
    update_rows: bool = True,
) -> None:
    """Free content (and pallets) from specific rows of an RM/packaging lot.

    ``deductions_by_row``: ``{storage_row_id: cases_to_free}``.
    ``pallets_by_row``: ``{storage_row_id: pallets_to_free}`` — the explicit,
    human-entered footprint freed from each row. When a row is absent here, the
    pallet delta falls back to ``cases / cpp`` (legacy behavior).

    Updates the allocation JSON; when ``update_rows`` is True also decrements the
    ``StorageRow.occupied_*`` counters. Pass ``update_rows=False`` when the caller
    already adjusted the rows itself.
    """
    if not deductions_by_row:
        return
    _guard_counted_lot(db, receipt, "deduct_rm_rows")
    cpp = _cpp(receipt)
    pallets_by_row = pallets_by_row or {}

    if update_rows:
        for row_id, cases in deductions_by_row.items():
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if not row:
                continue
            if row_id in pallets_by_row:
                pallets = float(pallets_by_row[row_id] or 0)
            else:
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
                if rid in pallets_by_row:
                    remaining_pallets = _entry_pallets(alloc) - float(pallets_by_row[rid] or 0)
                    _write_entry(alloc, remaining, cpp, pallets=remaining_pallets)
                else:
                    _write_entry(alloc, remaining, cpp)
                # Prune only entries THIS deduction emptied (by content).
                if remaining <= 0:
                    continue
            survivors.append(alloc)
        receipt.raw_material_row_allocations = survivors


def add_rm_rows(
    db: Session,
    receipt: Receipt,
    additions_by_row: dict,
    *,
    pallets_by_row: dict = None,
    update_rows: bool = True,
) -> None:
    """Add content (and pallets) to specific rows of an RM/packaging lot (e.g. the
    destination side of an internal row-to-row transfer, a staging return, or an
    IWT cancel restore). Creates allocation entries for rows not already present.

    ``pallets_by_row``: ``{storage_row_id: pallets_to_add}`` — explicit footprint
    added per row. Rows absent here fall back to ``cases / cpp`` (legacy)."""
    if not additions_by_row:
        return
    _guard_counted_lot(db, receipt, "add_rm_rows")
    cpp = _cpp(receipt)
    pallets_by_row = pallets_by_row or {}

    if update_rows:
        for row_id, cases in additions_by_row.items():
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if not row:
                continue
            if row_id in pallets_by_row:
                pallets = float(pallets_by_row[row_id] or 0)
            else:
                pallets = (cases / cpp) if cpp > 0 else 0
            row.occupied_cases = float(row.occupied_cases or 0) + cases
            row.occupied_pallets = float(row.occupied_pallets or 0) + pallets
            if not row.product_id:
                row.product_id = receipt.product_id

    allocs = receipt.raw_material_row_allocations
    new_allocs = copy.deepcopy(allocs) if isinstance(allocs, list) else []
    by_id = {a.get("rowId"): a for a in new_allocs}
    for row_id, cases in additions_by_row.items():
        explicit_pallets = float(pallets_by_row[row_id] or 0) if row_id in pallets_by_row else None
        if row_id in by_id:
            alloc = by_id[row_id]
            new_cases = _entry_cases(alloc, cpp) + cases
            if explicit_pallets is not None:
                _write_entry(alloc, new_cases, cpp, pallets=_entry_pallets(alloc) + explicit_pallets)
            else:
                _write_entry(alloc, new_cases, cpp)
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
            _write_entry(entry, cases, cpp, pallets=explicit_pallets)
            new_allocs.append(entry)
    receipt.raw_material_row_allocations = new_allocs


def deduct_rm_total(db: Session, receipt: Receipt, total_cases: float, *, update_rows: bool = True) -> None:
    """Deduct a lot total with no per-row breakdown by prorating CONTENT across
    the receipt's current allocations.

    NOTE: this path has no explicit pallet information, so its row-occupancy
    updates fall back to the cpp estimate. Rack-affecting consumption flows
    (staging-use, production consume) no longer call this with
    ``update_rows=True`` — they free the rack via explicit pallet counts at
    staging time, or leave it to an attended Inventory Actions adjustment. Kept
    for content-only JSON proration and legacy callers."""
    allocs = receipt.raw_material_row_allocations
    if not (allocs and isinstance(allocs, list)) or total_cases <= 0:
        return
    _guard_counted_lot(db, receipt, "deduct_rm_total")
    cpp = _cpp(receipt)
    current_total = sum(_entry_cases(a, cpp) for a in allocs)
    if current_total <= 0:
        return
    proportion = min(1.0, total_cases / current_total)
    deductions = {
        a.get("rowId"): _entry_cases(a, cpp) * proportion
        for a in allocs if a.get("rowId") and _entry_cases(a, cpp) > 0
    }
    # Prorate the real pallet footprint too (proportional to each row's actual
    # pallets), never cases/cpp — so JSON pallets stay sane on legacy proration.
    pallets = {
        a.get("rowId"): _entry_pallets(a) * proportion
        for a in allocs if a.get("rowId") and _entry_pallets(a) > 0
    }
    deduct_rm_rows(db, receipt, deductions, pallets_by_row=pallets, update_rows=update_rows)
