"""A forklift session that runs through midnight holds two lots. One column doesn't.

`forklift_requests.lot_number` is a single field, but production crossing
midnight rolls the lot while the driver keeps scanning. Everything keyed on that
one column could therefore only ever see the primary lot, and the secondary one
was treated as if nothing existed for it anywhere.

Two symptoms, both reported from production within a week:

  * A 27-pallet session showed "196 missing". It held 26 pallets of MP26126L1
    plus a single MP26026L1 pallet at sequence 195. Coverage was looked up once,
    for the header lot, so the MP26026L1 group got none and every sequence from
    1 to 194 was flagged — while 183 of those pallets sat in stock from two
    earlier sessions.

  * "Skip — Not Produced" answered invalid_or_wrong_lot for every genuine gap,
    because it compared each licence against the header lot. On a rollover
    session that rejects half the pallets, so the session could not be closed.

The approval gate never had this bug: _unresolved_missing_for_fr takes the lot
from each licence prefix. These tests pin the read path and the skip path to the
same rule.
"""
import pytest

from app.models import (
    Category, CategoryGroup, Product, Location, SubLocation,
    StorageArea, StorageRow, ForkliftRequest, PalletLicence, User,
)
from app.utils.auth import get_password_hash, create_access_token


@pytest.fixture
def supervisor_headers(db_session):
    """mark-not-produced allows forklift/admin/supervisor — not superadmin,
    so conftest's admin_auth_headers is refused by this endpoint."""
    user = User(
        id="sup-user-1", username="supervisor", name="Sup Ervisor",
        email="sup@sunberry.com", hashed_password=get_password_hash("pw123456789"),
        role="supervisor", is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    token = create_access_token(data={"sub": user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def rollover_session(db_session):
    """26 pallets of MP26126L1 (seq 2-28) + 1 of MP26026L1 (seq 195).

    MP26026L1 sequences 1-183 already exist on a separate, earlier session, so
    nothing below 195 is genuinely missing except the gaps left in that session.
    """
    db_session.add(CategoryGroup(id="grp", name="Group"))
    db_session.add(Category(id="cat-fg", name="Finished", type="finished", parent_id="grp"))
    db_session.add(Product(id="prod-gt", name="128 OZ GREEN TEA", category_id="cat-fg"))
    db_session.add(Location(id="loc-1", name="Plant"))
    db_session.add(SubLocation(id="sub-1", name="WH", location_id="loc-1"))
    db_session.add(StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="sub-1"))
    db_session.add(StorageRow(
        id="row-1", name="Dock 1", sub_location_id="sub-1", storage_area_id="area-1",
        pallet_capacity=1000,
    ))

    # The session under test — header carries only the newer lot.
    db_session.add(ForkliftRequest(
        id="fr-rollover", product_id="prod-gt", lot_number="MP26126L1",
        cases_per_pallet=50, status="submitted",
    ))
    # An earlier session that already holds MP26026L1 1-183.
    db_session.add(ForkliftRequest(
        id="fr-earlier", product_id="prod-gt", lot_number="MP26026L1",
        cases_per_pallet=50, status="approved",
    ))

    for s in range(2, 29):          # this session, newer lot (1 and 5 skipped)
        if s == 5:
            continue
        db_session.add(PalletLicence(
            id=f"pl-new-{s}", licence_number=f"MP26126L1-GRT128-{s:03d}",
            forklift_request_id="fr-rollover", product_id="prod-gt",
            lot_number="MP26126L1", sequence=s, cases=50, status="pending",
            storage_row_id="row-1", storage_area_id="area-1",
        ))
    db_session.add(PalletLicence(      # the lone pre-midnight pallet
        id="pl-new-195", licence_number="MP26026L1-GRT128-195",
        forklift_request_id="fr-rollover", product_id="prod-gt",
        lot_number="MP26026L1", sequence=195, cases=50, status="pending",
        storage_row_id="row-1", storage_area_id="area-1",
    ))
    for s in range(1, 184):         # the earlier session's stock
        db_session.add(PalletLicence(
            id=f"pl-old-{s}", licence_number=f"MP26026L1-GRT128-{s:03d}",
            forklift_request_id="fr-earlier", product_id="prod-gt",
            lot_number="MP26026L1", sequence=s, cases=50, status="in_stock",
            storage_row_id="row-1", storage_area_id="area-1",
        ))
    db_session.commit()
    return db_session


@pytest.mark.integration
def test_coverage_is_computed_for_every_lot_on_the_session(client, auth_headers, rollover_session):
    r = client.get("/api/scanner/requests/fr-rollover", headers=auth_headers)
    assert r.status_code == 200, r.text
    by_prefix = r.json()["covered_sequences_by_prefix"]

    # The older lot's coverage must be present — this is what was missing.
    old = set(by_prefix.get("MP26026L1-GRT128", []))
    assert len(old) == 183, f"expected 1-183 covered, got {len(old)}"
    assert 1 in old and 183 in old
    assert 195 not in old, "this session's own pallet is not 'covered elsewhere'"

    # The newer lot genuinely has no coverage — nothing else holds it.
    assert by_prefix.get("MP26126L1-GRT128", []) == []


@pytest.mark.integration
def test_one_lots_coverage_never_masks_another(client, auth_headers, rollover_session):
    """MP26026L1 covers 1-183. Those numbers must NOT silence MP26126L1's gaps.

    A flat list would have hidden sequences 1 and 5 of the newer lot, which are
    real gaps, because the older lot happens to cover those numbers.
    """
    r = client.get("/api/scanner/requests/fr-rollover", headers=auth_headers)
    by_prefix = r.json()["covered_sequences_by_prefix"]
    assert 1 not in set(by_prefix.get("MP26126L1-GRT128", []))
    assert 5 not in set(by_prefix.get("MP26126L1-GRT128", []))


@pytest.mark.integration
def test_skip_not_produced_accepts_the_secondary_lot(
    client, auth_headers, supervisor_headers, rollover_session
):
    """The header lot is MP26126L1; this licence is MP26026L1 and must be accepted."""
    r = client.post(
        "/api/scanner/requests/fr-rollover/mark-not-produced",
        json={"licence_numbers": ["MP26026L1-GRT128-184"]},
        headers=supervisor_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1, f"was skipped: {body.get('skipped')}"
    assert body.get("skipped") == []


@pytest.mark.integration
def test_skip_still_accepts_the_header_lot(
    client, auth_headers, supervisor_headers, rollover_session
):
    r = client.post(
        "/api/scanner/requests/fr-rollover/mark-not-produced",
        json={"licence_numbers": ["MP26126L1-GRT128-001"]},
        headers=supervisor_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1


@pytest.mark.integration
def test_skip_still_refuses_a_lot_that_is_not_on_the_session(
    client, auth_headers, supervisor_headers, rollover_session
):
    """Widening to 'any lot on the session' must not become 'any lot at all'."""
    r = client.post(
        "/api/scanner/requests/fr-rollover/mark-not-produced",
        json={"licence_numbers": ["MP99926L1-GRT128-001"]},
        headers=supervisor_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 0
    assert body["skipped"][0]["reason"] == "invalid_or_wrong_lot"


@pytest.mark.integration
def test_flat_covered_sequences_still_returned_for_cached_clients(
    client, auth_headers, rollover_session
):
    """Backend deploys before gh-pages, so the old field must keep its old meaning."""
    r = client.get("/api/scanner/requests/fr-rollover", headers=auth_headers)
    assert r.json()["covered_sequences"] == []   # header lot MP26126L1 has no coverage
