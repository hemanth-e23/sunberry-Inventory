"""Truck receiving — one gun session per incoming order (2026-10).

A trailer carries several lots mixed together. The worker scans a rack and then
ANY drum on it; the server routes the drum to its own line by the sticker's lot.
Stickers are identical per lot, so the system compensates with checks rather
than trusting the gun:

* a truck has ONE line per lot — duplicates merge at order entry and check-in
* a drum goes to its own line's receipt, never to "whichever line is open"
* more than the paperwork, or a lot not on this truck, asks first, then flags
* a held lot is accepted (it stays held) and flagged
* every rack touched is recounted by eye before the truck can be finished, and
  a recount that disagrees corrects the count and is flagged
* finishing short needs a reason; approving approves every line at once
"""
from datetime import datetime, timezone

import pytest

from app.constants import (
    RECEIVING_FLAG_LOT_HELD,
    RECEIVING_FLAG_NOT_ON_TRUCK,
    RECEIVING_FLAG_OTHER_TRUCK,
    RECEIVING_FLAG_OVER_PAPERWORK,
    RECEIVING_FLAG_RECOUNT_CORRECTED,
    RECEIVING_FLAG_SHORT,
)
from app.enums import IncomingOrderStatus, ReceiptStatus
from app.exceptions import ValidationError
from app.models import IntakeLot, LotPlacement, MaterialLot, Receipt, User
from app.services import lot_receiving_service as lrs

from tests.test_lot_receiving import (  # noqa: F401  (fixture import)
    BBD,
    OTHER_PRODUCT,
    PRODUCT,
    ROW_1,
    ROW_2,
    USER,
    VENDOR,
    WH,
    _order,
    recv_seed,
)
from tests.test_lot_receiving_api import (  # noqa: F401  (fixture import)
    ROW_1 as API_ROW_1,
    _make_order,
    _start,
    admin_headers,
    api_seed,
    fk_headers,
    wh_headers,
)

APPROVER = "user-recv-approver"


def _line(product=PRODUCT, lot="MG-1", count=3):
    return {
        "product_id": product,
        "category_id": "cat-ingredient",
        "vendor_lot": lot,
        "bbd": BBD,
        "expected_count": count,
        "unit_label": "drum",
        "weight_per_unit": 500.0,
        "weight_unit": "lbs",
    }


def _truck(db, lines):
    order = _order(db, lines=lines)
    lrs.check_in_truck(db, order, lines=[], user_id=USER)
    db.flush()
    return order


def _lot_code(db, order, vendor_lot):
    line = next(l for l in order.lots if l.vendor_lot == vendor_lot)
    return db.query(MaterialLot).filter(MaterialLot.id == line.material_lot_id).one().lot_code


def _scan(db, order, code, row=ROW_1, **kw):
    return lrs.truck_scan(db, order=order, lot_code=code, storage_row_id=row, user_id=USER, **kw)


def _flags(summary, kind):
    return [f for f in summary["flags"] if f["kind"] == kind]


def _approver(db):
    user = User(
        id=APPROVER, username="recvapprover", name="Recv Approver",
        email="appr@sunberry.com", hashed_password="x", role="admin", is_active=True,
    )
    db.add(user)
    db.flush()
    return user


class TestOneLinePerLot:
    def test_duplicate_lines_merge_when_the_order_is_entered(self, db_session, recv_seed):
        order = _order(db_session, lines=[
            _line(lot="MG-1", count=2),
            _line(lot=" mg-1 ", count=3),     # same lot, typed differently
            _line(lot="MG-2", count=4),
        ])
        assert len(order.lots) == 2
        merged = next(l for l in order.lots if l.vendor_lot == "MG-1")
        assert merged.expected_count == 5
        assert order.expected_count == 9

    def test_lines_with_no_lot_number_never_merge(self, db_session, recv_seed):
        # An order can no longer be entered without a lot number (F14), so the
        # merge rule is checked on its own: unknown never merges with unknown.
        merged = lrs.merge_duplicate_lines([_line(lot=None, count=2), _line(lot=None, count=2)])
        assert len(merged) == 2

    def test_check_in_merges_lines_corrected_into_the_same_lot(self, db_session, recv_seed):
        order = _order(db_session, lines=[_line(lot="MG-1", count=2), _line(lot="MG-9", count=3)])
        typo = next(l for l in order.lots if l.vendor_lot == "MG-9")
        lrs.check_in_truck(
            db_session, order, lines=[{"line_id": typo.id, "vendor_lot": "MG-1"}], user_id=USER,
        )
        assert len(order.lots) == 1
        assert order.lots[0].expected_count == 5
        receipt = db_session.query(Receipt).filter(Receipt.id == order.lots[0].receipt_id).one()
        assert receipt.container_count == 5

    def test_check_in_starts_every_line(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1"), _line(product=OTHER_PRODUCT, lot="GV-1")])
        assert all(l.receipt_id and l.material_lot_id for l in order.lots)
        assert order.status == IncomingOrderStatus.RECEIVING.value
        summary = lrs.truck_summary(db_session, order)
        assert summary["checked_in"] is True
        assert [t["unit"] for t in summary["totals"]] == ["drum"]


class TestScanRouting:
    def test_a_drum_goes_to_its_own_lines_receipt(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2), _line(lot="MG-2", count=2)])
        code_2 = _lot_code(db_session, order, "MG-2")

        result = _scan(db_session, order, code_2, idempotency_key="truck-scan-0001")
        assert result["status"] == "ok"
        by_lot = {l["vendor_lot"]: l for l in result["truck"]["lines"]}
        assert by_lot["MG-2"]["scanned_count"] == 1
        assert by_lot["MG-1"]["scanned_count"] == 0

    def test_a_replay_counts_once(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=3)])
        code = _lot_code(db_session, order, "MG-1")
        _scan(db_session, order, code, idempotency_key="truck-replay-01")
        again = _scan(db_session, order, code, idempotency_key="truck-replay-01")
        assert again["message"] == "Already recorded."
        assert again["truck"]["lines"][0]["scanned_count"] == 1

    def test_unknown_sticker_is_a_soft_answer(self, db_session, recv_seed):
        order = _truck(db_session, [_line()])
        assert _scan(db_session, order, "NOT-A-LOT")["status"] == "unknown_lot"

    def test_over_the_paperwork_asks_then_flags(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=1)])
        code = _lot_code(db_session, order, "MG-1")
        assert _scan(db_session, order, code)["status"] == "ok"

        asked = _scan(db_session, order, code)
        assert asked["status"] == "needs_confirm_over"
        assert asked["truck"]["lines"][0]["scanned_count"] == 1   # nothing booked

        done = _scan(db_session, order, code, confirm_over=True)
        assert done["status"] == "ok"
        assert done["flag"] == RECEIVING_FLAG_OVER_PAPERWORK
        assert len(_flags(done["truck"], RECEIVING_FLAG_OVER_PAPERWORK)) == 1

    def test_a_lot_not_on_the_truck_asks_then_becomes_an_extra_line(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        stranger = _truck(db_session, [_line(product=OTHER_PRODUCT, lot="GV-7", count=2)])
        code = _lot_code(db_session, stranger, "GV-7")

        asked = _scan(db_session, order, code)
        assert asked["status"] == "needs_confirm_over"
        assert stranger.intake_number in asked["message"]
        assert len(order.lots) == 1   # nothing added on a "No"

        done = _scan(db_session, order, code, confirm_over=True)
        assert done["status"] == "ok"
        assert done["flag"] == RECEIVING_FLAG_OTHER_TRUCK
        extra = next(l for l in done["truck"]["lines"] if l["vendor_lot"] == "GV-7")
        assert extra["expected_count"] == 0 and extra["scanned_count"] == 1

    def test_a_lot_on_no_truck_is_flagged_not_on_truck(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        other = _truck(db_session, [_line(lot="MG-5", count=2)])
        code = _lot_code(db_session, other, "MG-5")
        other.status = IncomingOrderStatus.RECEIVED.value   # that truck is done
        db_session.flush()
        done = _scan(db_session, order, code, confirm_over=True)
        assert done["flag"] == RECEIVING_FLAG_NOT_ON_TRUCK

    def test_a_held_lot_is_accepted_held_and_flagged(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        code = _lot_code(db_session, order, "MG-1")
        lot = db_session.query(MaterialLot).filter(MaterialLot.lot_code == code).one()
        lot.is_held = True
        db_session.flush()

        done = _scan(db_session, order, code)
        assert done["status"] == "ok"
        assert "ON HOLD" in done["message"]
        assert done["flag"] == RECEIVING_FLAG_LOT_HELD
        placement = db_session.query(LotPlacement).filter(
            LotPlacement.material_lot_id == lot.id, LotPlacement.storage_row_id == ROW_1
        ).one()
        assert placement.full_units == 1

    def test_a_palletised_lot_books_a_pallet_per_scan(self, db_session, recv_seed):
        line = _line(lot="BG-1", count=100)
        line.update({"unit_label": "bag", "units_per_pallet": 50})
        order = _truck(db_session, [line])
        code = _lot_code(db_session, order, "BG-1")
        assert _scan(db_session, order, code, allow_overfill=True)["line_scanned_count"] == 50
        assert _scan(db_session, order, code, allow_overfill=True, single=True)["line_scanned_count"] == 51

    def test_a_pallet_scan_over_the_paperwork_says_what_it_adds(self, db_session, recv_seed):
        # Browser test F13: "Is there really another bag?" for a +40 pallet scan.
        line = _line(lot="BG-2", count=50)
        line.update({"unit_label": "bag", "units_per_pallet": 40})
        order = _truck(db_session, [line])
        code = _lot_code(db_session, order, "BG-2")
        _scan(db_session, order, code, allow_overfill=True)
        asked = _scan(db_session, order, code, allow_overfill=True)
        assert asked["status"] == "needs_confirm_over"
        assert asked["units"] == 40 and asked["count_unit"] == "bags"
        assert "adds 40 bags" in asked["message"]
        assert "pallet of 40 bags" in asked["message"]
        assert "drum" not in asked["message"]

    def test_product_names_are_shown_as_stored(self, db_session, recv_seed):
        # Browser test F13: .title() printed "Qa Mango Puree" / "Ascorbic Acid (Sb)".
        from app.models import Product
        db_session.query(Product).filter(Product.id == PRODUCT).one().name = "QA Mango Puree (SB)"
        order = _truck(db_session, [_line(lot="MG-1", count=1)])
        code = _lot_code(db_session, order, "MG-1")
        _scan(db_session, order, code)
        asked = _scan(db_session, order, code)
        assert "QA Mango Puree (SB)" in asked["message"]

    def test_an_unknown_sticker_says_it_is_not_expected_here(self, db_session, recv_seed):
        order = _truck(db_session, [_line()])
        out = _scan(db_session, order, "NOT-A-LOT")
        assert order.intake_number in out["message"]
        assert "not one of ours" not in out["message"]


class TestRemoveAndRecount:
    def test_remove_takes_that_lot_off_that_rack_once(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=3), _line(lot="MG-2", count=3)])
        code_1 = _lot_code(db_session, order, "MG-1")
        code_2 = _lot_code(db_session, order, "MG-2")
        _scan(db_session, order, code_1)
        _scan(db_session, order, code_1)
        _scan(db_session, order, code_2)   # the most recent scan is a different lot
        line_1 = next(l for l in order.lots if l.vendor_lot == "MG-1")

        out = lrs.truck_remove(
            db_session, order=order, line_id=line_1.id, storage_row_id=ROW_1,
            user_id=USER, idempotency_key="truck-remove-01",
        )
        again = lrs.truck_remove(
            db_session, order=order, line_id=line_1.id, storage_row_id=ROW_1,
            user_id=USER, idempotency_key="truck-remove-01",
        )
        assert out["status"] == "removed" and again["message"] == "Already removed."
        by_lot = {l["vendor_lot"]: l for l in again["truck"]["lines"]}
        assert by_lot["MG-1"]["scanned_count"] == 1
        assert by_lot["MG-2"]["scanned_count"] == 1

    def test_remove_on_an_empty_rack_is_a_soft_answer(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1")])
        out = lrs.truck_remove(
            db_session, order=order, line_id=order.lots[0].id, storage_row_id=ROW_2, user_id=USER,
        )
        assert out["status"] == "nothing_to_remove"

    def test_every_scanned_rack_must_be_recounted(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        code = _lot_code(db_session, order, "MG-1")
        _scan(db_session, order, code, row=ROW_1)
        summary = _scan(db_session, order, code, row=ROW_2)["truck"]
        assert {p["storage_row_id"] for p in summary["pending_recounts"]} == {ROW_1, ROW_2}

        line_id = order.lots[0].id
        out = lrs.truck_recount(
            db_session, order=order, storage_row_id=ROW_1,
            counts=[{"line_id": line_id, "actual": 1}], user_id=USER,
        )
        assert out["status"] == "ok"
        assert [p["storage_row_id"] for p in out["truck"]["pending_recounts"]] == [ROW_2]

        # A new scan into a counted rack re-opens it.
        summary = _scan(db_session, order, code, row=ROW_1, confirm_over=True)["truck"]
        assert ROW_1 in {p["storage_row_id"] for p in summary["pending_recounts"]}

    def test_a_recount_that_disagrees_corrects_and_flags(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=3)])
        code = _lot_code(db_session, order, "MG-1")
        for _ in range(3):
            _scan(db_session, order, code)   # one of these was a double scan
        out = lrs.truck_recount(
            db_session, order=order, storage_row_id=ROW_1,
            counts=[{"line_id": order.lots[0].id, "actual": 2}], user_id=USER,
        )
        assert out["status"] == "corrected"
        assert out["truck"]["lines"][0]["scanned_count"] == 2
        flag = _flags(out["truck"], RECEIVING_FLAG_RECOUNT_CORRECTED)[0]
        assert (flag["expected"], flag["actual"]) == (3, 2)
        assert out["truck"]["pending_recounts"] == []


class TestFinishAndApprove:
    def _received(self, db, count=2, scans=2):
        order = _truck(db, [_line(lot="MG-1", count=count)])
        code = _lot_code(db, order, "MG-1")
        for _ in range(scans):
            _scan(db, order, code)
        lrs.truck_recount(
            db, order=order, storage_row_id=ROW_1,
            counts=[{"line_id": order.lots[0].id, "actual": scans}], user_id=USER,
        )
        return order

    def test_finish_is_blocked_until_racks_are_counted(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=1)])
        _scan(db_session, order, _lot_code(db_session, order, "MG-1"))
        out = lrs.truck_finish(db_session, order=order, user_id=USER)
        assert out["status"] == "needs_recount"
        assert order.forklift_submitted_at is None

    def test_finishing_short_needs_confirmation_and_a_reason(self, db_session, recv_seed):
        order = self._received(db_session, count=3, scans=2)
        assert lrs.truck_finish(db_session, order=order, user_id=USER)["status"] == "needs_confirm"
        assert lrs.truck_finish(
            db_session, order=order, user_id=USER, confirmed=True
        )["status"] == "needs_reason"
        assert lrs.truck_finish(
            db_session, order=order, user_id=USER, confirmed=True, short_reason="other"
        )["status"] == "needs_reason"   # "other" needs words

        out = lrs.truck_finish(
            db_session, order=order, user_id=USER, confirmed=True, short_reason="damaged",
        )
        assert out["status"] == "submitted"
        assert order.short_reason == "Damaged on arrival"
        assert _flags(out["truck"], RECEIVING_FLAG_SHORT)[0]["actual"] == 2
        receipt = db_session.query(Receipt).filter(Receipt.id == order.lots[0].receipt_id).one()
        assert receipt.forklift_submitted_at is not None

    def test_a_finished_truck_takes_no_more_scans(self, db_session, recv_seed):
        order = self._received(db_session)
        lrs.truck_finish(db_session, order=order, user_id=USER)
        code = _lot_code(db_session, order, "MG-1")
        assert _scan(db_session, order, code)["status"] == "truck_closed"
        assert lrs.open_trucks(db_session, warehouse_id=WH) == []

    def test_locating_a_finished_trucks_sticker_says_it_is_finished(self, db_session, recv_seed):
        # Browser test F7c: the list did nothing at all for this sticker.
        order = self._received(db_session)
        lrs.truck_finish(db_session, order=order, user_id=USER)
        located = lrs.locate_truck(db_session, _lot_code(db_session, order, "MG-1"), warehouse_id=WH)
        assert located["status"] == "truck_finished"
        assert located["trucks"] == []
        assert "already finished" in located["message"]
        assert order.intake_number in located["message"]

    def test_approve_needs_the_truck_finished(self, db_session, recv_seed):
        order = self._received(db_session)
        with pytest.raises(ValidationError):
            lrs.truck_approve(db_session, order=order, current_user=_approver(db_session))

    def test_a_line_with_nothing_scanned_is_closed_as_not_delivered(self, db_session, recv_seed):
        """Production 2026-10-02: a truck finished short with one line at 0 of
        20 could not be approved at all — the empty line fell back to the
        typed-rows gate ("rows place 0 of 20"). Nothing arrived, so nothing is
        booked: that line is rejected as not delivered, the rest approved."""
        order = _truck(db_session, [_line(lot="MG-1", count=1), _line(lot="MG-2", count=20)])
        _scan(db_session, order, _lot_code(db_session, order, "MG-1"))
        mg1 = next(l for l in order.lots if l.vendor_lot == "MG-1")
        lrs.truck_recount(
            db_session, order=order, storage_row_id=ROW_1,
            counts=[{"line_id": mg1.id, "actual": 1}], user_id=USER,
        )
        assert lrs.truck_finish(
            db_session, order=order, user_id=USER, confirmed=True, short_reason="truck_short",
        )["status"] == "submitted"

        out = lrs.truck_approve(db_session, order=order, current_user=_approver(db_session))
        assert out["approved_receipts"] == 1 and out["not_delivered"] == 1
        by_lot = {
            l.vendor_lot: db_session.query(Receipt).filter(Receipt.id == l.receipt_id).one()
            for l in order.lots
        }
        assert by_lot["MG-1"].status == ReceiptStatus.APPROVED
        assert by_lot["MG-2"].status == ReceiptStatus.REJECTED

    def test_approve_approves_every_line_and_closes_the_order(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=1), _line(lot="MG-2", count=1)])
        for vendor_lot in ("MG-1", "MG-2"):
            _scan(db_session, order, _lot_code(db_session, order, vendor_lot))
        for line in order.lots:
            lrs.truck_recount(
                db_session, order=order, storage_row_id=ROW_1,
                counts=[{"line_id": line.id, "actual": 1}], user_id=USER,
            )
        assert lrs.truck_finish(db_session, order=order, user_id=USER)["status"] == "submitted"

        out = lrs.truck_approve(db_session, order=order, current_user=_approver(db_session))
        assert out["approved_receipts"] == 2
        assert order.status == IncomingOrderStatus.RECEIVED.value
        statuses = {
            r.status for r in db_session.query(Receipt).filter(
                Receipt.id.in_([l.receipt_id for l in order.lots])
            )
        }
        assert statuses == {ReceiptStatus.APPROVED}

    def test_the_gun_lists_trucks_and_walk_ins_separately(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1")])
        trucks = lrs.open_trucks(db_session, warehouse_id=WH)
        assert [t["order_id"] for t in trucks] == [order.id]
        assert lrs.open_sessions(db_session, warehouse_id=WH, walk_in_only=True) == []
        located = lrs.locate_truck(db_session, _lot_code(db_session, order, "MG-1"), warehouse_id=WH)
        assert [t["order_id"] for t in located["trucks"]] == [order.id]


class TestTruckApi:
    def test_check_in_scan_and_receipt_link_over_http(
        self, client, api_seed, wh_headers, fk_headers, admin_headers,
    ):
        order = _make_order(client, wh_headers, count=2)
        assert client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        ).status_code == 200

        # Forklift cannot check a truck in — that is desk work.
        assert client.post(
            f"/api/lot-receiving/orders/{order['id']}/check-in",
            headers=fk_headers, json={"lines": []},
        ).status_code == 403
        checked = client.post(
            f"/api/lot-receiving/orders/{order['id']}/check-in",
            headers=wh_headers, json={"bol": "BOL-DRIVER", "lines": []},
        )
        assert checked.status_code == 200, checked.text
        truck = checked.json()
        assert truck["bol"] == "BOL-DRIVER" and truck["checked_in"] is True

        scan = client.post(
            f"/api/lot-receiving/trucks/{order['id']}/scan",
            headers=fk_headers,
            json={"lot_code": truck["lines"][0]["lot_code"], "storage_row_id": API_ROW_1,
                  "idempotency_key": "api-truck-0001"},
        )
        assert scan.status_code == 200, scan.text
        assert scan.json()["line_scanned_count"] == 1

        unknown = client.post(
            f"/api/lot-receiving/trucks/{order['id']}/scan",
            headers=fk_headers,
            json={"lot_code": "NOPE", "storage_row_id": API_ROW_1},
        )
        assert unknown.status_code == 200 and unknown.json()["status"] == "unknown_lot"

        listed = client.get("/api/lot-receiving/trucks", headers=fk_headers)
        assert [t["order_id"] for t in listed.json()] == [order["id"]]

        receipts = client.get("/api/receipts/?limit=50", headers=admin_headers).json()
        linked = [r for r in receipts if r.get("incoming_order_id") == order["id"]]
        assert len(linked) == 1
        assert linked[0]["incoming_order_number"] == order["order_number"]

        detail = client.get(f"/api/lot-receiving/orders/{order['id']}", headers=wh_headers).json()
        assert detail["totals_by_unit"] == [{"unit": "drum", "expected": 2, "scanned": 1}]


class TestIncompleteLinesAreRefused:
    """Plant rule (2026-10-01 browser test, F14): no vendor lot, no best-by or no
    weight per unit is not accepted — refused when the order or walk-in is typed."""

    @pytest.mark.parametrize("field,value,word", [
        ("vendor_lot", None, "vendor lot"),
        ("vendor_lot", "   ", "vendor lot"),
        ("bbd", None, "best-by"),
        ("weight_per_unit", None, "weight per drum"),
        ("weight_per_unit", 0, "weight per drum"),
    ])
    def test_a_missing_detail_refuses_the_order(self, db_session, recv_seed, field, value, word):
        line = _line()
        line[field] = value
        with pytest.raises(ValidationError) as exc:
            _order(db_session, lines=[line])
        assert word in exc.value.detail
        assert db_session.query(IntakeLot).count() == 0

    def test_a_complete_line_is_accepted(self, db_session, recv_seed):
        assert len(_order(db_session, lines=[_line()]).lots) == 1


class TestKnownLotWeights:
    """F17: the desk is warned when a known lot arrives at a different weight."""

    def test_an_earlier_delivery_reports_its_weight(self, db_session, recv_seed):
        _truck(db_session, [_line(lot="MG-1", count=2)])
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot=" mg-1 ", bbd=BBD,
        )
        assert len(out["lots"]) == 1
        assert out["lots"][0]["weights"] == [
            {"weight_per_unit": 500.0, "weight_unit": "lbs", "deliveries": 1}
        ]

    def test_without_a_vendor_any_vendors_lot_is_considered(self, db_session, recv_seed):
        _truck(db_session, [_line(lot="MG-1", count=2)])
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=None, vendor_lot="MG-1", bbd=BBD,
        )
        assert [w["weight_per_unit"] for w in out["lots"][0]["weights"]] == [500.0]

    def test_a_different_best_by_is_a_different_lot(self, db_session, recv_seed):
        _truck(db_session, [_line(lot="MG-1", count=2)])
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot="MG-1",
            bbd=datetime(2028, 1, 1, tzinfo=timezone.utc),
        )
        assert out["lots"] == []

    def test_a_held_lot_says_so(self, db_session, recv_seed):
        """PART 2 U9: walk-in / check-in warn that drums received will be held."""
        _truck(db_session, [_line(lot="MG-1", count=2)])
        lot = db_session.query(MaterialLot).filter(MaterialLot.product_id == PRODUCT).one()
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD,
        )
        assert out["lots"][0]["is_held"] is False
        assert out["lots"][0]["hold_reason"] is None

        lot.is_held = True
        lot.hold_reason = "positive swab"
        db_session.flush()
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD,
        )
        assert out["lots"][0]["is_held"] is True
        assert out["lots"][0]["hold_reason"] == "positive swab"

    def test_a_held_lot_with_no_weight_on_file_is_still_reported(self, db_session, recv_seed):
        _truck(db_session, [_line(lot="MG-1", count=2)])
        lot = db_session.query(MaterialLot).filter(MaterialLot.product_id == PRODUCT).one()
        lot.is_held = True
        lot.weight_per_unit = None
        for r in db_session.query(Receipt).filter(Receipt.material_lot_id == lot.id):
            r.weight_per_container = None
        db_session.flush()
        out = lrs.known_lot_weights(
            db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot="MG-1", bbd=BBD,
        )
        assert len(out["lots"]) == 1
        assert out["lots"][0]["weights"] == []
        assert out["lots"][0]["is_held"] is True

    def test_the_endpoint_answers_the_desk(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        _start(client, wh_headers, order)
        res = client.get(
            "/api/lot-receiving/lots/known-weights", headers=wh_headers,
            params={"product_id": order["lines"][0]["product_id"], "vendor_lot": "MG-API",
                    "bbd": "2027-04-01"},
        )
        assert res.status_code == 200, res.text
        assert res.json()["lots"][0]["weights"][0]["weight_per_unit"] == 500.0

    def test_a_forklift_cannot_ask(self, client, api_seed, fk_headers):
        res = client.get(
            "/api/lot-receiving/lots/known-weights", headers=fk_headers,
            params={"product_id": "x", "vendor_lot": "y"},
        )
        assert res.status_code == 403


class TestLotTraceArrivalsAndRejections:
    """Browser test PART 2, U11: every delivery shows the rack it arrived on, and
    rejected transfers are listed (marked rejected, nothing moved)."""

    def test_a_truck_delivery_shows_its_arrival_rack_and_room(self, db_session, recv_seed):
        from app.services.report_builders import build_lot_trace

        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        code = _lot_code(db_session, order, "MG-1")
        _scan(db_session, order, code, row=ROW_1)
        _scan(db_session, order, code, row=ROW_2)
        db_session.flush()

        trace = build_lot_trace(db_session, "MG-1")
        received = [
            ev for r in trace["receipts"] for ev in r["timeline"]
            if ev["event_type"] == "received"
        ]
        assert len(received) == 1
        ev = received[0]
        # The truck receipt has no location of its own; the room comes from the
        # racks the gun used.
        assert ev["to_location"] == "Plant A › Drum Barn"
        assert sorted(r["row"] for r in ev["to_rows"]) == ["A-01", "A-02"]

    def test_a_rejected_transfer_is_listed_as_rejected(self, db_session, recv_seed):
        from app.models import InventoryTransfer
        from app.services.report_builders import build_lot_trace

        order = _truck(db_session, [_line(lot="MG-1", count=2)])
        receipt_id = order.lots[0].receipt_id
        db_session.add(InventoryTransfer(
            id="xfer-rej-1", receipt_id=receipt_id, quantity=500.0, unit="lbs",
            transfer_type="warehouse-transfer", status="rejected",
            reason="move\n[Rejected by Sup]: wrong rack",
            source_breakdown=[{"id": f"row-{ROW_1}", "quantity": 500.0}],
            destination_breakdown=[{"id": f"row-{ROW_2}", "quantity": 500.0}],
            requested_by=USER,
        ))
        db_session.flush()

        trace = build_lot_trace(db_session, "MG-1")
        events = [ev for r in trace["receipts"] for ev in r["timeline"]]
        rejected = [ev for ev in events if ev["event_type"] == "transfer-rejected"]
        assert len(rejected) == 1
        assert rejected[0]["direction"] == "rejected"
        assert rejected[0]["event"] == "Warehouse Transfer (rejected)"
        assert rejected[0]["qty"] == 500.0
        assert "wrong rack" in rejected[0]["notes"]


class TestTypedVendorLot:
    """A drum with no sticker: the worker types the vendor lot printed on it
    (browser test G3). It resolves within THIS truck, and two lines sharing it
    are asked about, never guessed."""

    def test_the_vendor_lot_books_onto_its_line(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=2), _line(lot="MG-2", count=2)])
        out = _scan(db_session, order, " mg-2 ", idempotency_key="typed-vendor-01")
        assert out["status"] == "ok", out["message"]
        by_lot = {l["vendor_lot"]: l for l in out["truck"]["lines"]}
        assert by_lot["MG-2"]["scanned_count"] == 1
        assert by_lot["MG-1"]["scanned_count"] == 0

    def test_two_lines_with_that_lot_ask_which(self, db_session, recv_seed):
        order = _truck(db_session, [
            _line(lot="MG-1", count=2), _line(product=OTHER_PRODUCT, lot="MG-1", count=2),
        ])
        assert len(order.lots) == 2
        out = _scan(db_session, order, "MG-1")
        assert out["status"] == "ambiguous_lot"
        assert "No sticker?" in out["message"]
        assert all(l["scanned_count"] == 0 for l in out["truck"]["lines"])

    def test_a_vendor_lot_not_on_this_truck_is_still_unknown(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1")])
        out = _scan(db_session, order, "ZZ-404")
        assert out["status"] == "unknown_lot"
        assert "ZZ-404" in out["message"]

    def test_the_truck_list_finds_a_truck_by_vendor_lot(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1")])
        located = lrs.locate_truck(db_session, "mg-1", warehouse_id=WH)
        assert located["status"] == "ok"
        assert [t["order_id"] for t in located["trucks"]] == [order.id]
        assert located["lot_code"] == _lot_code(db_session, order, "MG-1")


class TestRackFill:
    def test_rack_fill_counts_what_is_on_each_rack(self, db_session, recv_seed):
        order = _truck(db_session, [_line(lot="MG-1", count=5)])
        code = _lot_code(db_session, order, "MG-1")
        _scan(db_session, order, code, idempotency_key="fill-scan-0001")
        _scan(db_session, order, code, idempotency_key="fill-scan-0002")
        fill = {r["storage_row_id"]: r["units"] for r in lrs.rack_fill(db_session, warehouse_id=WH)}
        assert fill.get(ROW_1) == 2

    def test_the_gun_can_read_rack_fill(self, client, api_seed, fk_headers):
        res = client.get("/api/lot-receiving/rack-fill", headers=fk_headers)
        assert res.status_code == 200, res.text
        assert isinstance(res.json()["rows"], list)
