import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, PalletLicence, StorageRow
from app.enums import ReceiptStatus, PalletStatus
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE


def _free_storage_row_occupancy(db: Session, receipt: Receipt) -> None:
    """Free storage row occupancy reserved when this receipt was created.

    Handles two paths:
    - Finished goods: allocation JSON plan (multiple rows)
    - Raw materials/packaging: single storage_row_id + pallets count
    """
    # Finished goods path (allocation plan)
    if receipt.allocation:
        allocation_data = (
            receipt.allocation
            if isinstance(receipt.allocation, dict)
            else json.loads(receipt.allocation)
        )
        if allocation_data.get("success") and allocation_data.get("plan"):
            for item in allocation_data["plan"]:
                row_id = item.get("rowId")
                pallets = float(item.get("pallets", 0))
                cases = float(item.get("cases", 0))
                if row_id and pallets > 0:
                    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                    if row:
                        row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets)
                        row.occupied_cases = max(0, (row.occupied_cases or 0) - cases)
                        if row.occupied_pallets <= 0:
                            row.product_id = None

    # Raw materials / packaging path
    if receipt.storage_row_id and receipt.pallets:
        pallets_to_free = float(receipt.pallets)
        if pallets_to_free > 0:
            row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
            if row:
                row.occupied_pallets = max(0, (row.occupied_pallets or 0) - pallets_to_free)
                if row.occupied_pallets <= 0:
                    row.product_id = None


def approve_receipt(db: Session, receipt: Receipt, current_user) -> Receipt:
    """Approve a receipt: validate state + permissions, transition pallet licences to IN_STOCK."""
    if receipt.status not in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
        raise ValidationError("Receipt is not in a state that can be approved")

    if current_user.role == ROLE_WAREHOUSE and receipt.submitted_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot approve your own receipts. Only other users' receipts can be approved."
        )

    receipt.status = ReceiptStatus.APPROVED
    receipt.approved_by = str(current_user.id)
    receipt.approved_at = datetime.now(timezone.utc)

    # Transition pending pallet licences to in_stock
    db.query(PalletLicence).filter(
        PalletLicence.receipt_id == receipt.id,
        PalletLicence.status == PalletStatus.PENDING,
    ).update({"status": PalletStatus.IN_STOCK}, synchronize_session=False)

    return receipt


def reject_receipt(db: Session, receipt: Receipt, reason: str, current_user) -> Receipt:
    """Reject a receipt: free storage row occupancy, cancel pallet licences."""
    if receipt.status not in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
        raise ValidationError("Receipt is not in a state that can be rejected")

    if current_user.role == ROLE_WAREHOUSE and receipt.submitted_by == str(current_user.id):
        raise ForbiddenError(
            "You cannot reject your own receipts. Only other users' receipts can be rejected."
        )

    _free_storage_row_occupancy(db, receipt)

    receipt.status = ReceiptStatus.REJECTED
    receipt.note = f"{receipt.note or ''}\n[Rejected by {current_user.name}]: {reason}".strip()

    db.query(PalletLicence).filter(PalletLicence.receipt_id == receipt.id).update(
        {"status": PalletStatus.CANCELLED}, synchronize_session=False
    )

    return receipt


def send_back_receipt(db: Session, receipt: Receipt, reason: str, current_user) -> Receipt:
    """Send a receipt back for correction: free occupancy, delete pallet licences for regeneration."""
    if receipt.status not in (ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED):
        raise ValidationError("Receipt is not in a state that can be sent back")

    if current_user.role == ROLE_WAREHOUSE:
        raise ForbiddenError(
            "Warehouse workers cannot send back receipts. Only admins and supervisors can send back for correction."
        )

    _free_storage_row_occupancy(db, receipt)

    receipt.status = "sent-back"
    receipt.note = f"{receipt.note or ''}\n[Sent Back by {current_user.name}]: {reason}".strip()

    # Delete licences so they get regenerated when the receipt is resubmitted
    db.query(PalletLicence).filter(PalletLicence.receipt_id == receipt.id).delete(
        synchronize_session=False
    )

    return receipt
