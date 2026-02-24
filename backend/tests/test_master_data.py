"""
Integration tests for master data API (locations, sub-locations, storage areas, etc.).
"""
import pytest
from app.models import Location, SubLocation


@pytest.mark.integration
def test_get_locations(client, auth_headers, seed_data):
    """Any authenticated user can list locations."""
    response = client.get("/api/master-data/locations", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    ids = [loc["id"] for loc in data]
    assert "loc-paw-paw" in ids


@pytest.mark.integration
def test_create_location_requires_admin(client, auth_headers):
    """Warehouse cannot create locations."""
    response = client.post(
        "/api/master-data/locations",
        json={"id": "loc-new", "name": "New Location"},
        headers=auth_headers,
    )
    assert response.status_code == 403


@pytest.mark.integration
def test_create_location_as_admin(client, admin_auth_headers, db_session):
    """Admin can create locations."""
    response = client.post(
        "/api/master-data/locations",
        json={"id": "loc-test-2", "name": "Test Location 2"},
        headers=admin_auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "loc-test-2"
    assert data["name"] == "Test Location 2"

    loc = db_session.query(Location).filter(Location.id == "loc-test-2").first()
    assert loc is not None


@pytest.mark.integration
def test_get_sub_locations(client, auth_headers, seed_data):
    """Any authenticated user can list sub-locations."""
    response = client.get(
        "/api/master-data/sub-locations",
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    ids = [s["id"] for s in data]
    assert "subloc-warehouse-a" in ids


@pytest.mark.integration
def test_create_sub_location_as_admin(
    client, admin_auth_headers, seed_data, db_session
):
    """Admin can create sub-locations."""
    response = client.post(
        "/api/master-data/sub-locations",
        json={
            "id": "subloc-new",
            "name": "New Sub Location",
            "location_id": "loc-paw-paw",
        },
        headers=admin_auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["location_id"] == "loc-paw-paw"

    sub = db_session.query(SubLocation).filter(SubLocation.id == "subloc-new").first()
    assert sub is not None


@pytest.mark.integration
def test_get_sub_locations_filter_by_location(client, auth_headers, seed_data):
    """Sub-locations can be filtered by location_id."""
    response = client.get(
        "/api/master-data/sub-locations?location_id=loc-paw-paw",
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    for sub in data:
        assert sub["location_id"] == "loc-paw-paw"


@pytest.mark.integration
def test_create_location_duplicate_id(client, admin_auth_headers, seed_data):
    """Cannot create location with existing ID."""
    response = client.post(
        "/api/master-data/locations",
        json={"id": "loc-paw-paw", "name": "Duplicate"},
        headers=admin_auth_headers,
    )
    assert response.status_code == 400
