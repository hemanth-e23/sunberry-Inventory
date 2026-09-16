import copy
import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    Receipt, InventoryTransfer, MaterialLot, StorageRow, StorageArea, PalletLicence, Category
)
from app.enums import TransferStatus, PalletStatus, ReceiptStatus
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE, CATEGORY_FINISHED
from app.services import lot_placement_service as lps
from app.services.row_allocation import (
    parse_breakdown, parse_pallet_breakdown, deduct_rm_rows, add_rm_rows,
    deduct_rm_total, resolve_breakdown, room_label,
)
from app.utils import category_rules
from app.utils.locations import warehouse_id_for_row


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def open_reserved_quantity(
    db: Session, receipt_id: str, *, exclude_id: Optional[str] = None
) -> float:
    """Σ quantity of this receipt's transfers still in flight (pending or
    forklift-submitted).

    This is what reservation means for RM (decision T1, 2026-09-16): drums
    named on a pending transfer are spoken for, and a second transfer may only
    claim the remainder. Three transfers of 17+48+8 drums against a 69-drum
    receipt each passed the old per-transfer check — the sum is what must be
    checked, at create AND again at approve.

    Approved transfers are deliberately excluded: a warehouse move keeps the
    material on the receipt, and an approved ship-out already decremented it.
    """
    query = db.query(func.coalesce(func.sum(InventoryTransfer.quantity), 0.0)).filter(
        InventoryTransfer.receipt_id == receipt_id,
        InventoryTransfer.status.in_(
            (TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED)
        ),
    )
    if exclude_id:
        query = query.filter(InventoryTransfer.id != exclude_id)
    return float(query.scalar() or 0.0)


def _require_unreserved_coverage(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Refuse approval when current stock minus holds minus OTHER in-flight
    transfers no longer covers this one."""
    others = open_reserved_quantity(db, transfer.receipt_id, exclude_id=transfer.id)
    available = (
        float(receipt.quantity or 0)
        - float(receipt.held_quantity or 0)
        - others
    )
    if float(transfer.quantity or 0) > available + 1e-6:
        detail = (
            f"Only {max(0.0, available):g} {receipt.unit or 'units'} of lot "
            f"{receipt.lot_number or receipt.id} is unreserved"
        )
        if others > 0:
            detail += f" ({others:g} is on other pending transfers)"
        raise ValidationError(
            detail + ". Approve or reject those first, or edit this transfer."
        )


def _is_finished_goods(db: Session, receipt: Receipt) -> bool:
    # Delegates to the shared predicate (app/utils/category_rules.py). This was
    # duplicated verbatim here and in inter_warehouse_transfer_service.py:17;
    # the local name is kept so call sites are unchanged.
    return category_rules.is_finished_goods(db, receipt)


def _apply_pallet_licence_ship_out(db: Session, licences: list, transfer_id: str) -> None:
    """Mark each licence as shipped and free its storage row occupancy."""
    for pl in licences:
        pl.status = "shipped"
        pl.transfer_id = transfer_id
        if pl.storage_row_id:
            row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
            if row:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - 1)
                row.occupied_cases = max(0, (row.occupied_cases or 0) - pl.cases)
                if row.occupied_pallets <= 0:
                    row.product_id = None


def _apply_pallet_licence_internal_transfer(
    db: Session, transfer: InventoryTransfer, licences: list
) -> None:
    """Move pallet licences to destination rows based on destination_breakdown."""
    dest_list = transfer.destination_breakdown or []
    has_per_row_pl_ids = any(d.get("pallet_licence_ids") for d in dest_list)

    for dest in dest_list:
        dest_id = dest.get("id", "")
        if not dest_id.startswith("row-"):
            continue
        to_row_id = dest_id.removeprefix("row-")
        to_row = db.query(StorageRow).filter(StorageRow.id == to_row_id).first()
        if not to_row:
            continue

        dest_pl_ids = dest.get("pallet_licence_ids")
        if dest_pl_ids:
            dest_licences = [pl for pl in licences if pl.id in dest_pl_ids]
        elif not has_per_row_pl_ids and dest_list[0].get("id") == dest_id:
            dest_licences = licences  # legacy: all pallets to first dest
        else:
            dest_licences = []

        for pl in dest_licences:
            if pl.storage_row_id:
                src_row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                if src_row:
                    src_row.occupied_pallets = max(0, (src_row.occupied_pallets or 0) - 1)
                    src_row.occupied_cases = max(0, (src_row.occupied_cases or 0) - pl.cases)
                    if src_row.occupied_pallets <= 0:
                        src_row.product_id = None
            pl.storage_row_id = to_row_id
            pl.storage_area_id = to_row.storage_area_id
            # Keep the pallet's warehouse consistent with the row it now sits in,
            # otherwise a cross-warehouse move leaves it pickable only from the
            # old warehouse's ship-out pool.
            dest_wh = warehouse_id_for_row(db, to_row_id)
            if dest_wh:
                pl.warehouse_id = dest_wh
            to_row.occupied_pallets = (to_row.occupied_pallets or 0) + 1
            to_row.occupied_cases = (to_row.occupied_cases or 0) + pl.cases
            if not to_row.product_id:
                to_row.product_id = pl.product_id


def _rebuild_receipt_allocation_from_licences(db: Session, receipt: Receipt) -> None:
    """Rebuild receipt.allocation JSON from live IN_STOCK pallet licence positions."""
    db.flush()  # Ensure updated storage_row_id values are visible
    all_in_stock = db.query(PalletLicence).filter(
        PalletLicence.receipt_id == receipt.id,
        PalletLicence.status == PalletStatus.IN_STOCK,
        PalletLicence.storage_row_id.isnot(None),
    ).all()

    row_groups: dict = {}
    for pl in all_in_stock:
        rid = pl.storage_row_id
        if rid not in row_groups:
            row_groups[rid] = {"pallets": 0, "cases": 0}
        row_groups[rid]["pallets"] += 1
        row_groups[rid]["cases"] += pl.cases

    plan = []
    for row_id, data in row_groups.items():
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        area = (
            db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
            if row else None
        )
        plan.append({
            "areaId": row.storage_area_id if row else None,
            "rowId": row_id,
            "areaName": area.name if area else "",
            "rowName": row.name if row else "",
            "pallets": data["pallets"],
            "cases": data["cases"],
        })

    receipt.allocation = {
        "success": True,
        "plan": plan,
        "totalCases": sum(p["cases"] for p in plan),
        "totalPallets": sum(p["pallets"] for p in plan),
    }


def _apply_finished_goods_occupancy_update(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Subtract cases/pallets from storage rows based on source_breakdown or proportional fallback."""
    allocation_data = (
        receipt.allocation
        if isinstance(receipt.allocation, dict)
        else json.loads(receipt.allocation)
    )
    if not (allocation_data.get("success") and allocation_data.get("plan")):
        return

    plan = allocation_data["plan"]
    transfer_quantity = float(transfer.quantity)

    if transfer.source_breakdown and isinstance(transfer.source_breakdown, list):
        for source in transfer.source_breakdown:
            source_id = source.get("id", "")
            cases_to_subtract = float(source.get("quantity", 0))
            if not source_id.startswith("row-"):
                continue
            row_id = source_id.removeprefix("row-")
            alloc_item = next((item for item in plan if item.get("rowId") == row_id), None)
            if alloc_item:
                row_cases = float(alloc_item.get("cases", 0))
                row_pallets = float(alloc_item.get("pallets", 0))
                cases_per_pallet = row_cases / row_pallets if row_pallets > 0 else 1
                pallets_to_subtract = cases_to_subtract / cases_per_pallet if cases_per_pallet > 0 else 0
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                if row:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_subtract)
                    row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_subtract)
                    if row.occupied_pallets <= 0:
                        row.product_id = None
    else:
        # Proportional fallback
        total_cases = sum(float(item.get("cases", 0)) for item in plan)
        if total_cases > 0:
            for item in plan:
                row_id = item.get("rowId")
                row_cases = float(item.get("cases", 0))
                row_pallets = float(item.get("pallets", 0))
                if not row_id or row_cases <= 0:
                    continue
                proportion = row_cases / total_cases
                cases_to_subtract = transfer_quantity * proportion
                cases_per_pallet = row_cases / row_pallets if row_pallets > 0 else 1
                pallets_to_subtract = cases_to_subtract / cases_per_pallet if cases_per_pallet > 0 else 0
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                if row:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_subtract)
                    row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_subtract)
                    if row.occupied_pallets <= 0:
                        row.product_id = None


def _apply_raw_material_internal_transfer(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Update storage row occupancies + allocation JSON for raw material
    warehouse-transfers, using the EXPLICIT per-row pallet counts the worker
    entered (pallets-out at source, pallets-in at destination). Content (cases)
    and pallets move independently — no cases/cases_per_pallet derivation."""
    # Resolving, not parsing: a source held at ROOM level (no rack) used to be
    # silently skipped here, which deducted nothing while the destination was
    # credited anyway. See resolve_breakdown for what that cost.
    source_cases, unresolved = resolve_breakdown(db, transfer.source_breakdown)
    if unresolved:
        rooms = ", ".join(room_label(db, sid) for sid in unresolved)
        raise ValidationError(
            f"Material in {rooms} is not on a single rack, so there is nothing "
            f"to move it from. Pick the rack it is being taken from."
        )
    source_pallets = parse_pallet_breakdown(transfer.source_breakdown)
    # The destination gets the SAME resolve-or-refuse the source got in the
    # 09-15 fix. `parse_breakdown` silently drops room-level ids, which let a
    # counted-lot transfer approve having credited NOTHING — the mirrored half
    # of the Grater Room incident.
    dest_cases, dest_unresolved = resolve_breakdown(db, transfer.destination_breakdown)
    if dest_unresolved:
        rooms = ", ".join(room_label(db, sid) for sid in dest_unresolved)
        raise ValidationError(
            f"The destination in {rooms} is not a single rack, so there is "
            f"nowhere to put the material. Pick the destination rack."
        )
    dest_pallets = parse_pallet_breakdown(transfer.destination_breakdown)

    # A move must never credit one end without debiting the other — nor the
    # reverse. Either half missing means the material would appear from or
    # vanish into nowhere.
    if dest_cases and not source_cases:
        raise ValidationError(
            "This transfer has a destination but no rack to take the material "
            "from, so it would add stock without removing any. Pick a source rack."
        )
    if source_cases and not dest_cases:
        raise ValidationError(
            "This transfer has a source rack but no destination rack, so the "
            "material would leave the books. Pick the destination rack."
        )

    # A lot nobody counted onto a rack cannot be moved between racks. The old
    # fallback silently updated only the allocation JSON here — an approved
    # transfer that moved nothing physical (the five 09-15 no-ops).
    if not lps.is_counted_lot(db, receipt.material_lot_id):
        raise ValidationError(
            f"Lot {receipt.lot_number or receipt.id} is not counted on any "
            "rack, so a transfer cannot move it. Receive or count it onto a "
            "rack first."
        )

    moved_units = _move_counted_lot(db, receipt, source_cases, dest_cases, transfer.id)

    # Postcondition: approval must move on the racks exactly what the paper
    # says. Every silent-no-op incident in the 2026-09 audit was the absence
    # of this check.
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    expected_units = lps.units_for_quantity(lot, float(transfer.quantity or 0)) if lot else 0
    if moved_units <= 0:
        raise ValidationError(
            "Approving this transfer would move nothing on the racks. Check "
            "the source and destination racks named on it."
        )
    if expected_units and moved_units != expected_units:
        raise ValidationError(
            f"This transfer's quantity works out to {expected_units} unit(s) "
            f"but the racks named on it would move {moved_units}. Fix the "
            "per-rack quantities so they match."
        )

    # Move the receipt's location pointer ONLY when the whole receipt moved.
    #
    # This used to fire on any single-destination move, which is how 20 of 88
    # drums going to ROW 14 took the other 68 with them on screen: the pointer
    # is what Inventory Overview reads, so the entire receipt appeared at the
    # destination. A split receipt has no single location, and claiming one is
    # worse than leaving the previous answer in place.
    #
    # Same test the staging returns already apply (staging_service.py:604,
    # staging_request_service.py:635) — they only reassign on a FULL return.
    dest_row_ids = list(dest_cases.keys())
    moved = sum(dest_cases.values())
    whole_receipt = moved >= float(receipt.quantity or 0) - 1e-6
    if len(dest_row_ids) == 1 and whole_receipt:
        receipt.storage_row_id = dest_row_ids[0]


def _move_counted_lot(
    db: Session, receipt: Receipt, source_cases: dict, dest_cases: dict, ref_id: str
) -> int:
    """Rack-to-rack for a counted lot: whole containers, source rack to dest rack.
    Returns the total units actually moved, for the caller's postcondition.

    Uses `move_units`, which writes the two halves of the move under one shared
    ref. That matters more here than anywhere else: a move is the one operation
    where a half-applied change leaves containers existing in neither place or
    both, and a shared ref is what lets `reconcile_lot` see the pair.

    Source and destination are zipped in order. A transfer that names three
    source racks and one destination consolidates onto the one; the reverse
    spreads out. Anything left over after the destinations are exhausted goes to
    the last named destination rather than being dropped.
    """
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot or not source_cases or not dest_cases:
        return 0

    dest_rows = [rid for rid in dest_cases if rid]
    if not dest_rows:
        return 0

    moved = 0
    for index, (src_row, qty) in enumerate(source_cases.items()):
        units = lps.units_for_quantity(lot, float(qty or 0))
        if units <= 0 or not src_row:
            continue
        dest_row = dest_rows[index] if index < len(dest_rows) else dest_rows[-1]
        if dest_row == src_row:
            continue
        lps.move_units(
            db, lot,
            from_row_id=src_row,
            to_row_id=dest_row,
            full_units=units,
            reason="Warehouse transfer",
            ref_id=f"{ref_id}:{index}",
        )
        moved += units
    return moved


def _apply_raw_material_ship_out(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Free raw material/packaging storage row occupancy for a ship-out.

    Live path: the ship-out carries a per-row ``source_breakdown`` with the
    EXPLICIT pallets-out the worker entered, so free exactly that content +
    pallets per row (no cases/cases_per_pallet). Legacy fallback (no per-row
    breakdown): prorate content across the lot's allocations, with pallets
    scaled to each row's real footprint."""
    # Room-level sources resolve to that room's rack rather than being skipped.
    # A skipped source here means stock stays on the books after it physically
    # left on a truck — the deduct_rm_total fallback below only covers the case
    # where NO breakdown was given at all, not one that silently emptied.
    source_cases, unresolved = resolve_breakdown(db, transfer.source_breakdown)
    if unresolved:
        rooms = ", ".join(room_label(db, sid) for sid in unresolved)
        raise ValidationError(
            f"Material in {rooms} is not on a single rack. Pick the rack it is "
            f"being shipped from."
        )

    if lps.is_counted_lot(db, receipt.material_lot_id):
        lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
        if not lot:
            return
        if source_cases:
            # The worker named the racks they pulled from. Honour exactly that.
            for row_id, qty in source_cases.items():
                units = lps.units_for_quantity(lot, float(qty or 0))
                if units > 0 and row_id:
                    lps.take_units(
                        db, lot, units=units, event_type=lps.EVENT_MOVED,
                        from_row_id=row_id, ref_type="transfer", ref_id=transfer.id,
                        reason="Shipped out",
                    )
        else:
            lps.take_units(
                db, lot,
                units=lps.units_for_quantity(lot, float(transfer.quantity)),
                event_type=lps.EVENT_MOVED,
                ref_type="transfer", ref_id=transfer.id, reason="Shipped out",
            )
        return

    if source_cases:
        source_pallets = parse_pallet_breakdown(transfer.source_breakdown)
        deduct_rm_rows(db, receipt, source_cases, pallets_by_row=source_pallets, update_rows=True)
        return

    deduct_rm_total(db, receipt, float(transfer.quantity), update_rows=True)


def _update_receipt_allocation_json(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Mutate receipt.allocation by subtracting source rows and adding destination rows."""
    if not (receipt.allocation and transfer.source_breakdown and transfer.destination_breakdown):
        return
    try:
        allocation_data = (
            receipt.allocation
            if isinstance(receipt.allocation, dict)
            else json.loads(receipt.allocation)
        )
        if not (allocation_data.get("success") and allocation_data.get("plan")):
            return

        allocation_data = copy.deepcopy(allocation_data)
        plan = allocation_data["plan"]
        cases_per_pallet = receipt.cases_per_pallet or 40

        # Subtract from source rows
        for source in transfer.source_breakdown:
            source_id = source.get("id", "")
            cases_to_subtract = float(source.get("quantity", 0))
            if not source_id.startswith("row-"):
                continue
            row_id = source_id.removeprefix("row-")
            for item in plan:
                if item.get("rowId") == row_id:
                    item["cases"] = max(0, float(item.get("cases", 0)) - cases_to_subtract)
                    item["pallets"] = max(
                        0,
                        int(item["cases"] / cases_per_pallet)
                        + (1 if item["cases"] % cases_per_pallet > 0 else 0),
                    )

        # Add to destination rows
        for dest in transfer.destination_breakdown:
            dest_id = dest.get("id", "")
            cases_to_add = float(dest.get("quantity", 0))
            if not dest_id.startswith("row-"):
                continue
            row_id = dest_id.removeprefix("row-")
            existing = next((item for item in plan if item.get("rowId") == row_id), None)
            if existing:
                existing["cases"] = float(existing.get("cases", 0)) + cases_to_add
                existing["pallets"] = max(
                    1,
                    int(existing["cases"] / cases_per_pallet)
                    + (1 if existing["cases"] % cases_per_pallet > 0 else 0),
                )
            else:
                storage_row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                if storage_row:
                    storage_area = (
                        db.query(StorageArea).filter(StorageArea.id == storage_row.storage_area_id).first()
                    )
                    plan.append({
                        "areaId": storage_row.storage_area_id,
                        "rowId": row_id,
                        "areaName": storage_area.name if storage_area else "FG",
                        "rowName": storage_row.name,
                        "pallets": max(
                            1,
                            int(cases_to_add / cases_per_pallet)
                            + (1 if cases_to_add % cases_per_pallet > 0 else 0),
                        ),
                        "cases": cases_to_add,
                    })

        allocation_data["plan"] = [item for item in plan if item.get("cases", 0) > 0]
        allocation_data["totalCases"] = sum(float(i.get("cases", 0)) for i in allocation_data["plan"])
        allocation_data["totalPallets"] = sum(int(i.get("pallets", 0)) for i in allocation_data["plan"])
        receipt.allocation = allocation_data
    except Exception:
        pass  # Don't fail the transfer if allocation update fails


# ---------------------------------------------------------------------------
# Public service functions
# ---------------------------------------------------------------------------

def _approve_multi_line_ship_out(db: Session, transfer: InventoryTransfer, current_user) -> InventoryTransfer:
    """Approval path for multi-line ship-outs.

    Two sub-paths:
    - **v2 lot-level** (any line has picks recorded): pallets were already
      flipped to SHIPPED and receipt quantities decremented at scan time.
      Approval just marks the order APPROVED, depletes drained receipts,
      and releases any lingering reservations.
    - **v1 multi-line** (no picks JSON, pallets in RESERVED/IN_STOCK):
      groups pallets by receipt, runs the ship-out mutations now.
    """
    pl_ids = list(transfer.pallet_licence_ids or [])
    if not pl_ids:
        raise ValidationError("Ship-out has no pallets to approve")

    is_v2 = any((ln.picks or []) for ln in (transfer.lines or []))

    licences = (
        db.query(PalletLicence)
        .filter(PalletLicence.id.in_(pl_ids))
        .with_for_update()
        .all()
    )
    found_ids = {pl.id for pl in licences}
    missing = [pid for pid in pl_ids if pid not in found_ids]
    if missing:
        raise ValidationError(f"Missing pallets at approval: {missing}")

    held = [pl.licence_number or pl.id for pl in licences if pl.is_held]
    if held:
        raise ValidationError(
            f"{len(held)} pallet(s) on hold — remove from ship-out or release hold first: {held}"
        )

    if is_v2:
        # v2 — pallets were shipped + receipts decremented at scan time. Just
        # tidy up: any pallet that somehow stayed IN_STOCK gets flipped to
        # SHIPPED here (drift safety), receipts that hit zero get depleted,
        # and lingering reservations are released.
        #
        # Exception: partial-pull pallets stay IN_STOCK at the Partials row
        # with their remaining cases — only the consumed portion shipped, and
        # the remainder is still on the shelf. Identify them by walking the
        # `picks` JSON across every line.
        partial_pulled_ids = set()
        for ln in (transfer.lines or []):
            for pick in (ln.picks or []):
                if pick.get("was_partial") and pick.get("pallet_licence_id"):
                    partial_pulled_ids.add(pick["pallet_licence_id"])

        for pl in licences:
            if pl.id in partial_pulled_ids:
                continue  # remainder stays in stock — don't ship the leftover
            if pl.status == PalletStatus.IN_STOCK:
                pl.status = PalletStatus.SHIPPED
                pl.transfer_id = transfer.id

        receipt_ids = {pl.receipt_id for pl in licences if pl.receipt_id}
        for rid in receipt_ids:
            receipt = db.query(Receipt).filter(Receipt.id == rid).with_for_update().first()
            if not receipt:
                continue
            _rebuild_receipt_allocation_from_licences(db, receipt)
            if not receipt.held_quantity or receipt.held_quantity <= 0:
                receipt.hold = False
            if (receipt.quantity or 0) <= 0:
                receipt.status = ReceiptStatus.DEPLETED

        # Release any reservations still sitting open on this transfer's lines.
        from app.services import ship_out_service
        ship_out_service.release_reservations(db, transfer)
    else:
        # v1 multi-line — pallets are still RESERVED/IN_STOCK; mutate now.
        bad_status = [
            pl.licence_number or pl.id
            for pl in licences
            if pl.status not in (PalletStatus.RESERVED, PalletStatus.IN_STOCK)
        ]
        if bad_status:
            raise ValidationError(
                f"Pallets no longer available (already shipped/transferred): {bad_status}"
            )

        by_receipt: dict = {}
        for pl in licences:
            by_receipt.setdefault(pl.receipt_id, []).append(pl)

        for rid, group in by_receipt.items():
            receipt = (
                db.query(Receipt).filter(Receipt.id == rid).with_for_update().first()
            )
            if not receipt:
                from app.exceptions import NotFoundError
                raise NotFoundError("Receipt", rid)
            _apply_pallet_licence_ship_out(db, group, transfer.id)
            cases_shipped = sum(pl.cases or 0 for pl in group)
            receipt.quantity = max(0, (receipt.quantity or 0) - cases_shipped)
            _rebuild_receipt_allocation_from_licences(db, receipt)
            if not receipt.held_quantity or receipt.held_quantity <= 0:
                receipt.hold = False
            if receipt.quantity <= 0:
                receipt.status = ReceiptStatus.DEPLETED

    transfer.status = TransferStatus.APPROVED
    transfer.approved_by = str(current_user.id)
    transfer.approved_at = datetime.now(timezone.utc)
    return transfer


def approve_transfer(db: Session, transfer: InventoryTransfer, current_user) -> InventoryTransfer:
    """Approve a transfer: validate permissions, apply all inventory mutations."""
    allowed_statuses = (TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED)
    if transfer.status not in allowed_statuses:
        raise ValidationError("Transfer is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot approve your own transfers. Only other users' transfers can be approved."
        )

    # ── New multi-product ship-out path (lines present, no parent receipt_id) ──
    if transfer.transfer_type == "shipped-out" and transfer.lines:
        return _approve_multi_line_ship_out(db, transfer, current_user)

    # ── Legacy path: single-receipt transfer ──
    # Lock the receipt row: this path does a read-modify-write on quantity, so
    # two concurrent approvals must not both read the pre-deduction value.
    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).with_for_update().first()
    if not receipt:
        from app.exceptions import NotFoundError
        raise NotFoundError("Receipt", transfer.receipt_id)

    finished = _is_finished_goods(db, receipt)
    pl_ids = transfer.pallet_licence_ids if isinstance(transfer.pallet_licence_ids, list) else []

    # --- Pallet-licence aware paths ---
    if pl_ids and finished:
        licences = db.query(PalletLicence).filter(
            PalletLicence.id.in_(pl_ids),
            PalletLicence.receipt_id == receipt.id,
            PalletLicence.status == PalletStatus.IN_STOCK,
        ).all()

        if transfer.transfer_type == "shipped-out":
            held = [p for p in licences if p.is_held]
            if held:
                from fastapi import HTTPException
                raise HTTPException(
                    status_code=400,
                    detail=f"{len(held)} pallet(s) on hold — remove from shipout or release hold first"
                )
            _apply_pallet_licence_ship_out(db, licences, transfer.id)
        else:
            _apply_pallet_licence_internal_transfer(db, transfer, licences)

    # --- Finished goods without pallet licences ---
    if finished and not pl_ids and receipt.allocation:
        _apply_finished_goods_occupancy_update(db, transfer, receipt)

    # --- Raw materials / packaging: re-check coverage at approve time ---
    # Stock, holds AND other in-flight transfers can all change between create
    # and approve; the create-time check alone let 73 drums be approved out of
    # a 69-drum receipt (each transfer individually under the total).
    if not finished:
        _require_unreserved_coverage(db, transfer, receipt)

    # --- Raw materials / packaging shipped out ---
    if transfer.transfer_type == "shipped-out" and not finished:
        _apply_raw_material_ship_out(db, transfer, receipt)

    # --- Raw materials / packaging internal transfer ---
    if transfer.transfer_type != "shipped-out" and not finished:
        _apply_raw_material_internal_transfer(db, transfer, receipt)

    # --- Update receipt quantity / location ---
    if transfer.transfer_type == "shipped-out":
        receipt.quantity = max(0, receipt.quantity - transfer.quantity)
    else:
        if transfer.to_location_id:
            receipt.location_id = transfer.to_location_id
        if transfer.to_sub_location_id:
            receipt.sub_location_id = transfer.to_sub_location_id

        # Rebuild allocation from live pallet data (pallet-licence internal transfer)
        if pl_ids and finished:
            _rebuild_receipt_allocation_from_licences(db, receipt)

        # Update allocation JSON (non-pallet-licence internal transfer)
        if not pl_ids:
            _update_receipt_allocation_json(db, transfer, receipt)

    # Clear hold if no held quantity remains
    if not receipt.held_quantity or receipt.held_quantity <= 0:
        receipt.hold = False

    if receipt.quantity <= 0:
        receipt.status = ReceiptStatus.DEPLETED

    transfer.status = TransferStatus.APPROVED
    transfer.approved_by = str(current_user.id)
    transfer.approved_at = datetime.now(timezone.utc)

    return transfer


def reject_transfer(db: Session, transfer: InventoryTransfer, reason: str, current_user) -> InventoryTransfer:
    """Reject a transfer: validate permissions, clear receipt hold, release any
    pallet reservations from the new multi-line ship-out path."""
    if transfer.status not in (TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED):
        raise ValidationError("Transfer is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot reject your own transfers. Only other users' transfers can be rejected."
        )

    if transfer.receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
        if receipt:
            # Some flows (e.g. scanner internal transfers) set receipt.hold=True
            # as a transient lock while the move is pending; rejecting the
            # transfer should release that lock. But a QA hold (held_quantity
            # > 0) is an independent quality hold and must NOT be released by
            # rejecting an unrelated transfer — only clear the flag when there
            # is nothing actually held.
            if not receipt.held_quantity or receipt.held_quantity <= 0:
                receipt.hold = False

    # Release any reserved pallets (new ship-out path)
    pl_ids = list(transfer.pallet_licence_ids or [])
    if pl_ids:
        licences = (
            db.query(PalletLicence)
            .filter(PalletLicence.id.in_(pl_ids))
            .with_for_update()
            .all()
        )
        for pl in licences:
            if pl.status == PalletStatus.RESERVED:
                pl.status = PalletStatus.IN_STOCK

    transfer.status = TransferStatus.REJECTED
    transfer.reason = f"{transfer.reason or ''}\n[Rejected by {current_user.name}]: {reason}".strip()

    return transfer
