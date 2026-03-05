import copy
import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, InventoryTransfer, StorageRow, StorageArea, PalletLicence, Category
from app.enums import TransferStatus, PalletStatus, ReceiptStatus
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE, CATEGORY_FINISHED


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_finished_goods(db: Session, receipt: Receipt) -> bool:
    category = db.query(Category).filter(Category.id == receipt.category_id).first()
    return bool(category and (category.parent_id == "group-finished" or category.type == CATEGORY_FINISHED))


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
    """Update storage row occupancies for raw material warehouse-transfers and update receipt location."""
    cases_per_pallet = float(receipt.cases_per_pallet or 40)

    # Free source rows
    if transfer.source_breakdown and isinstance(transfer.source_breakdown, list):
        for source in transfer.source_breakdown:
            source_id = source.get("id", "")
            if not source_id.startswith("row-"):
                continue
            row_id = source_id.removeprefix("row-")
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row:
                cases_to_free = float(source.get("quantity", 0))
                pallets_to_free = cases_to_free / cases_per_pallet if cases_per_pallet > 0 else 0
                row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_free)
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if row.occupied_pallets <= 0:
                    row.product_id = None

    # Reserve destination rows and update receipt.storage_row_id
    if transfer.destination_breakdown and isinstance(transfer.destination_breakdown, list):
        dest_row_ids = []
        for dest in transfer.destination_breakdown:
            dest_id = dest.get("id", "")
            if not dest_id.startswith("row-"):
                continue
            row_id = dest_id.removeprefix("row-")
            dest_row_ids.append(row_id)
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row:
                cases_to_add = float(dest.get("quantity", 0))
                pallets_to_add = cases_to_add / cases_per_pallet if cases_per_pallet > 0 else 0
                row.occupied_cases = (row.occupied_cases or 0) + cases_to_add
                row.occupied_pallets = (row.occupied_pallets or 0) + pallets_to_add
                if not row.product_id:
                    row.product_id = receipt.product_id

        # Update receipt storage_row_id if transferring to a single destination row
        if len(dest_row_ids) == 1:
            receipt.storage_row_id = dest_row_ids[0]


def _apply_raw_material_ship_out(
    db: Session, transfer: InventoryTransfer, receipt: Receipt
) -> None:
    """Free raw material/packaging storage row occupancy proportional to quantity shipped."""
    transfer_quantity = float(transfer.quantity)
    receipt_total = float(receipt.quantity)
    if receipt_total <= 0:
        return

    proportion_shipped = min(1.0, transfer_quantity / receipt_total)

    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        for alloc in receipt.raw_material_row_allocations:
            row_id = alloc.get("rowId")
            alloc_pallets = float(alloc.get("pallets", 0))
            if not row_id or alloc_pallets <= 0:
                continue
            pallets_to_free = alloc_pallets * proportion_shipped
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            if row and pallets_to_free > 0:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet)
                if row.occupied_pallets <= 0:
                    row.product_id = None
    elif receipt.storage_row_id and receipt.pallets:
        receipt_total_pallets = float(receipt.pallets)
        if receipt_total_pallets > 0:
            pallets_to_free = receipt_total_pallets * proportion_shipped
            row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            if row and pallets_to_free > 0:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if receipt.cases_per_pallet and receipt.cases_per_pallet > 0:
                    row.occupied_cases = max(0, (row.occupied_cases or 0) - pallets_to_free * receipt.cases_per_pallet)
                if row.occupied_pallets <= 0:
                    row.product_id = None


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

def approve_transfer(db: Session, transfer: InventoryTransfer, current_user) -> InventoryTransfer:
    """Approve a transfer: validate permissions, apply all inventory mutations."""
    if transfer.status != TransferStatus.PENDING:
        raise ValidationError("Transfer is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot approve your own transfers. Only other users' transfers can be approved."
        )

    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
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
    """Reject a transfer: validate permissions, clear receipt hold."""
    if transfer.status != TransferStatus.PENDING:
        raise ValidationError("Transfer is not in pending status")

    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot reject your own transfers. Only other users' transfers can be rejected."
        )

    receipt = db.query(Receipt).filter(Receipt.id == transfer.receipt_id).first()
    if receipt:
        receipt.hold = False

    transfer.status = TransferStatus.REJECTED
    transfer.reason = f"{transfer.reason or ''}\n[Rejected by {current_user.name}]: {reason}".strip()

    return transfer
