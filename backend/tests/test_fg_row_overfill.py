"""
Finished-goods row capacity is a SOFT prompt, not a block.

The situation this exists for: a rack the system believes is full is routinely
empty. Pallets leave without being scanned out — shipped, or moved rack to rack —
so the licences (or the counter) still point at the row. The driver who comes to
load it next used to be refused partway through, standing in front of racking he
could see was empty.

So a full row now answers `needs_confirm` and writes nothing; the gun asks the
driver once and re-sends with `allow_overfill`. The over-fill is accepted at the
point of work and reconciled later, rather than blocking on a count we know drifts.
"""
import pytest

from app.models import (
    User, Warehouse, Category, Product, ProductionLine,
    Location, SubLocation, StorageArea, StorageRow, PalletLicence,
)
from app.utils.auth import get_password_hash, create_access_token
from app.services import scanner_service


@pytest.fixture
def plant(db_session):
    """One driver, one line, one product, one 1-slot rack the system thinks is full.

    `occupied_pallets=1` against zero live pallets is the real-world shape: the
    counter (or a stale licence) says occupied, the rack is physically empty.
    """
    wh = Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True)
    driver = User(
        id="fk-1", username="driver", name="Driver", email="driver@plant.com",
        hashed_password=get_password_hash("pw"), role="forklift",
        is_active=True, warehouse_id="wh-a",
    )
    cat = Category(id="cat-fg", name="Finished", type="finished")
    line = ProductionLine(id="line-1", name="L1", warehouse_id="wh-a", is_active=True)
    mango = Product(id="p-mango", name="Mango", category_id="cat-fg", short_code="MANGO",
                    is_active=True, default_cases_per_pallet=50, expire_years=1)
    loc = Location(id="loc-1", name="Main", warehouse_id="wh-a")
    subloc = SubLocation(id="subloc-1", name="Sub", location_id="loc-1")
    area = StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="subloc-1")
    full_row = StorageRow(id="row-full", name="AA11", sub_location_id="subloc-1",
                          storage_area_id="area-1", pallet_capacity=1, occupied_pallets=1)
    open_row = StorageRow(id="row-open", name="AA12", sub_location_id="subloc-1",
                          storage_area_id="area-1", pallet_capacity=10, occupied_pallets=0)
    db_session.add_all([wh, driver, cat, line, mango, loc, subloc, area, full_row, open_row])
    db_session.commit()
    return {"driver": driver}


def _pallets_on(db, row_id):
    return db.query(PalletLicence).filter(PalletLicence.storage_row_id == row_id).count()


def test_full_row_asks_instead_of_refusing(db_session, plant):
    """The scan is not rejected — it comes back as a question, having written nothing."""
    fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", plant["driver"])

    result = scanner_service.scan_pallet(
        db_session, fr.id, "MP06226L1-MANGO-001", "row-full",
        False, None, plant["driver"],
    )

    assert result["status"] == "needs_confirm"
    assert result["warning"] == "row_full"
    assert "AA11" in result["message"]
    # Nothing recorded: the driver has not answered yet.
    assert _pallets_on(db_session, "row-full") == 0
    assert fr.total_full_pallets == 0


def test_confirmed_scan_lands_over_capacity(db_session, plant):
    """After the driver taps Continue, the pallet goes on the rack — past capacity."""
    fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", plant["driver"])

    result = scanner_service.scan_pallet(
        db_session, fr.id, "MP06226L1-MANGO-001", "row-full",
        False, None, plant["driver"], allow_overfill=True,
    )

    assert result["status"] == "scanned"
    assert _pallets_on(db_session, "row-full") == 1
    assert fr.total_full_pallets == 1


def test_keeps_loading_once_confirmed(db_session, plant):
    """The prompt is answered per rack, not per pallet: later scans just land."""
    fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", plant["driver"])

    for seq in (1, 2, 3):
        out = scanner_service.scan_pallet(
            db_session, fr.id, f"MP06226L1-MANGO-{seq:03d}", "row-full",
            False, None, plant["driver"], allow_overfill=True,
        )
        assert out["status"] == "scanned"

    assert _pallets_on(db_session, "row-full") == 3


def test_room_left_means_no_prompt(db_session, plant):
    """A rack with space behaves exactly as before — no question, no flag needed."""
    fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", plant["driver"])

    result = scanner_service.scan_pallet(
        db_session, fr.id, "MP06226L1-MANGO-001", "row-open",
        False, None, plant["driver"],
    )

    assert result["status"] == "scanned"
    assert result["row_available"] == 9


def test_over_the_wire(client, db_session, plant):
    """Through the endpoint, not just the service.

    Two things only this level catches: `allow_overfill` surviving the request
    schema, and the prompt coming back as 200. A 4xx would make the gun's offline
    queue park the scan as permanently failed and throw away the driver's pallet.
    """
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': 'driver'})}"}
    fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", plant["driver"])

    asked = client.post(
        f"/api/scanner/requests/{fr.id}/scan",
        json={"licence_number": "MP06226L1-MANGO-001", "storage_row_id": "row-full"},
        headers=headers,
    )
    assert asked.status_code == 200, "a full rack must not come back as an error"
    assert asked.json()["status"] == "needs_confirm"

    answered = client.post(
        f"/api/scanner/requests/{fr.id}/scan",
        json={
            "licence_number": "MP06226L1-MANGO-001",
            "storage_row_id": "row-full",
            "allow_overfill": True,
        },
        headers=headers,
    )
    assert answered.status_code == 200
    assert answered.json()["status"] == "scanned"
    assert _pallets_on(db_session, "row-full") == 1
