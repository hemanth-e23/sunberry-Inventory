"""Lot-level finished-goods ship-out flow (v2).

Warehouse worker reserves capacity by (lot_number, cases) on each line.
Forklift commits specific pallets at scan time. Partial pulls split a
pallet's case count (remainder moves to the warehouse's designated
partial-pallet row).

Differs from the v1 flow in `transfer_service` in two key ways:
- pallets stay IN_STOCK until each scan flips them to SHIPPED
- a `ShipOutLotReservation` row holds soft capacity per (product, lot)
  instead of relying on PalletStatus.RESERVED
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import and_ as sa_and, func, or_ as sa_or
from sqlalchemy.orm import Session

from app.constants import TRANSFER_TYPE_SHIPPED_OUT
from app.enums import PalletStatus, ShipOutScanReason, TransferStatus
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    InventoryTransfer,
    InventoryTransferLine,
    PalletLicence,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    TransferScanEvent,
)
from app.models.inventory import ShipOutLotReservation
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences


# ---------------------------------------------------------------------------
# ID generator (mirrors routers/transfers.py:_generate_id)
# ---------------------------------------------------------------------------

def _new_id(prefix: str) -> str:
    import uuid
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Lot availability + reservation math
# ---------------------------------------------------------------------------

def _active_reservation_cases(
    db: Session, product_id: str, lot_number: str, exclude_line_id: Optional[str] = None
) -> float:
    """Sum of cases reserved on active (un-released) reservations for a lot."""
    q = db.query(func.coalesce(func.sum(ShipOutLotReservation.cases_reserved), 0.0)).filter(
        ShipOutLotReservation.product_id == product_id,
        ShipOutLotReservation.lot_number == lot_number,
        ShipOutLotReservation.released_at.is_(None),
    )
    if exclude_line_id:
        q = q.filter(ShipOutLotReservation.transfer_line_id != exclude_line_id)
    return float(q.scalar() or 0.0)


def _pallet_pool_for_product(
    db: Session, product_id: str, warehouse_id: Optional[str], lock: bool = False
):
    """Live pool of in-stock, not-held pallets for a product in a warehouse."""
    q = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.status == PalletStatus.IN_STOCK,
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
    )
    if warehouse_id:
        q = q.filter(PalletLicence.warehouse_id == warehouse_id)
    if lock:
        q = q.with_for_update()
    return q.all()


def available_lots_for_product(
    db: Session, product_id: str, warehouse_id: Optional[str]
) -> list[dict]:
    """Return lots for a product, oldest first, with capacity minus active
    reservations. Used by Phase 1's lot picker."""
    pallets = _pallet_pool_for_product(db, product_id, warehouse_id, lock=False)

    by_lot: dict[str, dict] = {}
    for pl in pallets:
        lot_key = pl.lot_number or ""
        if not lot_key:
            continue  # pallets with no lot number aren't pickable in this flow
        entry = by_lot.setdefault(lot_key, {
            "pallets": [],
            "oldest_at": None,
            "rows": {},
        })
        entry["pallets"].append(pl)
        created = pl.created_at
        if created and (entry["oldest_at"] is None or created < entry["oldest_at"]):
            entry["oldest_at"] = created
        row_key = pl.storage_row_id or ""
        row_agg = entry["rows"].setdefault(row_key, {"cases": 0.0, "pallets": 0})
        row_agg["cases"] += float(pl.cases or 0)
        row_agg["pallets"] += 1

    # Pre-load row names for the rows we touched
    row_ids = {rid for entry in by_lot.values() for rid in entry["rows"].keys() if rid}
    row_lookup: dict[str, StorageRow] = {}
    if row_ids:
        for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all():
            row_lookup[r.id] = r

    out: list[dict] = []
    for lot_number, entry in by_lot.items():
        total_cases = sum(float(p.cases or 0) for p in entry["pallets"])
        reserved = _active_reservation_cases(db, product_id, lot_number)
        cases_available = max(0.0, total_cases - reserved)
        if cases_available <= 0:
            continue  # fully spoken for; hide from picker

        rows_payload = []
        for rid, agg in entry["rows"].items():
            row = row_lookup.get(rid) if rid else None
            rows_payload.append({
                "row_id": rid or None,
                "row_name": row.name if row else "Floor",
                "cases": agg["cases"],
                "pallets": agg["pallets"],
            })

        out.append({
            "lot_number": lot_number,
            "cases_available": cases_available,
            "pallets_available": len(entry["pallets"]),
            "oldest_at": entry["oldest_at"],
            "rows": rows_payload,
        })

    out.sort(key=lambda x: (x["oldest_at"] or datetime.max.replace(tzinfo=timezone.utc), x["lot_number"]))
    return out


# ---------------------------------------------------------------------------
# Phase 1 — create pick list
# ---------------------------------------------------------------------------

def create_pick_list_v2(
    db: Session, data, current_user, target_warehouse_id: Optional[str]
) -> InventoryTransfer:
    """Submit a lot-level ship-out order. Locks candidate pallet rows of each
    (product, lot) before inserting reservations, so concurrent submits on
    the same lot serialize."""

    if not data.lines:
        raise ValidationError("Ship-out has no lines")

    # 1. Validate each line's per-lot allocations sum to cases_requested.
    for li, line in enumerate(data.lines):
        alloc_sum = sum(float(la.cases_requested) for la in line.lot_allocations)
        if abs(alloc_sum - float(line.cases_requested)) > 0.001:
            raise ValidationError(
                f"Line {li + 1}: lot allocations sum to {alloc_sum} but "
                f"line requests {line.cases_requested}"
            )
        if any(la.cases_requested <= 0 for la in line.lot_allocations):
            raise ValidationError(
                f"Line {li + 1}: lot allocations must each request > 0 cases"
            )

    # 2. Lock pallet pools per product, then validate per-lot capacity.
    # We lock the candidate pallet rows so that another concurrent submit on
    # the same (product, lot) sees our reservation before deciding capacity.
    product_ids = {ln.product_id for ln in data.lines}
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()}
    for pid in product_ids:
        if pid not in products:
            raise ValidationError(f"Product not found: {pid}")

    pallet_pools: dict[str, list[PalletLicence]] = {}
    for pid in product_ids:
        pallet_pools[pid] = _pallet_pool_for_product(db, pid, target_warehouse_id, lock=True)

    # 3. Per-lot capacity check.
    for li, line in enumerate(data.lines):
        pool = pallet_pools[line.product_id]
        for la in line.lot_allocations:
            in_lot = [pl for pl in pool if (pl.lot_number or "") == la.lot_number]
            lot_total = sum(float(pl.cases or 0) for pl in in_lot)
            already_reserved = _active_reservation_cases(db, line.product_id, la.lot_number)
            free = max(0.0, lot_total - already_reserved)
            if float(la.cases_requested) > free + 0.001:
                raise ValidationError(
                    f"Line {li + 1}, lot {la.lot_number}: requested "
                    f"{la.cases_requested} cases but only {free} available "
                    f"(total {lot_total}, reserved {already_reserved})"
                )

    # 4. Persist parent + lines + reservations.
    transfer_id = _new_id("transfer")
    total_cases = float(sum(float(ln.cases_requested) for ln in data.lines))

    transfer = InventoryTransfer(
        id=transfer_id,
        receipt_id=None,
        quantity=total_cases,
        unit="cases",
        transfer_type=TRANSFER_TYPE_SHIPPED_OUT,
        order_number=data.order_number,
        source_breakdown=None,  # source rows are dynamic; resolved at scan time
        pallet_licence_ids=[],  # filled as scans happen
        requested_by=str(current_user.id),
        warehouse_id=target_warehouse_id,
        status=TransferStatus.PENDING,
    )
    db.add(transfer)

    # 4. Create the parent transfer. Then for each UI line, resolve every lot
    # allocation into per-receipt portions, then group BY RECEIPT and persist
    # one InventoryTransferLine per (product, receipt). The line's
    # lot_allocations JSON can hold multiple lots when a single receipt feeds
    # more than one of the line's lots.
    #
    # Why group by receipt and not by (lot, receipt)? The DB has a unique
    # constraint on (transfer_id, product_id, receipt_id) inherited from v1.
    # Consolidating per receipt respects it and keeps reports correct (each
    # row still has a real receipt_id).
    line_seq_counter = 0
    for ui_li, line in enumerate(data.lines):
        pool = pallet_pools[line.product_id]

        # by_receipt: {receipt_id: [{lot_number, cases}, ...]}
        by_receipt: dict[str, list[dict]] = {}
        for la in line.lot_allocations:
            chunks = _split_lot_allocation_by_receipt(
                db, pool, line.product_id, la.lot_number,
                float(la.cases_requested),
            )
            if not chunks:
                raise ValidationError(
                    f"Could not resolve any receipts for lot {la.lot_number}"
                )
            for receipt_id, alloc_cases in chunks:
                by_receipt.setdefault(receipt_id, []).append({
                    "lot_number": la.lot_number,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                })

        for receipt_id, lot_entries in by_receipt.items():
            sub_id = _new_id("trln")
            sub_total = sum(e["cases_requested"] for e in lot_entries)
            db.add(InventoryTransferLine(
                id=sub_id,
                transfer_id=transfer_id,
                product_id=line.product_id,
                receipt_id=receipt_id,
                cases_requested=sub_total,
                cases_picked=0.0,
                pallet_licence_ids=[],
                lot_allocations=lot_entries,
                picks=[],
                lot_swap_history=[],
                # line_seq groups sub-lines that share a UI line so the
                # response/approver UI can collapse them visually.
                line_seq=ui_li * 1000 + line_seq_counter,
            ))
            line_seq_counter += 1

            # One reservation per (sub-line, lot) — keeps reservation totals
            # accurate per lot for the capacity check on future submits.
            for e in lot_entries:
                db.add(ShipOutLotReservation(
                    id=_new_id("solr"),
                    transfer_line_id=sub_id,
                    product_id=line.product_id,
                    lot_number=e["lot_number"],
                    cases_reserved=e["cases_requested"],
                ))

    db.flush()
    return transfer


def _split_lot_allocation_by_receipt(
    db: Session,
    pallet_pool: list,
    product_id: str,
    lot_number: str,
    cases_requested: float,
) -> list:
    """Split `cases_requested` of a (product, lot) across the receipts that
    contribute pallets to that lot, oldest-receipt first (FIFO).

    Returns a list of (receipt_id, cases_allocated) tuples summing to
    cases_requested. Pallets from the locked pool are filtered to the lot,
    grouped by receipt, sorted by each receipt's earliest pallet date as a
    proxy for receipt age.
    """
    in_lot = [
        pl for pl in pallet_pool
        if pl.product_id == product_id and (pl.lot_number or "") == lot_number
    ]
    by_receipt: dict[str, dict] = {}
    for pl in in_lot:
        rid = pl.receipt_id
        if not rid:
            continue
        entry = by_receipt.setdefault(rid, {"cases": 0.0, "oldest": None})
        entry["cases"] += float(pl.cases or 0)
        if pl.created_at and (entry["oldest"] is None or pl.created_at < entry["oldest"]):
            entry["oldest"] = pl.created_at

    if not by_receipt:
        return []

    # Cross-check the receipts' own dates so the FIFO order reflects when
    # inventory was received, not just when individual pallets were scanned.
    receipts = {
        r.id: r
        for r in db.query(Receipt).filter(Receipt.id.in_(list(by_receipt.keys()))).all()
    }

    def receipt_sort_key(rid: str):
        r = receipts.get(rid)
        if r and r.receipt_date:
            return (r.receipt_date, rid)
        if r and r.created_at:
            return (r.created_at, rid)
        return (by_receipt[rid]["oldest"] or datetime.max.replace(tzinfo=timezone.utc), rid)

    ordered_rids = sorted(by_receipt.keys(), key=receipt_sort_key)

    out: list = []
    remaining = float(cases_requested)
    for rid in ordered_rids:
        if remaining <= 0:
            break
        avail = by_receipt[rid]["cases"]
        take = min(remaining, avail)
        if take > 0:
            out.append((rid, take))
            remaining -= take
    return out


# ---------------------------------------------------------------------------
# Phase 2 — scanner view
# ---------------------------------------------------------------------------

def _partial_pallet_row(db: Session, warehouse_id: Optional[str]) -> Optional[StorageRow]:
    """The single storage row designated as the partial-pallet destination
    for this warehouse, if one exists."""
    q = db.query(StorageRow).filter(
        StorageRow.is_partial_pallet_location == True,  # noqa: E712
        StorageRow.is_active == True,  # noqa: E712
    )
    if warehouse_id:
        # StorageRow has no direct warehouse_id; reach via storage_area or
        # sub_location. We do a coarse filter: any partial row visible in the
        # system. Refine if multi-warehouse partials conflict in practice.
        pass
    return q.first()


def _blocked_rows_for_line(line: InventoryTransferLine) -> dict[str, set[str]]:
    """Build a {lot_number -> {row_ids}} map of rows this line has marked
    inaccessible via the escape hatch. Used to skip those rows in the
    scanner view."""
    out: dict[str, set[str]] = {}
    for entry in (line.lot_swap_history or []):
        from_lot = entry.get("from_lot")
        blocked = entry.get("blocked_row_ids") or []
        if not from_lot:
            continue
        out.setdefault(from_lot, set()).update(blocked)
    return out


def scanner_view_for_transfer(
    db: Session, transfer: InventoryTransfer
) -> dict:
    """Render the forklift's view of a transfer: per-line, per-open-lot,
    per-row, with pallets inside each row sorted by sequence ASC."""
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")

    partial_row = _partial_pallet_row(db, transfer.warehouse_id)
    partial_row_view = (
        {
            "row_id": partial_row.id,
            "row_name": partial_row.name,
            "cases": float(partial_row.occupied_cases or 0),
            "pallets": int(partial_row.occupied_pallets or 0),
        }
        if partial_row
        else None
    )

    # Aggregate DB sub-lines into UI-level lines by (line_seq // 1000) —
    # that's the UI line index we encoded at submit. Falls back to product_id
    # grouping for any sub-lines whose line_seq doesn't follow the scheme
    # (e.g. drift sub-lines created at scan time, line_seq=1_000_000).
    grouped: dict = {}
    for sub in sorted(list(transfer.lines or []), key=lambda l: l.line_seq or 0):
        ui_key = (sub.line_seq or 0) // 1000
        # Drift sub-lines (line_seq=1_000_000) should fold into whichever UI
        # line already has this product. If none, they form their own group.
        if (sub.line_seq or 0) >= 1_000_000:
            existing = next(
                (k for k, g in grouped.items() if g["product_id"] == sub.product_id),
                None,
            )
            if existing is not None:
                ui_key = existing
        g = grouped.setdefault(ui_key, {
            "product_id": sub.product_id,
            "subs": [],
        })
        g["subs"].append(sub)

    lines_payload = []
    for ui_key, group in grouped.items():
        sub_lines = group["subs"]
        product_id = group["product_id"]
        product = db.query(Product).filter(Product.id == product_id).first()

        # Sum allocations per lot across sub-lines so the forklift sees ONE
        # entry per (product, lot) regardless of how many receipts back it.
        lot_totals: dict[str, dict] = {}
        for sub in sub_lines:
            for alloc in (sub.lot_allocations or []):
                lot = alloc.get("lot_number") or ""
                if not lot:
                    continue
                e = lot_totals.setdefault(lot, {"requested": 0.0, "picked": 0.0})
                e["requested"] += float(alloc.get("cases_requested") or 0)
                e["picked"] += float(alloc.get("cases_picked") or 0)

        # Union of blocked rows across sub-lines (per lot).
        blocked_combined: dict[str, set] = {}
        for sub in sub_lines:
            for lot, rows in _blocked_rows_for_line(sub).items():
                blocked_combined.setdefault(lot, set()).update(rows)

        lots_payload = []
        line_remaining_total = 0.0
        line_cases_requested = sum(float(s.cases_requested or 0) for s in sub_lines)

        for lot_number, totals in lot_totals.items():
            cases_remaining = max(0.0, totals["requested"] - totals["picked"])
            if cases_remaining <= 0:
                continue
            line_remaining_total += cases_remaining

            # Live pallets matching this product+lot+warehouse — both
            # IN_STOCK (still pending pick) AND SHIPPED-via-this-transfer
            # (already picked, shown as checkmark in the UI).
            pq = db.query(PalletLicence).filter(
                PalletLicence.product_id == product_id,
                PalletLicence.lot_number == lot_number,
                PalletLicence.is_held == False,  # noqa: E712
                PalletLicence.is_deleted == False,  # noqa: E712,
                sa_or(
                    PalletLicence.status == PalletStatus.IN_STOCK,
                    sa_and(
                        PalletLicence.status == PalletStatus.SHIPPED,
                        PalletLicence.transfer_id == transfer.id,
                    ),
                ),
            )
            if transfer.warehouse_id:
                pq = pq.filter(PalletLicence.warehouse_id == transfer.warehouse_id)
            pallets = pq.all()

            # Map pallet_licence_id -> picked entry from any sub-line for
            # this lot, so we can show consumed-cases on the UI line.
            picked_lookup: dict[str, dict] = {}
            for sub in sub_lines:
                for pick in (sub.picks or []):
                    pid = pick.get("pallet_licence_id")
                    if pid:
                        picked_lookup[pid] = pick

            blocked_rows_for_lot = blocked_combined.get(lot_number, set())
            rows_map: dict[str, list[PalletLicence]] = {}
            for pl in pallets:
                # Pallets that shipped under THIS transfer keep their
                # original storage row visible (they've moved physically,
                # but the forklift wants to see them where they were before
                # they got pulled). The scanner-view shows them grouped
                # under that row with a "picked" flag.
                rid = pl.storage_row_id or ""
                rows_map.setdefault(rid, []).append(pl)

            row_ids = [r for r in rows_map.keys() if r]
            row_lookup = {
                r.id: r
                for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
            } if row_ids else {}

            rows_payload = []
            for rid, pl_list in rows_map.items():
                pl_list_sorted = sorted(pl_list, key=lambda p: (p.sequence or 0))
                row_obj = row_lookup.get(rid) if rid else None
                pallets_view = []
                pending_pallets = 0
                pending_cases = 0.0
                for pl in pl_list_sorted:
                    pick = picked_lookup.get(pl.id)
                    is_picked = pick is not None
                    pallets_view.append({
                        "pallet_licence_id": pl.id,
                        "licence_number": pl.licence_number or "",
                        "sequence": pl.sequence or 0,
                        "cases": float(pl.cases or 0),
                        "lot_number": pl.lot_number or "",
                        "is_picked": is_picked,
                        "cases_consumed": float(pick.get("cases_consumed") or 0) if pick else None,
                        "was_partial": bool(pick.get("was_partial")) if pick else False,
                    })
                    if not is_picked:
                        pending_pallets += 1
                        pending_cases += float(pl.cases or 0)
                rows_payload.append({
                    "row_id": rid or None,
                    "row_name": row_obj.name if row_obj else "Floor",
                    "is_blocked": rid in blocked_rows_for_lot,
                    "pallets": pallets_view,
                    # Counts and totals reflect what's LEFT to pick in this
                    # row — already-picked pallets don't inflate the number.
                    "cases_total": pending_cases,
                    "pallets_total": pending_pallets,
                })
            rows_payload.sort(key=lambda r: (r["is_blocked"], r["row_name"] or ""))

            lots_payload.append({
                "lot_number": lot_number,
                "cases_remaining": cases_remaining,
                "rows": rows_payload,
                "is_suggested_swap": False,
            })

        lines_payload.append({
            # Use the first sub-line's id as the stable UI line key — escape
            # hatch resolves it to (product_id) and then operates across all
            # sibling sub-lines.
            "line_id": sub_lines[0].id,
            "product_id": product_id,
            "product_name": product.name if product else None,
            "product_short_code": product.short_code if product else None,
            "cases_requested": line_cases_requested,
            "cases_remaining": line_remaining_total,
            "lots": lots_payload,
        })

    return {
        "transfer_id": transfer.id,
        "order_number": transfer.order_number or "",
        "lines": lines_payload,
        "partial_pallet_row": partial_row_view,
    }


# ---------------------------------------------------------------------------
# Phase 2 — scan-pick
# ---------------------------------------------------------------------------

def _find_open_allocation_for_lot(line: InventoryTransferLine, lot_number: str) -> Optional[dict]:
    for alloc in (line.lot_allocations or []):
        if alloc.get("lot_number") == lot_number:
            cases_remaining = float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0)
            if cases_remaining > 0:
                return alloc
    return None


def _route_pick_to_sub_line(
    db: Session, transfer: InventoryTransfer, pl: PalletLicence,
    candidate_allocs: list,
) -> tuple:
    """Pick the sub-line whose receipt_id matches the scanned pallet's
    receipt_id. Fall back to:
      (a) any existing sub-line for (transfer, product, receipt_id) — add
          the lot allocation entry if needed
      (b) create a brand-new sub-line for that (product, receipt_id) when
          no matching sub-line was created at submit (drift case — pallet's
          receipt wasn't in the original lot split).

    Returns (sub_line, allocation_dict). The allocation dict is the entry
    inside sub_line.lot_allocations for the pallet's lot.
    """
    pl_receipt = pl.receipt_id
    pl_product = pl.product_id
    pl_lot = pl.lot_number or ""

    # 1. Best path: a candidate sub-line where receipt_id matches.
    for ln, alloc in candidate_allocs:
        if ln.receipt_id == pl_receipt:
            return ln, alloc

    # 2. A sub-line for (product, receipt) exists but didn't list this lot.
    receipt_sub = next(
        (ln for ln in transfer.lines
         if ln.product_id == pl_product and ln.receipt_id == pl_receipt),
        None,
    )
    if receipt_sub is not None:
        new_alloc = {
            "lot_number": pl_lot,
            "cases_requested": 0.0,
            "cases_picked": 0.0,
        }
        receipt_sub.lot_allocations = list(receipt_sub.lot_allocations or []) + [new_alloc]
        return receipt_sub, new_alloc

    # 3. Drift: pallet's receipt wasn't in the plan at all. Create a fresh
    # sub-line so the pick is attributed to the right receipt for reports.
    new_alloc = {
        "lot_number": pl_lot,
        "cases_requested": 0.0,
        "cases_picked": 0.0,
    }
    new_sub = InventoryTransferLine(
        id=_new_id("trln"),
        transfer_id=transfer.id,
        product_id=pl_product,
        receipt_id=pl_receipt,
        cases_requested=0.0,
        cases_picked=0.0,
        pallet_licence_ids=[],
        lot_allocations=[new_alloc],
        picks=[],
        lot_swap_history=[],
        # Sort drift sub-lines after pre-planned ones in the response.
        line_seq=1_000_000,
    )
    db.add(new_sub)
    db.flush()
    return new_sub, new_alloc


def _release_row_capacity(db: Session, pl: PalletLicence, cases_to_remove: float) -> None:
    """Decrement the pallet's current row counters by N cases / 1 pallet."""
    if not pl.storage_row_id:
        return
    row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
    if not row:
        return
    row.occupied_pallets = max(0, (row.occupied_pallets or 0) - 1)
    row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_remove)
    if row.occupied_pallets <= 0:
        row.product_id = None


def _add_to_row(row: StorageRow, pl: PalletLicence, cases_added: float) -> None:
    row.occupied_pallets = (row.occupied_pallets or 0) + 1
    row.occupied_cases = (row.occupied_cases or 0) + cases_added
    if not row.product_id:
        row.product_id = pl.product_id


def _record_scan_event(
    db: Session,
    transfer_id: str,
    pallet: Optional[PalletLicence],
    licence_number: str,
    on_list: bool,
    scanned_by: Optional[str],
) -> None:
    db.add(TransferScanEvent(
        id=_new_id("scan"),
        transfer_id=transfer_id,
        licence_number=licence_number,
        licence_id=pallet.id if pallet else None,
        on_list=on_list,
        scanned_by=scanned_by,
    ))


def _build_swap_suggestion(
    db: Session, transfer: InventoryTransfer, product_id: str, scanned_lot: str
) -> Optional[dict]:
    """When the scanned pallet's lot isn't on any line, suggest swapping the
    line(s) for this product over to the scanned lot — if it's actually
    available."""
    pq = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.lot_number == scanned_lot,
        PalletLicence.status == PalletStatus.IN_STOCK,
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
    )
    if transfer.warehouse_id:
        pq = pq.filter(PalletLicence.warehouse_id == transfer.warehouse_id)
    pallets = pq.all()
    if not pallets:
        return None

    rows_map: dict[str, list[PalletLicence]] = {}
    for pl in pallets:
        rows_map.setdefault(pl.storage_row_id or "", []).append(pl)
    row_ids = [r for r in rows_map.keys() if r]
    row_lookup = {
        r.id: r for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
    } if row_ids else {}

    rows_payload = []
    for rid, pl_list in rows_map.items():
        pl_list_sorted = sorted(pl_list, key=lambda p: (p.sequence or 0))
        row_obj = row_lookup.get(rid) if rid else None
        rows_payload.append({
            "row_id": rid or None,
            "row_name": row_obj.name if row_obj else "Floor",
            "is_blocked": False,
            "pallets": [
                {
                    "pallet_licence_id": pl.id,
                    "licence_number": pl.licence_number or "",
                    "sequence": pl.sequence or 0,
                    "cases": float(pl.cases or 0),
                    "lot_number": pl.lot_number or "",
                }
                for pl in pl_list_sorted
            ],
            "cases_total": sum(float(pl.cases or 0) for pl in pl_list_sorted),
            "pallets_total": len(pl_list_sorted),
        })

    return {
        "lot_number": scanned_lot,
        "cases_remaining": sum(float(pl.cases or 0) for pl in pallets),
        "rows": rows_payload,
        "is_suggested_swap": True,
    }


def scan_pick_v2(
    db: Session, transfer: InventoryTransfer, licence_number: str,
    cases_to_consume: Optional[float], current_user
) -> dict:
    """Process a forklift scan against a v2 ship-out transfer.

    Returns a dict matching `ScanPickResponseV2`. Caller is responsible for
    commit/rollback.
    """
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")
    if transfer.status != TransferStatus.PENDING:
        raise ValidationError("Pick list is no longer open for scanning")

    user_id = str(current_user.id) if current_user else None

    # 1. Normalize the licence number — strip leading/trailing whitespace and
    # collapse any internal whitespace (copy-paste sometimes injects an
    # invisible space, e.g. 'MP14426L1-GVN128C -079'). DB values never
    # contain whitespace, so this is always safe.
    licence_number = "".join((licence_number or "").split())

    pl = (
        db.query(PalletLicence)
        .filter(PalletLicence.licence_number == licence_number)
        .with_for_update()
        .first()
    )
    if not pl:
        _record_scan_event(db, transfer.id, None, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_NOT_FOUND.value,
            "message": f"Pallet licence not found: {licence_number}",
        }

    label = pl.licence_number or pl.id

    # 2. Pallet hygiene checks.
    if pl.is_held:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {label} is on hold",
        }
    if pl.status != PalletStatus.IN_STOCK:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": (
                f"Pallet {label} is not in stock (status: {pl.status})"
            ),
        }
    if transfer.warehouse_id and pl.warehouse_id and pl.warehouse_id != transfer.warehouse_id:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {label} belongs to another warehouse",
        }

    # 3. Confirm the order has at least one open allocation for (product, lot).
    # The pick routes by receipt later — here we just check that the lot is
    # on the order at all.
    lines = list(transfer.lines or [])
    lines_for_product = [ln for ln in lines if ln.product_id == pl.product_id]
    if not lines_for_product:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.WRONG_PRODUCT.value,
            "message": f"Pallet {label} is for a product not on this order",
        }

    # Aggregate every allocation for (product, lot) across all sub-lines.
    # The "is the lot fully picked?" check has to look at the **lot-level**
    # sum — picks may have accumulated on a drift sub-line whose
    # `cases_requested` is zero, while the planned sub-line still appears
    # to have remaining capacity. Per-sub-line evaluation lets over-scans
    # slip through.
    total_planned = 0.0
    total_picked_for_lot = 0.0
    lot_was_planned = False
    candidate_allocs: list = []  # allocs that still have room — used to satisfy fresh picks
    for ln in lines_for_product:
        for alloc in (ln.lot_allocations or []):
            if alloc.get("lot_number") != (pl.lot_number or ""):
                continue
            lot_was_planned = True
            req = float(alloc.get("cases_requested") or 0)
            picked = float(alloc.get("cases_picked") or 0)
            total_planned += req
            total_picked_for_lot += picked
            if req - picked > 0:
                candidate_allocs.append((ln, alloc))

    lot_remaining = max(0.0, total_planned - total_picked_for_lot)

    if lot_remaining <= 0:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        if lot_was_planned:
            return {
                "ok": False,
                "reject_reason": ShipOutScanReason.LINE_COMPLETE.value,
                "message": (
                    f"Lot {pl.lot_number} for this product is already fully "
                    f"picked. Pallet {label} is not needed."
                ),
            }
        # Lot wasn't on the plan at all — offer to swap a currently-open lot
        # over to the scanned lot.
        suggestion = _build_swap_suggestion(db, transfer, pl.product_id, pl.lot_number or "")
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.WRONG_LOT_NEEDS_SWAP.value,
            "swap_suggestion": suggestion,
            "message": (
                f"Pallet {label} is lot {pl.lot_number}, which isn't on this "
                f"order's plan for this product. Use the escape hatch to swap."
            ),
        }

    # 4. Decide full pull vs partial pull against the lot-level remaining.
    pallet_cases = float(pl.cases or 0)

    if pallet_cases > lot_remaining + 0.001:
        # This pallet would overshoot the lot's remaining need. Partial pull.
        if cases_to_consume is None:
            # First pass — ask the UI to confirm the partial pull.
            return {
                "ok": False,
                "needs_partial_confirm": True,
                "suggested_partial_cases": lot_remaining,
                "line_id": candidate_allocs[0][0].id,
                "message": (
                    f"Pallet has {pallet_cases:g} cases but only {lot_remaining:g} "
                    f"are needed. Confirm partial pull?"
                ),
            }
        consumed = float(cases_to_consume)
        if consumed <= 0 or consumed > pallet_cases + 0.001:
            raise ValidationError(
                f"Invalid partial cases: {consumed} (pallet has {pallet_cases})"
            )
        if consumed > lot_remaining + 0.001:
            raise ValidationError(
                f"Partial pull {consumed} exceeds lot need {lot_remaining}"
            )
        was_partial = True
    else:
        consumed = pallet_cases
        was_partial = False

    # 5. Route the pick to the sub-line whose receipt_id matches this pallet's,
    # so receipt-filtered reports stay accurate. Drift case (pallet's receipt
    # wasn't in the original split) creates a fresh sub-line.
    target_line, target_alloc = _route_pick_to_sub_line(db, transfer, pl, candidate_allocs)

    # 6. Apply the pick.
    now = datetime.now(timezone.utc)
    pick_entry = {
        "pallet_licence_id": pl.id,
        "cases_consumed": consumed,
        "was_partial": was_partial,
        "scanned_at": now.isoformat(),
        "scanned_by": user_id,
    }

    # Append to the line's picks (JSON column — copy + reassign so SQLAlchemy
    # detects the mutation).
    new_picks = list(target_line.picks or []) + [pick_entry]
    target_line.picks = new_picks
    target_line.cases_picked = float(target_line.cases_picked or 0) + consumed

    # Mirror the picked pallet onto the line's denormalized pallet_licence_ids
    # so the approver UI's per-line pallet count reflects actual scans.
    line_ids = list(target_line.pallet_licence_ids or [])
    if pl.id not in line_ids:
        line_ids.append(pl.id)
    target_line.pallet_licence_ids = line_ids

    new_allocs = []
    for a in (target_line.lot_allocations or []):
        if a.get("lot_number") == target_alloc.get("lot_number") and (a is target_alloc or a == target_alloc):
            new_allocs.append({**a, "cases_picked": float(a.get("cases_picked") or 0) + consumed})
        else:
            new_allocs.append(a)
    target_line.lot_allocations = new_allocs

    # Update the parent transfer's denormalized pallet_licence_ids
    parent_ids = list(transfer.pallet_licence_ids or [])
    if pl.id not in parent_ids:
        parent_ids.append(pl.id)
    transfer.pallet_licence_ids = parent_ids

    # 6. Mutate the pallet itself.
    row_emptied: Optional[str] = None
    remaining_after = int(max(0, round(pallet_cases - consumed)))
    if was_partial and remaining_after > 0:
        # Normal partial: cases left over → move to Partials row.
        partial_row = _partial_pallet_row(db, transfer.warehouse_id)
        if not partial_row:
            raise ValidationError(
                "No partial-pallet row configured for this warehouse — set "
                "`is_partial_pallet_location=true` on one storage row first."
            )
        # Free original row of the FULL original case count (before decrement).
        _release_row_capacity(db, pl, pallet_cases)
        prev_row_id = pl.storage_row_id
        pl.cases = remaining_after
        pl.is_partial = True
        pl.storage_row_id = partial_row.id
        pl.storage_area_id = partial_row.storage_area_id
        _add_to_row(partial_row, pl, float(remaining_after))
        # Check whether the original row hit zero (only meaningful if the
        # pallet actually moved; pulling a partial pallet that was already
        # at the Partials row won't empty anything new).
        if prev_row_id and prev_row_id != partial_row.id:
            prev = db.query(StorageRow).filter(StorageRow.id == prev_row_id).first()
            if prev and (prev.occupied_pallets or 0) <= 0:
                row_emptied = prev_row_id
    else:
        # Either a full-pull (consumed == pallet_cases) or a partial-pull
        # that happened to drain the pallet to zero — both end the same
        # way: pallet is gone, mark SHIPPED, free the row.
        _release_row_capacity(db, pl, pallet_cases)
        prev_row_id = pl.storage_row_id
        pl.cases = 0 if was_partial else pl.cases  # zero out for drain-from-partial
        pl.status = PalletStatus.SHIPPED
        pl.transfer_id = transfer.id
        if prev_row_id:
            prev = db.query(StorageRow).filter(StorageRow.id == prev_row_id).first()
            if prev and (prev.occupied_pallets or 0) <= 0:
                row_emptied = prev_row_id

    # 7. Rebuild receipt allocation so the FG occupancy view stays in sync.
    if pl.receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == pl.receipt_id).first()
        if receipt:
            _rebuild_receipt_allocation_from_licences(db, receipt)
            # Decrement receipt's overall quantity by the cases that shipped
            # (only the shipped portion; partials keep their remainder).
            receipt.quantity = max(0.0, float(receipt.quantity or 0) - consumed)

    # 8. Release reservation capacity by the consumed amount. In the normal
    # case the matched sub-line has its own reservation for this lot. In the
    # drift case the new sub-line has no reservation — instead we walk the
    # sibling sub-lines of (transfer, product, lot) and drain their
    # reservations FIFO. Either way, the total reserved across (product, lot)
    # decrements by `consumed`.
    line_ids_for_product_lot = [
        ln.id for ln in transfer.lines
        if ln.product_id == pl.product_id
        and any(a.get("lot_number") == (pl.lot_number or "") for a in (ln.lot_allocations or []))
    ]
    remaining_to_release = consumed
    if line_ids_for_product_lot:
        sibling_reservations = (
            db.query(ShipOutLotReservation)
            .filter(
                ShipOutLotReservation.transfer_line_id.in_(line_ids_for_product_lot),
                ShipOutLotReservation.lot_number == (pl.lot_number or ""),
                ShipOutLotReservation.released_at.is_(None),
            )
            .order_by(ShipOutLotReservation.created_at)
            .all()
        )
        # Drain target_line's own reservation first if it has one.
        sibling_reservations.sort(key=lambda r: 0 if r.transfer_line_id == target_line.id else 1)
        for r in sibling_reservations:
            if remaining_to_release <= 0.001:
                break
            take = min(remaining_to_release, float(r.cases_reserved))
            new_reserved = float(r.cases_reserved) - take
            if new_reserved <= 0.001:
                r.released_at = now
                r.cases_reserved = 0.0
            else:
                r.cases_reserved = new_reserved
            remaining_to_release -= take

    # 9. Audit scan event.
    _record_scan_event(db, transfer.id, pl, licence_number, on_list=True, scanned_by=user_id)

    # Compute remaining at the UI-line level (sum across all sub-lines of
    # this product), not just the sub-line we routed to.
    line_remaining_after = sum(
        max(
            0.0,
            float(ln.cases_requested or 0) - float(ln.cases_picked or 0),
        )
        for ln in transfer.lines
        if ln.product_id == pl.product_id
    )
    lot_remaining_after = lot_remaining - consumed

    return {
        "ok": True,
        "pick": pick_entry,
        "line_id": target_line.id,
        "line_remaining": max(0.0, line_remaining_after),
        "lot_remaining": max(0.0, lot_remaining_after),
        "row_emptied": row_emptied,
        "partial_pallet_remaining": float(pl.cases or 0) if was_partial else None,
        "message": (
            f"Pulled {consumed:g} cases from pallet {label}"
            + (" (partial)" if was_partial else "")
        ),
    }


# ---------------------------------------------------------------------------
# Phase 2 — escape hatch
# ---------------------------------------------------------------------------

def lot_escape_hatch(
    db: Session, transfer: InventoryTransfer, line_id: str,
    blocked_lot_number: str, blocked_row_ids: list[str],
    reason: Optional[str], current_user
) -> dict:
    """Swap a blocked lot allocation for the next-oldest lot.

    Operates on (transfer, product_id of the named line, blocked_lot_number)
    across ALL sub-lines that share the product — because a single UI line
    can fan out to multiple DB sub-lines (one per receipt). All those
    sub-lines' allocations for the blocked lot get capped at cases_picked
    (closing them out), and the outstanding cases are re-split across the
    new lot's receipts.
    """
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")
    if transfer.status != TransferStatus.PENDING:
        raise ValidationError("Pick list is no longer open")

    target_line: Optional[InventoryTransferLine] = None
    for ln in (transfer.lines or []):
        if ln.id == line_id:
            target_line = ln
            break
    if target_line is None:
        raise NotFoundError("Transfer line", line_id)

    product_id = target_line.product_id
    sibling_subs = [
        ln for ln in (transfer.lines or [])
        if ln.product_id == product_id
    ]

    # Sum outstanding cases across all sub-lines for (product, blocked_lot).
    outstanding = 0.0
    for sub in sibling_subs:
        for alloc in (sub.lot_allocations or []):
            if alloc.get("lot_number") == blocked_lot_number:
                outstanding += max(
                    0.0,
                    float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0),
                )

    if outstanding <= 0:
        raise ValidationError(
            f"Nothing left to swap for lot {blocked_lot_number} on this product"
        )

    # Collect every lot this line has already escaped from in past swaps
    # (across all sibling sub-lines, since lot_swap_history can be split).
    # Once a lot is in this set, the forklift has explicitly given up on it
    # — it must not surface as the next candidate, otherwise consecutive
    # "Try next lot" clicks can bounce back to a lot we already rejected.
    previously_escaped: set = {blocked_lot_number}
    for sub in sibling_subs:
        for entry in (sub.lot_swap_history or []):
            from_lot = entry.get("from_lot")
            if from_lot:
                previously_escaped.add(from_lot)

    # Find next-oldest lot of the same product, excluding any lot we've
    # already escaped from and any pallets in rows the forklift just
    # marked inaccessible.
    pool = _pallet_pool_for_product(db, product_id, transfer.warehouse_id, lock=True)
    by_lot: dict[str, dict] = {}
    blocked_row_set = set(blocked_row_ids or [])
    for pl in pool:
        lot_key = pl.lot_number or ""
        if not lot_key or lot_key in previously_escaped:
            continue
        if pl.storage_row_id and pl.storage_row_id in blocked_row_set:
            continue
        e = by_lot.setdefault(lot_key, {"cases": 0.0, "oldest": None})
        e["cases"] += float(pl.cases or 0)
        if pl.created_at and (e["oldest"] is None or pl.created_at < e["oldest"]):
            e["oldest"] = pl.created_at

    candidates = []
    for lot, agg in by_lot.items():
        reserved = _active_reservation_cases(db, product_id, lot)
        free = max(0.0, agg["cases"] - reserved)
        if free + 0.001 >= outstanding:
            candidates.append((lot, free, agg["oldest"]))
    candidates.sort(
        key=lambda x: (x[2] or datetime.max.replace(tzinfo=timezone.utc), x[0])
    )

    now = datetime.now(timezone.utc)
    new_lot: Optional[str] = candidates[0][0] if candidates else None

    swap_entry = {
        "from_lot": blocked_lot_number,
        "to_lot": new_lot,
        "reason": reason,
        "at": now.isoformat(),
        "by": str(current_user.id) if current_user else None,
        "blocked_row_ids": list(blocked_row_ids),
    }
    target_line.lot_swap_history = list(target_line.lot_swap_history or []) + [swap_entry]

    if new_lot is None:
        return {
            "swapped_to_lot": None,
            "new_line_view": None,
            "message": (
                f"No alternative lot found for product with at least "
                f"{outstanding:g} cases available. Manual intervention required."
            ),
        }

    # 1. Close out the blocked lot on every sub-line that had it: requested → picked.
    for sub in sibling_subs:
        allocs = list(sub.lot_allocations or [])
        changed = False
        for i, alloc in enumerate(allocs):
            if alloc.get("lot_number") == blocked_lot_number:
                allocs[i] = {
                    "lot_number": blocked_lot_number,
                    "cases_requested": float(alloc.get("cases_picked") or 0),
                    "cases_picked": float(alloc.get("cases_picked") or 0),
                }
                changed = True
        if changed:
            sub.lot_allocations = allocs

    # Release all (sibling, blocked_lot) reservations.
    db.query(ShipOutLotReservation).filter(
        ShipOutLotReservation.transfer_line_id.in_([s.id for s in sibling_subs]),
        ShipOutLotReservation.lot_number == blocked_lot_number,
        ShipOutLotReservation.released_at.is_(None),
    ).update(
        {"released_at": now, "cases_reserved": 0.0},
        synchronize_session=False,
    )

    # 2. Split the outstanding cases across the new lot's receipts and either
    # attach an allocation entry to an existing (product, receipt) sub-line
    # or create a new one.
    chunks = _split_lot_allocation_by_receipt(
        db, pool, product_id, new_lot, outstanding,
    )
    if not chunks:
        # Shouldn't happen — we just verified `free >= outstanding`.
        raise ValidationError(
            f"Could not split {outstanding:g} cases across receipts for lot {new_lot}"
        )

    for receipt_id, alloc_cases in chunks:
        existing_sub = next(
            (s for s in sibling_subs if s.receipt_id == receipt_id),
            None,
        )
        if existing_sub is None:
            new_sub = InventoryTransferLine(
                id=_new_id("trln"),
                transfer_id=transfer.id,
                product_id=product_id,
                receipt_id=receipt_id,
                cases_requested=alloc_cases,
                cases_picked=0.0,
                pallet_licence_ids=[],
                lot_allocations=[{
                    "lot_number": new_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                }],
                picks=[],
                lot_swap_history=[],
                line_seq=(target_line.line_seq or 0),
            )
            db.add(new_sub)
            sibling_subs.append(new_sub)
            db.add(ShipOutLotReservation(
                id=_new_id("solr"),
                transfer_line_id=new_sub.id,
                product_id=product_id,
                lot_number=new_lot,
                cases_reserved=alloc_cases,
            ))
        else:
            # Append (or merge into) an existing allocation entry on this sub-line.
            allocs = list(existing_sub.lot_allocations or [])
            merged = False
            for i, alloc in enumerate(allocs):
                if alloc.get("lot_number") == new_lot:
                    allocs[i] = {
                        "lot_number": new_lot,
                        "cases_requested": float(alloc.get("cases_requested") or 0) + alloc_cases,
                        "cases_picked": float(alloc.get("cases_picked") or 0),
                    }
                    merged = True
                    break
            if not merged:
                allocs.append({
                    "lot_number": new_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                })
            existing_sub.lot_allocations = allocs
            existing_sub.cases_requested = float(existing_sub.cases_requested or 0) + alloc_cases
            db.add(ShipOutLotReservation(
                id=_new_id("solr"),
                transfer_line_id=existing_sub.id,
                product_id=product_id,
                lot_number=new_lot,
                cases_reserved=alloc_cases,
            ))

    db.flush()
    refreshed = scanner_view_for_transfer(db, transfer)
    line_view = next(
        (l for l in refreshed["lines"] if l["product_id"] == product_id),
        None,
    )
    return {
        "swapped_to_lot": new_lot,
        "new_line_view": line_view,
        "message": f"Swapped lot {blocked_lot_number} → {new_lot} ({outstanding:g} cases)",
    }


# ---------------------------------------------------------------------------
# Void guard
# ---------------------------------------------------------------------------

def transfer_has_picks(transfer: InventoryTransfer) -> bool:
    """True if any pallet on this transfer has been scanned (full or partial).

    Used by the void endpoint to block voiding after picking has started —
    those pallets are physically gone from the shelf or split between two
    rows, and a void can't put them back."""
    for ln in (transfer.lines or []):
        if ln.picks:
            return True
    return False


# ---------------------------------------------------------------------------
# Release reservations on void / reject (no pallet status changes — pallets
# in v2 stay IN_STOCK until scanned, so no inventory mutation is required).
# ---------------------------------------------------------------------------

def release_reservations(db: Session, transfer: InventoryTransfer) -> None:
    now = datetime.now(timezone.utc)
    line_ids = [ln.id for ln in (transfer.lines or [])]
    if not line_ids:
        return
    db.query(ShipOutLotReservation).filter(
        ShipOutLotReservation.transfer_line_id.in_(line_ids),
        ShipOutLotReservation.released_at.is_(None),
    ).update(
        {"released_at": now, "cases_reserved": 0.0},
        synchronize_session=False,
    )
