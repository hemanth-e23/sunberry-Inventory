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
    client.post(f"/api/lot-receiving/orders/{order['id']}/release", headers=headers)
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
            f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers
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
        assert summary["lot_code"].startswith("L")

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
            "vendor_lot": "OLD-MG", "unit_label": "drum", "weight_per_unit": 500.0,
        })
        pending = client.get("/api/lot-cutover/unlabelled-lots", headers=wh_headers).json()
        assert len(pending) == 1
        assert pending[0]["full_units"] == 12

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
        client.post(f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers)
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
        client.post(f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers)
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
        client.post(f"/api/lot-receiving/orders/{order['id']}/release", headers=wh_headers)

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
