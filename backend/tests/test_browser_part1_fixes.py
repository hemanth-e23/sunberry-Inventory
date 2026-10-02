"""Browser test 2026-10-01, PART 1 — findings F3, F4, F6, F8, F9.

F3  Reports cut the day at UTC midnight, so a truck received at 8:13 PM
    Eastern fell into "tomorrow". Day boundaries are now the warehouse's.
F4  Save & Resubmit on a sent-back receipt rewrote receipt_date to midnight
    UTC of the day — the previous evening in Eastern.
F6  Typing a room created a hidden default row that stayed pickable, printable
    and visible after the room got real racks.
F8  A finished truck line could not be rejected (the gun no longer had the
    truck to undo scans on). Reject now reverses the scans through the ledger.
F9  Receipts carried the paperwork quantity until approval although the
    scanned stock was already live. Finish books the scanned count.
"""
from datetime import date, datetime, timezone

import pytest

from app.enums import ReceiptStatus
from app.exceptions import ValidationError
from app.models import (
    Location,
    LotPlacement,
    LotPlacementEvent,
    MaterialLot,
    Receipt,
    StorageArea,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import ingredient_row_service
from app.services import lot_placement_service as lps
from app.services import lot_receiving_service as lrs
from app.services import receipt_service
from app.services import report_builders as rb
from app.utils.auth import create_access_token

from tests.test_lot_receiving import (  # noqa: F401  (fixture import)
    PRODUCT,
    ROW_1,
    ROW_2,
    USER,
    WH,
    recv_seed,
)
from tests.test_truck_receiving import _approver, _line, _lot_code, _scan, _truck

EASTERN = "America/New_York"
# 2026-10-01 20:13 EDT — after UTC midnight, still 10/1 at the plant.
EVENING_RECEIPT = datetime(2026, 10, 2, 0, 13, tzinfo=timezone.utc)


# ─────────────────────────────────────────────────────────────────────────────
# F3 — report day boundaries
# ─────────────────────────────────────────────────────────────────────────────

class TestReportDayIsTheWarehouseDay:
    def test_day_bounds_are_local_midnight_to_local_midnight(self):
        assert rb.parse_dt_start("2026-10-01", EASTERN) == datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)
        end = rb.parse_dt_end("2026-10-01", EASTERN)
        assert end < datetime(2026, 10, 2, 4, 0, tzinfo=timezone.utc)
        assert end > EVENING_RECEIPT
        # Winter: EST is UTC-5.
        assert rb.parse_dt_start("2026-12-01", EASTERN) == datetime(2026, 12, 1, 5, 0, tzinfo=timezone.utc)

    def test_calendar_filters_are_not_shifted(self):
        assert rb.parse_calendar_start("2026-10-01") == datetime(2026, 10, 1, tzinfo=timezone.utc)

    @pytest.fixture
    def evening(self, db_session):
        db_session.add(Warehouse(id="wh-tz", name="Plant TZ", code="TZ", type="owned",
                                 timezone=EASTERN, is_active=True))
        db_session.add(Vendor(id="v-tz", name="QA Chem Supply"))
        db_session.add_all([
            Receipt(id="r-morning", product_id=None, quantity=2000.0, unit="lbs",
                    vendor_id="v-tz", warehouse_id="wh-tz", status=ReceiptStatus.APPROVED,
                    receipt_date=datetime(2026, 10, 1, 14, 0, tzinfo=timezone.utc)),
            Receipt(id="r-evening", product_id=None, quantity=750.0, unit="lbs",
                    vendor_id="v-tz", warehouse_id="wh-tz", status=ReceiptStatus.APPROVED,
                    receipt_date=EVENING_RECEIPT),
        ])
        db_session.commit()

    def test_vendor_receipts_counts_an_8pm_receipt_on_its_own_day(self, db_session, evening):
        out = rb.build_vendor_receipts_report(
            db_session, warehouse_id="wh-tz", start_date="2026-10-01", end_date="2026-10-01",
        )
        assert {r["receipt_id"] for r in out["rows"]} == {"r-morning", "r-evening"}
        assert out["by_vendor"]["QA Chem Supply"] == {"receipts": 2, "quantity": 2750.0, "remaining": 2750.0}

        tomorrow = rb.build_vendor_receipts_report(
            db_session, warehouse_id="wh-tz", start_date="2026-10-02", end_date="2026-10-02",
        )
        assert tomorrow["rows"] == []

    def test_activity_ledger_and_point_in_time_use_the_local_day(self, db_session, evening):
        db_session.add(User(id="u-tz", username="tzuser", name="TZ", email="tz@x.com",
                            hashed_password="x", role="supervisor", warehouse_id="wh-tz",
                            is_active=True))
        db_session.commit()
        ledger_ids = {
            r.id for r in db_session.query(Receipt).filter(
                Receipt.receipt_date >= rb.parse_dt_start("2026-10-01", EASTERN),
                Receipt.receipt_date <= rb.parse_dt_end("2026-10-01", EASTERN),
            )
        }
        assert ledger_ids == {"r-morning", "r-evening"}

        snap = rb.build_point_in_time_snapshot(db_session, as_of_date="2026-10-01",
                                               warehouse_id="wh-tz")
        assert {r["receipt_id"] for r in snap["rows"]} == {"r-morning", "r-evening"}

    def test_the_router_uses_the_viewers_warehouse(self, client, db_session, evening):
        user = User(id="u-tz2", username="tzsup", name="TZ Sup", email="tzsup@x.com",
                    hashed_password="x", role="supervisor", warehouse_id="wh-tz",
                    is_active=True)
        db_session.add(user)
        db_session.commit()
        headers = {"Authorization": f"Bearer {create_access_token(data={'sub': 'tzsup'})}"}
        resp = client.get("/api/reports/vendor-receipts",
                          params={"start_date": "2026-10-01", "end_date": "2026-10-01"},
                          headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["by_vendor"]["QA Chem Supply"]["receipts"] == 2

    def test_report_timezone_falls_back_sensibly(self, db_session):
        assert rb.report_timezone(db_session) == rb.DEFAULT_REPORT_TIMEZONE
        db_session.add(Warehouse(id="wh-ch", name="C", code="CH", type="owned",
                                 timezone="America/Chicago", is_active=True))
        db_session.commit()
        # The only warehouse decides when no warehouse is given.
        assert rb.report_timezone(db_session) == "America/Chicago"
        assert rb.report_timezone(db_session, "wh-ch") == "America/Chicago"

    def test_expiry_days_are_calendar_days(self, db_session, monkeypatch):
        db_session.add(Warehouse(id="wh-tz", name="Plant TZ", code="TZ", type="owned",
                                 timezone=EASTERN, is_active=True))
        db_session.add(Receipt(id="r-exp", product_id=None, quantity=10.0, unit="lbs",
                               warehouse_id="wh-tz", status=ReceiptStatus.APPROVED,
                               expiration_date=datetime(2026, 10, 2, tzinfo=timezone.utc)))
        db_session.commit()
        monkeypatch.setattr(rb, "local_today", lambda tz=None: date(2026, 10, 1))
        row = rb.build_expiry_alerts(db_session, warehouse_id="wh-tz")["rows"][0]
        assert row["days_until_expiry"] == 1
        assert row["urgency_bucket"] == "0-30 days"


# ─────────────────────────────────────────────────────────────────────────────
# F4 — resubmitting a corrected receipt keeps the received time
# ─────────────────────────────────────────────────────────────────────────────

class TestCorrectionKeepsReceivedTime:
    ORIGINAL = datetime(2026, 10, 2, 0, 12, tzinfo=timezone.utc)   # 10/1 8:12 PM EDT

    @pytest.fixture
    def sent_back(self, db_session, test_user, seed_data):
        db_session.add(Warehouse(id="wh-tz", name="Plant TZ", code="TZ", type="owned",
                                 timezone=EASTERN, is_active=True))
        db_session.add(Receipt(
            id="r-sent-back", product_id="product-1", category_id="raw-sunberry",
            quantity=100.0, unit="lbs",
            warehouse_id="wh-tz", status=ReceiptStatus.SENT_BACK,
            submitted_by=test_user.id, receipt_date=self.ORIGINAL,
        ))
        db_session.commit()
        return db_session.query(Receipt).filter(Receipt.id == "r-sent-back").one()

    def test_same_day_as_midnight_utc_keeps_the_original(self, db_session, sent_back):
        # What the client actually sent: the date input's day, as midnight UTC.
        for typed in (datetime(2026, 10, 1, tzinfo=timezone.utc),
                      datetime(2026, 10, 2, tzinfo=timezone.utc)):
            assert receipt_service.corrected_receipt_date(db_session, sent_back, typed) == sent_back.receipt_date

    def test_a_deliberately_changed_day_keeps_the_time_of_day(self, db_session, sent_back):
        out = receipt_service.corrected_receipt_date(
            db_session, sent_back, datetime(2026, 9, 29, tzinfo=timezone.utc))
        assert out == datetime(2026, 9, 30, 0, 12, tzinfo=timezone.utc)   # 9/29 8:12 PM EDT

    def test_a_full_timestamp_and_none(self, db_session, sent_back):
        explicit = datetime(2026, 10, 1, 15, 30, tzinfo=timezone.utc)
        assert receipt_service.corrected_receipt_date(db_session, sent_back, explicit) == explicit
        assert receipt_service.corrected_receipt_date(db_session, sent_back, None) == sent_back.receipt_date

    def test_save_and_resubmit_over_http(self, client, db_session, auth_headers, sent_back):
        for body in ({"receipt_date": "2026-10-01T00:00:00.000Z", "bol": "QA-BOL"},
                     {"receipt_date": "2026-10-01"}):
            resp = client.put("/api/receipts/r-sent-back", json=body, headers=auth_headers)
            assert resp.status_code == 200, resp.text
            db_session.expire_all()
            stored = db_session.query(Receipt).filter(Receipt.id == "r-sent-back").one()
            assert stored.receipt_date == self.ORIGINAL

        resp = client.post("/api/receipts/r-sent-back/resubmit", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        db_session.expire_all()
        stored = db_session.query(Receipt).filter(Receipt.id == "r-sent-back").one()
        assert stored.receipt_date == self.ORIGINAL
        assert stored.status == ReceiptStatus.REVIEWED


# ─────────────────────────────────────────────────────────────────────────────
# F6 — a room's default row retires once the room has racks
# ─────────────────────────────────────────────────────────────────────────────

def _barn(db):
    db.add(Location(id="loc-barn", name="QA Barn", warehouse_id=None))
    room = SubLocation(id="sub-qa-drums", name="QA Drum Room", location_id="loc-barn")
    db.add(room)
    db.commit()
    return room


def _names(rows):
    return sorted(r["name"] for r in rows)


class TestDefaultRowsDoNotOutliveTheirPurpose:
    def test_room_with_only_a_default_row_still_lists_it(self, db_session, admin_user):
        room = _barn(db_session)
        room.storage_unit = "drum"
        ingredient_row_service.ensure_default_row(db_session, room, admin_user)
        db_session.commit()
        # The reefer case: the room IS the rack, so the gun must offer it.
        assert _names(ingredient_row_service.list_rows(db_session, admin_user)) == ["QA Drum Room"]

    def test_adding_a_rack_retires_the_default_row(self, client, db_session, admin_user,
                                                   admin_auth_headers):
        room = _barn(db_session)
        resp = client.put(f"/api/master-data/sub-locations/{room.id}",
                          json={"storage_unit": "drum", "unit_capacity": 12},
                          headers=admin_auth_headers)
        assert resp.status_code == 200, resp.text
        default = db_session.query(StorageRow).filter(StorageRow.sub_location_id == room.id).one()
        assert default.name == "QA Drum Room" and default.is_active is not False

        resp = client.post("/api/master-data/storage-rows", json={
            "id": "row-qa-d1", "name": "QA-D1", "sub_location_id": room.id,
            "pallet_capacity": 0,
        }, headers=admin_auth_headers)
        assert resp.status_code == 200, resp.text

        db_session.expire_all()
        default = db_session.query(StorageRow).filter(StorageRow.id == default.id).one()
        assert default.is_active is False
        assert _names(ingredient_row_service.list_rows(db_session, admin_user)) == ["QA-D1"]
        # Still in Master Data's tree, as an inactive row — nothing hidden.
        subs = client.get("/api/master-data/sub-locations", headers=admin_auth_headers).json()
        rows = {r["name"]: r["is_active"] for s in subs if s["id"] == room.id for r in s["rows"]}
        assert rows == {"QA Drum Room": False, "QA-D1": True}

    def test_typing_a_room_that_already_has_racks_adds_nothing(self, client, db_session,
                                                               admin_auth_headers):
        room = _barn(db_session)
        db_session.add(StorageRow(id="row-qa-d1", name="QA-D1", sub_location_id=room.id,
                                  pallet_capacity=0, is_active=True))
        db_session.commit()
        client.put(f"/api/master-data/sub-locations/{room.id}", json={"storage_unit": "drum"},
                   headers=admin_auth_headers)
        names = [r.name for r in db_session.query(StorageRow)
                 .filter(StorageRow.sub_location_id == room.id)]
        assert names == ["QA-D1"]

    def test_racks_under_an_area_count_as_the_rooms_racks(self, db_session, admin_user):
        room = _barn(db_session)
        room.storage_unit = "drum"
        db_session.add(StorageArea(id="area-qa", name="Bay", sub_location_id=room.id,
                                   location_id="loc-barn"))
        db_session.add(StorageRow(id="row-bay-1", name="BAY-1", storage_area_id="area-qa",
                                  pallet_capacity=0, is_active=True))
        db_session.commit()
        assert ingredient_row_service.ensure_default_row(db_session, room, admin_user) is None

    def test_existing_phantom_rows_are_hidden_and_refused_at_the_gun(self, db_session, admin_user):
        """Rooms set up before the fix: both rows active in the DB."""
        room = _barn(db_session)
        room.storage_unit = "drum"
        db_session.add_all([
            StorageRow(id="row-default", name="QA Drum Room", sub_location_id=room.id,
                       barcode="QA-QADRUMROOM", pallet_capacity=0, is_active=True),
            StorageRow(id="row-qa-d1", name="QA-D1", sub_location_id=room.id,
                       barcode="QA-QA-D1", pallet_capacity=0, is_active=True),
        ])
        db_session.commit()

        assert _names(ingredient_row_service.list_rows(db_session, admin_user)) == ["QA-D1"]
        with pytest.raises(ValidationError, match="is the room, not a rack"):
            ingredient_row_service.resolve_row(db_session, admin_user, "QA-QADRUMROOM")
        assert ingredient_row_service.resolve_row(db_session, admin_user, "QA-QA-D1")["id"] == "row-qa-d1"

    def test_a_default_row_holding_stock_stays_visible(self, db_session, admin_user):
        room = _barn(db_session)
        room.storage_unit = "drum"
        db_session.add_all([
            StorageRow(id="row-default", name="QA Drum Room", sub_location_id=room.id,
                       pallet_capacity=0, occupied_pallets=2, is_active=True),
            StorageRow(id="row-qa-d1", name="QA-D1", sub_location_id=room.id,
                       pallet_capacity=0, is_active=True),
        ])
        db_session.commit()
        assert _names(ingredient_row_service.list_rows(db_session, admin_user)) == ["QA Drum Room", "QA-D1"]
        assert ingredient_row_service.retire_default_row(db_session, room) is None


# ─────────────────────────────────────────────────────────────────────────────
# F8 / F9 — finished truck lines
# ─────────────────────────────────────────────────────────────────────────────

def _finished_truck(db, *, expected=3, scans=2, rows=(ROW_1,)):
    order = _truck(db, [_line(lot="MG-1", count=expected)])
    code = _lot_code(db, order, "MG-1")
    per_row = {}
    for i in range(scans):
        row = rows[i % len(rows)]
        _scan(db, order, code, row=row, confirm_over=True, allow_overfill=True)
        per_row[row] = per_row.get(row, 0) + 1
    for row, n in per_row.items():
        lrs.truck_recount(db, order=order, storage_row_id=row,
                          counts=[{"line_id": order.lots[0].id, "actual": n}], user_id=USER)
    out = lrs.truck_finish(db, order=order, user_id=USER, confirmed=True, short_reason="damaged")
    assert out["status"] == "submitted", out
    receipt = db.query(Receipt).filter(Receipt.id == order.lots[0].receipt_id).one()
    return order, receipt


def _on_rack(db, lot_id):
    return {
        p.storage_row_id: int(p.full_units or 0)
        for p in db.query(LotPlacement).filter(LotPlacement.material_lot_id == lot_id)
        if int(p.full_units or 0)
    }


class TestFinishBooksTheScannedCount:
    def test_short_truck_receipt_says_what_is_on_the_rack(self, db_session, recv_seed):
        order, receipt = _finished_truck(db_session, expected=3, scans=2)
        assert receipt.status == ReceiptStatus.RECORDED          # not approved yet
        assert int(receipt.container_count) == 2
        assert float(receipt.quantity) == 2 * 500.0
        assert "Truck finished: booked at the 2" in receipt.note
        # The paperwork figure lives on in the line, for the approval card.
        line = lrs.truck_summary(db_session, order)["lines"][0]
        assert (line["expected_count"], line["scanned_count"]) == (3, 2)

    def test_over_truck_too(self, db_session, recv_seed):
        _order, receipt = _finished_truck(db_session, expected=1, scans=2)
        assert int(receipt.container_count) == 2 and float(receipt.quantity) == 1000.0

    def test_approval_stays_idempotent(self, db_session, recv_seed):
        order, receipt = _finished_truck(db_session, expected=3, scans=2)
        lrs.truck_approve(db_session, order=order, current_user=_approver(db_session))
        assert receipt.status == ReceiptStatus.APPROVED
        assert float(receipt.quantity) == 1000.0 and int(receipt.container_count) == 2
        assert receipt.note.count("booked at the") == 1
        assert "Approval correction" not in receipt.note

    def test_per_line_finish_books_too(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=5)])
        receipt = db_session.query(Receipt).filter(Receipt.id == order.lots[0].receipt_id).one()
        lot = db_session.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).one()
        for _ in range(3):
            lrs.scan_unit(db_session, receipt_id=receipt.id, lot_code=lot.lot_code,
                          storage_row_id=ROW_1, allow_overfill=True)
        out = lrs.submit_session(db_session, receipt_id=receipt.id, user_id=USER, confirmed=True)
        assert out["status"] == "submitted"
        assert int(receipt.container_count) == 3 and float(receipt.quantity) == 1500.0


class TestRejectAFinishedLine:
    def test_reject_takes_the_scans_back_off_the_racks(self, db_session, recv_seed):
        order, receipt = _finished_truck(db_session, expected=3, scans=3, rows=(ROW_1, ROW_2))
        lot_id = receipt.material_lot_id
        assert _on_rack(db_session, lot_id) == {ROW_1: 2, ROW_2: 1}

        receipt_service.reject_receipt(db_session, receipt, "Wrong product on the truck",
                                       _approver(db_session))
        db_session.flush()

        assert receipt.status == ReceiptStatus.REJECTED
        assert _on_rack(db_session, lot_id) == {}
        assert lrs.session_counts(db_session, receipt)["total"] == 0
        reversals = db_session.query(LotPlacementEvent).filter(
            LotPlacementEvent.ref_id == receipt.id,
            LotPlacementEvent.reason_code == "receipt_rejected",
        ).all()
        assert sorted(int(e.full_units_delta) for e in reversals) == [-2, -1]
        assert all("Wrong product on the truck" in e.reason for e in reversals)
        assert "back off the racks" in receipt.note

    def test_other_deliveries_of_the_lot_stay(self, db_session, recv_seed):
        """Only this receipt's scans come off — an earlier truck's drums of the
        same lot on the same rack are untouched."""
        order, receipt = _finished_truck(db_session, expected=2, scans=2)
        lot = db_session.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).one()
        # 5 drums of the same lot already on the rack from before.
        lps.apply_delta(db_session, lot, ROW_1, event_type=lps.EVENT_OPENING_BALANCE,
                        full_units_delta=5, ref_type="opening_balance", ref_id="ob-1")
        receipt_service.reject_receipt(db_session, receipt, "dup", _approver(db_session))
        assert _on_rack(db_session, lot.id) == {ROW_1: 5}

    def test_refused_when_units_have_moved_since(self, db_session, recv_seed):
        order, receipt = _finished_truck(db_session, expected=2, scans=2)
        lot = db_session.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).one()
        lps.move_units(db_session, lot, from_row_id=ROW_1, to_row_id=ROW_2, full_units=1,
                       actor_id=USER)
        db_session.flush()
        before = _on_rack(db_session, lot.id)
        assert before == {ROW_1: 1, ROW_2: 1}

        with pytest.raises(ValidationError, match="moved or been used") as err:
            receipt_service.reject_receipt(db_session, receipt, "nope", _approver(db_session))
        assert "A-01" in str(err.value)
        assert receipt.status == ReceiptStatus.RECORDED
        assert _on_rack(db_session, lot.id) == before
