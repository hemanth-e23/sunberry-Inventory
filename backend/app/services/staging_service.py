from datetime import datetime, timezone
from typing import Optional
import uuid
from sqlalchemy.orm import Session

from app.models import (
    Receipt, StagingItem, Product, Location, SubLocation, StorageRow, InventoryTransfer, InventoryAdjustment
)
from app.enums import ReceiptStatus, AdjustmentStatus
from app.exceptions import ValidationError, NotFoundError
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


def _stage_free_rack(db: Session, receipt: Receipt, staged_qty: float, staged_pallets: float) -> float:
    """Free a lot's rack footprint when material is pulled for staging: remove
    ``staged_qty`` content and ``staged_pallets`` pallets, distributed across the
    lot's current rows by their real content / pallet share (never cases/cpp).
    Returns the pallet count actually freed (the explicit number, or a
    proportional estimate when none was supplied)."""
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


def _compute_available_quantity(db: Session, receipt: Receipt) -> float:
    """Calculate how much of receipt.quantity is free to stage (not currently in active staging)."""
    staged_items = db.query(StagingItem).filter(
        StagingItem.receipt_id == receipt.id,
        StagingItem.status.in_(["staged", "partially_used", "partially_returned"]),
    ).all()
    quantity_still_in_staging = sum(
        item.quantity_staged - item.quantity_used - item.quantity_returned
        for item in staged_items
    )
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

    suggestions = []
    for receipt in receipts:
        available_quantity = _compute_available_quantity(db, receipt)
        if available_quantity <= 0.01:
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
        })

    return suggestions


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
                db, receipt, float(lot_request.quantity), getattr(lot_request, "pallets", None)
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
    receipt.quantity = max(0, receipt.quantity - request.quantity)
    db.add(adjustment)

    return staging_item


def return_staging_item(db: Session, staging_item: StagingItem, request, current_user) -> StagingItem:
    """Return staged quantity to warehouse: free staging rows, reserve return row, create return transfer."""
    available_quantity = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if request.quantity > available_quantity:
        raise ValidationError(
            f"Cannot return more than available. Available: {available_quantity}, Requested: {request.quantity}"
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

    # Add the returned content + explicit pallets to the chosen return row (rows
    # + allocation JSON), tracked independently — no cases/cases_per_pallet.
    if request.to_storage_row_id:
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
