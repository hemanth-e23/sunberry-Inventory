"""
Integration test fixtures for Sunberry Inventory backend.

Run from backend directory: pytest

Requires a test database. Create it first:
    createdb sunberry_inventory_test

Or use your existing PostgreSQL user:
    createdb -U hemanthegk sunberry_inventory_test
"""
import os

# Disable rate limiting during tests (prevents 429 Too Many Requests)
# Must be set before any app imports; use high values to avoid dotenv overwriting
os.environ["RATE_LIMIT_ENABLED"] = "False"
os.environ["RATE_LIMIT_PER_MINUTE"] = "100000"
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.database import Base, get_db
from main import app
from app.models import (
    User,
    Location,
    SubLocation,
    Product,
    Category,
    CategoryGroup,
    StorageRow,
    StorageArea,
    Vendor,
)
from app.utils.auth import get_password_hash, create_access_token

# Use a separate test database — never touch your real data
TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql://hemanthegk@localhost:5432/sunberry_inventory_test",
)

test_engine = create_engine(TEST_DATABASE_URL)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture(scope="function")
def db_session():
    """
    Fresh database for each test. Drops and recreates tables so every test
    starts with an empty database.
    """
    Base.metadata.drop_all(bind=test_engine)
    Base.metadata.create_all(bind=test_engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(scope="function")
def client(db_session):
    """
    HTTP test client. Overrides the real database with our test database so
    API calls hit the test DB instead of production.
    """
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def test_user(db_session):
    """Creates a warehouse test user for authenticated requests."""
    user = User(
        id="test-user-1",
        username="testworker",
        name="Test Worker",
        email="test@sunberry.com",
        hashed_password=get_password_hash("testpassword123"),
        role="warehouse",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def auth_headers(test_user):
    """JWT token for the test user."""
    token = create_access_token(data={"sub": test_user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin_user(db_session):
    """Admin user for admin-only endpoints."""
    user = User(
        id="admin-user-1",
        username="admin",
        name="Admin User",
        email="admin@sunberry.com",
        hashed_password=get_password_hash("adminpassword123"),
        role="admin",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def admin_auth_headers(admin_user):
    """JWT token for the admin user."""
    token = create_access_token(data={"sub": admin_user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def approved_receipt(client, auth_headers, admin_auth_headers, seed_data, db_session):
    """
    Creates and approves a receipt. Used by transfer, adjustment, hold-action tests.
    Warehouse creates, admin approves.
    """
    from app.models import Receipt

    payload = {
        "product_id": "product-1",
        "category_id": "raw-sunberry",
        "quantity": 100,
        "unit": "cases",
        "location_id": "loc-paw-paw",
        "sub_location_id": "subloc-warehouse-a",
    }
    create_resp = client.post("/api/receipts/", json=payload, headers=auth_headers)
    assert create_resp.status_code == 200
    receipt_id = create_resp.json()["id"]

    approve_resp = client.post(
        f"/api/receipts/{receipt_id}/approve",
        headers=admin_auth_headers,
    )
    assert approve_resp.status_code == 200

    receipt = db_session.query(Receipt).filter(Receipt.id == receipt_id).first()
    return receipt


@pytest.fixture
def seed_data(db_session):
    """
    Reference data required for receipts: locations, sub-locations,
    categories, products. Used by receipt tests.
    """
    group = CategoryGroup(id="sunberry", name="Sunberry")
    db_session.add(group)

    category = Category(
        id="raw-sunberry",
        name="Sunberry",
        type="raw",
        parent_id="sunberry",
    )
    db_session.add(category)

    product = Product(
        id="product-1",
        name="Sunberry Concentrate",
        category_id="raw-sunberry",
    )
    db_session.add(product)

    location = Location(id="loc-paw-paw", name="Sunberry Paw Paw")
    db_session.add(location)

    sub_location = SubLocation(
        id="subloc-warehouse-a",
        name="Warehouse A",
        location_id="loc-paw-paw",
    )
    db_session.add(sub_location)

    # Storage row for sub_location (for raw materials with row allocation)
    storage_area = StorageArea(
        id="area-1",
        name="Area 1",
        location_id="loc-paw-paw",
        sub_location_id="subloc-warehouse-a",
    )
    db_session.add(storage_area)

    storage_row = StorageRow(
        id="row-1",
        name="Row A",
        sub_location_id="subloc-warehouse-a",
        storage_area_id="area-1",
        pallet_capacity=10,
    )
    db_session.add(storage_row)

    vendor = Vendor(id="vendor-1", name="Test Vendor Inc.")
    db_session.add(vendor)

    db_session.commit()
    return {
        "category": category,
        "product": product,
        "location": location,
        "sub_location": sub_location,
        "storage_row": storage_row,
        "vendor": vendor,
    }
