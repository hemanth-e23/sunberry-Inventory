"""
Integration tests for cycle counts API.
"""
import pytest
from app.models import CycleCount


@pytest.mark.integration
def test_create_cycle_count_stores_fields(
    client, auth_headers, seed_data, db_session
):
    """Cycle count must be stored correctly."""
    payload = {
        "location_id": "loc-paw-paw",
        "category_id": "raw-sunberry",
        "count_date": "2026-02-16",
        "items": [
            {"receipt_id": "rcpt-1", "expected": 100, "actual": 98, "variance": -2},
        ],
        "summary": {"total_variance": -2, "item_count": 1},
        "performed_by": "Test Worker",
        "performed_by_id": "test-user-1",
    }

    response = client.post(
        "/api/inventory/cycle-counts",
        json=payload,
        headers=auth_headers,
    )
    assert response.status_code == 200

    data = response.json()
    assert data["location_id"] == "loc-paw-paw"
    assert data["count_date"] == "2026-02-16"
    assert data["performed_by"] == "Test Worker"
    assert len(data["items"]) == 1

    db_count = db_session.query(CycleCount).filter(
        CycleCount.id == data["id"]
    ).first()
    assert db_count is not None
    assert db_count.summary["total_variance"] == -2


@pytest.mark.integration
def test_get_cycle_counts(client, auth_headers, seed_data):
    """Can list cycle counts."""
    response = client.get(
        "/api/inventory/cycle-counts",
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert isinstance(response.json(), list)


@pytest.mark.integration
def test_get_cycle_counts_filter_by_location(client, auth_headers, seed_data):
    """Cycle counts can be filtered by location_id."""
    response = client.get(
        "/api/inventory/cycle-counts?location_id=loc-paw-paw",
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    for cc in data:
        assert cc["location_id"] == "loc-paw-paw"


@pytest.mark.integration
def test_create_cycle_count_without_auth(client, seed_data):
    """Unauthenticated request rejected."""
    response = client.post(
        "/api/inventory/cycle-counts",
        json={
            "location_id": "loc-paw-paw",
            "count_date": "2026-02-16",
            "items": [],
            "summary": {},
            "performed_by": "Test",
            "performed_by_id": "test-user-1",
        },
    )
    assert response.status_code == 403
