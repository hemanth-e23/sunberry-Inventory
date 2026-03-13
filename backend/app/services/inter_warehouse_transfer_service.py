"""
Service layer for inter-warehouse transfer inventory mutations.
Handles source receipt linking, inventory deduction, destination receipt
creation, and rollback on cancel.
"""
import uuid
import copy
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from fastapi import HTTPException

from app.models import Receipt, InterWarehouseTransfer, StorageRow, StorageArea, Category, PalletLicence
from app.enums import ReceiptStatus
from app.constants import CATEGORY_FINISHED


def _is_finished_goods(db: Session, receipt: Receipt) -> bool:
    category = db.query(Category).filter(Category.id == receipt.category_id).first()
    return bool(category and (category.parent_id == "group-finished" or category.type == CATEGORY_FINISHED))


def link_source_receipt(
    db: Session,
    transfer: InterWarehouseTransfer,
    source_receipt_id: str = None,
):
    """
    Find or validate the source receipt and link it to the transfer.
    Called at the confirm step.
    - If source_receipt_id is provided, validate it.
    - Otherwise, auto-find by product + lot + warehouse (FIFO).
    """
    if source_receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == source_receipt_id).first()
        if not receipt:
            raise HTTPException(status_code=404, detail="Source receipt not found")
        if receipt.warehouse_id != transfer.from_warehouse_id:
            raise HTTPException(status_code=400, detail="Source receipt does not belong to the sender warehouse")
        if receipt.product_id != transfer.product_id:
            raise HTTPException(status_code=400, detail="Source receipt product does not match the transfer product")
    else:
        # Auto-find: match product + warehouse, optionally lot, with enough quantity
        query = db.query(Receipt).filter(
            Receipt.product_id == transfer.product_id,
            Receipt.warehouse_id == transfer.from_warehouse_id,
            Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED]),
            Receipt.quantity >= transfer.quantity,
            Receipt.is_deleted == False,
        )
        if transfer.lot_number:
            query = query.filter(Receipt.lot_number == transfer.lot_number)
        receipt = query.order_by(Receipt.receipt_date.asc()).first()

        if not receipt:
            raise HTTPException(
                status_code=400,
                detail="No receipt found in the source warehouse with enough available quantity for this product/lot."
            )

    if receipt.quantity < transfer.quantity:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient quantity. Receipt has {receipt.quantity} {receipt.unit}, transfer needs {transfer.quantity} {transfer.unit}."
        )

    if receipt.hold:
        raise HTTPException(
            status_code=400,
            detail="Source receipt is currently on hold. Release the hold before confirming this transfer."
        )

    transfer.source_receipt_id = receipt.id
    return receipt


def deduct_source_inventory(db: Session, transfer: InterWarehouseTransfer):
    """
    Deduct quantity from the source receipt and free storage row occupancy.
    Called at the ship step. Uses specific rows/pallets if provided, else proportional fallback.
    """
    receipt = db.query(Receipt).filter(Receipt.id == transfer.source_receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=400, detail="Source receipt not found. Cannot deduct inventory.")

    is_fg = _is_finished_goods(db, receipt)
    pl_ids = transfer.pallet_licence_ids if isinstance(transfer.pallet_licence_ids, list) else []
    breakdown = transfer.source_breakdown if isinstance(transfer.source_breakdown, list) else []

    if is_fg and pl_ids:
        _deduct_fg_pallets(db, transfer, receipt)
    elif not is_fg and breakdown:
        _deduct_rm_from_breakdown(db, transfer, receipt)
    else:
        # Legacy proportional fallback
        receipt.quantity = max(0, receipt.quantity - transfer.quantity)
        _free_storage_occupancy(db, receipt, transfer.quantity)

    # Mark depleted if empty
    if receipt.quantity <= 0:
        receipt.status = ReceiptStatus.DEPLETED

    transfer.inventory_deducted = True


def _deduct_fg_pallets(db: Session, transfer: InterWarehouseTransfer, receipt: Receipt):
    """Deduct FG inventory by marking specific pallets as shipped and freeing their rows."""
    pl_ids = transfer.pallet_licence_ids
    licences = db.query(PalletLicence).filter(
        PalletLicence.id.in_(pl_ids),
        PalletLicence.receipt_id == receipt.id,
        PalletLicence.status == "in_stock",
    ).all()

    if len(licences) != len(pl_ids):
        found_ids = {pl.id for pl in licences}
        missing = [pid for pid in pl_ids if pid not in found_ids]
        raise HTTPException(
            status_code=400,
            detail=f"Some pallets are no longer available for shipment: {missing}"
        )

    for pl in licences:
        pl.status = "shipped"
        if pl.storage_row_id:
            row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
            if row:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - 1)
                row.occupied_cases = max(0, (row.occupied_cases or 0) - (pl.cases or 0))
                if row.occupied_pallets <= 0:
                    row.product_id = None

    receipt.quantity = max(0, receipt.quantity - transfer.quantity)
    _rebuild_receipt_allocation_from_licences(db, receipt)


def _deduct_rm_from_breakdown(db: Session, transfer: InterWarehouseTransfer, receipt: Receipt):
    """Deduct RM/ingredient inventory from specific rows per source_breakdown."""
    cases_per_pallet = float(receipt.cases_per_pallet or 40)

    for entry in transfer.source_breakdown:
        source_id = entry.get("id", "")
        qty = float(entry.get("quantity", 0))
        if not source_id.startswith("row-") or qty <= 0:
            continue
        row_id = source_id.removeprefix("row-")
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        if row:
            pallets_to_free = qty / cases_per_pallet if cases_per_pallet > 0 else 0
            row.occupied_cases = max(0, (row.occupied_cases or 0) - qty)
            row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
            if row.occupied_pallets <= 0:
                row.product_id = None

    # Update receipt.raw_material_row_allocations to reflect freed quantities
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        allocs = copy.deepcopy(receipt.raw_material_row_allocations)
        for entry in transfer.source_breakdown:
            source_id = entry.get("id", "")
            qty = float(entry.get("quantity", 0))
            if not source_id.startswith("row-"):
                continue
            row_id = source_id.removeprefix("row-")
            for alloc in allocs:
                if alloc.get("rowId") == row_id:
                    pallets_freed = qty / cases_per_pallet if cases_per_pallet > 0 else 0
                    alloc["pallets"] = max(0, float(alloc.get("pallets", 0)) - pallets_freed)
        receipt.raw_material_row_allocations = [a for a in allocs if float(a.get("pallets", 0)) > 0]

    receipt.quantity = max(0, receipt.quantity - transfer.quantity)


def _rebuild_receipt_allocation_from_licences(db: Session, receipt: Receipt) -> None:
    """Rebuild receipt.allocation JSON from live in_stock pallet licence positions."""
    db.flush()
    all_in_stock = db.query(PalletLicence).filter(
        PalletLicence.receipt_id == receipt.id,
        PalletLicence.status == "in_stock",
        PalletLicence.storage_row_id.isnot(None),
    ).all()

    row_groups: dict = {}
    for pl in all_in_stock:
        rid = pl.storage_row_id
        if rid not in row_groups:
            row_groups[rid] = {"pallets": 0, "cases": 0}
        row_groups[rid]["pallets"] += 1
        row_groups[rid]["cases"] += (pl.cases or 0)

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


def _free_storage_occupancy(db: Session, receipt: Receipt, quantity_shipped: float):
    """Free storage row occupancy proportional to quantity shipped (legacy fallback)."""
    receipt_total = float(receipt.quantity + quantity_shipped)  # original quantity before deduction
    if receipt_total <= 0:
        return

    proportion = min(1.0, float(quantity_shipped) / receipt_total)

    # Raw materials / packaging with multi-row allocations
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        for alloc in receipt.raw_material_row_allocations:
            row_id = alloc.get("rowId")
            alloc_pallets = float(alloc.get("pallets", 0))
            if not row_id or alloc_pallets <= 0:
                continue
            pallets_to_free = alloc_pallets * proportion
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row and pallets_to_free > 0:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet)
                if row.occupied_pallets <= 0:
                    row.product_id = None
    elif receipt.storage_row_id and receipt.pallets:
        # Single row allocation
        receipt_total_pallets = float(receipt.pallets)
        if receipt_total_pallets > 0:
            pallets_to_free = receipt_total_pallets * proportion
            row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            if row and pallets_to_free > 0:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet)
                if row.occupied_pallets <= 0:
                    row.product_id = None
    elif receipt.allocation:
        # Finished goods with allocation plan
        import json
        alloc_data = receipt.allocation if isinstance(receipt.allocation, dict) else json.loads(receipt.allocation or "{}")
        plan = alloc_data.get("plan") or []
        for item in plan:
            row_id = item.get("rowId")
            pallets = float(item.get("pallets", 0))
            cases = float(item.get("cases", 0))
            if not row_id or pallets <= 0:
                continue
            pallets_to_free = pallets * proportion
            cases_to_free = cases * proportion
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_free)
                if row.occupied_pallets <= 0:
                    row.product_id = None


def create_destination_receipt(
    db: Session,
    transfer: InterWarehouseTransfer,
    receiver_user_id: str,
) -> Receipt:
    """
    Create a new pre-approved receipt at the destination warehouse.
    Called at the receive step.
    """
    source_receipt = db.query(Receipt).filter(Receipt.id == transfer.source_receipt_id).first()

    new_receipt = Receipt(
        id=f"rcpt-{uuid.uuid4().hex[:12]}",
        product_id=transfer.product_id,
        category_id=source_receipt.category_id if source_receipt else None,
        lot_number=transfer.lot_number or (source_receipt.lot_number if source_receipt else None),
        quantity=transfer.quantity,
        unit=transfer.unit,
        warehouse_id=transfer.to_warehouse_id,
        submitted_by=receiver_user_id,
        approved_by=receiver_user_id,
        approved_at=datetime.now(timezone.utc),
        status=ReceiptStatus.APPROVED,
        note=f"Inter-warehouse transfer from {transfer.from_warehouse_id} (Transfer: {transfer.id})",
        cases_per_pallet=source_receipt.cases_per_pallet if source_receipt else None,
        production_date=source_receipt.production_date if source_receipt else None,
        expiration_date=source_receipt.expiration_date if source_receipt else None,
        vendor_id=source_receipt.vendor_id if source_receipt else None,
        receipt_date=datetime.now(timezone.utc),
    )
    db.add(new_receipt)
    db.flush()

    transfer.destination_receipt_id = new_receipt.id
    return new_receipt


def restore_source_inventory(db: Session, transfer: InterWarehouseTransfer):
    """
    Restore source receipt quantity on cancel (only if inventory was deducted).
    Also restores row occupancy for specific rows/pallets if they were used.
    """
    if not transfer.inventory_deducted or not transfer.source_receipt_id:
        return

    receipt = db.query(Receipt).filter(Receipt.id == transfer.source_receipt_id).first()
    if not receipt:
        return

    is_fg = _is_finished_goods(db, receipt)
    pl_ids = transfer.pallet_licence_ids if isinstance(transfer.pallet_licence_ids, list) else []
    breakdown = transfer.source_breakdown if isinstance(transfer.source_breakdown, list) else []

    if is_fg and pl_ids:
        _restore_fg_pallets(db, transfer, receipt)
    elif not is_fg and breakdown:
        _restore_rm_from_breakdown(db, transfer, receipt)
    else:
        # Legacy: just restore quantity
        receipt.quantity = receipt.quantity + transfer.quantity

    # Un-deplete if it was depleted
    if receipt.status == ReceiptStatus.DEPLETED:
        receipt.status = ReceiptStatus.APPROVED

    transfer.inventory_deducted = False


def _restore_fg_pallets(db: Session, transfer: InterWarehouseTransfer, receipt: Receipt):
    """Restore FG pallets back to in_stock and re-occupy their rows."""
    pl_ids = transfer.pallet_licence_ids
    licences = db.query(PalletLicence).filter(
        PalletLicence.id.in_(pl_ids),
        PalletLicence.receipt_id == receipt.id,
    ).all()

    for pl in licences:
        pl.status = "in_stock"
        if pl.storage_row_id:
            row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
            if row:
                row.occupied_pallets = (row.occupied_pallets or 0) + 1
                row.occupied_cases = (row.occupied_cases or 0) + (pl.cases or 0)
                if not row.product_id:
                    row.product_id = pl.product_id

    receipt.quantity = receipt.quantity + transfer.quantity
    _rebuild_receipt_allocation_from_licences(db, receipt)


def _restore_rm_from_breakdown(db: Session, transfer: InterWarehouseTransfer, receipt: Receipt):
    """Restore RM row occupancy from source_breakdown."""
    cases_per_pallet = float(receipt.cases_per_pallet or 40)

    for entry in transfer.source_breakdown:
        source_id = entry.get("id", "")
        qty = float(entry.get("quantity", 0))
        if not source_id.startswith("row-") or qty <= 0:
            continue
        row_id = source_id.removeprefix("row-")
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        if row:
            pallets_to_restore = qty / cases_per_pallet if cases_per_pallet > 0 else 0
            row.occupied_cases = (row.occupied_cases or 0) + qty
            row.occupied_pallets = (row.occupied_pallets or 0) + pallets_to_restore
            if not row.product_id:
                row.product_id = receipt.product_id

    # Restore receipt.raw_material_row_allocations
    if receipt.raw_material_row_allocations is not None:
        allocs = copy.deepcopy(receipt.raw_material_row_allocations) if receipt.raw_material_row_allocations else []
        for entry in transfer.source_breakdown:
            source_id = entry.get("id", "")
            qty = float(entry.get("quantity", 0))
            if not source_id.startswith("row-"):
                continue
            row_id = source_id.removeprefix("row-")
            pallets_to_restore = qty / cases_per_pallet if cases_per_pallet > 0 else 0
            existing = next((a for a in allocs if a.get("rowId") == row_id), None)
            if existing:
                existing["pallets"] = float(existing.get("pallets", 0)) + pallets_to_restore
            else:
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first() if row else None
                allocs.append({
                    "rowId": row_id,
                    "areaId": row.storage_area_id if row else None,
                    "areaName": area.name if area else "",
                    "rowName": row.name if row else "",
                    "pallets": pallets_to_restore,
                })
        receipt.raw_material_row_allocations = allocs

    receipt.quantity = receipt.quantity + transfer.quantity
