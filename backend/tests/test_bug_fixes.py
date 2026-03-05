"""
Integration tests for the 6 bugs found during manual QA testing.

Bugs fixed:
  Bug-1 (L-07): Deactivated user could log in — authenticate_user() now checks is_active
  Bug-2 (H-16): Forklift role could access GET /inventory/transfers — now returns 403
  Bug-3:        Receipt could be created without category_id — now required field
  Bug-4:        Mark-staging-used accepted quantity=0 — now returns 400
  Bug-5:        adjustment_type='reduce' silently did nothing — now deducts quantity
  Bug-6 (M-16): Raw material warehouse-transfer did not update storage row occupancy
"""
import pytest
from app.models import (
    User, Receipt, InventoryAdjustment, InventoryTransfer,
    StagingItem, StorageRow,
)
from app.utils.auth import get_password_hash, create_access_token


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def warehouse_a(db_session):
    from app.models import Warehouse
    wh = Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True)
    db_session.add(wh)
    db_session.commit()
    return wh


@pytest.fixture
def superadmin_user(db_session, warehouse_a):
    user = User(
        id="superadmin-1",
        username="superadmin",
        name="Super Admin",
        email="superadmin@test.com",
        hashed_password=get_password_hash("password"),
        role="superadmin",
        is_active=True,
        warehouse_id=None,
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def admin_user_wh(db_session, warehouse_a):
    user = User(
        id="admin-wh-1",
        username="plant_admin",
        name="Plant Admin",
        email="admin@plant.com",
        hashed_password=get_password_hash("password"),
        role="admin",
        is_active=True,
        warehouse_id="wh-a",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def warehouse_user(db_session, warehouse_a):
    user = User(
        id="wh-user-1",
        username="wh_worker",
        name="WH Worker",
        email="worker@plant.com",
        hashed_password=get_password_hash("password"),
        role="warehouse",
        is_active=True,
        warehouse_id="wh-a",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def forklift_user(db_session, warehouse_a):
    user = User(
        id="forklift-1",
        username="forklift_driver",
        name="Forklift Driver",
        email="forklift@plant.com",
        hashed_password=get_password_hash("password"),
        role="forklift",
        badge_id="BADGE-001",
        is_active=True,
        warehouse_id="wh-a",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def admin_headers(admin_user_wh):
    token = create_access_token(data={"sub": admin_user_wh.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def wh_headers(warehouse_user):
    token = create_access_token(data={"sub": warehouse_user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def forklift_headers(forklift_user):
    token = create_access_token(data={"sub": forklift_user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def superadmin_headers(superadmin_user):
    token = create_access_token(data={"sub": superadmin_user.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def base_seed(db_session, warehouse_a):
    from app.models import CategoryGroup, Category, Product, Location, SubLocation, StorageArea, StorageRow
    group = CategoryGroup(id="grp-raw", name="Raw Materials")
    db_session.add(group)

    cat_raw = Category(id="cat-raw", name="Raw", type="raw", parent_id="grp-raw")
    cat_finished = Category(id="cat-fg", name="Finished", type="finished", parent_id="grp-raw")
    db_session.add_all([cat_raw, cat_finished])

    product = Product(id="prod-1", name="Test Product", category_id="cat-raw")
    db_session.add(product)

    loc = Location(id="loc-1", name="Main", warehouse_id="wh-a")
    db_session.add(loc)

    subloc = SubLocation(id="subloc-1", name="Sub A", location_id="loc-1")
    db_session.add(subloc)

    area = StorageArea(id="area-1", name="Area A", location_id="loc-1", sub_location_id="subloc-1")
    db_session.add(area)

    row1 = StorageRow(
        id="row-src", name="Source Row", sub_location_id="subloc-1",
        storage_area_id="area-1", pallet_capacity=20, occupied_pallets=0,
    )
    row2 = StorageRow(
        id="row-dst", name="Dest Row", sub_location_id="subloc-1",
        storage_area_id="area-1", pallet_capacity=20, occupied_pallets=0,
    )
    db_session.add_all([row1, row2])
    db_session.commit()
    return {"category_raw": cat_raw, "category_fg": cat_finished, "product": product,
            "location": loc, "subloc": subloc, "row_src": row1, "row_dst": row2}


@pytest.fixture
def approved_raw_receipt(db_session, base_seed, warehouse_a, admin_user_wh):
    """An approved raw material receipt with 100 quantity and 5 pallets in row-src."""
    receipt = Receipt(
        id="rcpt-raw-1",
        product_id="prod-1",
        category_id="cat-raw",
        quantity=100,
        unit="cases",
        cases_per_pallet=20,
        pallets=5,
        lot_number="LOT-001",
        location_id="loc-1",
        sub_location_id="subloc-1",
        storage_row_id="row-src",
        status="approved",
        submitted_by=str(admin_user_wh.id),
        approved_by=str(admin_user_wh.id),
        warehouse_id="wh-a",
        is_deleted=False,
    )
    db_session.add(receipt)
    row = db_session.query(StorageRow).filter(StorageRow.id == "row-src").first()
    row.occupied_pallets = 5
    db_session.commit()
    return receipt


# ===========================================================================
# Bug-1: Deactivated user cannot login (L-07)
# ===========================================================================

@pytest.mark.integration
class TestBug1DeactivatedUserBlocked:
    def test_active_user_can_login(self, client, warehouse_user):
        resp = client.post("/api/auth/login", json={"username": "wh_worker", "password": "password"})
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_deactivated_user_cannot_login(self, client, db_session, warehouse_user):
        """After deactivation, login must be rejected even with correct password."""
        warehouse_user.is_active = False
        db_session.commit()

        resp = client.post("/api/auth/login", json={"username": "wh_worker", "password": "password"})
        assert resp.status_code == 401
        assert "access_token" not in resp.json()

    def test_deactivated_user_token_still_rejected_on_api(self, client, db_session, warehouse_user, wh_headers, base_seed):
        """Token from before deactivation is rejected because get_current_active_user checks is_active."""
        warehouse_user.is_active = False
        db_session.commit()

        resp = client.get("/api/receipts/", headers=wh_headers)
        assert resp.status_code == 400  # "Inactive user"


# ===========================================================================
# Bug-2: Forklift role blocked from transfer list (H-16)
# ===========================================================================

@pytest.mark.integration
class TestBug2ForkliftBlockedFromTransfers:
    def test_forklift_gets_403_on_transfer_list(self, client, forklift_user, forklift_headers, base_seed):
        resp = client.get("/api/inventory/transfers", headers=forklift_headers)
        assert resp.status_code == 403

    def test_admin_can_access_transfer_list(self, client, admin_headers, base_seed):
        resp = client.get("/api/inventory/transfers", headers=admin_headers)
        assert resp.status_code == 200

    def test_warehouse_user_can_access_transfer_list(self, client, wh_headers, base_seed):
        resp = client.get("/api/inventory/transfers", headers=wh_headers)
        assert resp.status_code == 200


# ===========================================================================
# Bug-3: category_id is required on receipt creation
# ===========================================================================

@pytest.mark.integration
class TestBug3CategoryIdRequired:
    def test_create_receipt_without_category_id_fails(self, client, admin_headers, base_seed):
        payload = {
            "product_id": "prod-1",
            "quantity": 50,
            "unit": "cases",
            "location_id": "loc-1",
            # category_id intentionally omitted
        }
        resp = client.post("/api/receipts/", json=payload, headers=admin_headers)
        assert resp.status_code == 422  # Pydantic validation error

    def test_create_receipt_with_category_id_succeeds(self, client, admin_headers, base_seed):
        payload = {
            "product_id": "prod-1",
            "category_id": "cat-raw",
            "quantity": 50,
            "unit": "cases",
            "location_id": "loc-1",
        }
        resp = client.post("/api/receipts/", json=payload, headers=admin_headers)
        assert resp.status_code == 200
        assert resp.json()["category_id"] == "cat-raw"


# ===========================================================================
# Bug-4: mark-staging-used rejects quantity=0
# ===========================================================================

@pytest.mark.integration
class TestBug4MarkUsedRejectsZero:
    @pytest.fixture
    def staging_item(self, db_session, approved_raw_receipt, admin_user_wh):
        # Must create a real InventoryTransfer first — staging_items.transfer_id has a FK constraint
        transfer = InventoryTransfer(
            id="xfer-dummy",
            receipt_id="rcpt-raw-1",
            quantity=50,
            unit="cases",
            transfer_type="staging",
            status="approved",
            requested_by=admin_user_wh.id,
            warehouse_id="wh-a",
        )
        db_session.add(transfer)
        db_session.flush()

        item = StagingItem(
            id="stage-1",
            transfer_id="xfer-dummy",
            receipt_id="rcpt-raw-1",
            product_id="prod-1",
            quantity_staged=50,
            quantity_used=0,
            quantity_returned=0,
            status="staged",
            warehouse_id="wh-a",
        )
        db_session.add(item)
        db_session.commit()
        return item

    def test_mark_used_zero_quantity_rejected(self, client, admin_headers, staging_item):
        resp = client.post(
            f"/api/inventory/staging/{staging_item.id}/mark-used",
            json={"quantity": 0},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert "greater than zero" in resp.json()["detail"].lower()

    def test_mark_used_negative_quantity_rejected(self, client, admin_headers, staging_item):
        resp = client.post(
            f"/api/inventory/staging/{staging_item.id}/mark-used",
            json={"quantity": -5},
            headers=admin_headers,
        )
        assert resp.status_code == 400

    def test_mark_used_valid_quantity_succeeds(self, client, admin_headers, staging_item):
        resp = client.post(
            f"/api/inventory/staging/{staging_item.id}/mark-used",
            json={"quantity": 10},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] in ("partially_used", "used")


# ===========================================================================
# Bug-5: adjustment_type='reduce' now deducts receipt quantity
# ===========================================================================

@pytest.mark.integration
class TestBug5ReduceAdjustmentDeducts:
    def test_reduce_adjustment_deducts_quantity_on_approval(
        self, client, admin_headers, approved_raw_receipt, db_session, base_seed
    ):
        before_qty = approved_raw_receipt.quantity  # 100

        # Create adjustment with type='reduce'
        create_resp = client.post(
            "/api/inventory/adjustments",
            json={
                "receipt_id": approved_raw_receipt.id,
                "adjustment_type": "reduce",
                "quantity": 15,
                "reason": "Test reduce type",
            },
            headers=admin_headers,
        )
        assert create_resp.status_code == 200
        adj_id = create_resp.json()["id"]
        assert create_resp.json()["status"] == "pending"

        # Quantity should NOT change yet (still pending)
        db_session.refresh(approved_raw_receipt)
        assert approved_raw_receipt.quantity == before_qty

        # Approve the adjustment
        approve_resp = client.post(
            f"/api/inventory/adjustments/{adj_id}/approve",
            headers=admin_headers,
        )
        assert approve_resp.status_code == 200

        # Quantity should now be reduced by 15
        db_session.refresh(approved_raw_receipt)
        assert approved_raw_receipt.quantity == before_qty - 15

    def test_reduce_to_zero_marks_receipt_depleted(
        self, client, admin_headers, approved_raw_receipt, db_session, base_seed
    ):
        create_resp = client.post(
            "/api/inventory/adjustments",
            json={
                "receipt_id": approved_raw_receipt.id,
                "adjustment_type": "reduce",
                "quantity": 100,  # exact quantity
                "reason": "Full depletion test",
            },
            headers=admin_headers,
        )
        adj_id = create_resp.json()["id"]

        client.post(f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_headers)

        db_session.refresh(approved_raw_receipt)
        assert approved_raw_receipt.quantity == 0
        assert approved_raw_receipt.status == "depleted"

    def test_stock_correction_still_deducts(
        self, client, admin_headers, approved_raw_receipt, db_session, base_seed
    ):
        """Existing deduction types still work after the change."""
        create_resp = client.post(
            "/api/inventory/adjustments",
            json={
                "receipt_id": approved_raw_receipt.id,
                "adjustment_type": "stock-correction",
                "quantity": 10,
                "reason": "Existing type still works",
            },
            headers=admin_headers,
        )
        adj_id = create_resp.json()["id"]
        client.post(f"/api/inventory/adjustments/{adj_id}/approve", headers=admin_headers)

        db_session.refresh(approved_raw_receipt)
        assert approved_raw_receipt.quantity == 90


# ===========================================================================
# Bug-6: Raw material warehouse-transfer updates storage row occupancy (M-16)
# ===========================================================================

@pytest.mark.integration
class TestBug6RawMaterialTransferUpdatesStorageRows:
    def test_warehouse_transfer_updates_storage_row_occupancy(
        self, client, admin_headers, approved_raw_receipt, db_session, base_seed
    ):
        """Approving a warehouse-transfer should free source row and reserve destination row."""
        src_row = db_session.query(StorageRow).filter(StorageRow.id == "row-src").first()
        dst_row = db_session.query(StorageRow).filter(StorageRow.id == "row-dst").first()
        src_before = src_row.occupied_pallets  # 5
        dst_before = dst_row.occupied_pallets  # 0

        # Create warehouse-transfer with source/destination breakdown
        create_resp = client.post(
            "/api/inventory/transfers",
            json={
                "receipt_id": approved_raw_receipt.id,
                "transfer_type": "warehouse-transfer",
                "reason": "Move to new row",
                "quantity": 40,
                "source_breakdown": [{"id": "row-row-src", "quantity": 40}],
                "destination_breakdown": [{"id": "row-row-dst", "quantity": 40}],
            },
            headers=admin_headers,
        )
        assert create_resp.status_code == 200
        transfer_id = create_resp.json()["id"]

        # Approve with a different user (to avoid self-approval block — admin created it, approve also as admin)
        approve_resp = client.post(
            f"/api/inventory/transfers/{transfer_id}/approve",
            headers=admin_headers,
        )
        assert approve_resp.status_code == 200

        db_session.refresh(src_row)
        db_session.refresh(dst_row)
        db_session.refresh(approved_raw_receipt)

        # Source row should have less, destination more
        assert src_row.occupied_pallets < src_before
        assert dst_row.occupied_pallets > dst_before

    def test_warehouse_transfer_updates_receipt_storage_row_id(
        self, client, admin_headers, approved_raw_receipt, db_session, base_seed
    ):
        """When transferring to a single destination row, receipt.storage_row_id updates."""
        assert approved_raw_receipt.storage_row_id == "row-src"

        create_resp = client.post(
            "/api/inventory/transfers",
            json={
                "receipt_id": approved_raw_receipt.id,
                "transfer_type": "warehouse-transfer",
                "reason": "Move to new row",
                "quantity": 40,
                "source_breakdown": [{"id": "row-row-src", "quantity": 40}],
                "destination_breakdown": [{"id": "row-row-dst", "quantity": 40}],
            },
            headers=admin_headers,
        )
        transfer_id = create_resp.json()["id"]
        client.post(f"/api/inventory/transfers/{transfer_id}/approve", headers=admin_headers)

        db_session.refresh(approved_raw_receipt)
        assert approved_raw_receipt.storage_row_id == "row-dst"
