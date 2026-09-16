from datetime import datetime, timezone
from typing import Optional
import uuid
from sqlalchemy.orm import Session

from app.models import (
    MaterialLot, Receipt, StagingItem, Product, Location, SubLocation, StorageRow,
    InventoryTransfer, InventoryAdjustment
)
from app.enums import ReceiptStatus, AdjustmentStatus
from app.exceptions import ValidationError, NotFoundError
from app.services import lot_placement_service as lps
from app.services.row_allocation import deduct_rm_total, deduct_rm_rows, add_rm_rows


def _lot_row_footprint(receipt: Receipt) -> dict:
    """Current per-row ``{cases, pallets}`` footprint of an RM lot, from its
    allocation JSON (multi-row) or its single ``storage_row_id``."""
    footprint: dict = {}
    allocs = receipt.raw_material_row_allocations
    if allocs and isinstance(allocs, list):
        for a in allocs:
            rid = a.get("rowId")
            if not rid:
                continue
            footprint[rid] = {
                "cases": float(a.get("cases", 0) or 0),
                "pallets": float(a.get("pallets", 0) or 0),
            }
    elif receipt.storage_row_id:
        footprint[receipt.storage_row_id] = {
            "cases": float(receipt.quantity or 0),
            "pallets": float(receipt.pallets or 0),
        }
    return footprint


def _stage_free_rack(
    db: Session, receipt: Receipt, staged_qty: float, staged_pallets: float,
    source_row_id=None,
) -> float:
    """Free a lot's rack footprint when material is pulled for staging.

    Two languages, one meaning. A COUNTED lot — one with placements — comes off
    the rack as whole containers off named racks, because that is what a person
    physically carries and what they can be told to go and fetch. Everything else
    keeps the original behaviour: remove ``staged_qty`` content and
    ``staged_pallets`` pallets spread across the lot's rows by their share.

    Returns the pallet count actually freed.
    """
    if lps.is_counted_lot(db, receipt.material_lot_id):
        return _stage_free_counted(db, receipt, staged_qty, source_row_id)

    footprint = _lot_row_footprint(receipt)
    total_cases = sum(r["cases"] for r in footprint.values())
    total_pallets = sum(r["pallets"] for r in footprint.values())

    if staged_pallets is None:
        # No explicit count — estimate proportionally from the lot's real pallets.
        staged_pallets = (
            (staged_qty / float(receipt.quantity) * total_pallets)
            if receipt.quantity and total_pallets > 0 else 0.0
        )

    content_by_row: dict = {}
    pallets_by_row: dict = {}
    for rid, r in footprint.items():
        c = (staged_qty * r["cases"] / total_cases) if total_cases > 0 else 0.0
        p = (staged_pallets * r["pallets"] / total_pallets) if total_pallets > 0 else 0.0
        if c > 0 or p > 0:
            content_by_row[rid] = c
            pallets_by_row[rid] = p
    if content_by_row:
        deduct_rm_rows(db, receipt, content_by_row, pallets_by_row=pallets_by_row, update_rows=True)
    return float(staged_pallets or 0)


def _stage_free_counted(
    db: Session, receipt: Receipt, staged_qty: float, source_row_id=None
) -> float:
    """Pull whole containers off named racks for a counted lot.

    The pallet argument is deliberately ignored here. For a counted lot the
    footprint is DERIVED from the unit count (`_project_rows` recomputes
    `occupied_pallets` from placements), so accepting a separate pallet figure
    would let two numbers disagree about the same shelf — the exact drift the
    lot model exists to remove. The count is the input; the footprint follows.
    """
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot:
        return 0.0

    # OPENED-FIRST: a part-used drum on the rack is exactly what a worker
    # would grab before breaking a new seal, and pulling it here is what
    # keeps a returned partial from stranding (availability counts its
    # content, so refusing to pull it would offer weight take_units cannot
    # deliver).
    remaining = float(staged_qty)
    freed_units = 0.0
    if not lot.is_held:
        # When the worker named the rack they pulled from (audit S8), stay on
        # it — draining fullest-first swapped drums between rows on paper.
        placements = lps.placements_for_lot(db, lot.id)
        if source_row_id:
            placements = [p for p in placements if p.storage_row_id == source_row_id]
        for placement in placements:
            while remaining > 1e-6 and int(placement.open_units or 0) > 0:
                open_units = int(placement.open_units)
                open_qty = float(placement.open_remaining_qty or 0)
                share = open_qty if open_units == 1 else open_qty / open_units
                if share <= 1e-6:
                    break
                if share <= remaining + 1e-6:
                    # The whole opened container goes to staging.
                    lps.apply_delta(
                        db, lot, placement.storage_row_id,
                        event_type=lps.EVENT_STAGED,
                        open_units_delta=-1,
                        open_qty_delta=-share,
                        ref_type="staging",
                        ref_id=receipt.id,
                        reason="Pulled for production staging (open container)",
                    )
                    remaining -= share
                    freed_units += 1
                else:
                    # Less than one open container needed: pour from it — the
                    # drum stays on the rack with the rest of its content.
                    lps.apply_delta(
                        db, lot, placement.storage_row_id,
                        event_type=lps.EVENT_STAGED,
                        open_qty_delta=-remaining,
                        ref_type="staging",
                        ref_id=receipt.id,
                        reason="Pulled for production staging (from open container)",
                    )
                    remaining = 0.0
                    break

    if remaining > 1e-6:
        units = lps.receipt_units_for_quantity(receipt, lot, remaining, exact=False)
        taken = lps.take_units(
            db, lot,
            units=units,
            event_type=lps.EVENT_STAGED,
            from_row_id=source_row_id,
            ref_type="staging",
            ref_id=receipt.id,
            reason="Pulled for production staging",
        )
        freed_units += float(sum(t["units"] for t in taken))

    # The footprint freed IS the container count — see `_project_rows`.
    return freed_units


def _compute_available_quantity(db: Session, receipt: Receipt) -> float:
    """How much of this receipt is free to stage.

    For a COUNTED lot this is derived from the containers actually pickable —
    what is on the racks, minus anything quarantined. `receipt.quantity` cannot
    answer it: it is a running weight that knows nothing about holds, so a lot
    with five drums under a QA hold would report every pound as available and
    then be refused by `take_units` at the moment of pulling. Offering material
    that cannot be pulled is how a picker ends up standing at a rack arguing
    with the system.

    Legacy receipts keep the old arithmetic — no placements, so no better source.

    Both paths still subtract what is currently out in staging, because those
    containers have physically left the rack but the receipt has not been
    decremented yet.
    """
    staged_items = db.query(StagingItem).filter(
        StagingItem.receipt_id == receipt.id,
        StagingItem.status.in_(["staged", "partially_used", "partially_returned"]),
    ).all()
    quantity_still_in_staging = sum(
        item.quantity_staged - item.quantity_used - item.quantity_returned
        for item in staged_items
    )

    if lps.is_counted_lot(db, receipt.material_lot_id):
        lot = db.query(MaterialLot).filter(
            MaterialLot.id == receipt.material_lot_id
        ).first()
        if lot:
            if lot.is_held:
                return 0.0
            placements = lps.placements_for_lot(db, lot.id)
            free_units = sum(lps._free_units(p) for p in placements)
            # Open (part-used) drums are pickable too — their weighed content
            # is real stock a worker can carry, and staging pulls them
            # opened-first so a partial never strands on a rack.
            open_qty = sum(float(p.open_remaining_qty or 0) for p in placements)
            pickable = free_units * float(lot.weight_per_unit or 0) + open_qty
            # The staging subtraction is already reflected in the placements —
            # staging takes the units off the rack — so it must not be applied
            # twice here.
            return max(0.0, pickable)

    return receipt.quantity - quantity_still_in_staging


def suggest_lots_for_staging(
    db: Session, product_id: str, quantity: float, wh_id: Optional[str]
) -> list:
    """Return FEFO-sorted lot suggestions for staging a product."""
    q = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.status == ReceiptStatus.APPROVED,
        Receipt.quantity > 0,
        Receipt.hold == False,
    )
    if wh_id:
        q = q.filter(Receipt.warehouse_id == wh_id)
    receipts = q.order_by(Receipt.expiration_date.asc().nullslast()).all()

    # A counted lot's drums live on racks, not in `Receipt.quantity`. Usage
    # sync decrements the paperwork weight and can zero it (status depleted)
    # while sealed drums still sit on a rack — the `quantity > 0` filter above
    # would then hide a lot a picker can walk to and touch. Rescue: any lot of
    # this product that still has placements is offered; the availability
    # check below reads the racks, so an actually-empty lot still drops out.
    seen_lot_ids = {r.material_lot_id for r in receipts if r.material_lot_id}
    seen_receipt_ids = {r.id for r in receipts}
    rescue_q = db.query(Receipt).filter(
        Receipt.product_id == product_id,
        Receipt.material_lot_id.isnot(None),
        Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED]),
        Receipt.hold == False,  # noqa: E712
        Receipt.is_deleted == False,  # noqa: E712
    )
    if wh_id:
        rescue_q = rescue_q.filter(Receipt.warehouse_id == wh_id)
    # Newest first: `project_lot` writes the lot's picture onto the newest
    # receipt, so that is the one to speak for the lot.
    for rescued in rescue_q.order_by(
        Receipt.receipt_date.desc(), Receipt.created_at.desc()
    ).all():
        if rescued.id in seen_receipt_ids or rescued.material_lot_id in seen_lot_ids:
            continue
        seen_lot_ids.add(rescued.material_lot_id)
        receipts.append(rescued)
    # Keep FEFO across the combined list.
    receipts.sort(key=lambda r: (r.expiration_date is None, r.expiration_date or 0))

    suggestions = []
    for receipt in receipts:
        available_quantity = _compute_available_quantity(db, receipt)
        detail = _counted_lot_detail(db, receipt)
        # A lot whose racks are empty but whose material sits in staging is
        # still a fact the screen must state ("already staged — add more?"),
        # not something to silently hide.
        if available_quantity <= 0.01 and float(detail.get("already_staged_qty") or 0) <= 0.01:
            continue

        location_name = sub_location_name = storage_row_name = None
        if receipt.location_id:
            loc = db.query(Location).filter(Location.id == receipt.location_id).first()
            location_name = loc.name if loc else None
        if receipt.sub_location_id:
            sub = db.query(SubLocation).filter(SubLocation.id == receipt.sub_location_id).first()
            sub_location_name = sub.name if sub else None
        if receipt.storage_row_id:
            row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            storage_row_name = row.name if row else None
            if not sub_location_name and row and row.sub_location_id:
                sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
                sub_location_name = sub.name if sub else None

        unit = receipt.unit or "cases"
        if not unit or unit == "cases":
            product = db.query(Product).filter(Product.id == receipt.product_id).first()
            if product and product.quantity_uom:
                unit = product.quantity_uom

        suggestions.append({
            "receipt_id": receipt.id,
            "lot_number": receipt.lot_number or "",
            "location_id": receipt.location_id,
            "location_name": location_name,
            "sub_location_id": receipt.sub_location_id,
            "sub_location_name": sub_location_name,
            "storage_row_name": storage_row_name,
            "expiration_date": receipt.expiration_date,
            "available_quantity": available_quantity,
            "unit": unit,
            "container_count": receipt.container_count,
            "container_unit": receipt.container_unit,
            "weight_per_container": receipt.weight_per_container,
            "weight_unit": receipt.weight_unit,
            **detail,
        })

    return suggestions


def _counted_lot_detail(db: Session, receipt: Receipt) -> dict:
    """Containers and racks, for a lot whose location is tracked as placements.

    What the staging screen needs to stop speaking in pounds. A worker does not
    remove 62% of a pound from a rack — they carry two drums off ROW 3 — so the
    screen has to be able to say how many containers there are and which racks
    they are on.

    Quarantined containers are reported but EXCLUDED from `available_units`.
    They are physically on the rack, so hiding them entirely would contradict
    what somebody sees standing there; they cannot be pulled, so counting them
    as available would offer material `take_units` will refuse.
    """
    empty = {"is_counted": False, "unit_label": None, "available_units": 0,
             "held_units": 0, "open_units": 0, "open_remaining_qty": 0.0,
             "already_staged_qty": 0.0, "racks": []}
    if not lps.is_counted_lot(db, receipt.material_lot_id):
        return empty

    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    if not lot:
        return empty
    # A wholly-held lot offers nothing, but still says so rather than vanishing:
    # the row is filtered out upstream by `Receipt.hold`, and if it ever reaches
    # here the honest answer is zero available with the hold visible.
    placements = lps.placements_for_lot(db, lot.id)
    rows = _rows_by_id(db, [p.storage_row_id for p in placements])

    racks = []
    for placement in placements:
        held = int(placement.held_units or 0)
        free = 0 if lot.is_held else max(0, int(placement.full_units or 0) - held)
        open_units = 0 if lot.is_held else int(placement.open_units or 0)
        open_qty = 0.0 if lot.is_held else float(placement.open_remaining_qty or 0)
        if free <= 0 and held <= 0 and open_units <= 0:
            continue
        row = rows.get(placement.storage_row_id)
        racks.append({
            "storage_row_id": placement.storage_row_id,
            "storage_row_name": row.name if row else placement.storage_row_id,
            "available_units": free,
            "held_units": int(placement.full_units or 0) if lot.is_held else held,
            # Opened containers — shown so a picker uses them up first.
            "open_units": open_units,
            "open_remaining_qty": round(open_qty, 3),
        })
    # Fullest first — the same order `take_units` drains them in, so the screen
    # shows the racks in the order a picker will actually walk them.
    racks.sort(key=lambda r: r["available_units"], reverse=True)

    # What is already out in staging for this lot's receipt, so the screen can
    # say "1,200 lbs already staged — add more?" instead of silently hiding.
    staged_items = db.query(StagingItem).filter(
        StagingItem.receipt_id == receipt.id,
        StagingItem.status.in_(["staged", "partially_used", "partially_returned"]),
    ).all()
    already_staged = sum(
        max(0.0, float(i.quantity_staged or 0) - float(i.quantity_used or 0)
            - float(i.quantity_returned or 0))
        for i in staged_items
    )

    return {
        "is_counted": True,
        "unit_label": lot.unit_label,
        "available_units": sum(r["available_units"] for r in racks),
        "held_units": sum(r["held_units"] for r in racks),
        "open_units": sum(r["open_units"] for r in racks),
        "open_remaining_qty": round(sum(r["open_remaining_qty"] for r in racks), 3),
        "already_staged_qty": round(already_staged, 3),
        "racks": racks,
    }


def _rows_by_id(db: Session, row_ids) -> dict:
    ids = [r for r in set(row_ids) if r]
    if not ids:
        return {}
    return {r.id: r for r in db.query(StorageRow).filter(StorageRow.id.in_(ids)).all()}


def create_staging_transfer(db: Session, staging_data, current_user) -> dict:
    """Create staging transfers for multiple products/lots."""
    staging_batch_id = f"staging-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    created_transfers = []
    created_staging_items = []

    for item_request in staging_data.items:
        if not item_request.lots or len(item_request.lots) == 0:
            raise ValidationError(f"No lots specified for product {item_request.product_id}")

        total_lot_quantity = sum(lot.quantity for lot in item_request.lots)
        if abs(total_lot_quantity - item_request.quantity_needed) > 0.01:
            raise ValidationError(
                f"Total lot quantities ({total_lot_quantity}) must match requested quantity ({item_request.quantity_needed})"
            )

        for lot_request in item_request.lots:
            receipt = db.query(Receipt).filter(Receipt.id == lot_request.receipt_id).first()
            if not receipt:
                raise NotFoundError("Receipt", lot_request.receipt_id)

            if receipt.product_id != item_request.product_id:
                raise ValidationError(
                    f"Receipt {lot_request.receipt_id} does not belong to product {item_request.product_id}"
                )

            available_quantity = _compute_available_quantity(db, receipt)
            if lot_request.quantity > available_quantity:
                raise ValidationError(
                    f"Insufficient quantity for lot {receipt.lot_number}. Available: {available_quantity}, Requested: {lot_request.quantity}"
                )

            unit = receipt.unit or "cases"
            if not unit or unit == "cases":
                product = db.query(Product).filter(Product.id == receipt.product_id).first()
                if product and product.quantity_uom:
                    unit = product.quantity_uom

            transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            transfer = InventoryTransfer(
                id=transfer_id,
                receipt_id=receipt.id,
                from_location_id=receipt.location_id,
                from_sub_location_id=receipt.sub_location_id,
                to_location_id=staging_data.staging_location_id,
                to_sub_location_id=staging_data.staging_sub_location_id,
                quantity=lot_request.quantity,
                unit=unit,
                reason="Staging for production",
                transfer_type="staging",
                requested_by=str(current_user.id),
                status="completed",
            )
            db.add(transfer)
            db.flush()

            original_storage_row_id = receipt.storage_row_id

            # Free the rack at the moment material is physically pulled, using the
            # EXPLICIT pallets the worker entered (falls back to a proportional
            # estimate from the lot's real pallets when not supplied). Content and
            # pallets come off independently — no cases/cases_per_pallet.
            pallets_staged = _stage_free_rack(
                db, receipt, float(lot_request.quantity),
                getattr(lot_request, "pallets", None),
                source_row_id=getattr(lot_request, "source_row_id", None),
            )

            receipt.location_id = staging_data.staging_location_id
            receipt.sub_location_id = staging_data.staging_sub_location_id

            staging_item_id = f"staging-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            staging_item = StagingItem(
                id=staging_item_id,
                transfer_id=transfer.id,
                receipt_id=receipt.id,
                product_id=item_request.product_id,
                quantity_staged=lot_request.quantity,
                pallets_staged=pallets_staged,
                original_storage_row_id=original_storage_row_id,
                staging_storage_row_id=None,
                staging_batch_id=staging_batch_id,
                warehouse_id=current_user.warehouse_id,
            )

            db.add(staging_item)
            created_transfers.append(transfer)
            created_staging_items.append(staging_item)

    # Link to production request items in the SAME transaction (audit S9).
    # The old flow did this with a second HTTP call, and a crash between the
    # two left staged material linked to no request.
    for f in (getattr(staging_data, "fulfillments", None) or []):
        from app.services import staging_request_service

        staging_request_service.fulfill_staging_request_item(
            db,
            request_id=f.request_id,
            item_id=f.item_id,
            quantity_fulfilled=float(f.quantity),
            staging_item_ids=[s.id for s in created_staging_items],
            commit=False,
        )

    return {
        "staging_batch_id": staging_batch_id,
        "transfers": [{"id": t.id, "receipt_id": t.receipt_id, "quantity": t.quantity} for t in created_transfers],
        "staging_items": [{"id": s.id, "receipt_id": s.receipt_id, "quantity_staged": s.quantity_staged} for s in created_staging_items],
    }


def mark_staging_used(db: Session, staging_item: StagingItem, request, current_user) -> StagingItem:
    """Mark staged quantity as consumed: free storage rows, create auto-approved adjustment."""
    if request.quantity <= 0:
        raise ValidationError("Quantity used must be greater than zero")
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if request.quantity > available_quantity:
        raise ValidationError(
            f"Cannot use more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt for staging item")

    # The rack was already freed when this material was pulled for staging, so
    # consumption only reduces the lot total — no storage-row changes here.
    # pallets_used is tracked for reporting (proportional to the staged pallets).
    pallets_used_now = 0.0
    if staging_item.pallets_staged and staging_item.quantity_staged > 0:
        pallets_used_now = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged

    staging_item.quantity_used += request.quantity
    staging_item.pallets_used = (staging_item.pallets_used or 0) + pallets_used_now

    if staging_item.quantity_used >= staging_item.quantity_staged:
        staging_item.status = "used"
    elif staging_item.quantity_used > 0:
        staging_item.status = "partially_used"
    staging_item.used_at = datetime.now(timezone.utc)

    # Auto-approved adjustment for consumption
    adjustment_id = f"adjust-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    adjustment = InventoryAdjustment(
        id=adjustment_id,
        receipt_id=staging_item.receipt_id,
        category_id=receipt.category_id,
        product_id=staging_item.product_id,
        adjustment_type="production-consumption",
        quantity=request.quantity,
        reason="Used from staging for production",
        status=AdjustmentStatus.APPROVED,
        original_quantity=receipt.quantity,
        new_quantity=receipt.quantity - request.quantity,
        submitted_by=str(current_user.id),
        approved_by=str(current_user.id),
        approved_at=datetime.now(timezone.utc),
    )
    # Rack/allocation already settled at staging time; consumption just reduces
    # the lot total.
    # Spills across the lot's receipts instead of clamping at zero (audit S5).
    from app.services.staging_request_service import consume_receipt_quantity

    consume_receipt_quantity(db, receipt, request.quantity)
    db.add(adjustment)

    return staging_item


def return_staging_item(db: Session, staging_item: StagingItem, request, current_user) -> StagingItem:
    """Return staged quantity to warehouse: free staging rows, reserve return row, create return transfer."""
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if request.quantity > available_quantity:
        raise ValidationError(
            f"Cannot return more than available. Available: {available_quantity}, Requested: {request.quantity}"
        )

    # The rack is MANDATORY (audit S1): a return without one incremented
    # quantity_returned while re-crediting no rack — the drums were deducted
    # at pull and now existed nowhere until a physical count found them. The
    # request-flow twin has always refused this; the desk flow now matches.
    # A room named instead of a rack resolves to the room's single row, the
    # same way intake and transfers resolve.
    if not request.to_storage_row_id and getattr(request, "to_sub_location_id", None):
        row_ids = [
            rid for (rid,) in db.query(StorageRow.id).filter(
                StorageRow.sub_location_id == request.to_sub_location_id,
                StorageRow.is_active == True,  # noqa: E712
            ).all()
        ]
        if len(row_ids) == 1:
            request.to_storage_row_id = row_ids[0]
    if not request.to_storage_row_id:
        raise ValidationError(
            "Pick the rack these containers are going back onto. A return "
            "without a rack re-credits nothing, and the material vanishes "
            "from every count."
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt for staging item")

    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()
    if not transfer:
        raise NotFoundError("Original transfer")

    unit = receipt.unit or "cases"
    product = db.query(Product).filter(Product.id == receipt.product_id).first()
    if not unit or unit == "cases":
        if product and product.quantity_uom:
            unit = product.quantity_uom

    # Pallets returned to the rack: the EXPLICIT count the worker entered, else a
    # proportional estimate from what was staged. The source rack was already
    # freed at staging time, so a return only ADDS to the chosen return row.
    returned_pallets = (
        float(request.pallets) if getattr(request, "pallets", None) is not None
        else ((request.quantity / staging_item.quantity_staged) * (staging_item.pallets_staged or 0)
              if staging_item.quantity_staged else 0.0)
    )

    # Create return transfer (auto-completed)
    return_transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    return_transfer = InventoryTransfer(
        id=return_transfer_id,
        receipt_id=staging_item.receipt_id,
        from_location_id=transfer.to_location_id,
        from_sub_location_id=transfer.to_sub_location_id,
        to_location_id=request.to_location_id,
        to_sub_location_id=request.to_sub_location_id,
        quantity=request.quantity,
        unit=unit,
        reason="Returned from staging",
        transfer_type="warehouse-transfer",
        requested_by=str(current_user.id),
        status="completed",
    )
    db.add(return_transfer)

    # Put it back where the worker says they put it.
    if request.to_storage_row_id:
        if lps.is_counted_lot(db, receipt.material_lot_id):
            # Whole containers back whole, and the remainder as ONE open unit
            # holding the weighed leftover — 600 lbs against 500 lb drums is a
            # full drum on the shelf plus an open drum with 100 lbs in it.
            # Rounding up would invent a sealed drum; the old round-down lost
            # the partial from every rack until a count found it.
            lot = db.query(MaterialLot).filter(
                MaterialLot.id == receipt.material_lot_id
            ).first()
            if lot:
                lps.return_units(
                    db, lot,
                    quantity=float(request.quantity),
                    to_row_id=request.to_storage_row_id,
                    ref_type="staging",
                    ref_id=staging_item.id,
                    reason="Returned from staging",
                )
        else:
            # Content + explicit pallets onto the chosen row, tracked
            # independently — no cases/cases_per_pallet.
            add_rm_rows(
                db, receipt,
                {request.to_storage_row_id: float(request.quantity)},
                pallets_by_row={request.to_storage_row_id: returned_pallets},
                update_rows=True,
            )

    # Only re-home the receipt's primary location when this return completes the
    # staged item — a partial return must not claim the whole lot moved.
    is_full_return = (
        staging_item.quantity_returned + request.quantity
        >= staging_item.quantity_staged - staging_item.quantity_used
    )
    if is_full_return:
        receipt.location_id = request.to_location_id
        receipt.sub_location_id = request.to_sub_location_id
        if request.to_storage_row_id:
            receipt.storage_row_id = request.to_storage_row_id

    staging_item.quantity_returned += request.quantity
    staging_item.pallets_returned = (staging_item.pallets_returned or 0) + returned_pallets

    if staging_item.quantity_returned >= staging_item.quantity_staged - staging_item.quantity_used:
        staging_item.status = "returned" if staging_item.quantity_used == 0 else "partially_returned"
    staging_item.returned_at = datetime.now(timezone.utc)

    return staging_item
