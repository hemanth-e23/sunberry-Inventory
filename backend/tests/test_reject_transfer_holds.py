"""
Regression test — Phase 1 Task 1.4.

reject_transfer used to clear receipt.hold unconditionally, so rejecting an
unrelated transfer silently released a QA hold on the lot. Now the flag is
only cleared when nothing is actually held (held_quantity <= 0), which still
releases the transient lock that scanner internal transfers set.
"""
import pytest
from app.models import Category, CategoryGroup, Product, Receipt, InventoryTransfer, User
from app.utils.auth import get_password_hash, create_access_token


@pytest.fixture
def transfer_world(db_session):
    db_session.add(CategoryGroup(id="grp", name="Group"))
    db_session.add(Category(id="cat-raw", name="Raw", type="raw", parent_id="grp"))
    db_session.add(Product(id="prod-1", name="Concentrate", category_id="cat-raw"))
    db_session.add(User(
        id="u-sup", username="sup", name="Sup", email="sup@s.com",
        hashed_password=get_password_hash("password123"), role="supervisor", is_active=True,
    ))
    db_session.commit()
    return db_session


def _admin_headers():
    return {"Authorization": f"Bearer {create_access_token(data={'sub': 'sup'})}"}


def _make_receipt_and_transfer(db, *, hold, held_quantity):
    db.add(Receipt(
        id="rec-1", product_id="prod-1", category_id="cat-raw",
        quantity=1000, unit="lbs", status="approved",
        hold=hold, held_quantity=held_quantity,
    ))
    db.add(InventoryTransfer(
        id="tr-1", receipt_id="rec-1", quantity=100, unit="lbs",
        transfer_type="warehouse-transfer", status="pending", requested_by="u-sup",
    ))
    db.commit()


@pytest.mark.integration
def test_reject_transfer_preserves_qa_hold(client, transfer_world, db_session):
    """A real QA hold (held_quantity > 0) must survive an unrelated transfer reject."""
    _make_receipt_and_transfer(db_session, hold=True, held_quantity=500)

    resp = client.post(
        "/api/inventory/transfers/tr-1/reject?reason=not+needed", headers=_admin_headers()
    )
    assert resp.status_code == 200, resp.text

    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-1").first()
    assert receipt.hold is True            # hold preserved
    assert receipt.held_quantity == 500    # untouched


@pytest.mark.integration
def test_reject_transfer_releases_transient_lock(client, transfer_world, db_session):
    """A transient lock (held_quantity == 0) is still released on reject."""
    _make_receipt_and_transfer(db_session, hold=True, held_quantity=0)

    resp = client.post(
        "/api/inventory/transfers/tr-1/reject?reason=cancel", headers=_admin_headers()
    )
    assert resp.status_code == 200, resp.text

    receipt = db_session.query(Receipt).filter(Receipt.id == "rec-1").first()
    assert receipt.hold is False
