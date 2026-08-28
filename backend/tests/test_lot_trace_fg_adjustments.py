"""A donated Finished Goods lot must still report what it originally held.

Reported from production: a 128 OZ Green Tea lot (MP22026L1) that had been
donated out showed "Initial Qty: 0 cases", "Current On Hand 0", status
Depleted, and an activity timeline containing nothing but "Received". It read
as though the adjustment had erased the lot's history.

The stock maths was never wrong. `adjustment_service.approve_adjustment`
reaches the receipt through `pallet.receipt_id`, so 500 - 100 = 400 was
computed correctly every time.

The reports were blind. An FG adjustment is submitted with
`pallet_licence_ids` *instead of* a receipt (InventoryContext.jsx:664) and the
router never derives one, so its `receipt_id` is NULL. Both report paths
filtered on exactly that column:

    initial_receipt_qty      -> initial = current + shipped + 0  -> 0
    lot trace timeline       -> the donation event never appeared

so the drawn-down cases were never added back and the donation was invisible.
"""
import pytest

from app.models import (
    Category, CategoryGroup, Product, Location, SubLocation,
    StorageArea, StorageRow, Receipt, PalletLicence,
)


@pytest.fixture
def green_tea_lot(db_session):
    """500 cases of one FG lot across 10 pallets of 50."""
    db_session.add(CategoryGroup(id="grp", name="Group"))
    db_session.add(Category(id="cat-fg", name="Finished", type="finished", parent_id="grp"))
    db_session.add(Product(id="prod-gt", name="128 OZ GREEN TEA", category_id="cat-fg"))
    db_session.add(Location(id="loc-1", name="Plant"))
    db_session.add(SubLocation(id="sub-1", name="WH", location_id="loc-1"))
    db_session.add(StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="sub-1"))
    db_session.add(StorageRow(
        id="row-1", name="AA11", sub_location_id="sub-1", storage_area_id="area-1",
        pallet_capacity=15, occupied_pallets=10, occupied_cases=500, product_id="prod-gt",
    ))
    db_session.add(Receipt(
        id="rec-gt", product_id="prod-gt", category_id="cat-fg", lot_number="MP22026L1",
        quantity=500, unit="cases", status="approved", cases_per_pallet=50,
    ))
    for i in range(1, 11):
        db_session.add(PalletLicence(
            id=f"pl-{i}", licence_number=f"MP22026L1-GRT128-{i:03d}", receipt_id="rec-gt",
            product_id="prod-gt", storage_area_id="area-1", storage_row_id="row-1",
            cases=50, status="in_stock",
        ))
    db_session.commit()
    return db_session


def _donate(client, auth_headers, admin_auth_headers, pallet_ids):
    """Submit and approve an FG donation for the given pallets."""
    created = client.post(
        "/api/inventory/adjustments",
        json={
            "product_id": "prod-gt",
            "adjustment_type": "donation",
            "reason": "Donated to food bank",
            "pallet_licence_ids": pallet_ids,
        },
        headers=auth_headers,
    )
    assert created.status_code == 200, created.text
    adj_id = created.json()["id"]

    approved = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve",
        headers=admin_auth_headers,
    )
    assert approved.status_code == 200, approved.text
    return adj_id


def _trace(client, auth_headers):
    r = client.get("/api/reports/lot-trace", params={"lot_number": "MP22026L1"}, headers=auth_headers)
    assert r.status_code == 200, r.text
    payload = r.json()
    receipts = payload["receipts"] if isinstance(payload, dict) else payload
    return next(x for x in receipts if x["receipt_id"] == "rec-gt")


@pytest.mark.integration
def test_partial_donation_reports_the_original_quantity(
    client, auth_headers, admin_auth_headers, green_tea_lot
):
    """500 on hand, donate 100 -> the report reads 500 initial, 400 now."""
    _donate(client, auth_headers, admin_auth_headers, ["pl-1", "pl-2"])

    receipt = _trace(client, auth_headers)
    assert receipt["current_quantity"] == 400
    # Was 400 before the fix: the 100 donated cases were never added back.
    assert receipt["initial_quantity"] == 500


@pytest.mark.integration
def test_fully_donated_lot_does_not_report_zero_initial(
    client, auth_headers, admin_auth_headers, green_tea_lot
):
    """The exact production case: every pallet donated.

    On hand legitimately reaches 0 and the receipt is Depleted, but the lot
    still held 500 cases and the report has to say so.
    """
    _donate(client, auth_headers, admin_auth_headers, [f"pl-{i}" for i in range(1, 11)])

    receipt = _trace(client, auth_headers)
    assert receipt["current_quantity"] == 0
    assert receipt["initial_quantity"] == 500, "a depleted lot must still show what it held"


@pytest.mark.integration
def test_donation_appears_on_the_timeline(
    client, auth_headers, admin_auth_headers, green_tea_lot
):
    """The timeline showed only 'Received' — the donation has to be on it."""
    _donate(client, auth_headers, admin_auth_headers, ["pl-1", "pl-2"])

    receipt = _trace(client, auth_headers)
    events = receipt["timeline"]

    received = next(e for e in events if e["event_type"] == "received")
    assert received["qty"] == 500

    donation = next(
        (e for e in events if e["event_type"] == "donation"), None
    )
    assert donation is not None, f"no donation event on the timeline: {[e['event_type'] for e in events]}"
    assert donation["qty"] == 100
    assert donation["notes"] == "Donated to food bank"


@pytest.mark.integration
def test_adjustment_is_counted_once(
    client, auth_headers, admin_auth_headers, green_tea_lot, db_session
):
    """Guards the dedupe.

    An adjustment reachable BOTH by receipt_id and through its pallets must be
    counted a single time, so populating receipt_id at creation later cannot
    silently double the initial quantity.
    """
    from app.models import InventoryAdjustment

    adj_id = _donate(client, auth_headers, admin_auth_headers, ["pl-1", "pl-2"])

    adj = db_session.query(InventoryAdjustment).filter_by(id=adj_id).first()
    adj.receipt_id = "rec-gt"          # now findable down both paths
    db_session.commit()

    receipt = _trace(client, auth_headers)
    assert receipt["initial_quantity"] == 500, "counted twice — 600 means the dedupe broke"
    assert sum(1 for e in receipt["timeline"] if e["event_type"] == "donation") == 1
