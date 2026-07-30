"""
Reports must include SCHEDULED-flow shipments.

The scheduled ship-out lifecycle ends in status 'docs_generated' with no
approved_at (the 2026-07 cutover). Reports written for the legacy 'approved'
status silently dropped every scheduled shipment; these tests guard the fix.
"""
from datetime import datetime, timezone, timedelta

from app.models import (
    User, Warehouse, Category, Product, Receipt,
    InventoryTransfer, InventoryTransferLine,
)
from app.utils.auth import get_password_hash
from app.enums import ShipOutLifecycle
from app.services import report_builders as rb

import pytest


@pytest.fixture
def scheduled_shipment(db_session):
    now = datetime.now(timezone.utc)
    wh = Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True)
    cat = Category(id="cat-fg", name="Finished", type="finished")
    prod = Product(id="p-mango", name="Mango", category_id="cat-fg",
                   short_code="MANGO", is_active=True, default_cases_per_pallet=50, expire_years=1)
    user = User(id="u-1", username="wh", name="WH", email="wh@p.com",
                hashed_password=get_password_hash("pw"), role="warehouse",
                is_active=True, warehouse_id="wh-a")
    rcpt = Receipt(id="r-a", product_id="p-mango", category_id="cat-fg", lot_number="LOTA",
                   quantity=200, unit="cases", status="approved",
                   receipt_date=now - timedelta(days=5), warehouse_id="wh-a")
    # A finalized scheduled ship-out: status docs_generated, no approved_at,
    # ship time on time_out / docs_generated_at. Parent receipt_id is NULL; the
    # shipped cases live on a receipt-pinned line (multi-product shape).
    t = InventoryTransfer(
        id="t-sched", transfer_type="shipped-out", status=ShipOutLifecycle.DOCS_GENERATED.value,
        order_number="SCH-RPT-1", warehouse_id="wh-a", quantity=300, unit="cases",
        requested_by="u-1", pallet_licence_ids=[], receipt_id=None,
        time_out=now, docs_generated_at=now, docs_generated_by="u-1", is_locked=True,
    )
    line = InventoryTransferLine(
        id="tl-sched", transfer_id="t-sched", product_id="p-mango", receipt_id="r-a",
        cases_requested=300, cases_picked=300, pallet_licence_ids=[],
        lot_allocations=[], picks=[], lot_swap_history=[], line_seq=0,
    )
    db_session.add_all([wh, cat, prod, user, rcpt, t, line])
    db_session.commit()
    return {"transfer_id": "t-sched", "receipt_id": "r-a", "product_id": "p-mango"}


def test_shipments_report_includes_scheduled_order(db_session, scheduled_shipment):
    out = rb.build_shipments_report(db_session, start_date="2020-01-01", end_date="2030-12-31")
    orders = {r["order_number"] for r in out["rows"]}
    assert "SCH-RPT-1" in orders
    assert out["totals"]["total_cases"] == 300


def test_shipment_detail_resolves_scheduled_order(db_session, scheduled_shipment):
    d = rb.build_shipment_detail(db_session, scheduled_shipment["transfer_id"])
    assert d is not None
    assert d["order_number"] == "SCH-RPT-1"
    assert d["totals"]["cases_picked"] == 300
    # No approver on scheduled orders — falls back to whoever generated the BOL.
    assert d["approved_by"] is not None
    assert d["approved_at"] is not None


def test_shipped_cases_helper_counts_scheduled_order(db_session, scheduled_shipment):
    assert rb._shipped_cases_for_receipt(db_session, scheduled_shipment["receipt_id"]) == 300


def test_order_search_ignores_date_range(db_session, scheduled_shipment):
    # Searching by order # pulls it up regardless of the date window.
    out = rb.build_shipments_report(
        db_session, start_date="1999-01-01", end_date="1999-12-31", order_number="SCH-RPT-1"
    )
    assert {r["order_number"] for r in out["rows"]} == {"SCH-RPT-1"}
