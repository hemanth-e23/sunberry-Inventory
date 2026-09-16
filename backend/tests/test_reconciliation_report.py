"""The standing alarm: receipts↔placements reconciliation (2026-09 audit).

Every silent failure class from the incident must show up here, and a healthy
book must come back clean.
"""
import uuid
from datetime import datetime, timezone

import pytest

from app.enums import ReceiptStatus, TransferStatus
from app.models import (
    Category,
    InventoryTransfer,
    Location,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import receipt_service
from app.services.report_builders import build_reconciliation_report

WH = "wh-recon-1"
PRODUCT = "prod-recon"
VENDOR = "vendor-recon"
ROW_1 = "row-recon-1"
SUB = "sub-recon"
BBD = datetime(2027, 9, 1, tzinfo=timezone.utc)


@pytest.fixture
def recon_seed(db_session):
    db_session.add(Warehouse(id=WH, name="Plant R", code="PR", type="owned", is_active=True))
    db_session.add(Category(id="cat-recon-raw", name="Raw", type="raw"))
    db_session.add(Product(id=PRODUCT, name="Recon Mango", category_id="cat-recon-raw"))
    db_session.add(Vendor(id=VENDOR, name="Recon Vendor"))
    db_session.add(Location(id="loc-recon", name="Plant R", warehouse_id=WH))
    db_session.add(SubLocation(id=SUB, name="Drum Barn", location_id="loc-recon",
                               storage_unit="drum"))
    db_session.add(StorageArea(id="area-recon", name="Barn", location_id="loc-recon"))
    db_session.add(StorageRow(id=ROW_1, name="R-01", sub_location_id=SUB,
                              storage_area_id="area-recon", pallet_capacity=0))
    db_session.add(User(id="u-recon", username="ru", name="Recon User",
                        email="ru@x.test", hashed_password="x", role="admin",
                        is_active=True))
    db_session.commit()


class _Approver:
    id = "u-recon"
    role = "admin"
    name = "Recon User"
    warehouse_id = WH


def _gated_receipt(db, *, units=10):
    receipt = Receipt(
        id=f"rcpt-recon-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT,
        category_id="cat-recon-raw",
        vendor_id=VENDOR,
        lot_number=f"RC-{uuid.uuid4().hex[:6]}",
        expiration_date=BBD,
        quantity=units * 500.0,
        unit="lbs",
        container_count=units,
        container_unit="drums",
        weight_per_container=500.0,
        weight_unit="lbs",
        warehouse_id=WH,
        sub_location_id=SUB,
        storage_row_id=ROW_1,
        status=ReceiptStatus.RECORDED,
        submitted_by="u-recon",
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def test_clean_books_come_back_clean(db_session, recon_seed):
    _gated_receipt(db_session, units=10)
    db_session.commit()
    report = build_reconciliation_report(db_session, warehouse_id=WH)
    assert report["totals"]["clean"] is True
    assert report["phantom_receipts"] == []
    assert report["noop_transfers"] == []
    assert report["lot_imbalances"] == []


def test_every_incident_class_is_surfaced(db_session, recon_seed):
    healthy = _gated_receipt(db_session, units=10)

    # 1 ─ a phantom: approved directly, no lot, no placements (the BOL-G shape)
    phantom = Receipt(
        id="rcpt-recon-phantom",
        product_id=PRODUCT,
        category_id="cat-recon-raw",
        lot_number="RC-PHANTOM",
        quantity=32706,
        unit="lbs",
        warehouse_id=WH,
        status=ReceiptStatus.APPROVED,
        submitted_by="u-recon",
    )
    db_session.add(phantom)

    # 2 ─ a no-op transfer: approved, zero ledger events (the 09-15 shape)
    db_session.add(InventoryTransfer(
        id="transfer-recon-noop",
        receipt_id=healthy.id,
        quantity=500.0,
        unit="lbs",
        transfer_type="warehouse-transfer",
        status=TransferStatus.APPROVED,
        approved_at=datetime.now(timezone.utc),
        requested_by="u-recon",
        approved_by="u-recon",
        warehouse_id=WH,
    ))

    # 3 ─ an imbalance: paper says 10 drums, shrink the receipt to 6 on paper
    imbalanced = _gated_receipt(db_session, units=10)
    imbalanced.container_count = 6
    db_session.commit()

    report = build_reconciliation_report(db_session, warehouse_id=WH)
    assert report["totals"]["clean"] is False
    assert [r["receipt_id"] for r in report["phantom_receipts"]] == ["rcpt-recon-phantom"]
    assert [t["transfer_id"] for t in report["noop_transfers"]] == ["transfer-recon-noop"]
    lots = {r["lot_code"]: r for r in report["lot_imbalances"]}
    assert len(lots) == 1
    (row,) = lots.values()
    assert row["paper_units"] == 6
    assert row["racked_units"] == 10
    assert row["difference"] == 4
