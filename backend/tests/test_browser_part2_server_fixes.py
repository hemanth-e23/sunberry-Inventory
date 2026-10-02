"""Browser test 2026-10-01, PART 2 — server-side findings.

B3  Activity Ledger (and Vendor Receipts / Movement Ledger / Lot Trace) counted
    a REJECTED delivery's paperwork quantity as received and on hand.
B4  Hold screens, approval cards and the Holds report showed one receipt's
    hold-time weight (5,688 lb) instead of the lot's current held amount
    (13 drums, 6,162 lb after a drum arrived while held).
B5  Hold cards / Lot Trace labelled the lot with the receipt's last-transfer
    room ("QA Quarantine") instead of where its racks are; Holds report
    LOCATION was "—".
B8  Transfer approval cards dropped the drum count on mixed-weight lots.
G2  Plant-to-plant transfer of lot-tracked stock is refused at initiation.
G4  Shipped Out needs a reason (return to vendor / sale / sample / other).
G5  Reports open to supervisors and admins, scoped to their own plant.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.enums import HoldStatus, ReceiptStatus, TransferStatus
from app.models import (
    Category,
    InventoryHoldAction,
    InventoryTransfer,
    Location,
    MaterialLot,
    Product,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import hold_service, receipt_service
from app.services import lot_status as lot_status_service
from app.services import report_builders as rb
from app.utils.auth import create_access_token, get_password_hash

WH = "wh-p2"
WH_OTHER = "wh-p2-other"
PRODUCT = "prod-p2-guava"
VENDOR = "vendor-p2"
ROW_D3 = "row-p2-d3"
ROW_D4 = "row-p2-d4"
ROW_Q1 = "row-p2-q1"
BBD = datetime(2028, 5, 3, tzinfo=timezone.utc)
TODAY = datetime.now(timezone.utc).date().isoformat()


class _Approver:
    id = "u-p2-approve"
    role = "admin"
    name = "Ada"


@pytest.fixture
def seed(db_session):
    db_session.add_all([
        Warehouse(id=WH, name="Plant P", code="PP", type="owned", is_active=True,
                  timezone="UTC"),
        Warehouse(id=WH_OTHER, name="Plant O", code="PO", type="owned", is_active=True,
                  timezone="UTC"),
    ])
    db_session.add(Category(id="cat-p2-raw", name="Raw", type="raw"))
    db_session.add(Product(id=PRODUCT, name="Guava Concentrate", category_id="cat-p2-raw"))
    db_session.add(Vendor(id=VENDOR, name="Vendor P"))
    db_session.add(Location(id="loc-p2", name="QA Barn", warehouse_id=WH))
    db_session.add_all([
        SubLocation(id="sub-p2-drum", name="QA Drum Room", location_id="loc-p2",
                    storage_unit="drum", unit_capacity=500),
        SubLocation(id="sub-p2-quar", name="QA Quarantine", location_id="loc-p2",
                    storage_unit="drum", unit_capacity=500),
    ])
    db_session.add_all([
        StorageRow(id=ROW_D3, name="QA-D3", sub_location_id="sub-p2-drum", pallet_capacity=0),
        StorageRow(id=ROW_D4, name="QA-D4", sub_location_id="sub-p2-drum", pallet_capacity=0),
        StorageRow(id=ROW_Q1, name="QA-Q1", sub_location_id="sub-p2-quar", pallet_capacity=0),
    ])
    pw = get_password_hash("pw")
    db_session.add_all([
        User(id="u-p2-wh", username="p2wh", name="Wanda", email="p2wh@x.test",
             hashed_password=pw, role="warehouse", warehouse_id=WH, is_active=True),
        User(id="u-p2-sup", username="p2sup", name="Sam", email="p2sup@x.test",
             hashed_password=pw, role="supervisor", warehouse_id=WH, is_active=True),
        User(id="u-p2-adm", username="p2adm", name="Al", email="p2adm@x.test",
             hashed_password=pw, role="admin", warehouse_id=WH, is_active=True),
        User(id="u-p2-approve", username="p2ada", name="Ada", email="p2ada@x.test",
             hashed_password=pw, role="admin", warehouse_id=WH, is_active=True),
        User(id="u-p2-super", username="p2super", name="Sue", email="p2super@x.test",
             hashed_password=pw, role="superadmin", is_active=True),
    ])
    db_session.commit()


def _headers(username):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': username})}"}


def _delivery(db, *, drums, row, per_drum=474.0, lot_number="B-0910",
              sub_location_id="sub-p2-drum", when=None):
    receipt = Receipt(
        id=f"rcpt-p2-{uuid.uuid4().hex[:10]}",
        product_id=PRODUCT, category_id="cat-p2-raw", vendor_id=VENDOR,
        lot_number=lot_number, expiration_date=BBD,
        quantity=drums * per_drum, unit="lbs",
        container_count=drums, container_unit="drums",
        weight_per_container=per_drum, weight_unit="lbs",
        warehouse_id=WH, status=ReceiptStatus.RECORDED,
        location_id="loc-p2", sub_location_id=sub_location_id,
        submitted_by="u-p2-wh",
        receipt_date=when or datetime.now(timezone.utc),
        raw_material_row_allocations=[{"rowId": row, "units": drums}],
    )
    db.add(receipt)
    db.flush()
    receipt_service.approve_receipt(db, receipt, _Approver())
    db.flush()
    return receipt


def _approved_hold(db, receipt, action="hold", reason="positive swab"):
    h = InventoryHoldAction(
        id=f"hold-p2-{uuid.uuid4().hex[:8]}", receipt_id=receipt.id, action=action,
        reason=reason, submitted_by="u-p2-wh", warehouse_id=WH, status=HoldStatus.PENDING,
    )
    db.add(h)
    db.flush()
    hold_service.approve_hold_action(db, h, _Approver())
    db.flush()
    return h


# ─────────────────────────────────────────────────────────────────────────────
# B3 — a rejected delivery is not stock
# ─────────────────────────────────────────────────────────────────────────────

class TestRejectedReceiptIsNotStock:
    @pytest.fixture
    def lots(self, db_session, seed):
        good = _delivery(db_session, drums=4, row=ROW_D3, per_drum=50.0, lot_number="D-0801")
        rejected = Receipt(
            id="rcpt-p2-rejected", product_id=PRODUCT, category_id="cat-p2-raw",
            vendor_id=VENDOR, lot_number="D-0801", quantity=150.0, unit="lbs",
            warehouse_id=WH, status=ReceiptStatus.REJECTED,
            material_lot_id=good.material_lot_id,  # a rejected truck line of the same lot
            receipt_date=datetime.now(timezone.utc), submitted_by="u-p2-wh",
        )
        db_session.add(rejected)
        db_session.commit()
        return good, rejected

    def test_activity_ledger_leaves_it_out(self, db_session, lots):
        out = rb.build_activity_ledger(db_session, start_date=TODAY, end_date=TODAY, tz="UTC")
        row = next(r for r in out["rows"] if r["product_id"] == PRODUCT)
        assert row["received"] == pytest.approx(200.0)
        assert row["current_on_hand"] == pytest.approx(200.0)
        assert row["receipts_count"] == 1

    def test_vendor_receipts_lists_it_but_does_not_total_it(self, db_session, lots):
        out = rb.build_vendor_receipts_report(db_session, warehouse_id=WH, tz="UTC")
        assert {r["receipt_id"] for r in out["rows"]} >= {"rcpt-p2-rejected"}
        assert out["by_vendor"]["Vendor P"] == {"receipts": 1, "quantity": 200.0}

    def test_movement_ledger_leaves_it_out(self, db_session, lots):
        out = rb.build_movement_ledger(db_session, product_id=PRODUCT, tz="UTC")
        receipts = [e for e in out["events"] if e["event_type"] == "Receipt"]
        assert len(receipts) == 1
        assert out["events"][-1]["running_balance"] == pytest.approx(200.0)

    def test_lot_trace_current_and_initial_leave_it_out(self, db_session, lots):
        out = rb.build_lot_trace(db_session, "D-0801", warehouse_id=WH)
        assert len(out["receipts"]) == 1
        lot = out["receipts"][0]
        assert lot["initial_quantity"] == pytest.approx(200.0)
        assert lot["current_quantity"] == pytest.approx(200.0)
        assert lot["status"] == ReceiptStatus.APPROVED
        rejected = [e for e in lot["timeline"] if "rejected" in e["event"]]
        assert rejected and rejected[0]["qty"] == 0

    def test_ledger_is_scoped_to_the_plant(self, db_session, lots):
        out = rb.build_activity_ledger(db_session, start_date=TODAY, end_date=TODAY,
                                       tz="UTC", warehouse_id=WH_OTHER)
        assert out["rows"] == []


# ─────────────────────────────────────────────────────────────────────────────
# B4 / B5 — the LOT's current held amount and racks
# ─────────────────────────────────────────────────────────────────────────────

class TestLotWideHoldFigures:
    @pytest.fixture
    def held(self, db_session, seed):
        first = _delivery(db_session, drums=9, row=ROW_D3)
        _delivery(db_session, drums=3, row=ROW_D4)
        hold = _approved_hold(db_session, first)
        # A drum arrives while the lot is held — the B-0910 case.
        late = _delivery(db_session, drums=1, row=ROW_D4, per_drum=474.0)
        # A transfer to quarantine (since moved back) left the receipt
        # labelled with the quarantine room — what the cards used to print.
        first.sub_location_id = "sub-p2-quar"
        db_session.commit()
        return first, late, hold

    def test_lot_status_is_lot_wide(self, db_session, held):
        first, late, _hold = held
        st = lot_status_service.lot_status(db_session, first)
        assert st["is_held"] is True
        assert st["units"] == 13 and st["held_units"] == 13
        assert st["held_quantity"] == pytest.approx(13 * 474.0)
        assert st["unit_label"] == "drum"
        assert st["location_label"] == "QA Drum Room: QA-D3, QA-D4"
        assert "Quarantine" not in st["location_label"]
        # The same answer from the late delivery's receipt.
        assert lot_status_service.lot_status(db_session, late)["held_units"] == 13

    def test_hold_action_stamps_what_it_covered(self, db_session, held):
        _first, _late, hold = held
        assert hold.total_quantity == pytest.approx(12 * 474.0)

    def test_hold_actions_api_carries_lot_status(self, client, db_session, held):
        resp = client.get("/api/inventory/hold-actions", headers=_headers("p2sup"))
        assert resp.status_code == 200, resp.text
        lot_hold = next(h for h in resp.json() if h["receipt_id"] == held[0].id)
        assert lot_hold["quantity_at_action"] == pytest.approx(12 * 474.0)
        assert lot_hold["lot_status"]["held_units"] == 13
        assert lot_hold["lot_status"]["location_label"] == "QA Drum Room: QA-D3, QA-D4"

    def test_held_lots_endpoint_one_entry_per_lot(self, client, db_session, held):
        resp = client.get("/api/inventory/hold-actions/held-lots", headers=_headers("p2wh"))
        assert resp.status_code == 200, resp.text
        lots = resp.json()
        assert len(lots) == 1
        assert lots[0]["held_units"] == 13
        assert lots[0]["hold_reason"] == "positive swab"

    def test_lot_status_endpoint(self, client, db_session, held):
        resp = client.get(f"/api/inventory/hold-actions/lot-status/{held[1].id}",
                          headers=_headers("p2wh"))
        assert resp.status_code == 200, resp.text
        assert resp.json()["held_quantity"] == pytest.approx(13 * 474.0)

    def test_holds_report_shows_history_and_now(self, db_session, held):
        out = rb.build_holds_report(db_session, warehouse_id=WH, tz="UTC")
        row = out["rows"][0]
        assert row["quantity_at_action"] == pytest.approx(12 * 474.0)
        assert row["current_held_units"] == 13
        assert row["current_held_quantity"] == pytest.approx(13 * 474.0)
        assert row["hold_location"] == "QA Drum Room: QA-D3, QA-D4"

    def test_release_clears_the_held_figure(self, db_session, held):
        first, _late, _hold = held
        _approved_hold(db_session, first, action="release", reason="retest clean")
        st = lot_status_service.lot_status(db_session, first)
        assert st["is_held"] is False and st["held_units"] == 0
        assert lot_status_service.held_lots(db_session, WH) == []

    def test_lot_trace_receive_line_names_the_put_away_room(self, db_session, held):
        out = rb.build_lot_trace(db_session, "B-0910", warehouse_id=WH)
        received = [e for e in out["receipts"][0]["timeline"] if e["event_type"] == "received"]
        assert received
        for ev in received:
            assert ev["to_location"] == "QA Barn › QA Drum Room"


# ─────────────────────────────────────────────────────────────────────────────
# B8 — drum count per source rack on a mixed-weight lot
# ─────────────────────────────────────────────────────────────────────────────

class TestTransferUnits:
    def _pending(self, db, receipt, lbs, row):
        tr = InventoryTransfer(
            id=f"transfer-p2-{uuid.uuid4().hex[:8]}", receipt_id=receipt.id,
            quantity=lbs, unit="lbs", transfer_type="warehouse-transfer",
            source_breakdown=[{"id": f"row-{row}", "quantity": lbs}],
            destination_breakdown=[{"id": f"row-{ROW_Q1}", "quantity": lbs}],
            requested_by="u-p2-wh", warehouse_id=WH, status=TransferStatus.PENDING,
        )
        db.add(tr)
        db.flush()
        return tr

    def test_mixed_rack_reads_whole_drums(self, db_session, seed):
        _delivery(db_session, drums=3, row=ROW_D4, per_drum=502.0, lot_number="A-0925",
                  when=datetime.now(timezone.utc) - timedelta(days=2))
        carrier = _delivery(db_session, drums=17, row=ROW_D4, per_drum=474.0,
                            lot_number="A-0925")
        three_502 = self._pending(db_session, carrier, 1506.0, ROW_D4)
        out = lot_status_service.transfer_units(db_session, three_502)
        assert out["container_units"] == 3
        assert out["container_unit"] == "drum"

        two_474 = self._pending(db_session, carrier, 948.0, ROW_D4)
        assert lot_status_service.transfer_units(db_session, two_474)["container_units"] == 2

    def test_api_response_carries_units(self, client, db_session, seed):
        carrier = _delivery(db_session, drums=9, row=ROW_D3, per_drum=474.0)
        tr = self._pending(db_session, carrier, 4266.0, ROW_D3)
        db_session.commit()
        resp = client.get("/api/inventory/transfers", headers=_headers("p2sup"))
        assert resp.status_code == 200, resp.text
        mine = next(t for t in resp.json() if t["id"] == tr.id)
        assert mine["container_units"] == 9
        assert mine["source_units"][0]["units"] == 9


# ─────────────────────────────────────────────────────────────────────────────
# G4 — a reason when material is shipped out
# ─────────────────────────────────────────────────────────────────────────────

class TestShipOutReason:
    def _payload(self, receipt, **extra):
        body = {
            "receipt_id": receipt.id, "quantity": 948.0, "unit": "lbs",
            "transfer_type": "shipped-out", "order_number": "RTV-QA-001",
            "source_breakdown": [{"id": f"row-{ROW_D3}", "quantity": 948.0}],
            "reason": "",
        }
        body.update(extra)
        return body

    def test_reason_is_required_for_rm(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inventory/transfers", json=self._payload(r),
                           headers=_headers("p2wh"))
        assert resp.status_code == 400
        assert "Return to vendor" in resp.json()["detail"]

    def test_unknown_reason_refused(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inventory/transfers",
                           json=self._payload(r, ship_out_reason="gift"),
                           headers=_headers("p2wh"))
        assert resp.status_code == 400

    def test_other_needs_notes(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inventory/transfers",
                           json=self._payload(r, ship_out_reason="other"),
                           headers=_headers("p2wh"))
        assert resp.status_code == 400
        ok = client.post("/api/inventory/transfers",
                         json=self._payload(r, ship_out_reason="other", reason="lab disposal"),
                         headers=_headers("p2wh"))
        assert ok.status_code == 200, ok.text

    def test_reason_stored_and_reported(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inventory/transfers",
                           json=self._payload(r, ship_out_reason="return_to_vendor",
                                              reason="swab failed"),
                           headers=_headers("p2wh"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ship_out_reason"] == "return_to_vendor"
        assert body["ship_out_reason_label"] == "Return to vendor"

        t = db_session.get(InventoryTransfer, body["id"])
        assert t.ship_out_reason == "return_to_vendor"
        # Reports read the approved record.
        t.status = TransferStatus.APPROVED
        t.approved_at = datetime.now(timezone.utc)
        t.approved_by = "u-p2-approve"
        db_session.commit()

        ship = rb.build_shipments_report(db_session, warehouse_id=WH, tz="UTC")
        row = next(x for x in ship["rows"] if x["transfer_id"] == t.id)
        assert row["ship_out_reason_label"] == "Return to vendor"
        assert row["notes"] == "swab failed"

        trace = rb.build_lot_trace(db_session, "B-0910", warehouse_id=WH)
        ev = next(e for e in trace["receipts"][0]["timeline"]
                  if e["event_type"] == "shipped-out")
        assert ev["ship_out_reason"] == "Return to vendor"

        ledger = rb.build_movement_ledger(db_session, product_id=PRODUCT, tz="UTC")
        out_ev = next(e for e in ledger["events"] if e["event_type"] == "Shipped Out")
        assert out_ev["notes"].startswith("Return to vendor")

    def test_warehouse_transfer_never_stores_a_reason(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        body = {
            "receipt_id": r.id, "quantity": 474.0, "unit": "lbs",
            "transfer_type": "warehouse-transfer", "ship_out_reason": "sale",
            "source_breakdown": [{"id": f"row-{ROW_D3}", "quantity": 474.0}],
            "destination_breakdown": [{"id": f"row-{ROW_Q1}", "quantity": 474.0}],
            "to_location_id": "loc-p2", "to_sub_location_id": "sub-p2-quar",
        }
        resp = client.post("/api/inventory/transfers", json=body, headers=_headers("p2wh"))
        assert resp.status_code == 200, resp.text
        assert resp.json()["ship_out_reason"] is None


# ─────────────────────────────────────────────────────────────────────────────
# G5 — reports for supervisors and admins, own plant only
# ─────────────────────────────────────────────────────────────────────────────

class TestReportAccess:
    @pytest.fixture
    def two_plants(self, db_session, seed):
        r = _delivery(db_session, drums=2, row=ROW_D3)
        _approved_hold(db_session, r)
        other = Receipt(
            id="rcpt-p2-other", product_id=PRODUCT, category_id="cat-p2-raw",
            lot_number="ELSEWHERE", quantity=10.0, unit="lbs", warehouse_id=WH_OTHER,
            status=ReceiptStatus.APPROVED, hold=True, held_quantity=10.0,
            receipt_date=datetime.now(timezone.utc),
        )
        db_session.add(other)
        db_session.add(InventoryHoldAction(
            id="hold-p2-other", receipt_id="rcpt-p2-other", action="hold", reason="x",
            submitted_by="u-p2-wh", warehouse_id=WH_OTHER, status=HoldStatus.APPROVED,
            approved_at=datetime.now(timezone.utc), approved_by="u-p2-super",
        ))
        db_session.commit()

    def test_warehouse_role_is_refused(self, client, two_plants):
        resp = client.get("/api/reports/holds", headers=_headers("p2wh"))
        assert resp.status_code == 403

    @pytest.mark.parametrize("username", ["p2sup", "p2adm"])
    def test_plant_roles_see_their_own_plant(self, client, two_plants, username):
        resp = client.get("/api/reports/holds", headers=_headers(username))
        assert resp.status_code == 200, resp.text
        lots = {r["lot_number"] for r in resp.json()["rows"]}
        assert lots == {"B-0910"}

        ledger = client.get("/api/reports/activity-ledger",
                            params={"start_date": TODAY, "end_date": TODAY},
                            headers=_headers(username))
        assert ledger.status_code == 200, ledger.text
        assert all(r["lot_numbers"] != ["ELSEWHERE"] for r in ledger.json()["rows"])

    def test_superadmin_sees_every_plant(self, client, two_plants):
        resp = client.get("/api/reports/holds", headers=_headers("p2super"))
        assert resp.status_code == 200, resp.text
        assert {r["lot_number"] for r in resp.json()["rows"]} == {"B-0910", "ELSEWHERE"}


# ─────────────────────────────────────────────────────────────────────────────
# G2 interim — lot-tracked stock refused at INITIATION of a plant-to-plant move
# ─────────────────────────────────────────────────────────────────────────────

class TestInterWarehouseInitiation:
    def _body(self, **extra):
        body = {"from_warehouse_id": WH, "to_warehouse_id": WH_OTHER,
                "product_id": PRODUCT, "quantity": 474.0, "unit": "lbs"}
        body.update(extra)
        return body

    def test_lot_tracked_refused_at_initiate(self, client, db_session, seed):
        _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inter-warehouse-transfers/", json=self._body(lot_number="B-0910"),
                           headers=_headers("p2super"))
        assert resp.status_code == 400
        assert "tracked by lot" in resp.json()["detail"]

    def test_named_lot_tracked_receipt_refused(self, client, db_session, seed):
        r = _delivery(db_session, drums=9, row=ROW_D3)
        db_session.commit()
        resp = client.post("/api/inter-warehouse-transfers/",
                           json=self._body(source_receipt_id=r.id),
                           headers=_headers("p2super"))
        assert resp.status_code == 400

    def test_legacy_stock_still_initiates(self, client, db_session, seed):
        db_session.add(Receipt(
            id="rcpt-p2-legacy", product_id=PRODUCT, category_id="cat-p2-raw",
            lot_number="OLD-1", quantity=1000.0, unit="lbs", warehouse_id=WH,
            status=ReceiptStatus.APPROVED, receipt_date=datetime.now(timezone.utc),
        ))
        db_session.commit()
        resp = client.post("/api/inter-warehouse-transfers/", json=self._body(lot_number="OLD-1"),
                           headers=_headers("p2super"))
        assert resp.status_code == 200, resp.text
