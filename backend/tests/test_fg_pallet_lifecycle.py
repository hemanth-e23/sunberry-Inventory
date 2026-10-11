"""FG pallet lifecycle (FG-PALLET-LIFECYCLE-SPEC.md, 2026-10-08).

Every correction is a status on a specific pallet with who/when/why, and no
pallet leaves the books without a record:

  §1.1 Moyel shuttle      §1.2 MISSING + found on a later scan
  §2.1 Not Produced needs a reason; a later scan is accepted
  §2.2/2.3 live-loaded pallets join the receipt; rows are not under-counted
  §2.4 "already shipped" names order / customer / date / scanner
  §3.1 gun gap check is lot-wide     §3.2 kiosk continues numbering
  §3.3 closing scan                  §4.1 gun cycle check + Find Pallet
  §4.2 ±N cases on one pallet        §5   pallet-based FG lot trace
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.enums import (
    AdjustmentStatus, ForkliftRequestStatus, PalletEventType, PalletStatus, ShipOutLifecycle,
)
from app.exceptions import ValidationError
from app.models import (
    ActiveLineProduction, Category, CycleCount, ForkliftRequest, InventoryAdjustment,
    InventoryTransfer, Location, PackageSize, PalletEvent, PalletLicence, Product,
    ProductionLine, Receipt, StorageArea, StorageRow, SubLocation, User, Warehouse,
)
from app.services import (
    active_production_service, bol_pdf_service, cycle_check_service, moyel_shuttle_service,
    scanner_service, ship_out_service,
)
from app.services.adjustment_service import approve_adjustment
from app.services.fg_lot_trace import build_fg_pallet_trace
from app.utils.auth import create_access_token, get_password_hash

LOT = "MP28026L1"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def fg(db_session):
    db = db_session
    db.add(Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True,
                     timezone="America/Detroit"))
    db.add(Category(id="cat-fg", name="Finished", type="finished"))
    db.add(PackageSize(id="ps-64", label="64 oz", case_weight=30.0))
    db.add(Product(id="p-mango", name="Mango", category_id="cat-fg", short_code="MANGO",
                   fcc_code="FCC-M", is_active=True, default_cases_per_pallet=40,
                   expire_years=1, package_size_id="ps-64"))
    db.add(ProductionLine(id="line-1", name="L1", warehouse_id="wh-a", is_active=True))
    db.add(Location(id="loc-1", name="Main", warehouse_id="wh-a"))
    db.add(SubLocation(id="sub-1", name="Sub", location_id="loc-1"))
    db.add(StorageArea(id="area-1", name="FG", location_id="loc-1", sub_location_id="sub-1"))
    for rid, name in (("row-1", "FG-01"), ("row-2", "FG-02"), ("dock-1", "DOCK 1")):
        db.add(StorageRow(id=rid, name=name, sub_location_id="sub-1", storage_area_id="area-1",
                          pallet_capacity=30, occupied_pallets=0, occupied_cases=0, is_active=True))
    db.add(StorageRow(id="row-part", name="PARTIALS", sub_location_id="sub-1", storage_area_id="area-1",
                      pallet_capacity=99, is_partial_pallet_location=True, is_active=True))
    users = {}
    for uid, role in (("fk-1", "forklift"), ("fk-2", "forklift"), ("clerk", "warehouse"),
                      ("sup", "supervisor")):
        u = User(id=uid, username=uid, name=uid.upper(), email=f"{uid}@p.com",
                 hashed_password=get_password_hash("pw"), role=role, is_active=True,
                 warehouse_id="wh-a")
        db.add(u)
        users[uid] = u
    db.commit()
    return users


def _receipt(db, rid="r-1", qty=120, lot=LOT):
    r = Receipt(id=rid, product_id="p-mango", category_id="cat-fg", lot_number=lot, quantity=qty,
                quantity_produced=qty, unit="cases", status="approved", cases_per_pallet=40,
                warehouse_id="wh-a")
    db.add(r)
    return r


def _pallet(db, seq, status=PalletStatus.IN_STOCK, row="row-1", receipt_id="r-1", cases=40,
            fr_id=None, lot=LOT):
    pl = PalletLicence(
        id=f"pl-{lot}-{seq}", licence_number=f"{lot}-MANGO-{seq:03d}", receipt_id=receipt_id,
        forklift_request_id=fr_id, product_id="p-mango", lot_number=lot, sequence=seq,
        cases=cases, status=status.value if hasattr(status, "value") else status,
        storage_row_id=row, storage_area_id="area-1" if row else None, warehouse_id="wh-a",
        is_held=False, is_deleted=False,
    )
    db.add(pl)
    if status == PalletStatus.IN_STOCK and row:
        r = db.query(StorageRow).get(row)
        r.occupied_pallets = (r.occupied_pallets or 0) + 1
        r.occupied_cases = (r.occupied_cases or 0) + cases
    return pl


def _session(db, user, status=ForkliftRequestStatus.SCANNING, fid="fr-1"):
    fr = ForkliftRequest(id=fid, product_id="p-mango", lot_number=LOT, cases_per_pallet=40,
                         status=status.value, scanned_by=user.id, warehouse_id="wh-a",
                         line_id="line-1", shift_id=None,
                         last_activity_at=datetime.now(timezone.utc))
    db.add(fr)
    return fr


def _row(db, rid):
    db.expire_all()
    return db.query(StorageRow).get(rid)


def _shift(db):
    from app.models import ProductionShift
    db.add(ProductionShift(id="shift-1", name="Day", is_active=True))
    db.flush()
    return "shift-1"


# ---------------------------------------------------------------------------
# §1.1 Moyel shuttle
# ---------------------------------------------------------------------------

def test_shuttle_ships_stock_pending_and_missing_numbers(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)                       # in stock, row-1
    _pallet(db, 2)                       # in stock, row-1
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    _pallet(db, 3, PalletStatus.PENDING, row="dock-1", receipt_id=None, fr_id=fr.id)
    _pallet(db, 5, PalletStatus.PENDING, row="dock-1", receipt_id=None, fr_id=fr.id)
    db.commit()

    avail = moyel_shuttle_service.available_for_product(db, "p-mango", "wh-a")
    labels = {r["licence_number"]: r["status_label"] for r in avail["pallets"]}
    assert labels[f"{LOT}-MANGO-001"] == "in stock"
    assert labels[f"{LOT}-MANGO-003"] == "waiting review"
    assert labels[f"{LOT}-MANGO-004"] == "never scanned"   # gap inside the open run

    t = moyel_shuttle_service.create_shuttle(
        db, trailer_number="T-12", seal_number="S-99", destination_id=None,
        pallet_ids=[f"pl-{LOT}-1", f"pl-{LOT}-3"], missing_licences=[f"{LOT}-MANGO-004"],
        warehouse_id="wh-a", current_user=fg["clerk"],
    )
    db.commit()

    assert t.transfer_type == "moyel-shuttle"
    for seq in (1, 3, 4):
        p = db.query(PalletLicence).filter(PalletLicence.licence_number == f"{LOT}-MANGO-{seq:03d}").one()
        assert p.status == PalletStatus.SHIPPED.value and p.transfer_id == t.id
    # In-stock pallet: row freed, receipt deducted. Pending pallet: neither.
    assert _row(db, "row-1").occupied_pallets == 1
    assert _row(db, "dock-1").occupied_pallets == 0
    assert db.query(Receipt).get("r-1").quantity == 40

    snap = t.document_snapshot
    assert snap["bol_number"] == "001"            # placeholder until the real numbering
    assert snap["carrier"] == "SUNBERRY"
    assert snap["ship_to"]["customer_name"] == "RMI WAREHOUSE"
    assert snap["order_rows"][0]["order_no"] == f"Lot: {LOT}"
    assert "Mango (FCC-M)" in snap["order_rows"][0]["info"]
    assert snap["pallet_count"] == 3 and snap["total_cases"] == 120
    assert snap["weight"]["product"] == 120 * 30.0
    fields = bol_pdf_service.build_field_values(snap)
    assert fields["orderNo1"] == f"Lot: {LOT}" and fields["bolNo"] == "001"
    assert bol_pdf_service.render_bol_pdf(snap)[:4] == b"%PDF"
    assert db.query(PalletEvent).filter(PalletEvent.event_type == PalletEventType.SHUTTLED.value).count() == 2
    assert db.query(PalletEvent).filter(PalletEvent.event_type == PalletEventType.CREATED_SHIPPED.value).count() == 1

    # The already-shipped message names the trailer.
    p1 = db.query(PalletLicence).get(f"pl-{LOT}-1")
    assert "Moyel shuttle trailer T-12" in scanner_service.plc.shipped_detail(db, p1)

    # Next day: the review shows the pallet on the trailer, and approval counts
    # the shipped + created pallets as produced without stocking them.
    fr = db.query(ForkliftRequest).get("fr-1")
    fr.shift_id = _shift(db)
    db.commit()
    res = scanner_service.approve_forklift_request(db, "fr-1", fg["sup"])
    db.expire_all()
    rec = db.query(Receipt).get(res["receipt_id"])
    assert rec.quantity == 40                     # only #005 entered stock
    assert rec.quantity_produced == 120           # #003 + #004 + #005
    assert db.query(PalletLicence).get(f"pl-{LOT}-3").status == PalletStatus.SHIPPED.value
    assert db.query(PalletLicence).get(f"pl-{LOT}-3").receipt_id == rec.id
    created = db.query(PalletLicence).filter(PalletLicence.licence_number == f"{LOT}-MANGO-004").one()
    assert created.receipt_id == rec.id
    assert _row(db, "dock-1").occupied_pallets == 1   # only #005


def test_shuttle_refuses_without_trailer_or_seal(db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    db_session.commit()
    with pytest.raises(ValidationError):
        moyel_shuttle_service.create_shuttle(
            db_session, trailer_number="", seal_number="S", destination_id=None,
            pallet_ids=[f"pl-{LOT}-1"], missing_licences=[], warehouse_id="wh-a",
            current_user=fg["clerk"])


def test_two_shuttles_both_print_placeholder_bol(db_session, fg):
    """Regression: the placeholder "001" was stored in the UNIQUE bol_number
    column, so the second shuttle ever made failed with a duplicate key."""
    _receipt(db_session)
    _pallet(db_session, 1)
    _pallet(db_session, 2)
    db_session.commit()
    made = []
    for seq, trailer in ((1, "T-A"), (2, "T-B")):
        t = moyel_shuttle_service.create_shuttle(
            db_session, trailer_number=trailer, seal_number="S", destination_id=None,
            pallet_ids=[f"pl-{LOT}-{seq}"], missing_licences=[], warehouse_id="wh-a",
            current_user=fg["clerk"])
        db_session.commit()
        made.append(t)
    for t in made:
        assert t.bol_number is None                       # column stays free for ship-out GSINs
        assert t.document_snapshot["bol_number"] == "001"  # printed placeholder
        assert moyel_shuttle_service.shuttle_summary(db_session, t)["bol_number"] == "001"


def test_shuttle_destinations_are_not_customer_ship_tos(client, db_session, fg):
    moyel_shuttle_service.ensure_default_destination(db_session)
    db_session.commit()
    h = {"Authorization": f"Bearer {create_access_token(data={'sub': 'clerk'})}"}
    r = client.get("/api/master-data/ship-to-locations", headers=h)
    assert r.status_code == 200, r.text
    assert "RMI WAREHOUSE" not in {x["customer_name"] for x in r.json()}


def test_shuttle_api_and_bol_reprint(client, db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    db_session.commit()
    h = {"Authorization": f"Bearer {create_access_token(data={'sub': 'clerk'})}"}
    r = client.post("/api/inventory/moyel-shuttle", headers=h, json={
        "trailer_number": "T1", "seal_number": "S1", "pallet_ids": [f"pl-{LOT}-1"]})
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    hist = client.get("/api/inventory/moyel-shuttle", headers=h).json()
    assert hist[0]["trailer_number"] == "T1" and hist[0]["pallets"] == 1
    pdf = client.get(f"/api/inventory/moyel-shuttle/{tid}/bol.pdf", headers=h)
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    fk = {"Authorization": f"Bearer {create_access_token(data={'sub': 'fk-1'})}"}
    assert client.get("/api/inventory/moyel-shuttle", headers=fk).status_code == 403


# ---------------------------------------------------------------------------
# §1.2 MISSING, found by a later scan
# ---------------------------------------------------------------------------

def _scheduled(db, user, order_number, cases):
    data = SimpleNamespace(
        order_number=order_number,
        lines=[SimpleNamespace(product_id="p-mango", cases_requested=cases)],
        pallet_type_id=None, ship_to=None, carrier=None,
        scheduled_date=datetime.now(timezone.utc).date(), appointment_time=None, po_number=None,
    )
    t = ship_out_service.create_scheduled_order(db, data, user, "wh-a")
    t.status = ShipOutLifecycle.SCANNING.value
    db.flush()
    return t


def test_missing_adjustment_then_found_at_ship_out(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2)
    db.commit()
    adj = InventoryAdjustment(id="adj-1", product_id="p-mango", adjustment_type="missing",
                              quantity=40, reason="Not on the rack", status="pending",
                              pallet_licence_ids=[f"pl-{LOT}-1"], submitted_by="clerk")
    db.add(adj)
    db.commit()
    approve_adjustment(db, adj, fg["sup"])
    db.commit()
    p1 = db.query(PalletLicence).get(f"pl-{LOT}-1")
    assert p1.status == PalletStatus.MISSING.value
    assert db.query(Receipt).get("r-1").quantity == 40
    assert _row(db, "row-1").occupied_pallets == 1
    ev = db.query(PalletEvent).filter(PalletEvent.event_type == "missing").one()
    assert ev.user_id == "sup" and ev.reason == "Not on the rack"

    t = _scheduled(db, fg["clerk"], "SO-9", 40)
    res = ship_out_service.scan_pick_v2(db, t, f"{LOT}-MANGO-001", None, fg["fk-1"])
    db.commit()
    assert res["ok"] is True
    assert res["message"].startswith("Found missing pallet — shipped")
    p1 = db.query(PalletLicence).get(f"pl-{LOT}-1")
    assert p1.status == PalletStatus.SHIPPED.value
    assert db.query(Receipt).get("r-1").quantity == 40   # restored +40, shipped −40
    assert _row(db, "row-1").occupied_pallets == 1       # added back, then released
    assert db.query(PalletEvent).filter(PalletEvent.event_type == "found").count() == 1


def test_forklift_scan_of_missing_pallet_finds_it_into_the_row(db_session, fg):
    db = db_session
    _receipt(db, qty=0)
    _pallet(db, 1, PalletStatus.MISSING, row="row-1")
    _session(db, fg["fk-1"])
    db.commit()
    res = scanner_service.scan_pallet(db, "fr-1", f"{LOT}-MANGO-001", "row-2", False, None, fg["fk-1"])
    assert res["status"] == "found"
    p = db.query(PalletLicence).get(f"pl-{LOT}-1")
    assert p.status == PalletStatus.IN_STOCK.value and p.storage_row_id == "row-2"
    assert p.forklift_request_id is None                 # not re-added as production
    assert db.query(Receipt).get("r-1").quantity == 40
    assert _row(db, "row-2").occupied_pallets == 1


# ---------------------------------------------------------------------------
# §2.1 Not Produced: reason required, later scan accepted
# ---------------------------------------------------------------------------

def test_not_produced_requires_reason_and_later_scan_is_accepted(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    _pallet(db, 1, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    _pallet(db, 3, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    db.commit()
    lic = f"{LOT}-MANGO-002"
    with pytest.raises(ValidationError):
        scanner_service.mark_not_produced(db, "fr-1", [lic], fg["sup"])
    with pytest.raises(ValidationError):
        scanner_service.mark_not_produced(db, "fr-1", [lic], fg["sup"], reason_code="other")
    out = scanner_service.mark_not_produced(db, "fr-1", [lic], fg["sup"], reason_code="qa_rejected")
    assert out["count"] == 1
    ev = db.query(PalletEvent).filter(PalletEvent.event_type == "not_produced").one()
    assert ev.reason_code == "qa_rejected" and ev.user_id == "sup"

    # A later session scans #002 after all: accepted, flagged, joins that session.
    _session(db, fg["fk-2"], fid="fr-2")
    db.commit()
    res = scanner_service.scan_pallet(db, "fr-2", lic, "row-1", False, None, fg["fk-2"])
    assert res["status"] == "scanned"
    assert "was marked Not Produced by SUP" in res["flag"]
    p = db.query(PalletLicence).filter(PalletLicence.licence_number == lic).one()
    assert p.status == PalletStatus.PENDING.value and p.forklift_request_id == "fr-2"
    assert p.cases == 40


def test_not_produced_api_requires_reason(client, db_session, fg):
    fr = _session(db_session, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    _pallet(db_session, 2, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    db_session.commit()
    from app.models import User as U
    db_session.add(U(id="adm", username="adm", name="Adm", email="a@p.com",
                     hashed_password=get_password_hash("pw"), role="admin", is_active=True,
                     warehouse_id="wh-a"))
    db_session.commit()
    h = {"Authorization": f"Bearer {create_access_token(data={'sub': 'adm'})}"}
    r = client.post("/api/scanner/requests/fr-1/mark-not-produced", headers=h,
                    json={"licence_numbers": [f"{LOT}-MANGO-001"]})
    assert r.status_code == 400
    r = client.post("/api/scanner/requests/fr-1/mark-not-produced", headers=h,
                    json={"licence_numbers": [f"{LOT}-MANGO-001"], "reason_code": "sticker_damaged"})
    assert r.status_code == 200 and r.json()["count"] == 1
    fr_json = client.get("/api/scanner/requests/fr-1", headers=h).json()
    note = [v for v in fr_json["pallet_notes"].values() if v.startswith("Not produced")]
    assert note and "sticker damaged" in note[0]


# ---------------------------------------------------------------------------
# §2.2 / §2.3 live load
# ---------------------------------------------------------------------------

def test_live_load_does_not_undercount_row_and_joins_receipt(db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2)            # row-1 now holds 2 counted pallets
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED, fid="fr-9")
    db.flush()
    _pallet(db, 1, PalletStatus.PENDING, row="row-1", receipt_id=None, fr_id=fr.id, lot="MP28126L1")
    db.commit()
    t = _scheduled(db, fg["clerk"], "SO-LL", 40)
    lic = "MP28126L1-MANGO-001"
    first = ship_out_service.scan_pick_v2(db, t, lic, None, fg["fk-2"])
    assert first["reject_reason"] == "live_load_needs_confirm"
    ok = ship_out_service.scan_pick_v2(db, t, lic, None, fg["fk-2"], allow_live_load=True)
    db.commit()
    assert ok["ok"] is True
    assert _row(db, "row-1").occupied_pallets == 2     # NOT 1 — the pending pallet was never counted

    fr = db.query(ForkliftRequest).get("fr-9")
    fr.shift_id = _shift(db)
    db.commit()
    # The review labels it as shipped on the order.
    from app.routers.scanner import _pallet_notes
    notes = _pallet_notes(db, fr)
    assert notes["pl-MP28126L1-1"].startswith("🚚 Shipped on SO-LL")
    res = scanner_service.approve_forklift_request(db, "fr-9", fg["sup"])
    db.expire_all()
    rec = db.query(Receipt).get(res["receipt_id"])
    assert rec.quantity_produced == 40 and rec.quantity == 0
    assert rec.status == "depleted"
    assert db.query(PalletLicence).get("pl-MP28126L1-1").receipt_id == rec.id
    assert _row(db, "row-1").occupied_pallets == 2
    # Reports: the live-loaded pallet's pick sits on a receipt-less line; once
    # approval attaches the pallet, the receipt's shipped and initial figures
    # must include it (they read 0 / 0 before).
    from app.services.report_builders import _shipped_cases_for_receipt, initial_receipt_qty
    assert _shipped_cases_for_receipt(db, rec.id) == 40
    assert initial_receipt_qty(rec, db) == 40


def test_submit_counts_shipped_pallets(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"])
    _pallet(db, 1, PalletStatus.SHIPPED, receipt_id=None, fr_id=fr.id)
    db.commit()
    assert scanner_service.submit_forklift_request(db, "fr-1")["status"] == "submitted"


# ---------------------------------------------------------------------------
# §2.4 already shipped detail
# ---------------------------------------------------------------------------

def test_already_shipped_message_names_order_and_scanner(db_session, fg):
    db = db_session
    _receipt(db, qty=40)
    _pallet(db, 1)
    db.commit()
    t = _scheduled(db, fg["clerk"], "SO-77", 40)
    assert ship_out_service.scan_pick_v2(db, t, f"{LOT}-MANGO-001", None, fg["fk-1"])["ok"]
    db.commit()
    t2 = _scheduled(db, fg["clerk"], "SO-78", 40)
    res = ship_out_service.scan_pick_v2(db, t2, f"{LOT}-MANGO-001", None, fg["fk-2"])
    assert res["ok"] is False
    assert "already shipped on order SO-77" in res["message"]
    assert "scanned by FK-1" in res["message"]


# ---------------------------------------------------------------------------
# §3.1 gap check lot-wide
# ---------------------------------------------------------------------------

def test_gun_gap_check_uses_whole_lot(db_session, fg):
    db = db_session
    other = _session(db, fg["fk-1"], fid="fr-a")
    for s in (1, 2, 3):
        _pallet(db, s, PalletStatus.PENDING, receipt_id=None, fr_id=other.id)
    _session(db, fg["fk-2"], fid="fr-b")
    db.commit()
    r4 = scanner_service.scan_pallet(db, "fr-b", f"{LOT}-MANGO-004", "row-1", False, None, fg["fk-2"])
    assert r4["gap_detected"] is False
    r7 = scanner_service.scan_pallet(db, "fr-b", f"{LOT}-MANGO-007", "row-1", False, None, fg["fk-2"])
    assert r7["gap_missing"] == [f"{LOT}-MANGO-005", f"{LOT}-MANGO-006"]


# ---------------------------------------------------------------------------
# §3.2 kiosk numbering
# ---------------------------------------------------------------------------

def test_kiosk_resumes_numbering_and_keeps_old_row_at_rollover(db_session, fg):
    db = db_session
    db.add(Product(id="p-guava", name="Guava", category_id="cat-fg", short_code="GUAVA",
                   is_active=True, default_cases_per_pallet=40))
    db.commit()
    a = active_production_service.new_active_row(db, "line-1", "p-mango", LOT, "sup")
    a.last_printed_seq = 12
    db.flush()
    a.is_active = False
    db.flush()
    b = active_production_service.new_active_row(db, "line-1", "p-guava", LOT, "sup")
    assert b.last_printed_seq == 0
    b.is_active = False
    db.flush()
    a2 = active_production_service.new_active_row(db, "line-1", "p-mango", LOT, "sup")
    assert a2.last_printed_seq == 12          # A → B → A continues at #13
    # A scanned pallet with a higher number than was printed also counts.
    _pallet(db, 15, PalletStatus.PENDING, receipt_id=None)
    db.flush()
    assert active_production_service.starting_seq(db, "line-1", LOT, "p-mango", exclude_id=a2.id) == 15

    # Midnight: the old row is kept with its number; a new row opens for today.
    a2.set_at = datetime.now(timezone.utc) - timedelta(days=2)
    db.flush()
    cur = active_production_service.ensure_today(db, a2, "America/Detroit")
    db.commit()
    assert cur is not a2 and cur.is_active and not a2.is_active
    assert a2.last_printed_seq == 12 and a2.lot_number == LOT
    assert cur.lot_number != LOT and cur.product_id == "p-mango"
    assert db.query(ActiveLineProduction).count() == 4


# ---------------------------------------------------------------------------
# §3.3 closing scan
# ---------------------------------------------------------------------------

def test_closing_scan_flags_numbers_after_last_scan(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"])
    for s in (1, 2, 3):
        _pallet(db, s, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    db.commit()
    out = scanner_service.record_closing_scan(db, "fr-1", fg["fk-1"], licence_number=f"{LOT}-MANGO-005")
    assert out["sequence"] == 5
    fr = db.query(ForkliftRequest).get("fr-1")
    assert fr.closing_scans[LOT]["sequence"] == 5
    assert scanner_service._unresolved_missing_for_fr(db, fr) == [f"{LOT}-MANGO-004", f"{LOT}-MANGO-005"]
    assert scanner_service.missing_after_last_scan(db, fr) == {
        f"{LOT}-MANGO": [f"{LOT}-MANGO-004", f"{LOT}-MANGO-005"]}
    assert scanner_service.closing_status_by_lot(fr) == {LOT: "closed"}

    with pytest.raises(ValidationError):
        scanner_service.record_closing_scan(db, "fr-1", fg["fk-1"], licence_number="MP99926L1-MANGO-001")

    scanner_service.record_closing_scan(db, "fr-1", fg["fk-1"], skipped=True, lot_number=LOT)
    fr = db.query(ForkliftRequest).get("fr-1")
    assert scanner_service.closing_status_by_lot(fr) == {LOT: "skipped"}
    assert scanner_service._unresolved_missing_for_fr(db, fr) == []


# ---------------------------------------------------------------------------
# §4.1 gun cycle check + Find Pallet
# ---------------------------------------------------------------------------

def test_cycle_check_marks_not_here_missing_and_records_count(db_session, fg):
    db = db_session
    _receipt(db, qty=120)
    _receipt(db, rid="r-2", qty=80, lot="MP28126L1")
    _pallet(db, 1)
    _pallet(db, 2)
    _pallet(db, 1, receipt_id="r-2", lot="MP28126L1")
    _pallet(db, 2, receipt_id="r-2", lot="MP28126L1")
    _pallet(db, 3, row="row-2")                  # system says row-2; it's really in row-1
    db.commit()
    contents = cycle_check_service.row_contents(db, "row-1")
    assert [(g["lot_number"], g["count"]) for g in contents["groups"]] == [(LOT, 2), ("MP28126L1", 2)]

    out = cycle_check_service.submit_row_check(
        db, row_id="row-1", scanned=[f"{LOT}-MANGO-001", f"{LOT}-MANGO-003"],
        not_here_pallet_ids=["pl-MP28126L1-1", "pl-MP28126L1-2"], confirmed=False,
        user=fg["fk-1"], warehouse_id="wh-a",
    )
    db.commit()
    assert out["status"] == "recorded"
    for pid in ("pl-MP28126L1-1", "pl-MP28126L1-2"):
        assert db.query(PalletLicence).get(pid).status == PalletStatus.MISSING.value
    assert db.query(Receipt).get("r-2").quantity == 0
    moved = db.query(PalletLicence).get(f"pl-{LOT}-3")
    assert moved.storage_row_id == "row-1"
    assert _row(db, "row-1").occupied_pallets == 3 and _row(db, "row-2").occupied_pallets == 0
    cc = db.query(CycleCount).one()
    assert cc.summary["kind"] == "gun_row_check" and cc.summary["not_here"] == 2
    by_lot = {i["lotNo"]: i for i in cc.items}
    assert by_lot["MP28126L1"]["actualQuantity"] == 0 and by_lot["MP28126L1"]["expectedQuantity"] == 2
    assert by_lot[LOT]["actualQuantity"] == 3

    # Shows on the Cycle Count report with the pallet numbers.
    from app.services.report_builders import build_cycle_count_report
    rep = build_cycle_count_report(db, warehouse_id="wh-a")
    row = [r for r in rep["rows"] if r.get("lot_number") == "MP28126L1"][0]
    assert row["system_count"] == 2 and row["actual_count"] == 0 and row["variance"] == -2
    assert "MP28126L1-MANGO-001" in row["notes"]


def test_cycle_check_confirms_more_than_five(db_session, fg):
    db = db_session
    _receipt(db, qty=240)
    for s in range(1, 7):
        _pallet(db, s)
    db.commit()
    ids = [f"pl-{LOT}-{s}" for s in range(1, 7)]
    out = cycle_check_service.submit_row_check(
        db, row_id="row-1", scanned=[], not_here_pallet_ids=ids, confirmed=False,
        user=fg["fk-1"], warehouse_id="wh-a")
    assert out["status"] == "needs_confirm" and out["not_here_count"] == 6
    db.rollback()
    assert db.query(PalletLicence).get(ids[0]).status == PalletStatus.IN_STOCK.value
    out = cycle_check_service.submit_row_check(
        db, row_id="row-1", scanned=[], not_here_pallet_ids=ids, confirmed=True,
        user=fg["fk-1"], warehouse_id="wh-a")
    assert out["status"] == "recorded"


def test_find_pallet_missing_found_and_never_existed(db_session, fg):
    db = db_session
    _receipt(db, qty=0)
    _pallet(db, 1, PalletStatus.MISSING)
    db.commit()
    info = cycle_check_service.find_pallet(db, f"{LOT}-MANGO-001")
    assert info["status"] == "missing" and info["actions"] == ["found_here"]
    after = cycle_check_service.find_pallet_action(
        db, licence=f"{LOT}-MANGO-001", action="found_here", row_id="row-2",
        user=fg["fk-1"], warehouse_id="wh-a")
    assert after["status"] == "in_stock" and after["row_name"] == "FG-02"
    assert after["history"][0]["event_type"] == "found"

    new = cycle_check_service.find_pallet(db, f"{LOT}-MANGO-009")
    assert new["exists"] is False and new["actions"] == ["create_here"]
    created = cycle_check_service.find_pallet_action(
        db, licence=f"{LOT}-MANGO-009", action="create_here", row_id="row-2",
        user=fg["fk-1"], warehouse_id="wh-a")
    assert created["status"] == "in_stock" and created["cases"] == 40
    assert created["history"][0]["event_type"] == "created_from_sticker"
    assert db.query(Receipt).get("r-1").quantity == 80


def test_cycle_check_api_open_to_forklift(client, db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    db_session.commit()
    h = {"Authorization": f"Bearer {create_access_token(data={'sub': 'fk-1'})}"}
    rows = client.get("/api/scanner/cycle-check/rows", headers=h)
    assert rows.status_code == 200 and {"FG-01", "DOCK 1"} <= {r["name"] for r in rows.json()}
    got = client.get("/api/scanner/cycle-check/rows/row-1", headers=h).json()
    assert got["groups"][0]["count"] == 1
    sub = client.post("/api/scanner/cycle-check/submit", headers=h,
                      json={"row_id": "row-1", "scanned": [f"{LOT}-MANGO-001"]})
    assert sub.status_code == 200 and sub.json()["status"] == "recorded"


# ---------------------------------------------------------------------------
# §4.2 case adjustments
# ---------------------------------------------------------------------------

def _case_adj(client, h, pallet_id, delta, reason="leaker_damaged"):
    return client.post("/api/inventory/adjustments", headers=h, json={
        "product_id": "p-mango", "adjustment_type": "case-adjustment", "reason": "Leaker",
        "pallet_licence_ids": [pallet_id],
        "source_breakdown": [{"case_delta": delta, "reason_code": reason}],
    })


def test_case_adjustment_minus_and_plus_and_to_zero(client, db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2)
    db.commit()
    clerk = {"Authorization": f"Bearer {create_access_token(data={'sub': 'clerk'})}"}
    sup = {"Authorization": f"Bearer {create_access_token(data={'sub': 'sup'})}"}

    assert _case_adj(client, clerk, f"pl-{LOT}-1", -5, reason="bogus").status_code == 400
    assert _case_adj(client, clerk, f"pl-{LOT}-1", -50).status_code == 400
    r = _case_adj(client, clerk, f"pl-{LOT}-1", -5)
    assert r.status_code == 200, r.text
    assert r.json()["quantity"] == 5
    assert client.post(f"/api/inventory/adjustments/{r.json()['id']}/approve", headers=sup).status_code == 200
    db.expire_all()
    p1 = db.query(PalletLicence).get(f"pl-{LOT}-1")
    assert p1.cases == 35 and p1.status == "in_stock" and p1.is_partial
    assert db.query(Receipt).get("r-1").quantity == 75
    assert _row(db, "row-1").occupied_cases == 75 and _row(db, "row-1").occupied_pallets == 2

    r = _case_adj(client, clerk, f"pl-{LOT}-1", 2, reason="count_correction")
    client.post(f"/api/inventory/adjustments/{r.json()['id']}/approve", headers=sup)
    db.expire_all()
    assert db.query(PalletLicence).get(f"pl-{LOT}-1").cases == 37
    assert db.query(Receipt).get("r-1").quantity == 77

    r = _case_adj(client, clerk, f"pl-{LOT}-2", -40, reason="qa_sample")
    client.post(f"/api/inventory/adjustments/{r.json()['id']}/approve", headers=sup)
    db.expire_all()
    p2 = db.query(PalletLicence).get(f"pl-{LOT}-2")
    assert p2.status == PalletStatus.EMPTIED.value and p2.cases == 0
    assert _row(db, "row-1").occupied_pallets == 1 and _row(db, "row-1").occupied_cases == 37
    evs = db.query(PalletEvent).filter(PalletEvent.event_type == "case_adjusted").all()
    assert {(e.cases_before, e.cases_after) for e in evs} == {(40, 35), (35, 37), (40, 0)}


# ---------------------------------------------------------------------------
# §4.2 an emptied pallet stays at 0: every scan refuses it, nothing revives it
# ---------------------------------------------------------------------------

def _empty(db, sup, seq, reason="Forklift tipped it"):
    adj = InventoryAdjustment(id=f"adj-e{seq}", product_id="p-mango", adjustment_type="case-adjustment",
                              quantity=40, reason=reason, status="pending", submitted_by="clerk",
                              pallet_licence_ids=[f"pl-{LOT}-{seq}"],
                              source_breakdown=[{"case_delta": -40, "reason_code": "leaker_damaged"}])
    db.add(adj)
    db.flush()
    approve_adjustment(db, adj, sup)
    db.commit()


def test_emptied_pallet_is_refused_by_every_scan_and_never_revived(client, db_session, fg):
    db = db_session
    _receipt(db, qty=80)
    _pallet(db, 1)
    _pallet(db, 2)
    _session(db, fg["fk-1"])
    db.commit()
    _empty(db, fg["sup"], 2)
    lic = f"{LOT}-MANGO-002"

    def state():
        db.expire_all()
        p = db.query(PalletLicence).get(f"pl-{LOT}-2")
        r = db.query(Receipt).get("r-1")
        row = db.query(StorageRow).get("row-1")
        return (p.status, p.cases, p.storage_row_id, r.quantity, r.quantity_produced, r.status,
                row.occupied_pallets, row.occupied_cases)

    # Same bookkeeping the 0-case branch always did — only the status differs.
    before = state()
    assert before == (PalletStatus.EMPTIED.value, 0, "row-1", 40, 80, "approved", 1, 40)

    def refused(msg):
        assert msg.startswith("#002 was emptied to 0 cases by SUP on "), msg
        assert "(Forklift tipped it)" in msg

    # Ship-out v2 (gun).
    t = _scheduled(db, fg["clerk"], "SO-E", 40)
    res = ship_out_service.scan_pick_v2(db, t, lic, None, fg["fk-1"])
    db.commit()
    assert res["ok"] is False
    refused(res["message"])

    # Ship-out v1 — even when it was on the pick list before it was emptied.
    db.add(InventoryTransfer(id="t-v1", quantity=40, transfer_type="shipped-out", status="pending",
                             pallet_licence_ids=[f"pl-{LOT}-2"], requested_by="clerk",
                             warehouse_id="wh-a"))
    db.commit()
    h = {"Authorization": f"Bearer {create_access_token(data={'sub': 'fk-1'})}"}
    v1 = client.post("/api/inventory/transfers/t-v1/scan-pick", headers=h, json={"licence_number": lic})
    assert v1.status_code == 200 and v1.json()["success"] is False
    refused(v1.json()["message"])

    # Forklift receipt scan: never re-used as a new pending pallet.
    with pytest.raises(ValidationError) as e:
        scanner_service.scan_pallet(db, "fr-1", lic, "row-2", False, None, fg["fk-1"])
    refused(str(e.value.message if hasattr(e.value, "message") else e.value))
    db.rollback()

    # Gun cycle check of the row it was in.
    out = cycle_check_service.submit_row_check(
        db, row_id="row-1", scanned=[f"{LOT}-MANGO-001", lic], not_here_pallet_ids=[],
        confirmed=False, user=fg["fk-1"], warehouse_id="wh-a")
    db.commit()
    [scan] = [x for x in out["summary"]["scans"] if x["licence_number"] == lic]
    assert scan["result"] == "emptied"
    refused(scan["message"])

    # Find Pallet: status, history, no actions; a forced action is refused.
    info = cycle_check_service.find_pallet(db, lic, "wh-a")
    assert info["status"] == "emptied" and info["actions"] == []
    refused(info["message"])
    assert info["history"][0]["event_type"] == "case_adjusted"
    for action in ("restore_here", "found_here", "move_here"):
        with pytest.raises(ValidationError):
            cycle_check_service.find_pallet_action(
                db, licence=lic, action=action, row_id="row-2", user=fg["fk-1"], warehouse_id="wh-a")
        db.rollback()

    # Moyel shuttle: not offered, not loadable as a "missing" number.
    avail = moyel_shuttle_service.available_for_product(db, "p-mango", "wh-a")["pallets"]
    assert lic not in {r["licence_number"] for r in avail}
    with pytest.raises(ValidationError):
        moyel_shuttle_service.create_shuttle(
            db, trailer_number="T1", seal_number="S1", destination_id=None, pallet_ids=[],
            missing_licences=[lic], warehouse_id="wh-a", current_user=fg["clerk"])
    db.rollback()

    assert state() == before
    assert db.query(PalletEvent).filter(
        PalletEvent.pallet_licence_id == f"pl-{LOT}-2",
        PalletEvent.event_type.in_(("revived", "found", "not_produced_scanned")),
    ).count() == 0


def test_emptied_pallet_counts_as_adjusted_and_covers_its_number(db_session, fg):
    db = db_session
    _receipt(db, qty=120)
    for s in (1, 2, 3):
        _pallet(db, s)
    db.commit()
    _empty(db, fg["sup"], 3)

    [g] = build_fg_pallet_trace(db, LOT, "wh-a")
    assert g["produced"] == {"pallets": 3, "cases": 120}
    assert (g["adjusted"]["pallets"], g["adjusted"]["cases"]) == (1, 40)
    assert (g["in_stock"]["pallets"], g["in_stock"]["cases"]) == (2, 80)
    assert g["balanced"] is True and g["books"]["on_hand_difference"] == 0

    # #3 existed: the next session's #4 is not a gap, and Not Produced can't
    # overwrite it.
    _session(db, fg["fk-2"], fid="fr-b")
    db.commit()
    r4 = scanner_service.scan_pallet(db, "fr-b", f"{LOT}-MANGO-004", "row-1", False, None, fg["fk-2"])
    assert r4["gap_detected"] is False
    from app.services.scanner_service import _COVERED_PALLET_STATUSES_FOR_GAPS
    from app.routers.scanner import _COVERED_PALLET_STATUSES
    assert PalletStatus.EMPTIED in _COVERED_PALLET_STATUSES_FOR_GAPS
    assert PalletStatus.EMPTIED in _COVERED_PALLET_STATUSES


# ---------------------------------------------------------------------------
# §5 pallet-based lot trace
# ---------------------------------------------------------------------------

def test_fg_lot_trace_balances_from_pallets(db_session, fg):
    db = db_session
    _receipt(db, qty=200)
    for s in range(1, 6):
        _pallet(db, s)
    db.commit()
    # 1 → order, 2 → shuttle, 3 → missing, 4 → −5 cases, 5 stays; 6 not produced.
    t = _scheduled(db, fg["clerk"], "SO-1", 40)
    assert ship_out_service.scan_pick_v2(db, t, f"{LOT}-MANGO-001", None, fg["fk-1"])["ok"]
    db.commit()
    moyel_shuttle_service.create_shuttle(
        db, trailer_number="T9", seal_number="S9", destination_id=None,
        pallet_ids=[f"pl-{LOT}-2"], missing_licences=[], warehouse_id="wh-a", current_user=fg["clerk"])
    cycle_check_service._mark_missing(db, db.query(PalletLicence).get(f"pl-{LOT}-3"),
                                      db.query(StorageRow).get("row-1"), fg["fk-1"], "cc-x")
    adj = InventoryAdjustment(id="adj-c", product_id="p-mango", adjustment_type="case-adjustment",
                              quantity=5, reason="leak", status="pending", submitted_by="clerk",
                              pallet_licence_ids=[f"pl-{LOT}-4"],
                              source_breakdown=[{"case_delta": -5, "reason_code": "leaker_damaged"}])
    db.add(adj)
    db.flush()
    approve_adjustment(db, adj, fg["sup"])
    _pallet(db, 6, PalletStatus.NOT_PRODUCED, receipt_id=None, cases=0)
    db.commit()

    [g] = build_fg_pallet_trace(db, LOT, "wh-a")
    assert g["produced"] == {"pallets": 5, "cases": 200}
    assert (g["shipped"]["pallets"], g["shipped"]["cases"]) == (1, 40)
    assert (g["shuttle"]["pallets"], g["shuttle"]["cases"]) == (1, 40)
    assert (g["missing"]["pallets"], g["missing"]["cases"]) == (1, 40)
    assert (g["adjusted"]["pallets"], g["adjusted"]["cases"]) == (0, 5)
    assert (g["in_stock"]["pallets"], g["in_stock"]["cases"]) == (2, 75)
    assert g["not_produced"]["pallets"] == 1
    assert g["balanced"] is True
    assert g["books"]["receipt_on_hand"] == 75 and g["books"]["on_hand_difference"] == 0
    assert g["shuttle"]["items"][0]["trailer_number"] == "T9"
    assert g["shipped"]["items"][0]["order_number"] == "SO-1"


# ---------------------------------------------------------------------------
# Security review 2026-10-08 — warehouse scoping, roles, input hygiene
# ---------------------------------------------------------------------------

def _other_plant(db):
    """A second warehouse with one row and one in-stock pallet."""
    db.add(Warehouse(id="wh-b", name="Plant B", code="PB", type="owned", is_active=True))
    db.add(Location(id="loc-b", name="B Main", warehouse_id="wh-b"))
    db.add(StorageArea(id="area-b", name="FG B", location_id="loc-b"))
    db.add(StorageRow(id="row-b", name="B-01", storage_area_id="area-b", pallet_capacity=10,
                      occupied_pallets=1, occupied_cases=40, is_active=True))
    db.add(PalletLicence(
        id="pl-b-1", licence_number="MP27726L1-MANGO-001", product_id="p-mango",
        lot_number="MP27726L1", sequence=1, cases=40, status="in_stock",
        storage_row_id="row-b", storage_area_id="area-b", warehouse_id="wh-b",
        is_held=False, is_deleted=False,
    ))
    db.commit()


def _h(uid):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': uid})}"}


def test_cycle_check_cannot_touch_another_warehouse(client, db_session, fg):
    _other_plant(db_session)
    h = _h("fk-1")
    assert client.get("/api/scanner/cycle-check/rows/row-b", headers=h).status_code == 404
    r = client.post("/api/scanner/cycle-check/submit", headers=h, json={
        "row_id": "row-b", "not_here_pallet_ids": ["pl-b-1"], "confirmed": True})
    assert r.status_code == 404
    found = client.get("/api/scanner/cycle-check/find", headers=h,
                       params={"licence_number": "MP27726L1-MANGO-001"}).json()
    assert found["status"] == "other_warehouse" and found["actions"] == [] and "row_name" not in found
    mv = client.post("/api/scanner/cycle-check/find", headers=h, json={
        "licence_number": "MP27726L1-MANGO-001", "action": "move_here", "row_id": "row-1"})
    assert mv.status_code == 400
    # Scanned during a row check in plant A: reported, not moved.
    sub = client.post("/api/scanner/cycle-check/submit", headers=h, json={
        "row_id": "row-1", "scanned": ["MP27726L1-MANGO-001"], "confirmed": True}).json()
    assert sub["summary"]["scans"][0]["result"] == "other_warehouse"
    db_session.expire_all()
    pl = db_session.query(PalletLicence).get("pl-b-1")
    assert pl.status == "in_stock" and pl.storage_row_id == "row-b"


def test_shuttle_only_accepts_offered_missing_numbers_and_cleans_text(db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    db_session.commit()
    with pytest.raises(ValidationError):   # not a gap of any open lot run
        moyel_shuttle_service.create_shuttle(
            db_session, trailer_number="T", seal_number="S", destination_id=None,
            pallet_ids=[], missing_licences=[f"{LOT}-MANGO-099"], warehouse_id="wh-a",
            current_user=fg["clerk"])
    db_session.rollback()
    t = moyel_shuttle_service.create_shuttle(
        db_session, trailer_number='T"9\r\nX-Evil: 1', seal_number="S\t1", destination_id=None,
        pallet_ids=[f"pl-{LOT}-1"], missing_licences=[], warehouse_id="wh-a",
        current_user=fg["clerk"])
    assert "\r" not in t.trailer_number and "\n" not in t.trailer_number
    assert t.seal_number == "S 1"
    name = moyel_shuttle_service.bol_filename(t)
    assert all(c.isalnum() or c in "._-" for c in name)


def test_adjustments_refuse_forklift_and_other_warehouse_pallets(client, db_session, fg):
    _receipt(db_session)
    _pallet(db_session, 1)
    _other_plant(db_session)
    body = {"adjustment_type": "case-adjustment", "pallet_licence_ids": [f"pl-{LOT}-1"],
            "reason": "x", "source_breakdown": [{"case_delta": -1, "reason_code": "qa_sample"}],
            "product_id": "p-mango"}
    assert client.post("/api/inventory/adjustments", headers=_h("fk-1"), json=body).status_code == 403
    cross = {"adjustment_type": "missing", "pallet_licence_ids": ["pl-b-1"], "reason": "x",
             "product_id": "p-mango"}
    r = client.post("/api/inventory/adjustments", headers=_h("clerk"), json=cross)
    assert r.status_code == 400 and "another warehouse" in r.json()["detail"]
    huge = {**body, "source_breakdown": [{"case_delta": 50000, "reason_code": "count_correction"}]}
    assert client.post("/api/inventory/adjustments", headers=_h("clerk"), json=huge).status_code == 400
