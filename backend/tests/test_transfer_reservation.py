"""Pending transfers reserve their drums (2026-09 audit T1/T9).

The prod incident: three transfers of 17+48+8 drums against a 69-drum receipt
each individually passed "quantity ≤ receipt.quantity" and all three were
approved — 73 drums moved out of 69 on paper. Reservation closes both doors:

* create: available = quantity − holds − Σ(other in-flight transfers)
* approve: the same check runs again, excluding the transfer being approved
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus, TransferStatus
from app.exceptions import ValidationError
from app.models import InventoryTransfer
from app.services import transfer_service


def _pending_transfer(db, receipt, *, qty, src=None, dest=None):
    transfer = InventoryTransfer(
        id=f"transfer-resv-{uuid.uuid4().hex[:10]}",
        receipt_id=receipt.id,
        quantity=qty,
        unit=receipt.unit,
        transfer_type="warehouse-transfer",
        to_location_id="loc-paw-paw",
        to_sub_location_id="subloc-warehouse-a",
        source_breakdown=src,
        destination_breakdown=dest,
        status=TransferStatus.PENDING,
        requested_by="test-user-1",
    )
    db.add(transfer)
    db.flush()
    return transfer


class TestCreateSideReservation:
    def test_second_transfer_may_only_claim_the_remainder(
        self, client, auth_headers, approved_receipt
    ):
        """100 on the lot; 60 pending → a 50 ask is refused, a 40 ask is not."""
        first = client.post(
            "/api/inventory/transfers",
            json={"receipt_id": approved_receipt.id, "quantity": 60,
                  "to_location_id": "loc-paw-paw",
                  "to_sub_location_id": "subloc-warehouse-a"},
            headers=auth_headers,
        )
        assert first.status_code == 200

        too_much = client.post(
            "/api/inventory/transfers",
            json={"receipt_id": approved_receipt.id, "quantity": 50,
                  "to_location_id": "loc-paw-paw",
                  "to_sub_location_id": "subloc-warehouse-a"},
            headers=auth_headers,
        )
        assert too_much.status_code == 400
        assert "pending transfers" in too_much.json()["detail"]

        remainder = client.post(
            "/api/inventory/transfers",
            json={"receipt_id": approved_receipt.id, "quantity": 40,
                  "to_location_id": "loc-paw-paw",
                  "to_sub_location_id": "subloc-warehouse-a"},
            headers=auth_headers,
        )
        assert remainder.status_code == 200


class TestApproveSideReservation:
    def test_approval_rechecks_against_other_pending_transfers(
        self, db_session, approved_receipt, admin_user
    ):
        """Two 60-drum transfers against a 100-drum lot (inserted directly —
        the prod incident predates the create-side check): approving either
        must refuse, because the other still reserves 60."""
        t1 = _pending_transfer(db_session, approved_receipt, qty=60)
        _pending_transfer(db_session, approved_receipt, qty=60)
        db_session.commit()

        with pytest.raises(ValidationError, match="other pending transfers"):
            transfer_service.approve_transfer(db_session, t1, admin_user)
        assert t1.status == TransferStatus.PENDING

    def test_approval_passes_when_others_leave_room(
        self, db_session, approved_receipt, admin_user, seed_data
    ):
        """60 + 40 against 100 both fit; approving the 60 succeeds and moves
        drums on the racks."""
        from app.models import StorageRow

        db_session.add(StorageRow(
            id="row-resv-dst", name="Row R", sub_location_id="subloc-warehouse-a",
            storage_area_id="area-1", pallet_capacity=10,
        ))
        db_session.flush()
        t1 = _pending_transfer(
            db_session, approved_receipt, qty=60,
            src=[{"id": "row-row-1", "quantity": 60}],
            dest=[{"id": "row-row-resv-dst", "quantity": 60}],
        )
        _pending_transfer(db_session, approved_receipt, qty=40)
        db_session.commit()

        transfer_service.approve_transfer(db_session, t1, admin_user)
        db_session.commit()
        assert t1.status == TransferStatus.APPROVED
