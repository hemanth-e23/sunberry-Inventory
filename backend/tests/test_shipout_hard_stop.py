"""
Ship-out gun hard-stop for SCHEDULED (advisory) orders.

Mirrors the legacy v1 scanner: once a product's ordered cases are met, the
forklift gun stops.
  • Scanning past the ordered total is rejected ("Quantity reached").
  • A whole pallet that would overshoot prompts a partial pull of exactly what's
    still needed; the remainder goes to the Partials rack.
  • Office/manual paths (picked_via="manual_select": Select-pallets,
    Fix-over-ship) stay permissive so a supervisor can still correct a load.
  • Lot-planned orders keep their soft-total behaviour (covered in
    test_shipout_soft_totals.py) — the hard stop is scoped to scheduled orders.
"""
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

from app.models import (
    User, Warehouse, Category, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, PalletLicence,
)
from app.utils.auth import get_password_hash
from app.enums import PalletStatus, ShipOutLifecycle
from app.services import ship_out_service

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def base(db_session):
    wh = Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True)
    cat = Category(id="cat-fg", name="Finished", type="finished")
    mango = Product(id="p-mango", name="Mango", category_id="cat-fg",
                    short_code="MANGO", is_active=True, default_cases_per_pallet=50, expire_years=1)
    user = User(id="u-1", username="wh", name="WH", email="wh@p.com",
                hashed_password=get_password_hash("pw"), role="warehouse",
                is_active=True, warehouse_id="wh-a")
    loc = Location(id="loc-1", name="Main", warehouse_id="wh-a")
    subloc = SubLocation(id="subloc-1", name="Sub", location_id="loc-1")
    area = StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="subloc-1")
    row = StorageRow(id="row-1", name="FG-01", sub_location_id="subloc-1",
                     storage_area_id="area-1", pallet_capacity=50, occupied_pallets=0)
    # Partial-pallet destination row (where an overshoot remainder is homed).
    part = StorageRow(id="row-part", name="PARTIALS", sub_location_id="subloc-1",
                      storage_area_id="area-1", pallet_capacity=99,
                      is_partial_pallet_location=True, is_active=True)
    db_session.add_all([wh, cat, mango, user, loc, subloc, area, row, part])
    db_session.commit()
    return {"user": user}


def _receipt(db, rid, lot, qty, days_old):
    when = datetime.now(timezone.utc) - timedelta(days=days_old)
    r = Receipt(id=rid, product_id="p-mango", lot_number=lot, quantity=qty,
                unit="cases", status="approved", receipt_date=when, warehouse_id="wh-a")
    db.add(r)
    return r


def _pallet(db, pid, lic, lot, receipt_id, cases, days_old):
    when = datetime.now(timezone.utc) - timedelta(days=days_old)
    pl = PalletLicence(
        id=pid, licence_number=lic, receipt_id=receipt_id, product_id="p-mango",
        lot_number=lot, cases=cases, is_partial=False, sequence=1,
        status=PalletStatus.IN_STOCK, warehouse_id="wh-a",
        storage_row_id="row-1", storage_area_id="area-1",
        is_held=False, is_deleted=False, created_at=when,
    )
    db.add(pl)
    return pl


def _scheduled(db, user, order_number, cases):
    """Create a SCHEDULED (advisory, no-lot) order for p-mango and flip it to
    SCANNING so scan_pick_v2 will accept scans."""
    data = SimpleNamespace(
        order_number=order_number,
        lines=[SimpleNamespace(product_id="p-mango", cases_requested=cases)],
        pallet_type_id=None, ship_to=None, carrier=None,
        scheduled_date=(datetime.now(timezone.utc).date()),
        appointment_time=None, po_number=None,
    )
    t = ship_out_service.create_scheduled_order(db, data, user, "wh-a")
    t.status = ShipOutLifecycle.SCANNING.value
    db.flush()
    return t


def _scan(db, t, lic, cases, user):
    """Scan a pallet the way production does — each scan re-reads the transfer,
    so scheduled-order picks that land on receipt-pinned drift sub-lines
    accumulate. Flush pending writes and expire the session first, else the
    reused `t` object hides prior scans' sub-lines and the product looks
    under-picked forever."""
    db.flush()
    db.expire_all()
    return ship_out_service.scan_pick_v2(db, t, lic, cases, user)


# ---------------------------------------------------------------------------
# Hard stop when the ordered quantity is reached
# ---------------------------------------------------------------------------

def test_scheduled_scan_hard_stops_when_quantity_reached(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 200, days_old=5)
    _pallet(db_session, "p1", "P-1", "LOTA", "r-a", 50, days_old=5)
    _pallet(db_session, "p2", "P-2", "LOTA", "r-a", 50, days_old=5)
    _pallet(db_session, "p3", "P-3", "LOTA", "r-a", 50, days_old=5)
    db_session.commit()

    t = _scheduled(db_session, base["user"], "SCH-1", 100)

    assert _scan(db_session, t, "P-1", None, base["user"])["ok"] is True
    assert _scan(db_session, t, "P-2", None, base["user"])["ok"] is True

    # Product is now 100/100 — a third pallet is refused, nothing consumed.
    r3 = _scan(db_session, t, "P-3", None, base["user"])
    assert r3["ok"] is False
    assert r3["reject_reason"] == "line_complete"
    assert "Quantity reached" in r3["message"]

    p3 = db_session.query(PalletLicence).get("p3")
    assert p3.status == PalletStatus.IN_STOCK  # still on the floor
    assert "p3" not in (t.pallet_licence_ids or [])


# ---------------------------------------------------------------------------
# Overshoot pallet → confirm-then-split to the Partials rack
# ---------------------------------------------------------------------------

def test_scheduled_overshoot_prompts_partial_then_completes(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 200, days_old=5)
    _pallet(db_session, "p1", "P-1", "LOTA", "r-a", 50, days_old=5)
    _pallet(db_session, "p2", "P-2", "LOTA", "r-a", 50, days_old=5)
    db_session.commit()

    t = _scheduled(db_session, base["user"], "SCH-2", 80)

    assert _scan(db_session, t, "P-1", None, base["user"])["ok"] is True  # 50/80

    # P-2 has 50 cs but only 30 are needed → prompt a partial, consume nothing.
    r2 = _scan(db_session, t, "P-2", None, base["user"])
    assert r2["ok"] is False
    assert r2["needs_partial_confirm"] is True
    assert r2["suggested_partial_cases"] == 30
    p2 = db_session.query(PalletLicence).get("p2")
    assert p2.status == PalletStatus.IN_STOCK and p2.cases == 50  # untouched

    # Forklift confirms → pull 30, move the remaining 20 to the Partials rack.
    r2c = _scan(db_session, t, "P-2", 30, base["user"])
    assert r2c["ok"] is True
    assert r2c["pick"]["was_partial"] is True
    assert r2c["partial_pallet_remaining"] == 20
    db_session.refresh(p2)
    assert p2.is_partial is True and p2.cases == 20
    assert p2.storage_row_id == "row-part"

    # Product is now 80/80 — the next pallet hard-stops.
    _pallet(db_session, "p3", "P-3", "LOTA", "r-a", 50, days_old=5)
    db_session.commit()
    r3 = _scan(db_session, t, "P-3", None, base["user"])
    assert r3["ok"] is False and r3["reject_reason"] == "line_complete"


def test_scheduled_exact_last_pallet_completes_without_prompt(db_session, base):
    """A pallet that exactly meets the remaining need pulls in full — no partial
    prompt, no overshoot."""
    _receipt(db_session, "r-a", "LOTA", 200, days_old=5)
    _pallet(db_session, "p1", "P-1", "LOTA", "r-a", 50, days_old=5)
    _pallet(db_session, "p2", "P-2", "LOTA", "r-a", 50, days_old=5)
    db_session.commit()

    t = _scheduled(db_session, base["user"], "SCH-4", 100)
    assert _scan(db_session, t, "P-1", None, base["user"])["ok"] is True
    r2 = _scan(db_session, t, "P-2", None, base["user"])
    assert r2["ok"] is True
    assert r2.get("needs_partial_confirm") in (False, None)
    assert r2["pick"]["was_partial"] is False  # whole pallet, exact finish


# ---------------------------------------------------------------------------
# Office / manual paths stay permissive
# ---------------------------------------------------------------------------

def test_office_select_pallet_bypasses_hard_stop(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 200, days_old=5)
    _pallet(db_session, "p1", "P-1", "LOTA", "r-a", 50, days_old=5)
    _pallet(db_session, "p2", "P-2", "LOTA", "r-a", 50, days_old=5)
    db_session.commit()

    t = _scheduled(db_session, base["user"], "SCH-3", 50)
    assert _scan(db_session, t, "P-1", None, base["user"])["ok"] is True  # 50/50

    # Gun would hard-stop here, but the office "Select pallets" path
    # (picked_via="manual_select") is allowed to over-ship for corrections.
    db_session.flush()
    db_session.expire_all()
    r2 = ship_out_service.select_pallet(db_session, t, "P-2", base["user"])
    assert r2["ok"] is True


# ---------------------------------------------------------------------------
# Multi-product scheduled orders must render as separate lines
# ---------------------------------------------------------------------------

def test_scheduled_two_products_render_as_separate_lines(db_session, base):
    """Regression: a scheduled order's planning lines are keyed line_seq=i*1000
    so the scanner view groups them by `line_seq // 1000`. A bare `i` (0,1,2)
    collapsed every product into group 0 — merging a 2-product order into one
    line (500+600=1,100) that never reads complete and never 'closes'."""
    guava = Product(id="p-guava", name="Organic Guava", category_id="cat-fg",
                    short_code="GUAVA", is_active=True, default_cases_per_pallet=50, expire_years=1)
    db_session.add(guava)
    db_session.commit()

    data = SimpleNamespace(
        order_number="SCH-MULTI",
        lines=[
            SimpleNamespace(product_id="p-mango", cases_requested=500),
            SimpleNamespace(product_id="p-guava", cases_requested=600),
        ],
        pallet_type_id=None, ship_to=None, carrier=None,
        scheduled_date=(datetime.now(timezone.utc).date()),
        appointment_time=None, po_number=None,
    )
    t = ship_out_service.create_scheduled_order(db_session, data, base["user"], "wh-a")
    db_session.flush()

    view = ship_out_service.scanner_view_for_transfer(db_session, t)
    by_product = {l["product_id"]: l for l in view["lines"]}

    # Two DISTINCT lines, each with its own ordered total — not one merged 1,100.
    assert set(by_product) == {"p-mango", "p-guava"}
    assert by_product["p-mango"]["cases_requested"] == 500
    assert by_product["p-guava"]["cases_requested"] == 600
