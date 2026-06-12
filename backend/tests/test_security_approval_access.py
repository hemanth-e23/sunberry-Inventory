"""
Security regression tests — Phase 1 Task 1.2.

Approve/reject endpoints used to require only an authenticated user, so a
forklift (or any logged-in user, in any warehouse) could approve documents.
These tests lock in:
  - forklift / unauthorized roles cannot approve, and
  - a plant-scoped user cannot approve another warehouse's records, while a
    same-warehouse supervisor / warehouse worker can.
"""
import pytest
from app.models import User, Warehouse, Category, CategoryGroup, Product, Receipt, InventoryAdjustment
from app.utils.auth import get_password_hash, create_access_token


def _token(username):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': username})}"}


def _make_user(db, uid, username, role, warehouse_id=None):
    u = User(
        id=uid,
        username=username,
        name=username.title(),
        email=f"{username}@sunberry.com",
        hashed_password=get_password_hash("password123"),
        role=role,
        is_active=True,
        warehouse_id=warehouse_id,
    )
    db.add(u)
    return u


@pytest.fixture
def scoped_world(db_session):
    """Two warehouses, scoped users in each, and a pending adjustment in wh-A."""
    db_session.add(Warehouse(id="wh-A", name="Plant A", code="PA", type="plant"))
    db_session.add(Warehouse(id="wh-B", name="Plant B", code="PB", type="plant"))

    db_session.add(CategoryGroup(id="grp", name="Group"))
    db_session.add(Category(id="cat-raw", name="Raw", type="raw", parent_id="grp"))
    db_session.add(Product(id="prod-1", name="Concentrate", category_id="cat-raw"))

    _make_user(db_session, "u-submit", "submitter", "warehouse", "wh-A")
    _make_user(db_session, "u-fork", "forklift1", "forklift", "wh-A")
    _make_user(db_session, "u-admA", "adminA", "admin", "wh-A")
    _make_user(db_session, "u-admB", "adminB", "admin", "wh-B")
    _make_user(db_session, "u-supA", "supervisorA", "supervisor", "wh-A")
    _make_user(db_session, "u-whA2", "warehouseA2", "warehouse", "wh-A")

    db_session.add(Receipt(
        id="rec-A", product_id="prod-1", category_id="cat-raw",
        quantity=100, unit="lbs", status="approved", warehouse_id="wh-A",
        submitted_by="u-submit",
    ))
    db_session.commit()
    return db_session


def _new_pending_adjustment(db, adj_id="adj-A"):
    adj = InventoryAdjustment(
        id=adj_id, receipt_id="rec-A", product_id="prod-1",
        adjustment_type="damage-reduction", quantity=10, reason="test",
        submitted_by="u-submit", warehouse_id="wh-A", status="pending",
    )
    db.add(adj)
    db.commit()
    return adj_id


@pytest.mark.integration
def test_forklift_cannot_approve_adjustment(client, scoped_world):
    adj_id = _new_pending_adjustment(scoped_world)
    resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=_token("forklift1")
    )
    assert resp.status_code == 403


@pytest.mark.integration
def test_cross_warehouse_admin_cannot_approve(client, scoped_world):
    adj_id = _new_pending_adjustment(scoped_world)
    resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=_token("adminB")
    )
    assert resp.status_code == 403


@pytest.mark.integration
def test_same_warehouse_supervisor_can_approve(client, scoped_world, db_session):
    adj_id = _new_pending_adjustment(scoped_world)
    resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=_token("supervisorA")
    )
    assert resp.status_code == 200, resp.text
    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-A").first()
    assert receipt.quantity == 90  # 100 - 10


@pytest.mark.integration
def test_same_warehouse_worker_can_approve_others_adjustment(client, scoped_world):
    """Warehouse workers may approve OTHER users' records in their warehouse."""
    adj_id = _new_pending_adjustment(scoped_world)
    resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/approve", headers=_token("warehouseA2")
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.integration
def test_forklift_cannot_reject_adjustment(client, scoped_world):
    adj_id = _new_pending_adjustment(scoped_world)
    resp = client.post(
        f"/api/inventory/adjustments/{adj_id}/reject?reason=no",
        headers=_token("forklift1"),
    )
    assert resp.status_code == 403
