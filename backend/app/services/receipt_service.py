import json
from datetime import datetime, timezone
from sqlalchemy.orm import Session

from app.models import Receipt, PalletLicence, StorageRow
from app.enums import ReceiptStatus, PalletStatus
from app.exceptions import ForbiddenError, ValidationError
from app.constants import ROLE_WAREHOUSE
from app.utils.warehouse_time import as_aware_utc, warehouse_timezone, zone


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

    # The gate runs BEFORE the status flips: for non-FG receipts it either
    # verifies the forklift's scans (and corrects the paperwork to them) or
    # turns the typed rows into placements — refusing when neither covers the
    # stated count, so a refused receipt is left exactly as it was. Approving
    # paper the racks contradict is how ~170 phantom drums entered the books
    # on 2026-09-14; this is the guard that makes that loud.
    #
    # Imported here rather than at module scope only to keep the receipt service
    # free of a lot-model dependency at import time; there is no cycle.
    from app.services import lot_receiving_service

    lot_receiving_service.approve_gate_and_place(db, receipt, actor_id=str(current_user.id))

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

    # Scans are physical placements; rejecting the paperwork must not leave the
    # scanned drums as stock with a rejected paper trail (audit I7). Before
    # 2026-10 this refused and told the forklift to undo the scans, which is
    # impossible once the truck is finished (browser test F8). The reject now
    # takes them back off the racks through the ledger itself, and still
    # refuses when any of them have moved or been used since.
    from app.services import lot_receiving_service

    removed = lot_receiving_service.reverse_receiving_for_reject(
        db, receipt, actor_id=str(current_user.id), reason=reason,
    )

    _free_storage_row_occupancy(db, receipt)

    receipt.status = ReceiptStatus.REJECTED
    receipt.note = f"{receipt.note or ''}\n[Rejected by {current_user.name}]: {reason}".strip()
    if removed:
        receipt.note += f"\n[Reject took {removed} scanned unit(s) back off the racks]"

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

    receipt.status = ReceiptStatus.SENT_BACK
    receipt.note = f"{receipt.note or ''}\n[Sent Back by {current_user.name}]: {reason}".strip()

    # Delete licences so they get regenerated when the receipt is resubmitted
    db.query(PalletLicence).filter(PalletLicence.receipt_id == receipt.id).delete(
        synchronize_session=False
    )

    return receipt


def corrected_receipt_date(db: Session, receipt: Receipt, new_value):
    """What `receipt_date` should become when a correction posts one.

    `receipt_date` is an INSTANT (when the truck was received), but the
    corrections form edits it through a date input, so what arrives is a bare
    day — midnight UTC once the client or schema has parsed it. Writing that
    back verbatim moved an 8:12 PM EDT receipt to 00:00 UTC — 8 PM the evening
    BEFORE in Eastern — and it showed as received the previous day everywhere
    (browser test 2026-10-01, F4).

    Rules:
      * A full timestamp (anything but exactly midnight UTC) was set on
        purpose — keep it.
      * A bare day that is the receipt's own day (as the warehouse sees it, or
        as the UTC/as-loaded readings show it — the form pre-fills from one of
        those) is "unchanged": keep the original instant.
      * A different bare day is a deliberate re-date: that day, at the original
        local time of day in the warehouse's timezone.
      * None never wipes a received timestamp.
    """
    original = receipt.receipt_date
    if new_value is None:
        return original
    if original is None:
        return new_value
    nv = as_aware_utc(new_value)
    if (nv.hour, nv.minute, nv.second, nv.microsecond) != (0, 0, 0, 0):
        return new_value

    typed = nv.date()
    tz = zone(warehouse_timezone(db, receipt.warehouse_id))
    orig_utc = as_aware_utc(original)
    orig_local = orig_utc.astimezone(tz)
    same_day = {orig_local.date(), orig_utc.date(), original.date()}
    if typed in same_day:
        return original

    redated = datetime(
        typed.year, typed.month, typed.day,
        orig_local.hour, orig_local.minute, orig_local.second, orig_local.microsecond,
        tzinfo=tz,
    )
    return redated.astimezone(timezone.utc)
