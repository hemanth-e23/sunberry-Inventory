"""
Regression test — Phase 2 Task 2.11.

The cycle-count creator is taken from the server identity, not the client, so a
bogus/incomplete client value (e.g. the literal "Unknown") is never persisted.
"""
import pytest


@pytest.mark.integration
def test_cycle_count_performed_by_is_server_side(client, auth_headers, seed_data):
    payload = {
        "count_date": "2026-02-16",
        "items": [],
        "summary": {"totalItems": 0},
        "performed_by": "Unknown",          # client lies
        "performed_by_id": "not-a-real-id",  # client lies
    }
    resp = client.post("/api/inventory/cycle-counts", json=payload, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["performed_by"] == "Test Worker"   # from the authenticated user
    assert data["performed_by_id"] == "test-user-1"
