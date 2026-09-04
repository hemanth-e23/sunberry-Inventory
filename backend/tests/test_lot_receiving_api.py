"""The HTTP surface of lot receiving and the cutover.

The service tests cover the logic. These cover the things only the wire can get
wrong, and every one of them has a specific failure it exists to catch:

* **A soft answer must be an HTTP 200.** `scanQueue.js` classifies anything that
  is not no-response / 5xx / 408 / 429 as TERMINAL: it writes the item to
  localStorage as permanently failed and the gun drops the driver's optimistic
  row. So a full rack answered with a 409 is a scan the warehouse silently
  loses. A service-level test cannot catch this — the status code only exists at
  the router.
* **The response shape the gun redraws from.** One shape, one `status`
  discriminator. The finished-goods scan endpoint returns four different shapes
  from one route and its client detects outcomes by which fields are ABSENT.
* **Role gates.** Forklift users must be able to scan and must not be able to
  create paperwork or run a cutover.
* **Warehouse scoping.** Every list is scoped, and a create resolves its target
  warehouse rather than writing a NULL that is then invisible everywhere.
"""
from datetime import datetime, timezone

import pytest

from app.models import (
    Category,
    Location,
    MaterialLot,
    Product,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.utils.auth import create_access_token, get_password_hash

WH = "wh-api-1"
OTHER_WH = "wh-api-2"
PRODUCT = "prod-api-mango"
VENDOR = "vendor-api"
ROW_1 = "row-api-1"
ROW_2 = "row-api-2"

BBD = "2027-04-01T00:00:00Z"


def _headers(username):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': username})}"}


@pytest.fixture
def api_seed(db_session):
    db_session.add_all([
        Warehouse(id=WH, name="Plant A", code="PA", type="owned", is_active=True),
        Warehouse(id=OTHER_WH, name="Plant B", code="PB", type="owned", is_active=True),
    ])
    db_session.add(Category(id="cat-ing", name="Ingredients", type="ingredient"))
    db_session.add(Product(id=PRODUCT, name="Mango Puree", category_id="cat-ing", sid="SID-A"))
    db_session.add(Vendor(id=VENDOR, name="Acme Juice"))
    db_session.add(Location(id="loc-api", name="Plant A", warehouse_id=WH))
    db_session.add(SubLocation(
        id="sub-api", name="Drum Barn", location_id="loc-api",
        storage_unit="drum", unit_capacity=5,
    ))
    db_session.add_all([
        StorageRow(id=ROW_1, name="A-01", sub_location_id="sub-api",
                   barcode="PA-A01", pallet_capacity=0, is_active=True),
        StorageRow(id=ROW_2, name="A-02", sub_location_id="sub-api",
                   barcode="PA-A02", pallet_capacity=0, is_active=True),
    ])
    for uid, username, role in (
        ("u-api-wh", "apiwarehouse", "warehouse"),
        ("u-api-fk", "apiforklift", "forklift"),
        ("u-api-ad", "apiadmin", "admin"),
    ):
        db_session.add(User(
            id=uid, username=username, name=username,
            email=f"{username}@sunberry.com",
            hashed_password=get_password_hash("pw123456789"),
            role=role, is_active=True, warehouse_id=WH,
        ))
    db_session.commit()


@pytest.fixture
def wh_headers():
    return _headers("apiwarehouse")


@pytest.fixture
def fk_headers():
    return _headers("apiforklift")


@pytest.fixture
def admin_headers():
    return _headers("apiadmin")


def _make_order(client, headers, *, count=8):
    response = client.post("/api/lot-receiving/orders", headers=headers, json={
        "vendor_id": VENDOR,
        "bol": "BOL-API",
        "origin_name": "Chicago 3PL",
        "lines": [{
            "product_id": PRODUCT,
            "category_id": "cat-ing",
            "vendor_lot": "MG-API",
            "bbd": BBD,
            "expected_count": count,
            "unit_label": "drum",
            "weight_per_unit": 500.0,
            "weight_unit": "lbs",
        }],
    })
    assert response.status_code == 200, response.text
    return response.json()


def _start(client, headers, order):
    # Releasing now requires an arrival day — the plant's screen is organised by
    # day, so an order released without one would sit outside every day view.
    released = client.post(
        f"/api/lot-receiving/orders/{order['id']}/release",
        headers=headers, json={"expected_date": "2026-08-25"},
    )
    assert released.status_code == 200, released.text
    response = client.post(
        f"/api/lot-receiving/orders/{order['id']}/start-receiving",
        headers=headers,
        json={"line_id": order["lines"][0]["id"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------

class TestOrderApi:
    def test_create_release_and_read_back(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        assert order["status"] == "draft"
        assert order["expected_count"] == 8
        assert order["warehouse_id"] == WH
        assert order["origin_name"] == "Chicago 3PL"
        assert order["lines"][0]["product_name"] == "Mango Puree"

        released = client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        )
        assert released.status_code == 200
        assert released.json()["status"] == "in_transit"

    def test_forklift_cannot_create_paperwork(self, client, api_seed, fk_headers):
        """The gun scans. It does not raise orders."""
        response = client.post("/api/lot-receiving/orders", headers=fk_headers, json={
            "lines": [{"product_id": PRODUCT, "expected_count": 5}],
        })
        assert response.status_code == 403

    def test_open_orders_only_by_default(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        client.post(f"/api/lot-receiving/orders/{order['id']}/cancel",
                    headers=wh_headers, json={"reason": "not coming"})

        assert client.get("/api/lot-receiving/orders", headers=wh_headers).json() == []
        with_closed = client.get(
            "/api/lot-receiving/orders?include_closed=true", headers=wh_headers
        ).json()
        assert len(with_closed) == 1
        assert with_closed[0]["status"] == "cancelled"

    def test_start_receiving_returns_the_summary(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        summary = _start(client, wh_headers, order)
        assert summary["expected_count"] == 8
        assert summary["scanned_count"] == 0
        assert summary["count_unit"] == "drums"
        assert summary["source"] == "incoming_order"
        # Built from the vendor's lot number, with a uniqueness marker.
        assert "MG-API" in summary["lot_code"]

    def test_closing_short_without_a_reason_is_rejected(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        _start(client, wh_headers, order)
        response = client.post(
            f"/api/lot-receiving/orders/{order['id']}/close",
            headers=wh_headers, json={"reason": None},
        )
        assert response.status_code == 400
        assert "reason" in response.text.lower()


# ---------------------------------------------------------------------------
# Scanning — the status codes are the point
# ---------------------------------------------------------------------------

class TestScanApi:
    def _session(self, client, headers):
        order = _make_order(client, headers, count=8)
        return _start(client, headers, order)

    def test_a_scan_is_a_200_and_one_shape(self, client, api_seed, wh_headers, fk_headers):
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                  "idempotency_key": "api-scan-0001"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        # Every field the gun redraws from, present on EVERY outcome.
        for key in ("status", "message", "lot_code", "row_id", "row_name",
                    "row_scanned_count", "session_scanned_count",
                    "session_expected_count", "count_unit", "warning", "scan_id"):
            assert key in body
        assert body["session_scanned_count"] == 1
        assert body["count_unit"] == "drums"

    def test_forklift_can_scan(self, client, api_seed, wh_headers, fk_headers):
        """The role that does the scanning is `forklift`, which is absent from
        APPROVAL_ROLES. Gating this endpoint would make the gun unusable."""
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1},
        )
        assert response.status_code == 200

    def test_an_unknown_sticker_is_200_not_4xx(self, client, api_seed, wh_headers, fk_headers):
        """A 4xx here is a scan the warehouse permanently loses — the offline
        queue parks it as failed and the gun drops the driver's row."""
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": "L0000000", "storage_row_id": ROW_1},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "unknown_lot"

    def test_an_unknown_rack_is_200_not_4xx(self, client, api_seed, wh_headers, fk_headers):
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": "row-nope"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "unknown_row"

    def test_a_full_rack_is_200_and_asks(self, client, api_seed, wh_headers, fk_headers):
        """Capacity is 5 in this room. The sixth scan asks; it does not refuse."""
        session = self._session(client, wh_headers)
        url = f"/api/lot-receiving/sessions/{session['receipt_id']}/scan"
        for i in range(5):
            client.post(url, headers=fk_headers, json={
                "lot_code": session["lot_code"], "storage_row_id": ROW_1,
                "idempotency_key": f"api-fill-{i:03d}",
            })

        asked = client.post(url, headers=fk_headers, json={
            "lot_code": session["lot_code"], "storage_row_id": ROW_1,
            "idempotency_key": "api-over-1",
        })
        assert asked.status_code == 200
        assert asked.json()["status"] == "needs_confirm"
        assert asked.json()["warning"] == "row_full"
        assert asked.json()["session_scanned_count"] == 5    # nothing written

        # The gun replays with the SAME key plus the driver's answer.
        confirmed = client.post(url, headers=fk_headers, json={
            "lot_code": session["lot_code"], "storage_row_id": ROW_1,
            "idempotency_key": "api-over-1", "allow_overfill": True,
        })
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "ok"
        assert confirmed.json()["session_scanned_count"] == 6

    def test_a_short_idempotency_key_is_a_422_and_that_is_intended(
        self, client, api_seed, wh_headers, fk_headers
    ):
        """A 422 IS terminal in the queue — which is right for a malformed
        request. The gun mints a long key; a short one is a client bug, not a
        soft question."""
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                  "idempotency_key": "short"},
        )
        assert response.status_code == 422

    def test_a_missing_session_is_a_404(self, client, api_seed, fk_headers):
        """A genuinely absent receipt IS a 4xx. The 200 rule is for questions the
        system understood, not for a request pointing at nothing."""
        response = client.post(
            "/api/lot-receiving/sessions/rcpt-nope/scan",
            headers=fk_headers,
            json={"lot_code": "L0000001", "storage_row_id": ROW_1},
        )
        assert response.status_code == 404

    def test_undo_is_a_200_even_with_nothing_to_undo(self, client, api_seed, wh_headers, fk_headers):
        session = self._session(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/undo", headers=fk_headers
        )
        assert response.status_code == 200
        assert response.json()["status"] == "nothing_to_undo"

    def test_undo_walks_the_count_back(self, client, api_seed, wh_headers, fk_headers):
        session = self._session(client, wh_headers)
        url = f"/api/lot-receiving/sessions/{session['receipt_id']}/scan"
        for i in range(3):
            client.post(url, headers=fk_headers, json={
                "lot_code": session["lot_code"], "storage_row_id": ROW_1,
                "idempotency_key": f"api-u-{i:03d}",
            })
        undone = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/undo", headers=fk_headers
        )
        assert undone.json()["session_scanned_count"] == 2

    def test_the_session_list_shows_both_paths(self, client, api_seed, wh_headers, fk_headers):
        """The gun gets one list. A worker does not care who raised the paperwork."""
        order = _make_order(client, wh_headers)
        _start(client, wh_headers, order)
        sessions = client.get("/api/lot-receiving/sessions", headers=fk_headers).json()
        assert len(sessions) == 1
        assert sessions[0]["source"] == "incoming_order"


# ---------------------------------------------------------------------------
# Rack + lot lookup
# ---------------------------------------------------------------------------

class TestLookupApi:
    def test_a_rack_resolves_by_barcode(self, client, api_seed, fk_headers):
        response = client.get("/api/lot-receiving/resolve-row?code=PA-A01", headers=fk_headers)
        assert response.status_code == 200
        assert response.json()["id"] == ROW_1

    def test_lot_lookup_carries_the_sid(self, client, api_seed, wh_headers, fk_headers):
        """The production app checks SID before a batch, so it has to be
        derivable from the sticker."""
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        response = client.get(
            f"/api/lot-receiving/lots/lookup?code={session['lot_code']}", headers=fk_headers
        )
        assert response.status_code == 200
        body = response.json()
        assert body["product_sid"] == "SID-A"
        assert body["vendor_lot"] == "MG-API"
        assert body["unit_label"] == "drum"
        assert body["weight_per_unit"] == 500.0

    def test_lookup_accepts_the_sb2_envelope(self, client, api_seed, wh_headers, fk_headers):
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        payload = f"SB2|{session['lot_code']}|MG-API|20270401"
        response = client.get(
            "/api/lot-receiving/lots/lookup", params={"code": payload}, headers=fk_headers
        )
        assert response.status_code == 200
        assert response.json()["lot_code"] == session["lot_code"]


# ---------------------------------------------------------------------------
# Stickers
# ---------------------------------------------------------------------------

class TestLabelApi:
    def test_printing_returns_n_identical_stickers(self, client, api_seed, wh_headers):
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 8},
        )
        assert response.status_code == 200
        sheet = response.json()
        assert sheet["count"] == 8
        assert len(sheet["labels"]) == 8
        assert all(label == sheet["labels"][0] for label in sheet["labels"])
        assert sheet["labels"][0]["lot_code"] == session["lot_code"]

    def test_forklift_cannot_print(self, client, api_seed, wh_headers, fk_headers):
        """An identical sticker on the wrong material cannot be found later, so
        printing is not a gun-level action."""
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=fk_headers, json={"count": 8},
        )
        assert response.status_code == 403

    def test_printing_writes_no_stock(self, client, api_seed, wh_headers):
        """Printing is NOT receiving."""
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 8},
        )
        after = client.get(
            f"/api/lot-receiving/sessions/{session['receipt_id']}", headers=wh_headers
        ).json()
        assert after["scanned_count"] == 0

    def test_a_lot_under_review_refuses_to_print(self, client, api_seed, wh_headers, db_session):
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        lot = db_session.query(MaterialLot).filter(
            MaterialLot.lot_code == session["lot_code"]
        ).first()
        lot.needs_review = True
        lot.review_reason = "Two receipts disagree on drum weight"
        db_session.commit()

        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 8},
        )
        assert response.status_code == 409


# ---------------------------------------------------------------------------
# Cutover
# ---------------------------------------------------------------------------

class TestCutoverApi:
    def test_status_walks_the_steps(self, client, api_seed, wh_headers):
        response = client.get("/api/lot-cutover/status", headers=wh_headers)
        assert response.status_code == 200
        assert response.json()["step"] in (
            "zero_out", "opening_balances", "labelling", "complete",
        )

    def test_only_a_supervisor_and_up_sees_the_zero_out_preview(
        self, client, api_seed, fk_headers, admin_headers
    ):
        assert client.get(
            "/api/lot-cutover/zero-out/preview", headers=fk_headers
        ).status_code == 403
        assert client.get(
            "/api/lot-cutover/zero-out/preview", headers=admin_headers
        ).status_code == 200

    def test_the_zero_out_needs_an_explicit_confirm(self, client, api_seed, admin_headers):
        """The one call in the cutover that cannot be undone by pressing
        something else."""
        response = client.post(
            "/api/lot-cutover/zero-out", headers=admin_headers, json={"confirm": False}
        )
        assert response.status_code == 400

    def test_an_opening_balance_creates_stock(self, client, api_seed, wh_headers):
        response = client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT,
            "storage_row_id": ROW_1,
            "full_units": 31,
            "vendor_id": VENDOR,
            "vendor_lot": "OLD-MG",
            "bbd": BBD,
            "unit_label": "drum",
            "weight_per_unit": 500.0,
            "weight_unit": "lbs",
        })
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["full_units"] == 31
        assert body["derived_weight"] == 15500.0
        assert body["needs_labels"] is True

    def test_forklift_cannot_enter_a_count(self, client, api_seed, fk_headers):
        response = client.post("/api/lot-cutover/opening-balance", headers=fk_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 5,
        })
        assert response.status_code == 403

    def test_a_count_reports_its_variance(self, client, api_seed, wh_headers):
        created = client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 40,
            "vendor_lot": "OLD-MG", "unit_label": "drum", "weight_per_unit": 500.0,
        }).json()

        counted = client.post("/api/lot-cutover/count", headers=wh_headers, json={
            "material_lot_id": created["material_lot_id"],
            "storage_row_id": ROW_1,
            "full_units": 38,
            "note": "Month end",
        })
        assert counted.status_code == 200
        assert counted.json()["variance"] == -2
        assert counted.json()["system_units"] == 40

    def test_unlabelled_lots_lists_what_still_needs_stickers(
        self, client, api_seed, wh_headers
    ):
        client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 12,
            "vendor_lot": "OLD-MG", "bbd": BBD, "unit_label": "drum",
            "weight_per_unit": 500.0,
        })
        pending = client.get("/api/lot-cutover/unlabelled-lots", headers=wh_headers).json()
        assert len(pending) == 1
        assert pending[0]["full_units"] == 12
        # Printable: it has a lot number, a best-by and a weight.
        assert pending[0]["blocked_reason"] is None

        client.post(
            f"/api/lot-receiving/lots/{pending[0]['material_lot_id']}/print-labels",
            headers=wh_headers, json={"count": 12},
        )
        assert client.get("/api/lot-cutover/unlabelled-lots", headers=wh_headers).json() == []


# ---------------------------------------------------------------------------
# Cross-warehouse isolation
# ---------------------------------------------------------------------------

class TestWarehouseIsolation:
    """Scoping a LIST is not enough on its own.

    Every id in this API is guessable, and several of these endpoints MOVE
    STOCK. A by-id fetch therefore has to check warehouse membership too, or a
    user at Plant A can scan into, print for, close or count Plant B's material
    just by knowing an id — and under lot identity that is unrecoverable,
    because every drum of the lot wears the same sticker.
    """

    @pytest.fixture
    def foreign_order(self, client, db_session, api_seed, wh_headers):
        """An order that belongs to the OTHER warehouse."""
        from app.models import IngredientIntake

        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        db_session.query(IngredientIntake).filter(
            IngredientIntake.id == order["id"]
        ).update({"warehouse_id": OTHER_WH})
        from app.models import Receipt
        db_session.query(Receipt).filter(
            Receipt.id == session["receipt_id"]
        ).update({"warehouse_id": OTHER_WH})
        db_session.query(MaterialLot).filter(
            MaterialLot.lot_code == session["lot_code"]
        ).update({"warehouse_id": OTHER_WH})
        db_session.commit()
        return order, session

    def test_another_warehouses_order_is_not_readable(
        self, client, foreign_order, wh_headers
    ):
        order, _session = foreign_order
        assert client.get(
            f"/api/lot-receiving/orders/{order['id']}", headers=wh_headers
        ).status_code == 403

    def test_another_warehouses_order_cannot_be_closed(
        self, client, foreign_order, wh_headers
    ):
        order, _session = foreign_order
        assert client.post(
            f"/api/lot-receiving/orders/{order['id']}/close",
            headers=wh_headers, json={"reason": "nope"},
        ).status_code == 403

    def test_another_warehouses_session_cannot_be_scanned_into(
        self, client, foreign_order, fk_headers
    ):
        _order, session = foreign_order
        response = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1},
        )
        assert response.status_code == 403

    def test_another_warehouses_session_cannot_be_undone(
        self, client, foreign_order, fk_headers
    ):
        _order, session = foreign_order
        assert client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/undo", headers=fk_headers
        ).status_code == 403

    def test_another_warehouses_stickers_cannot_be_printed(
        self, client, foreign_order, wh_headers
    ):
        _order, session = foreign_order
        assert client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 4},
        ).status_code == 403

    def test_another_warehouses_lot_cannot_be_counted(
        self, client, api_seed, wh_headers, db_session
    ):
        created = client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 10,
            "vendor_lot": "MG-X", "unit_label": "drum", "weight_per_unit": 500.0,
        }).json()
        db_session.query(MaterialLot).filter(
            MaterialLot.id == created["material_lot_id"]
        ).update({"warehouse_id": OTHER_WH})
        db_session.commit()

        response = client.post("/api/lot-cutover/count", headers=wh_headers, json={
            "material_lot_id": created["material_lot_id"],
            "storage_row_id": ROW_1,
            "full_units": 99,
        })
        assert response.status_code == 403

    def test_the_zero_out_touches_only_the_users_warehouse(
        self, client, api_seed, admin_headers, db_session
    ):
        """It must not be able to wipe every site's receipts at once."""
        from app.enums import ReceiptStatus
        from app.models import Receipt

        for rid, wh in (("r-mine", WH), ("r-theirs", OTHER_WH)):
            db_session.add(Receipt(
                id=rid, product_id=PRODUCT, category_id="cat-ing",
                quantity=1000.0, unit="lbs", warehouse_id=wh,
                status=ReceiptStatus.APPROVED,
            ))
        db_session.commit()

        result = client.post(
            "/api/lot-cutover/zero-out", headers=admin_headers, json={"confirm": True}
        )
        assert result.status_code == 200
        assert db_session.query(Receipt).filter(Receipt.id == "r-mine").first().quantity == 0
        assert db_session.query(Receipt).filter(Receipt.id == "r-theirs").first().quantity == 1000.0


class TestRemainingGates:
    """Gates added after an adversarial review found them missing."""

    def test_forklift_cannot_start_receiving(self, client, api_seed, wh_headers, fk_headers):
        """Not a scan. It creates the paperwork, mints the lot identity, and
        writes the weight-per-unit that every derived pound comes from —
        desk work, and the gun holds the weakest credential in the building."""
        order = _make_order(client, wh_headers)
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        )
        response = client.post(
            f"/api/lot-receiving/orders/{order['id']}/start-receiving",
            headers=fk_headers, json={"line_id": order["lines"][0]["id"]},
        )
        assert response.status_code == 403

    def test_an_opening_balance_cannot_name_another_warehouse(
        self, client, api_seed, wh_headers, db_session
    ):
        """The client does not get to choose whose books it writes to. The field
        is gone from the schema, so naming it is ignored, not honoured."""
        from app.models import MaterialLot as ML

        response = client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 200,
            "vendor_lot": "SNEAK-1", "unit_label": "drum", "weight_per_unit": 500.0,
            "warehouse_id": OTHER_WH,
        })
        assert response.status_code == 200
        lot = db_session.query(ML).filter(
            ML.id == response.json()["material_lot_id"]
        ).first()
        assert lot.warehouse_id == WH

    def test_an_incoming_order_is_invisible_to_the_legacy_intake_screen(
        self, client, api_seed, wh_headers
    ):
        """They share a table. The legacy per-drum endpoints only guard on status
        and on whether CONTAINERS exist — and an incoming order has none by
        construction, so void would have gone straight through."""
        order = _make_order(client, wh_headers)

        listed = client.get("/api/ingredient-intakes/", headers=wh_headers).json()
        assert all(item["id"] != order["id"] for item in listed.get("items", []))

        assert client.get(
            f"/api/ingredient-intakes/{order['id']}", headers=wh_headers
        ).status_code == 404
        assert client.post(
            f"/api/ingredient-intakes/{order['id']}/void",
            headers=wh_headers, json={"reason": "nope"},
        ).status_code == 404

    def test_a_weightless_line_is_flagged_and_cannot_print(
        self, client, api_seed, wh_headers
    ):
        """Pounds are derived from weight-per-unit, so a NULL one makes scanned
        material read as zero stock to production. The lot is flagged, which
        stops stickers — and nothing can be scanned in without a sticker."""
        response = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "NO-WT",
                "expected_count": 10, "unit_label": "drum",
            }],
        })
        order = response.json()
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        )
        summary = client.post(
            f"/api/lot-receiving/orders/{order['id']}/start-receiving",
            headers=wh_headers, json={"line_id": order["lines"][0]["id"]},
        ).json()
        assert summary["needs_review"] is True

        printed = client.post(
            f"/api/lot-receiving/sessions/{summary['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 10},
        )
        assert printed.status_code == 409

    def test_a_receipt_from_an_order_carries_a_category(
        self, client, api_seed, wh_headers, db_session
    ):
        """`IN (...)` never matches NULL, so a receipt with no category is
        invisible to every category-scoped report in the app."""
        from app.models import Receipt

        from app.models import IntakeLot

        # Deliberately NOT sending category_id — the UI has no field for it, so
        # this is what every real order looks like. It has to come from Product.
        order = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "CAT-1", "expected_count": 4,
                "unit_label": "drum", "weight_per_unit": 500.0, "weight_unit": "lbs",
            }],
        }).json()
        assert db_session.query(IntakeLot).filter(
            IntakeLot.id == order["lines"][0]["id"]
        ).first().category_id == "cat-ing"

        summary = _start(client, wh_headers, order)
        receipt = db_session.query(Receipt).filter(
            Receipt.id == summary["receipt_id"]
        ).first()
        assert receipt.category_id == "cat-ing"


class TestWeightUnitIsAskedNotAssumed:
    """A wrong weight unit is out by 2.2x in every pound the system derives, so
    the receiving form asks rather than defaulting silently."""

    def test_the_plant_can_correct_the_unit_against_the_bol(
        self, client, api_seed, wh_headers, db_session
    ):
        from app.models import IntakeLot, MaterialLot as ML, Receipt

        order = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "UNIT-1", "expected_count": 10,
                "unit_label": "drum", "weight_per_unit": 200.0, "weight_unit": "kg",
            }],
        }).json()
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        )

        # The paperwork actually said pounds.
        summary = client.post(
            f"/api/lot-receiving/orders/{order['id']}/start-receiving",
            headers=wh_headers,
            json={"line_id": order["lines"][0]["id"],
                  "weight_per_unit": 440.0, "weight_unit": "lbs"},
        ).json()

        receipt = db_session.query(Receipt).filter(
            Receipt.id == summary["receipt_id"]
        ).first()
        assert receipt.weight_unit == "lbs"
        assert receipt.weight_per_container == 440.0
        # Derived total follows the corrected figure, not corporate's.
        assert receipt.quantity == 4400.0
        assert receipt.unit == "lbs"

        lot = db_session.query(ML).filter(ML.id == receipt.material_lot_id).first()
        assert lot.weight_unit == "lbs"
        # And the correction is written back onto the order line, so the next
        # person to look at the order sees what actually arrived.
        line = db_session.query(IntakeLot).filter(
            IntakeLot.id == order["lines"][0]["id"]
        ).first()
        assert line.weight_unit == "lbs"
        assert line.net_weight_per_container == 440.0


class TestCalendarDatesSurviveTheRoundTrip:
    """A BBD is a CALENDAR DAY, not an instant, and it gets printed on a
    food-safety label. Two separate things conspire to shift it by a day.

    ON THE WAY IN: `<input type="date">` posts a bare `YYYY-MM-DD`, which
    Pydantic 2.5 rejects for a datetime field with a 422 the person filling the
    form cannot act on.

    ON THE WAY OUT: Postgres returns a timestamptz in the SESSION timezone. This
    database runs America/Chicago, so midnight UTC comes back as
    `...T18:00:00-06:00` and every lexical reader — including the label encoder —
    takes the leading ten characters and gets the PREVIOUS DAY.
    """

    def test_a_bare_date_is_accepted_and_read_back_unchanged(
        self, client, api_seed, wh_headers
    ):
        response = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "expected_date": "2026-08-25",
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "CAL-1", "bbd": "2027-02-15",
                "expected_count": 4, "unit_label": "drum", "weight_per_unit": 500.0,
            }],
        })
        assert response.status_code == 200, response.text
        order = response.json()
        assert order["expected_date"] == "2026-08-25"
        assert order["lines"][0]["bbd"] == "2027-02-15"

        # And on a fresh read, not just the create response.
        again = client.get(
            f"/api/lot-receiving/orders/{order['id']}", headers=wh_headers
        ).json()
        assert again["lines"][0]["bbd"] == "2027-02-15"

    def test_a_full_timestamp_still_works(self, client, api_seed, wh_headers):
        """Anything posting the old way must keep working."""
        order = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "CAL-2",
                "bbd": "2027-02-15T00:00:00Z", "expected_count": 4,
                "unit_label": "drum", "weight_per_unit": 500.0,
            }],
        }).json()
        assert order["lines"][0]["bbd"] == "2027-02-15"

    def test_the_printed_label_carries_the_day_that_was_typed(
        self, client, api_seed, wh_headers
    ):
        """The one that actually matters — this date goes on a drum."""
        order = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "CAL-3", "bbd": "2027-02-15",
                "expected_count": 2, "unit_label": "drum", "weight_per_unit": 500.0,
            }],
        }).json()
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/release",
            headers=wh_headers, json={"expected_date": "2026-08-25"},
        )
        summary = client.post(
            f"/api/lot-receiving/orders/{order['id']}/start-receiving",
            headers=wh_headers, json={"line_id": order["lines"][0]["id"]},
        ).json()
        assert summary["bbd"] == "2027-02-15"

        sheet = client.post(
            f"/api/lot-receiving/sessions/{summary['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 2},
        ).json()
        assert sheet["labels"][0]["bbd"] == "2027-02-15"
        assert sheet["labels"][0] == sheet["labels"][1]

    def test_an_opening_balance_takes_a_bare_date_too(
        self, client, api_seed, wh_headers
    ):
        response = client.post("/api/lot-cutover/opening-balance", headers=wh_headers, json={
            "product_id": PRODUCT, "storage_row_id": ROW_1, "full_units": 5,
            "vendor_lot": "CAL-4", "bbd": "2027-06-30", "unit_label": "drum",
            "weight_per_unit": 500.0,
        })
        assert response.status_code == 200, response.text
        pending = client.get("/api/lot-cutover/unlabelled-lots", headers=wh_headers).json()
        assert [p for p in pending if p["vendor_lot"] == "CAL-4"][0]["bbd"] == "2027-06-30"

    def test_a_malformed_date_is_still_rejected(self, client, api_seed, wh_headers):
        """The coercion must not swallow genuine nonsense."""
        response = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR, "expected_date": "not-a-date",
            "lines": [{"product_id": PRODUCT, "expected_count": 1}],
        })
        assert response.status_code == 422


class TestReprintIsAlwaysAvailable:
    """Anything can happen on a dock: a sticker tears, one lands face-down in the
    freezer, the printer jams halfway through eighty.

    Under lot identity a reprint is TRIVIALLY the same sticker — there is no
    serial to keep in step, no sequence to resume, and no way to mint a second
    identity for the same drums. That guarantee is what the per-drum design
    needed a locked counter to provide.
    """

    def _session(self, client, headers):
        order = _make_order(client, headers, count=8)
        return _start(client, headers, order)

    def test_reprinting_gives_the_identical_sticker(self, client, api_seed, wh_headers):
        session = self._session(client, wh_headers)
        url = f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels"

        first = client.post(url, headers=wh_headers, json={"count": 8}).json()
        second = client.post(url, headers=wh_headers, json={"count": 3}).json()

        assert second["count"] == 3
        assert second["labels"][0] == first["labels"][0]
        assert second["lot_code"] == first["lot_code"]

    def test_reprinting_creates_no_stock(self, client, api_seed, wh_headers):
        session = self._session(client, wh_headers)
        url = f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels"
        for _ in range(3):
            client.post(url, headers=wh_headers, json={"count": 8})

        after = client.get(
            f"/api/lot-receiving/sessions/{session['receipt_id']}", headers=wh_headers
        ).json()
        assert after["scanned_count"] == 0

    def test_reprinting_works_mid_receiving(self, client, api_seed, wh_headers, fk_headers):
        """The case that matters: half the drums are already scanned in and a
        sticker on the pallet tears."""
        session = self._session(client, wh_headers)
        for i in range(4):
            # Assert the scan LANDED. An earlier version of this test used a
            # 6-character idempotency key, which 422s on min_length=8 — so every
            # scan silently failed and the test still "passed" its later checks
            # for the wrong reason. Never fire a scan without checking it.
            scanned = client.post(
                f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
                headers=fk_headers,
                json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                      "idempotency_key": f"rp-scan-{i:03d}", "allow_overfill": True},
            )
            assert scanned.status_code == 200, scanned.text
            assert scanned.json()["status"] == "ok"
        sheet = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels",
            headers=wh_headers, json={"count": 1},
        )
        assert sheet.status_code == 200
        assert sheet.json()["labels"][0]["lot_code"] == session["lot_code"]

        # And the count is untouched by the reprint.
        after = client.get(
            f"/api/lot-receiving/sessions/{session['receipt_id']}", headers=wh_headers
        ).json()
        assert after["scanned_count"] == 4


class TestSchedulingIsASeparateStep:
    """Creating an order and committing it to a day are different moments.

    Corporate raises it as soon as they have the PO; the arrival slot is agreed
    with the carrier afterwards. So a draft with no date is a normal state, and
    the date is required only when the order becomes something a plant is
    expected to act on.
    """

    def _draft(self, client, headers):
        return client.post("/api/lot-receiving/orders", headers=headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "SCH-1", "bbd": BBD,
                "expected_count": 40, "unit_label": "drum", "weight_per_unit": 500.0,
            }],
        }).json()

    def test_a_draft_needs_no_date(self, client, api_seed, wh_headers):
        order = self._draft(client, wh_headers)
        assert order["status"] == "draft"
        assert order["expected_date"] is None

    def test_releasing_without_a_date_is_refused(self, client, api_seed, wh_headers):
        """An order released with no day would sit outside every day view and be
        found only by somebody who thought to look for it."""
        order = self._draft(client, wh_headers)
        response = client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers, json={},
        )
        assert response.status_code == 400
        assert "day" in response.text.lower()
        assert client.get(
            f"/api/lot-receiving/orders/{order['id']}", headers=wh_headers
        ).json()["status"] == "draft"

    def test_releasing_records_the_slot(self, client, api_seed, wh_headers):
        order = self._draft(client, wh_headers)
        released = client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers,
            json={"expected_date": "2026-08-27", "expected_time": "07:00 AM"},
        ).json()
        assert released["status"] == "in_transit"
        assert released["expected_date"] == "2026-08-27"
        assert released["expected_time"] == "07:00 AM"

    def test_the_time_is_optional(self, client, api_seed, wh_headers):
        """A carrier does not always quote one, and nothing computes with it."""
        order = self._draft(client, wh_headers)
        released = client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers,
            json={"expected_date": "2026-08-27"},
        ).json()
        assert released["status"] == "in_transit"
        assert released["expected_time"] is None

    def test_the_day_filter_selects_that_day(self, client, api_seed, wh_headers):
        order = self._draft(client, wh_headers)
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers,
            json={"expected_date": "2026-08-27"},
        )
        on_day = client.get(
            "/api/lot-receiving/orders?date=2026-08-27", headers=wh_headers
        ).json()
        assert [o["order_number"] for o in on_day] == [order["order_number"]]

        off_day = client.get(
            "/api/lot-receiving/orders?date=2026-08-28", headers=wh_headers
        ).json()
        assert off_day == []

    def test_drafts_appear_on_every_day(self, client, api_seed, wh_headers):
        """A draft has no arrival day — that is what makes it a draft — so
        filtering it out of a day view would hide corporate's own backlog from
        them on every single day."""
        draft = self._draft(client, wh_headers)
        for day in ("2026-08-27", "2026-09-15", "2027-01-01"):
            listed = client.get(
                f"/api/lot-receiving/orders?date={day}", headers=wh_headers
            ).json()
            assert draft["order_number"] in [o["order_number"] for o in listed]

    def test_a_released_order_leaves_the_draft_group(self, client, api_seed, wh_headers):
        draft = self._draft(client, wh_headers)
        client.post(
            f"/api/lot-receiving/orders/{draft['id']}/release", headers=wh_headers,
            json={"expected_date": "2026-08-27"},
        )
        elsewhere = client.get(
            "/api/lot-receiving/orders?date=2026-09-01", headers=wh_headers
        ).json()
        assert elsewhere == []

    def test_a_malformed_day_is_rejected(self, client, api_seed, wh_headers):
        assert client.get(
            "/api/lot-receiving/orders?date=27-08-2026", headers=wh_headers
        ).status_code == 400

    def test_releasing_twice_is_refused(self, client, api_seed, wh_headers):
        order = self._draft(client, wh_headers)
        body = {"expected_date": "2026-08-27"}
        assert client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers, json=body,
        ).status_code == 200
        assert client.post(
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers, json=body,
        ).status_code == 409


class TestClosingAnOrderClearsTheGun:
    """Closing an order does not touch its receipts, so a session filtered only
    on receipt status stayed on the gun forever with nothing left to scan."""

    def _received(self, client, headers):
        order = _make_order(client, headers, count=8)
        session = _start(client, headers, order)
        return order, session

    def test_a_closed_order_leaves_the_session_list(self, client, api_seed, wh_headers, fk_headers):
        order, _session = self._received(client, wh_headers)
        assert len(client.get("/api/lot-receiving/sessions", headers=fk_headers).json()) == 1

        client.post(
            f"/api/lot-receiving/orders/{order['id']}/close",
            headers=wh_headers, json={"reason": "truck was short"},
        )
        assert client.get("/api/lot-receiving/sessions", headers=fk_headers).json() == []

    def test_a_cancelled_order_leaves_too(self, client, api_seed, wh_headers, fk_headers):
        order, _session = self._received(client, wh_headers)
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/cancel",
            headers=wh_headers, json={"reason": "not coming"},
        )
        assert client.get("/api/lot-receiving/sessions", headers=fk_headers).json() == []

    def test_an_open_order_stays(self, client, api_seed, wh_headers, fk_headers):
        self._received(client, wh_headers)
        assert len(client.get("/api/lot-receiving/sessions", headers=fk_headers).json()) == 1

    def test_a_walk_in_is_unaffected(self, client, api_seed, wh_headers, fk_headers, db_session):
        """A walk-in has no order, so its receipt status IS its lifecycle. The
        order filter must not touch it."""
        from app.enums import ReceiptStatus as RS
        from app.models import Receipt
        from datetime import datetime, timezone as tz

        receipt = Receipt(
            id="rcpt-walkin-gun", product_id=PRODUCT, category_id="cat-ing",
            lot_number="WI-9", expiration_date=datetime(2027, 4, 1, tzinfo=tz.utc),
            quantity=5000.0, unit="lbs", container_count=10, container_unit="drums",
            weight_per_container=500.0, weight_unit="lbs", warehouse_id=WH,
            status=RS.RECORDED, receipt_date=datetime(2026, 8, 20, tzinfo=tz.utc),
        )
        db_session.add(receipt)
        db_session.commit()
        client.post(
            f"/api/lot-receiving/sessions/{receipt.id}/print-labels",
            headers=wh_headers, json={"count": 10},
        )
        sessions = client.get("/api/lot-receiving/sessions", headers=fk_headers).json()
        assert [s["source"] for s in sessions].count("walk_in") == 1

    def test_a_scan_that_arrives_after_closing_is_still_recorded(
        self, client, api_seed, wh_headers, fk_headers
    ):
        """The list stops ADVERTISING a closed session; it does not refuse the
        scan. A queued offline scan draining after the order was closed is a drum
        that physically exists on a rack — dropping it would lose real stock."""
        order, session = self._received(client, wh_headers)
        client.post(
            f"/api/lot-receiving/orders/{order['id']}/close",
            headers=wh_headers, json={"reason": "closed early"},
        )
        late = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                  "idempotency_key": "late-after-close-1"},
        )
        assert late.status_code == 200
        assert late.json()["status"] == "ok"
        assert late.json()["session_scanned_count"] == 1


class TestPalletisedMaterial:
    """Bags and boxes arrive 40-70 to a wrapped pallet.

    Nobody is going to destack one at the dock to sticker every bag, so
    receiving scans ONE sticker on the pallet and tells the gun how many are
    under it. Without that, 500 bags means 500 trigger-pulls.

    The sticker is IDENTICAL either way — same lot, same code, same QR — with
    one word different in the middle band so a person can see whether they hold
    a bag or a pallet of them. A bag does not become different material by
    coming off a pallet.
    """

    def _bagged(self, client, headers, *, count=500, per_pallet=50):
        order = client.post("/api/lot-receiving/orders", headers=headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "BAG-1", "bbd": BBD,
                "expected_count": count, "unit_label": "bag",
                "weight_per_unit": 25.0, "units_per_pallet": per_pallet,
            }],
        }).json()
        return order, _start(client, headers, order)

    def test_the_pallet_size_reaches_the_gun(self, client, api_seed, wh_headers):
        order, session = self._bagged(client, wh_headers)
        assert order["lines"][0]["units_per_pallet"] == 50
        assert session["units_per_pallet"] == 50
        assert session["count_unit"] == "bags"

    def test_ten_scans_book_five_hundred_bags(self, client, api_seed, wh_headers, fk_headers):
        """The whole point. One scan per pallet, not one per bag."""
        _order, session = self._bagged(client, wh_headers)
        for i in range(10):
            r = client.post(
                f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
                headers=fk_headers,
                json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                      "units": 50, "allow_overfill": True,
                      "idempotency_key": f"pallet-{i:03d}"},
            )
            assert r.status_code == 200, r.text
        assert r.json()["session_scanned_count"] == 500

    def test_a_loose_bag_still_counts_as_one(self, client, api_seed, wh_headers, fk_headers):
        """A broken pallet's bags scan one at a time — same sticker, no multiplier."""
        _order, session = self._bagged(client, wh_headers)
        client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                  "units": 50, "allow_overfill": True, "idempotency_key": "mix-pallet"},
        )
        one = client.post(
            f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
            headers=fk_headers,
            json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                  "allow_overfill": True, "idempotency_key": "mix-single"},
        )
        assert one.json()["session_scanned_count"] == 51

    def test_a_replayed_pallet_scan_books_fifty_once(self, client, api_seed, wh_headers, fk_headers):
        """A multiplier makes a double-count 50x worse, so the idempotency key
        matters more here than anywhere."""
        _order, session = self._bagged(client, wh_headers)
        for _ in range(3):
            r = client.post(
                f"/api/lot-receiving/sessions/{session['receipt_id']}/scan",
                headers=fk_headers,
                json={"lot_code": session["lot_code"], "storage_row_id": ROW_1,
                      "units": 50, "allow_overfill": True,
                      "idempotency_key": "replayed-pallet-1"},
            )
        assert r.json()["session_scanned_count"] == 50

    def test_a_pallet_sticker_is_the_same_sticker(self, client, api_seed, wh_headers):
        """Only the band differs. Same lot, same code, same QR — so scanning
        either resolves to the same material."""
        _order, session = self._bagged(client, wh_headers)
        url = f"/api/lot-receiving/sessions/{session['receipt_id']}/print-labels"

        pallets = client.post(url, headers=wh_headers,
                              json={"count": 10, "scope": "pallet"}).json()
        bags = client.post(url, headers=wh_headers,
                           json={"count": 2, "scope": "unit"}).json()

        assert pallets["scope"] == "pallet" and bags["scope"] == "unit"
        assert pallets["labels"][0]["pack_scope"] == "pallet"
        assert bags["labels"][0]["pack_scope"] == "unit"
        # The identity is identical; only the printed band is not.
        assert pallets["labels"][0]["lot_code"] == bags["labels"][0]["lot_code"]
        assert pallets["labels"][0]["vendor_lot"] == bags["labels"][0]["vendor_lot"]
        assert pallets["labels"][0]["bbd"] == bags["labels"][0]["bbd"]

    def test_drums_have_no_pallet_size(self, client, api_seed, wh_headers):
        """Individually stickered, so one scan is one drum and the gun never
        shows a multiplier."""
        order = _make_order(client, wh_headers)
        session = _start(client, wh_headers, order)
        assert session["units_per_pallet"] is None

    def test_the_plant_can_correct_the_pallet_size(self, client, api_seed, wh_headers):
        """The order said 50 to a pallet; the truck brought 40. A wrong number
        here books the wrong count on every scan."""
        order, _ = self._bagged(client, wh_headers, per_pallet=50)
        # A second line so there is something still unstarted to correct.
        order2 = client.post("/api/lot-receiving/orders", headers=wh_headers, json={
            "vendor_id": VENDOR,
            "lines": [{
                "product_id": PRODUCT, "vendor_lot": "BAG-2", "bbd": BBD,
                "expected_count": 400, "unit_label": "bag",
                "weight_per_unit": 25.0, "units_per_pallet": 50,
            }],
        }).json()
        client.post(f"/api/lot-receiving/orders/{order2['id']}/release",
                    headers=wh_headers, json={"expected_date": "2026-08-25"})
        summary = client.post(
            f"/api/lot-receiving/orders/{order2['id']}/start-receiving",
            headers=wh_headers,
            json={"line_id": order2["lines"][0]["id"], "units_per_pallet": 40},
        ).json()
        assert summary["units_per_pallet"] == 40
