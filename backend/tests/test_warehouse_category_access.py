"""
Integration tests for warehouse-scoped product visibility and creation permissions.

Features tested:
  - Superadmin assigns category groups to warehouses (warehouse_category_access table)
  - Superadmin toggles allow_product_creation per warehouse
  - Plant users only see products/categories in their assigned category groups
  - Corporate/superadmin see everything (no filter)
  - Product creation: superadmin always, warehouse admins only if flag is on + category is assigned
  - Category/category-group creation: superadmin only (admins no longer allowed)
"""
import pytest
from app.models import User, CategoryGroup, Category, Product
from app.models import Warehouse
from app.utils.auth import get_password_hash, create_access_token


# ---------------------------------------------------------------------------
# Fixtures — Warehouses
# ---------------------------------------------------------------------------

@pytest.fixture
def plant_a(db_session):
    """Owned plant — will have allow_product_creation toggled on in some tests."""
    wh = Warehouse(
        id="wh-plant-a", name="Plant A", code="PA",
        type="owned", is_active=True,
    )
    db_session.add(wh)
    db_session.commit()
    return wh


@pytest.fixture
def plant_b(db_session):
    """Partner plant — allow_product_creation stays False (default)."""
    wh = Warehouse(
        id="wh-plant-b", name="Plant B", code="PB",
        type="partner", is_active=True,
    )
    db_session.add(wh)
    db_session.commit()
    return wh


@pytest.fixture
def corporate_wh(db_session):
    """Corporate warehouse."""
    wh = Warehouse(
        id="wh-corp", name="Corporate", code="CORP",
        type="corporate", is_active=True,
    )
    db_session.add(wh)
    db_session.commit()
    return wh


# ---------------------------------------------------------------------------
# Fixtures — Users
# ---------------------------------------------------------------------------

@pytest.fixture
def superadmin(db_session):
    user = User(
        id="user-superadmin", username="superadmin", name="Super Admin",
        email="superadmin@test.com",
        hashed_password=get_password_hash("password"),
        role="superadmin", is_active=True, warehouse_id=None,
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def plant_a_admin(db_session, plant_a):
    user = User(
        id="user-plant-a-admin", username="plant_a_admin", name="Plant A Admin",
        email="admin_a@test.com",
        hashed_password=get_password_hash("password"),
        role="admin", is_active=True, warehouse_id="wh-plant-a",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def plant_b_admin(db_session, plant_b):
    user = User(
        id="user-plant-b-admin", username="plant_b_admin", name="Plant B Admin",
        email="admin_b@test.com",
        hashed_password=get_password_hash("password"),
        role="admin", is_active=True, warehouse_id="wh-plant-b",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def corporate_user(db_session, corporate_wh):
    user = User(
        id="user-corporate", username="corp_viewer", name="Corp Viewer",
        email="corp@test.com",
        hashed_password=get_password_hash("password"),
        role="corporate_viewer", is_active=True, warehouse_id="wh-corp",
    )
    db_session.add(user)
    db_session.commit()
    return user


# ---------------------------------------------------------------------------
# Fixtures — Auth headers
# ---------------------------------------------------------------------------

@pytest.fixture
def superadmin_headers(superadmin):
    token = create_access_token(data={"sub": superadmin.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def plant_a_headers(plant_a_admin):
    token = create_access_token(data={"sub": plant_a_admin.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def plant_b_headers(plant_b_admin):
    token = create_access_token(data={"sub": plant_b_admin.username})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def corporate_headers(corporate_user):
    token = create_access_token(data={"sub": corporate_user.username})
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Fixtures — Product catalog (two companies)
# ---------------------------------------------------------------------------

@pytest.fixture
def catalog(db_session):
    """
    Two category groups (companies) each with one category and one product.
      grp-sunberry → cat-sunberry-raw → prod-sunberry-juice
      grp-clientx  → cat-clientx-raw  → prod-clientx-sauce
    """
    grp_sb = CategoryGroup(id="grp-sunberry", name="Sunberry")
    grp_cx = CategoryGroup(id="grp-clientx", name="Client X")
    db_session.add_all([grp_sb, grp_cx])

    cat_sb = Category(id="cat-sunberry-raw", name="Sunberry Raw", type="raw", parent_id="grp-sunberry")
    cat_cx = Category(id="cat-clientx-raw", name="ClientX Raw", type="raw", parent_id="grp-clientx")
    db_session.add_all([cat_sb, cat_cx])

    prod_sb = Product(id="prod-sunberry-juice", name="Sunberry Juice", category_id="cat-sunberry-raw")
    prod_cx = Product(id="prod-clientx-sauce", name="ClientX Sauce", category_id="cat-clientx-raw")
    db_session.add_all([prod_sb, prod_cx])

    db_session.commit()
    return {
        "grp_sunberry": grp_sb, "grp_clientx": grp_cx,
        "cat_sunberry": cat_sb, "cat_clientx": cat_cx,
        "prod_sunberry": prod_sb, "prod_clientx": prod_cx,
    }


@pytest.fixture
def plant_a_has_sunberry_access(db_session, plant_a, catalog):
    """Assign Sunberry category group to Plant A."""
    from app.models import WarehouseCategoryAccess
    access = WarehouseCategoryAccess(
        warehouse_id="wh-plant-a", category_group_id="grp-sunberry"
    )
    db_session.add(access)
    db_session.commit()
    return access


@pytest.fixture
def plant_a_has_both_access(db_session, plant_a, catalog):
    """Assign both Sunberry and ClientX category groups to Plant A."""
    from app.models import WarehouseCategoryAccess
    db_session.add(WarehouseCategoryAccess(warehouse_id="wh-plant-a", category_group_id="grp-sunberry"))
    db_session.add(WarehouseCategoryAccess(warehouse_id="wh-plant-a", category_group_id="grp-clientx"))
    db_session.commit()


@pytest.fixture
def plant_a_can_create(db_session, plant_a):
    """Turn on allow_product_creation for Plant A."""
    plant_a.allow_product_creation = True
    db_session.commit()


# ===========================================================================
# 1. Superadmin manages warehouse category access
# ===========================================================================

@pytest.mark.integration
class TestCategoryAccessManagement:
    def test_superadmin_can_assign_category_group(
        self, client, superadmin_headers, plant_a, catalog
    ):
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/category-access",
            json={"category_group_id": "grp-sunberry"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["warehouse_id"] == "wh-plant-a"
        assert resp.json()["category_group_id"] == "grp-sunberry"

    def test_duplicate_assignment_returns_409(
        self, client, superadmin_headers, plant_a, plant_a_has_sunberry_access
    ):
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/category-access",
            json={"category_group_id": "grp-sunberry"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 409

    def test_superadmin_can_list_assignments(
        self, client, superadmin_headers, plant_a, plant_a_has_both_access
    ):
        resp = client.get(
            "/api/master-data/warehouses/wh-plant-a/category-access",
            headers=superadmin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 2
        group_ids = [item["category_group_id"] for item in data]
        assert "grp-sunberry" in group_ids
        assert "grp-clientx" in group_ids

    def test_superadmin_can_remove_assignment(
        self, client, superadmin_headers, plant_a, plant_a_has_sunberry_access
    ):
        resp = client.delete(
            "/api/master-data/warehouses/wh-plant-a/category-access/grp-sunberry",
            headers=superadmin_headers,
        )
        assert resp.status_code == 200

        # Confirm it's gone
        list_resp = client.get(
            "/api/master-data/warehouses/wh-plant-a/category-access",
            headers=superadmin_headers,
        )
        assert list_resp.json() == []

    def test_remove_nonexistent_assignment_returns_404(
        self, client, superadmin_headers, plant_a, catalog
    ):
        resp = client.delete(
            "/api/master-data/warehouses/wh-plant-a/category-access/grp-sunberry",
            headers=superadmin_headers,
        )
        assert resp.status_code == 404

    def test_non_superadmin_cannot_manage_assignments(
        self, client, plant_a_headers, plant_a, catalog
    ):
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/category-access",
            json={"category_group_id": "grp-sunberry"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403


# ===========================================================================
# 2. Superadmin toggles allow_product_creation
# ===========================================================================

@pytest.mark.integration
class TestToggleProductCreation:
    def test_superadmin_can_toggle_on(
        self, client, superadmin_headers, plant_a
    ):
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/toggle-product-creation",
            headers=superadmin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["allow_product_creation"] is True

    def test_toggle_twice_returns_to_false(
        self, client, superadmin_headers, plant_a
    ):
        client.post(
            "/api/master-data/warehouses/wh-plant-a/toggle-product-creation",
            headers=superadmin_headers,
        )
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/toggle-product-creation",
            headers=superadmin_headers,
        )
        assert resp.json()["allow_product_creation"] is False

    def test_non_superadmin_cannot_toggle(
        self, client, plant_a_headers, plant_a
    ):
        resp = client.post(
            "/api/master-data/warehouses/wh-plant-a/toggle-product-creation",
            headers=plant_a_headers,
        )
        assert resp.status_code == 403

    def test_warehouse_list_includes_flag(
        self, client, superadmin_headers, plant_a
    ):
        """GET /warehouses should return allow_product_creation on each warehouse."""
        resp = client.get("/api/master-data/warehouses", headers=superadmin_headers)
        assert resp.status_code == 200
        wh = next(w for w in resp.json() if w["id"] == "wh-plant-a")
        assert "allow_product_creation" in wh
        assert wh["allow_product_creation"] is False  # default


# ===========================================================================
# 3. Product visibility filtering
# ===========================================================================

@pytest.mark.integration
class TestProductVisibilityFiltering:
    def test_superadmin_sees_all_products(
        self, client, superadmin_headers, catalog
    ):
        resp = client.get("/api/products/products", headers=superadmin_headers)
        assert resp.status_code == 200
        ids = [p["id"] for p in resp.json()["items"]]
        assert "prod-sunberry-juice" in ids
        assert "prod-clientx-sauce" in ids

    def test_corporate_sees_all_products(
        self, client, corporate_headers, catalog
    ):
        resp = client.get("/api/products/products", headers=corporate_headers)
        assert resp.status_code == 200
        ids = [p["id"] for p in resp.json()["items"]]
        assert "prod-sunberry-juice" in ids
        assert "prod-clientx-sauce" in ids

    def test_plant_with_one_group_sees_only_that_group(
        self, client, plant_a_headers, catalog, plant_a_has_sunberry_access
    ):
        """Plant A assigned Sunberry only → sees Sunberry product, not ClientX."""
        resp = client.get("/api/products/products", headers=plant_a_headers)
        assert resp.status_code == 200
        ids = [p["id"] for p in resp.json()["items"]]
        assert "prod-sunberry-juice" in ids
        assert "prod-clientx-sauce" not in ids

    def test_plant_with_both_groups_sees_all(
        self, client, plant_a_headers, catalog, plant_a_has_both_access
    ):
        resp = client.get("/api/products/products", headers=plant_a_headers)
        assert resp.status_code == 200
        ids = [p["id"] for p in resp.json()["items"]]
        assert "prod-sunberry-juice" in ids
        assert "prod-clientx-sauce" in ids

    def test_plant_with_no_access_sees_no_products(
        self, client, plant_b_headers, catalog, plant_b
    ):
        """Plant B has no category access assigned → empty product list."""
        resp = client.get("/api/products/products", headers=plant_b_headers)
        assert resp.status_code == 200
        assert resp.json()["items"] == []
        assert resp.json()["total"] == 0


# ===========================================================================
# 4. Category visibility filtering
# ===========================================================================

@pytest.mark.integration
class TestCategoryVisibilityFiltering:
    def test_superadmin_sees_all_categories(
        self, client, superadmin_headers, catalog
    ):
        resp = client.get("/api/products/categories", headers=superadmin_headers)
        assert resp.status_code == 200
        ids = [c["id"] for c in resp.json()]
        assert "cat-sunberry-raw" in ids
        assert "cat-clientx-raw" in ids

    def test_plant_with_one_group_sees_only_that_groups_categories(
        self, client, plant_a_headers, catalog, plant_a_has_sunberry_access
    ):
        resp = client.get("/api/products/categories", headers=plant_a_headers)
        assert resp.status_code == 200
        ids = [c["id"] for c in resp.json()]
        assert "cat-sunberry-raw" in ids
        assert "cat-clientx-raw" not in ids

    def test_plant_with_no_access_sees_no_categories(
        self, client, plant_b_headers, catalog, plant_b
    ):
        resp = client.get("/api/products/categories", headers=plant_b_headers)
        assert resp.status_code == 200
        assert resp.json() == []


# ===========================================================================
# 5. Category group visibility filtering
# ===========================================================================

@pytest.mark.integration
class TestCategoryGroupVisibilityFiltering:
    def test_superadmin_sees_all_groups(
        self, client, superadmin_headers, catalog
    ):
        resp = client.get("/api/products/category-groups", headers=superadmin_headers)
        assert resp.status_code == 200
        ids = [g["id"] for g in resp.json()]
        assert "grp-sunberry" in ids
        assert "grp-clientx" in ids

    def test_plant_with_one_group_sees_only_that_group(
        self, client, plant_a_headers, catalog, plant_a_has_sunberry_access
    ):
        resp = client.get("/api/products/category-groups", headers=plant_a_headers)
        assert resp.status_code == 200
        ids = [g["id"] for g in resp.json()]
        assert "grp-sunberry" in ids
        assert "grp-clientx" not in ids

    def test_plant_with_no_access_sees_no_groups(
        self, client, plant_b_headers, catalog, plant_b
    ):
        resp = client.get("/api/products/category-groups", headers=plant_b_headers)
        assert resp.status_code == 200
        assert resp.json() == []


# ===========================================================================
# 6. Product creation permissions
# ===========================================================================

@pytest.mark.integration
class TestProductCreationPermissions:
    def test_superadmin_can_create_product_in_any_category(
        self, client, superadmin_headers, catalog
    ):
        resp = client.post(
            "/api/products/products",
            json={"id": "prod-new-1", "name": "New Product", "category_id": "cat-clientx-raw"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == "prod-new-1"

    def test_plant_admin_with_flag_on_can_create_in_assigned_category(
        self, client, plant_a_headers, catalog,
        plant_a_has_sunberry_access, plant_a_can_create
    ):
        resp = client.post(
            "/api/products/products",
            json={"id": "prod-new-2", "name": "New Sunberry Product", "category_id": "cat-sunberry-raw"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 200

    def test_plant_admin_with_flag_on_cannot_create_in_unassigned_category(
        self, client, plant_a_headers, catalog,
        plant_a_has_sunberry_access, plant_a_can_create
    ):
        """Plant A is assigned Sunberry only — cannot create a ClientX product."""
        resp = client.post(
            "/api/products/products",
            json={"id": "prod-new-3", "name": "Bad Product", "category_id": "cat-clientx-raw"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403

    def test_plant_admin_with_flag_off_cannot_create_product(
        self, client, plant_a_headers, catalog, plant_a_has_sunberry_access
    ):
        """Plant A has Sunberry access but allow_product_creation is False (default)."""
        resp = client.post(
            "/api/products/products",
            json={"id": "prod-new-4", "name": "Blocked Product", "category_id": "cat-sunberry-raw"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403

    def test_partner_plant_admin_cannot_create_product(
        self, client, plant_b_headers, catalog
    ):
        """Partner plant has allow_product_creation=False by default."""
        resp = client.post(
            "/api/products/products",
            json={"id": "prod-new-5", "name": "Partner Product", "category_id": "cat-sunberry-raw"},
            headers=plant_b_headers,
        )
        assert resp.status_code == 403


# ===========================================================================
# 7. Product edit permissions
# ===========================================================================

@pytest.mark.integration
class TestProductEditPermissions:
    def test_superadmin_can_edit_any_product(
        self, client, superadmin_headers, catalog
    ):
        resp = client.put(
            "/api/products/products/prod-sunberry-juice",
            json={"name": "Sunberry Juice Updated"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Sunberry Juice Updated"

    def test_plant_admin_with_flag_on_can_edit_product_in_assigned_category(
        self, client, plant_a_headers, catalog,
        plant_a_has_sunberry_access, plant_a_can_create
    ):
        resp = client.put(
            "/api/products/products/prod-sunberry-juice",
            json={"name": "Sunberry Juice Edited"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 200

    def test_plant_admin_with_flag_on_cannot_edit_product_in_unassigned_category(
        self, client, plant_a_headers, catalog,
        plant_a_has_sunberry_access, plant_a_can_create
    ):
        resp = client.put(
            "/api/products/products/prod-clientx-sauce",
            json={"name": "Hacked ClientX Sauce"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403

    def test_plant_admin_with_flag_off_cannot_edit_product(
        self, client, plant_a_headers, catalog, plant_a_has_sunberry_access
    ):
        resp = client.put(
            "/api/products/products/prod-sunberry-juice",
            json={"name": "Should Fail"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403


# ===========================================================================
# 8. Category and CategoryGroup creation — superadmin only
# ===========================================================================

@pytest.mark.integration
class TestCategoryManagementSuperadminOnly:
    def test_superadmin_can_create_category_group(
        self, client, superadmin_headers
    ):
        resp = client.post(
            "/api/products/category-groups",
            json={"id": "grp-new", "name": "New Company"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 200

    def test_admin_cannot_create_category_group(
        self, client, plant_a_headers, plant_a
    ):
        resp = client.post(
            "/api/products/category-groups",
            json={"id": "grp-new", "name": "New Company"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403

    def test_superadmin_can_create_category(
        self, client, superadmin_headers, catalog
    ):
        resp = client.post(
            "/api/products/categories",
            json={"id": "cat-new", "name": "New Category", "type": "raw", "parent_id": "grp-sunberry"},
            headers=superadmin_headers,
        )
        assert resp.status_code == 200

    def test_admin_cannot_create_category(
        self, client, plant_a_headers, plant_a, catalog
    ):
        resp = client.post(
            "/api/products/categories",
            json={"id": "cat-new", "name": "New Category", "type": "raw", "parent_id": "grp-sunberry"},
            headers=plant_a_headers,
        )
        assert resp.status_code == 403
