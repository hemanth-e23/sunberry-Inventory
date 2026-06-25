"""
Service-level tests for the ship-out soft-totals work (Phases A–D):

  A. Remove-a-scan: wrong_pallet fully reverses; leaker_damaged raises a hold.
  B. Soft cap + advisory FIFO: over-pulls and off-plan lots are accepted, not
     rejected; whole pallets are pulled by default.
  C. Reversible lot picker: retarget to a lot and back works (no dead-end).
  D. Product-level reservation pool: capacity is checked per product, and a
     second order can't over-reserve the shared pool.
"""
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

import pytest

from app.models import (
    User, Warehouse, Category, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, PalletLicence, InventoryHoldAction,
    InventoryTransfer, InventoryTransferLine,
)
from app.models.inventory import ShipOutLotReservation
from app.utils.auth import get_password_hash
from app.enums import PalletStatus, TransferStatus
from app.exceptions import ValidationError
from app.services import ship_out_service


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
    db_session.add_all([wh, cat, mango, user, loc, subloc, area, row])
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


def _line(product_id, cases, allocs):
    return SimpleNamespace(
        product_id=product_id, cases_requested=cases,
        lot_allocations=[SimpleNamespace(lot_number=l, cases_requested=c) for l, c in allocs],
    )


def _order(db, user, order_number, lines):
    data = SimpleNamespace(order_number=order_number, lines=lines)
    return ship_out_service.create_pick_list_v2(db, data, user, "wh-a")


# ---------------------------------------------------------------------------
# B. Soft cap + advisory FIFO
# ---------------------------------------------------------------------------

def test_overpull_on_complete_lot_accepted(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 100, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pa2", "PA-2", "LOTA", "r-a", 50, days_old=10)
    db_session.commit()

    t = _order(db_session, base["user"], "ORD-1", [_line("p-mango", 50, [("LOTA", 50)])])

    r1 = ship_out_service.scan_pick_v2(db_session, t, "PA-1", None, base["user"])
    assert r1["ok"] is True and r1["is_overage"] is False

    # Lot is now fully picked; scanning a 2nd LOTA pallet used to be rejected
    # (LINE_COMPLETE) — now it's accepted as an over-pull.
    r2 = ship_out_service.scan_pick_v2(db_session, t, "PA-2", None, base["user"])
    assert r2["ok"] is True
    assert r2["is_overage"] is True


def test_wrong_lot_accepted_with_hint(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _receipt(db_session, "r-b", "LOTB", 50, days_old=1)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pb1", "PB-1", "LOTB", "r-b", 50, days_old=1)
    db_session.commit()

    t = _order(db_session, base["user"], "ORD-2", [_line("p-mango", 50, [("LOTA", 50)])])

    # LOTB isn't on the plan — used to be WRONG_LOT_NEEDS_SWAP reject; now accepted.
    r = ship_out_service.scan_pick_v2(db_session, t, "PB-1", None, base["user"])
    assert r["ok"] is True
    assert r["lot_hint"] is not None


# ---------------------------------------------------------------------------
# A. Remove-a-scan
# ---------------------------------------------------------------------------

def test_unscan_wrong_pallet_restores_stock(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    db_session.commit()
    t = _order(db_session, base["user"], "ORD-3", [_line("p-mango", 50, [("LOTA", 50)])])

    ship_out_service.scan_pick_v2(db_session, t, "PA-1", None, base["user"])
    pl = db_session.query(PalletLicence).get("pa1")
    assert pl.status == PalletStatus.SHIPPED
    assert db_session.query(Receipt).get("r-a").quantity == 0

    out = ship_out_service.unscan_pick_v2(db_session, t, "pa1", "wrong_pallet", base["user"])
    assert out["ok"] is True and out["hold_created"] is False
    db_session.refresh(pl)
    assert pl.status == PalletStatus.IN_STOCK
    assert pl.is_held is False
    assert db_session.query(Receipt).get("r-a").quantity == 50
    # Pick removed from the line.
    assert all(not ln.picks for ln in t.lines)


def test_unscan_leaker_raises_hold(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    db_session.commit()
    t = _order(db_session, base["user"], "ORD-4", [_line("p-mango", 50, [("LOTA", 50)])])

    ship_out_service.scan_pick_v2(db_session, t, "PA-1", None, base["user"])
    out = ship_out_service.unscan_pick_v2(db_session, t, "pa1", "leaker_damaged", base["user"])
    assert out["ok"] is True and out["hold_created"] is True
    db_session.flush()  # session is autoflush=False; make the new hold visible

    holds = db_session.query(InventoryHoldAction).filter(
        InventoryHoldAction.action == "hold", InventoryHoldAction.status == "pending",
    ).all()
    assert any("pa1" in (h.pallet_licence_ids or []) for h in holds)
    # Pallet is back in stock (hold flips is_held only on supervisor approval).
    pl = db_session.query(PalletLicence).get("pa1")
    assert pl.status == PalletStatus.IN_STOCK


def test_unscan_partial_pull_rejected(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    # partial-pallet destination row required for a partial pull
    db_session.add(StorageRow(id="row-part", name="PARTIALS", sub_location_id="subloc-1",
                              storage_area_id="area-1", pallet_capacity=99,
                              is_partial_pallet_location=True, is_active=True))
    db_session.commit()
    t = _order(db_session, base["user"], "ORD-5", [_line("p-mango", 30, [("LOTA", 30)])])

    # Explicit partial pull of 30 from the 50-case pallet.
    ship_out_service.scan_pick_v2(db_session, t, "PA-1", 30, base["user"])
    with pytest.raises(ValidationError, match="Partial pulls"):
        ship_out_service.unscan_pick_v2(db_session, t, "pa1", "wrong_pallet", base["user"])


# ---------------------------------------------------------------------------
# C. Reversible lot picker
# ---------------------------------------------------------------------------

def test_retarget_lot_and_back(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _receipt(db_session, "r-b", "LOTB", 50, days_old=1)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pb1", "PB-1", "LOTB", "r-b", 50, days_old=1)
    db_session.commit()
    t = _order(db_session, base["user"], "ORD-6", [_line("p-mango", 50, [("LOTA", 50)])])
    line_id = t.lines[0].id

    def open_lots():
        # Query lines fresh — retarget can add a new sub-line, and t.lines is
        # a cached relationship under the autoflush=False test session.
        lines = db_session.query(InventoryTransferLine).filter(
            InventoryTransferLine.transfer_id == t.id
        ).all()
        out = set()
        for ln in lines:
            for a in (ln.lot_allocations or []):
                if float(a.get("cases_requested") or 0) - float(a.get("cases_picked") or 0) > 0:
                    out.add(a.get("lot_number"))
        return out

    assert open_lots() == {"LOTA"}
    ship_out_service.retarget_lot(db_session, t, line_id, "LOTA", "LOTB", "blocked", base["user"])
    assert open_lots() == {"LOTB"}
    # Reload t.lines (prod re-queries the transfer per request; the test reuses
    # the same object, whose relationship is stale after a sub-line was added).
    db_session.expire(t)
    # Going back is just selecting the original lot again — not blocked.
    ship_out_service.retarget_lot(db_session, t, line_id, "LOTB", "LOTA", "back", base["user"])
    assert "LOTA" in open_lots()

    # The picker lists ALL lots, oldest recommended.
    view = ship_out_service.available_lots_for_line(db_session, t, line_id)
    lots = {l["lot_number"]: l for l in view["lots"]}
    assert "LOTA" in lots and "LOTB" in lots
    assert lots["LOTA"]["is_recommended"] is True  # oldest


# ---------------------------------------------------------------------------
# D. Product-level reservation pool
# ---------------------------------------------------------------------------

def test_reservations_are_product_level(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 50, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    db_session.commit()
    t = _order(db_session, base["user"], "ORD-7", [_line("p-mango", 50, [("LOTA", 50)])])

    res = db_session.query(ShipOutLotReservation).filter(
        ShipOutLotReservation.transfer_line_id.in_([ln.id for ln in t.lines])
    ).all()
    assert res and all(r.lot_number is None for r in res)  # product-level, not lot-pinned
    assert sum(r.cases_reserved for r in res) == 50


def test_picks_on_retargeted_lot_credit_product_total(db_session, base):
    """Regression for order 06-12530 ("640 of 960").

    After a lot change, picks can land on a sub-line whose cases_requested is 0
    (the lot that was retargeted away, scanned anyway because that's what was on
    the floor). Remaining must be the PRODUCT-level max(0, Σrequested − Σpicked),
    not the sum of per-lot clamped remainders — otherwise those picks are clamped
    away and the order looks under-picked forever, blocking the forklift.
    """
    _receipt(db_session, "r-a", "LOTA", 100, days_old=10)
    _receipt(db_session, "r-b", "LOTB", 100, days_old=1)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pa2", "PA-2", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pb1", "PB-1", "LOTB", "r-b", 50, days_old=1)
    _pallet(db_session, "pb2", "PB-2", "LOTB", "r-b", 50, days_old=1)
    db_session.commit()

    t = _order(db_session, base["user"], "ORD-10", [_line("p-mango", 100, [("LOTA", 100)])])
    line_id = t.lines[0].id

    # Move the whole plan LOTA → LOTB before any pick: LOTA alloc now requested 0.
    ship_out_service.retarget_lot(db_session, t, line_id, "LOTA", "LOTB", "blocked", base["user"])
    db_session.expire(t)

    # Forklift pulls one pallet of EACH lot: 50 from LOTA (lands on the
    # requested=0 alloc) + 50 from LOTB. Product is now fully picked: 100/100.
    ship_out_service.scan_pick_v2(db_session, t, "PA-1", None, base["user"])
    ship_out_service.scan_pick_v2(db_session, t, "PB-1", None, base["user"])
    db_session.expire(t)

    fresh = db_session.query(InventoryTransfer).get(t.id)
    view = ship_out_service.scanner_view_for_transfer(db_session, fresh)
    mango_line = next(l for l in view["lines"] if l["product_id"] == "p-mango")

    # The fix: product-level remaining is 0 (not the buggy 50 from clamping the
    # LOTA over-pick away while LOTB still shows 50 outstanding).
    assert mango_line["cases_remaining"] == 0
    assert sum(l["cases_remaining"] for l in view["lines"]) == 0  # order shows DONE

    # Product is complete, so only already-picked pallets surface (for Remove);
    # the fresh PA-2 / PB-2 are hidden so the forklift can't keep over-pulling.
    shown = [p for lot in mango_line["lots"] for row in lot["rows"] for p in row["pallets"]]
    assert shown and all(p["is_picked"] for p in shown)


def test_retargeted_away_lot_stays_scannable_until_product_done(db_session, base):
    """While the product still owes cases, a lot that was retargeted away (its
    alloc requested=0) must keep surfacing its fresh pallets — so the forklift
    can fulfill from whatever lot is physically on the floor. This is the
    unblock half of the 06-12530 fix."""
    _receipt(db_session, "r-a", "LOTA", 100, days_old=10)
    _receipt(db_session, "r-b", "LOTB", 100, days_old=1)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pa2", "PA-2", "LOTA", "r-a", 50, days_old=10)
    _pallet(db_session, "pb1", "PB-1", "LOTB", "r-b", 50, days_old=1)
    db_session.commit()

    t = _order(db_session, base["user"], "ORD-11", [_line("p-mango", 100, [("LOTA", 100)])])
    line_id = t.lines[0].id
    ship_out_service.retarget_lot(db_session, t, line_id, "LOTA", "LOTB", "blocked", base["user"])
    db_session.expire(t)

    # Only 50 picked so far — product still owes 50.
    ship_out_service.scan_pick_v2(db_session, t, "PB-1", None, base["user"])
    db_session.expire(t)

    fresh = db_session.query(InventoryTransfer).get(t.id)
    view = ship_out_service.scanner_view_for_transfer(db_session, fresh)
    mango_line = next(l for l in view["lines"] if l["product_id"] == "p-mango")
    assert mango_line["cases_remaining"] == 50

    # The fresh, un-picked LOTA pallet (PA-1) is still offered even though LOTA's
    # alloc was retargeted to requested=0 — old per-lot gating would have hidden it.
    fresh_lots = {
        p["lot_number"]
        for lot in mango_line["lots"] for row in lot["rows"] for p in row["pallets"]
        if not p["is_picked"]
    }
    assert "LOTA" in fresh_lots


def test_second_order_cannot_over_reserve_product_pool(db_session, base):
    _receipt(db_session, "r-a", "LOTA", 60, days_old=10)
    _pallet(db_session, "pa1", "PA-1", "LOTA", "r-a", 50, days_old=10)
    db_session.commit()  # only 50 physical cases in stock

    _order(db_session, base["user"], "ORD-8", [_line("p-mango", 50, [("LOTA", 50)])])
    # Second order for the same product has no pool left.
    with pytest.raises(ValidationError, match="available"):
        _order(db_session, base["user"], "ORD-9", [_line("p-mango", 50, [("LOTA", 50)])])
