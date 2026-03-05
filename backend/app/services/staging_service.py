from datetime import datetime, timezone
from typing import Optional
import uuid
from sqlalchemy.orm import Session

from app.models import (
    Receipt, StagingItem, Product, Location, SubLocation, StorageRow, InventoryTransfer, InventoryAdjustment
)
from app.enums import ReceiptStatus, AdjustmentStatus
from app.exceptions import ValidationError, NotFoundError


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

            pallets_staged = None
            if receipt.pallets and receipt.pallets > 0 and receipt.quantity > 0:
                pallets_staged = (lot_request.quantity / receipt.quantity) * receipt.pallets

            original_storage_row_id = receipt.storage_row_id

            receipt.location_id = staging_data.staging_location_id
            receipt.sub_location_id = staging_data.staging_sub_location_id

            staging_storage_row_id = None
            if staging_data.staging_sub_location_id:
                # Future: resolve staging row if sub-location uses rows
                db.query(StorageRow).filter(
                    StorageRow.sub_location_id == staging_data.staging_sub_location_id
                ).all()

            staging_item_id = f"staging-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            staging_item = StagingItem(
                id=staging_item_id,
                transfer_id=transfer.id,
                receipt_id=receipt.id,
                product_id=item_request.product_id,
                quantity_staged=lot_request.quantity,
                pallets_staged=pallets_staged,
                original_storage_row_id=original_storage_row_id,
                staging_storage_row_id=staging_storage_row_id,
                staging_batch_id=staging_batch_id,
                warehouse_id=current_user.warehouse_id,
            )

            if staging_storage_row_id and pallets_staged:
                staging_row = db.query(StorageRow).filter(StorageRow.id == staging_storage_row_id).first()
                if staging_row:
                    staging_row.occupied_pallets = (staging_row.occupied_pallets or 0) + pallets_staged
                    if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                        staging_row.occupied_cases = (
                            (staging_row.occupied_cases or 0) + pallets_staged * receipt.cases_per_pallet
                        )
                    if not staging_row.product_id:
                        staging_row.product_id = item_request.product_id

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

    # Proportional pallets to free
    pallets_to_free = 0.0
    if staging_item.pallets_staged and staging_item.pallets_staged > 0 and staging_item.quantity_staged > 0:
        pallets_to_free = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged

    receipt_total = float(receipt.quantity)
    quantity_staged = float(staging_item.quantity_staged)
    quantity_used_now = float(request.quantity)

    proportion_of_receipt_freed = 0.0
    if receipt_total > 0 and quantity_staged > 0:
        proportion_of_receipt_freed = (quantity_used_now / quantity_staged) * (quantity_staged / receipt_total)

    # Multi-row raw material allocations
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        for alloc in receipt.raw_material_row_allocations:
            row_id = alloc.get("rowId")
            alloc_pallets = float(alloc.get("pallets", 0))
            if not row_id or alloc_pallets <= 0:
                continue
            pallets_to_free_from_row = alloc_pallets * proportion_of_receipt_freed
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row and pallets_to_free_from_row > 0:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free_from_row)
                if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                    row.occupied_cases = max(
                        0, (row.occupied_cases or 0) - pallets_to_free_from_row * receipt.cases_per_pallet
                    )
                if row.occupied_pallets <= 0:
                    row.product_id = None
    elif staging_item.original_storage_row_id and pallets_to_free > 0:
        original_row = db.query(StorageRow).filter(StorageRow.id == staging_item.original_storage_row_id).first()
        if original_row:
            original_row.occupied_pallets = max(0, (original_row.occupied_pallets or 0) - pallets_to_free)
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                original_row.occupied_cases = max(
                    0, (original_row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet
                )
            if original_row.occupied_pallets <= 0:
                original_row.product_id = None

    if staging_item.staging_storage_row_id and pallets_to_free > 0:
        staging_row = db.query(StorageRow).filter(StorageRow.id == staging_item.staging_storage_row_id).first()
        if staging_row:
            staging_row.occupied_pallets = max(0, (staging_row.occupied_pallets or 0) - pallets_to_free)
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                staging_row.occupied_cases = max(
                    0, (staging_row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet
                )
            if staging_row.occupied_pallets <= 0:
                staging_row.product_id = None

    staging_item.quantity_used += request.quantity
    staging_item.pallets_used = (staging_item.pallets_used or 0) + pallets_to_free

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
    receipt.quantity -= request.quantity
    if receipt.quantity <= 0:
        receipt.quantity = 0
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

    # Proportional pallets to return
    pallets_to_free = 0.0
    if staging_item.pallets_staged and staging_item.pallets_staged > 0 and staging_item.quantity_staged > 0:
        pallets_to_free = (request.quantity / staging_item.quantity_staged) * staging_item.pallets_staged

    # Free original location row
    if staging_item.original_storage_row_id and pallets_to_free > 0:
        original_row = db.query(StorageRow).filter(StorageRow.id == staging_item.original_storage_row_id).first()
        if original_row:
            original_row.occupied_pallets = max(0, (original_row.occupied_pallets or 0) - pallets_to_free)
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                original_row.occupied_cases = max(
                    0, (original_row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet
                )
            if original_row.occupied_pallets <= 0:
                original_row.product_id = None

    # Free staging row
    if staging_item.staging_storage_row_id and pallets_to_free > 0:
        staging_row = db.query(StorageRow).filter(StorageRow.id == staging_item.staging_storage_row_id).first()
        if staging_row:
            staging_row.occupied_pallets = max(0, (staging_row.occupied_pallets or 0) - pallets_to_free)
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                staging_row.occupied_cases = max(
                    0, (staging_row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet
                )
            if staging_row.occupied_pallets <= 0:
                staging_row.product_id = None

    # Reserve pallets in return row
    if request.to_storage_row_id and pallets_to_free > 0:
        return_row = db.query(StorageRow).filter(StorageRow.id == request.to_storage_row_id).first()
        if return_row:
            current_occupied = return_row.occupied_pallets or 0
            capacity = return_row.pallet_capacity or 0
            if capacity > 0 and (current_occupied + pallets_to_free) > capacity:
                raise ValidationError(
                    f"Returning {pallets_to_free} pallets would exceed row capacity ({capacity}). "
                    f"Currently occupied: {current_occupied}"
                )
            return_row.occupied_pallets = current_occupied + pallets_to_free
            if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                return_row.occupied_cases = (
                    (return_row.occupied_cases or 0) + pallets_to_free * receipt.cases_per_pallet
                )
            if not return_row.product_id:
                return_row.product_id = receipt.product_id

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

    # Update receipt location
    receipt.location_id = request.to_location_id
    receipt.sub_location_id = request.to_sub_location_id
    if request.to_storage_row_id:
        receipt.storage_row_id = request.to_storage_row_id

    staging_item.quantity_returned += request.quantity
    staging_item.pallets_returned = (staging_item.pallets_returned or 0) + pallets_to_free

    if staging_item.quantity_returned >= staging_item.quantity_staged - staging_item.quantity_used:
        staging_item.status = "returned" if staging_item.quantity_used == 0 else "partially_returned"
    staging_item.returned_at = datetime.now(timezone.utc)

    return staging_item
