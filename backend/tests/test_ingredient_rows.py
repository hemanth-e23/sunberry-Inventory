"""Row barcode resolution + labelling — SPEC §8.3, audit B9.

The router is mounted on a LOCAL FastAPI app here rather than on `main.app`,
because the include_router line in main.py is owned by another change in flight.
Mounting locally keeps these tests honest about `ingredient_rows.router` itself
and independent of when the mount lands. The prefix used here
(`/api/ingredient-rows`) is the prefix the router expects in production.

The two-barn "A-12" collision that motivated the barcode column is the whole
point of this file, so it is exercised from three directions: barcode wins,
name-only resolves when unambiguous, and two name matches refuse to guess.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database import get_db
from app.models import Location, StorageArea, StorageRow, SubLocation, User, Warehouse
from app.routers import ingredient_rows
from app.utils.auth import create_access_token, get_password_hash


@pytest.fixture
def rows_client(db_session):
    """TestClient over an app mounting only the ingredient-rows router."""
    app = FastAPI()
    app.include_router(ingredient_rows.router, prefix="/api/ingredient-rows")

    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _headers(username):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': username})}"}


def _user(db_session, *, user_id, username, role, warehouse_id=None):
    user = User(
        id=user_id,
        username=username,
        name=username.title(),
        email=f"{username}@sunberry.com",
        hashed_password=get_password_hash("password123"),
        role=role,
        is_active=True,
        warehouse_id=warehouse_id,
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def barns(db_session):
    """One warehouse, two barns, and a row named "A-12" in EACH — the exact
    topology that made the client-side fuzzy match unsafe.

    Blueberry Barn's rows hang off a sub_location with pallet_capacity = 0
    (how ingredient rows are actually created — capacity is advisory per §8.1).
    Applebarn's rows hang off a storage_area with a real capacity, i.e. the
    finished-goods shape, so the path derivation is covered through both parent
    chains.
    """
    warehouse = Warehouse(id="wh-paw-paw", name="Paw Paw", code="PP", type="plant")
    other_warehouse = Warehouse(id="wh-other", name="Other Plant", code="OP", type="plant")
    db_session.add_all([warehouse, other_warehouse])

    blueberry = Location(id="loc-blueberry", name="Blueberry Barn", warehouse_id="wh-paw-paw")
    apple = Location(id="loc-apple", name="Applebarn", warehouse_id="wh-paw-paw")
    far = Location(id="loc-far", name="Far Barn", warehouse_id="wh-other")
    db_session.add_all([blueberry, apple, far])

    blue_sub = SubLocation(id="sub-blueberry", name="Barrel Bay", location_id="loc-blueberry")
    far_sub = SubLocation(id="sub-far", name="Far Bay", location_id="loc-far")
    db_session.add_all([blue_sub, far_sub])

    apple_area = StorageArea(id="area-apple", name="Rack Block 1", location_id="loc-apple")
    db_session.add(apple_area)

    # Ingredient row: sub_location parent, capacity 0, barcode already backfilled.
    blue_a12 = StorageRow(
        id="row-blue-a12",
        name="A-12",
        sub_location_id="sub-blueberry",
        pallet_capacity=0,
        barcode="BLU-A-12",
    )
    # Same name, different barn, FG shape.
    apple_a12 = StorageRow(
        id="row-apple-a12",
        name="A-12",
        storage_area_id="area-apple",
        pallet_capacity=20,
        barcode="APP-A-12",
    )
    # Unique name, ingredient shape, capacity 0 — the exact row the existing
    # scanner list hides (audit B9b).
    blue_quarantine = StorageRow(
        id="row-blue-q1",
        name="Q-1",
        sub_location_id="sub-blueberry",
        pallet_capacity=0,
        barcode="BLU-Q-1",
    )
    # Another warehouse entirely — must never satisfy a name match for a
    # Paw Paw user.
    far_a12 = StorageRow(
        id="row-far-a12",
        name="A-12",
        sub_location_id="sub-far",
        pallet_capacity=0,
        barcode="FAR-A-12",
    )
    db_session.add_all([blue_a12, apple_a12, blue_quarantine, far_a12])
    db_session.commit()
    return {
        "warehouse": warehouse,
        "blueberry": blueberry,
        "apple": apple,
    }


@pytest.fixture
def paw_paw_user(db_session, barns):
    return _user(
        db_session,
        user_id="user-pp",
        username="ppworker",
        role="warehouse",
        warehouse_id="wh-paw-paw",
    )


@pytest.fixture
def pp_headers(paw_paw_user):
    return _headers(paw_paw_user.username)


# ─────────────────────────────────────────────────────────────────────────────
# Resolution order
# ─────────────────────────────────────────────────────────────────────────────

class TestResolveOrder:
    def test_barcode_match_wins_over_name_match(self, rows_client, db_session, barns, pp_headers):
        """A row whose BARCODE is another row's NAME must resolve by barcode.

        Without an explicit ordering this is the ambiguity that silently binds a
        drum to the wrong rack.
        """
        # Give Applebarn's row the literal name "BLU-A-12": the code below is
        # now simultaneously Blueberry's barcode and Applebarn's name.
        collider = db_session.query(StorageRow).filter(StorageRow.id == "row-apple-a12").first()
        collider.name = "BLU-A-12"
        db_session.commit()

        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "BLU-A-12"}, headers=pp_headers
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "row-blue-a12"
        assert body["resolved_by"] == "barcode"
        assert body["path"] == "Blueberry Barn / Barrel Bay"

    def test_barcode_resolves_case_insensitively(self, rows_client, barns, pp_headers):
        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": " blu-q-1 "}, headers=pp_headers
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == "row-blue-q1"
        assert resp.json()["resolved_by"] == "barcode"

    def test_exact_name_fallback_within_warehouse(self, rows_client, db_session, barns, pp_headers):
        """Name fallback resolves when exactly one row in the caller's warehouse
        carries that name — the un-labelled-rack path."""
        # Only Blueberry keeps the name "A-12" inside Paw Paw. Far Barn also has
        # an "A-12" but belongs to another warehouse and must be invisible.
        apple = db_session.query(StorageRow).filter(StorageRow.id == "row-apple-a12").first()
        apple.name = "B-3"
        db_session.commit()

        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "a-12"}, headers=pp_headers
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "row-blue-a12"
        assert body["resolved_by"] == "name"
        assert body["warehouse_id"] == "wh-paw-paw"

    def test_ambiguous_name_errors_rather_than_guessing(self, rows_client, barns, pp_headers):
        """Two barns, one name, no barcode scanned -> refuse, and name both."""
        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "A-12"}, headers=pp_headers
        )
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "matches 2 rows" in detail
        assert "Blueberry Barn" in detail
        assert "Applebarn" in detail
        # Far Barn is in another warehouse and must not even be a candidate.
        assert "Far Barn" not in detail

    def test_unknown_code_404s(self, rows_client, barns, pp_headers):
        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "ZZZ-NOPE"}, headers=pp_headers
        )
        assert resp.status_code == 404, resp.text
        assert "not found" in resp.json()["detail"].lower()

    def test_no_fuzzy_prefix_match(self, rows_client, barns, pp_headers):
        """The FG scanner strips an "FG-" prefix client-side. Nothing here does
        anything of the sort — a partial code is simply unknown."""
        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "BLU-A"}, headers=pp_headers
        )
        assert resp.status_code == 404, resp.text

    def test_blank_code_is_a_400_not_a_404(self, rows_client, barns, pp_headers):
        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "   "}, headers=pp_headers
        )
        assert resp.status_code == 400, resp.text

    def test_deactivated_row_refuses_with_a_reason(self, rows_client, db_session, barns, pp_headers):
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-blue-q1").first()
        row.is_active = False
        db_session.commit()

        resp = rows_client.get(
            "/api/ingredient-rows/resolve", params={"code": "BLU-Q-1"}, headers=pp_headers
        )
        assert resp.status_code == 400, resp.text
        assert "deactivated" in resp.json()["detail"]

    def test_forklift_may_resolve(self, rows_client, db_session, barns):
        """§18.2 R-3 blocks every drum scan until resolution succeeds, and the
        role holding the gun is `forklift`."""
        _user(
            db_session,
            user_id="user-fk",
            username="forkie",
            role="forklift",
            warehouse_id="wh-paw-paw",
        )
        resp = rows_client.get(
            "/api/ingredient-rows/resolve",
            params={"code": "BLU-Q-1"},
            headers=_headers("forkie"),
        )
        assert resp.status_code == 200, resp.text


# ─────────────────────────────────────────────────────────────────────────────
# Listing
# ─────────────────────────────────────────────────────────────────────────────

class TestListRows:
    def test_capacity_zero_rows_are_still_listed(self, rows_client, barns, pp_headers):
        """audit B9b — `GET /scanner/storage-rows` filters pallet_capacity > 0,
        which hides every ingredient row. This endpoint must not."""
        resp = rows_client.get("/api/ingredient-rows/", headers=pp_headers)
        assert resp.status_code == 200, resp.text
        by_id = {r["id"]: r for r in resp.json()}
        assert "row-blue-a12" in by_id
        assert "row-blue-q1" in by_id
        assert by_id["row-blue-q1"]["pallet_capacity"] == 0

    def test_sub_location_rows_get_a_location_path(self, rows_client, barns, pp_headers):
        """audit B9c — the scanner list resolves the area name through
        storage_area_id only, which is NULL for these rows."""
        resp = rows_client.get("/api/ingredient-rows/", headers=pp_headers)
        by_id = {r["id"]: r for r in resp.json()}
        assert by_id["row-blue-q1"]["path"] == "Blueberry Barn / Barrel Bay"
        assert by_id["row-blue-q1"]["location_name"] == "Blueberry Barn"
        assert by_id["row-blue-q1"]["sub_location_name"] == "Barrel Bay"
        assert by_id["row-blue-q1"]["storage_area_id"] is None

    def test_storage_area_rows_get_a_location_path_too(self, rows_client, barns, pp_headers):
        resp = rows_client.get("/api/ingredient-rows/", headers=pp_headers)
        by_id = {r["id"]: r for r in resp.json()}
        assert by_id["row-apple-a12"]["path"] == "Applebarn / Rack Block 1"

    def test_warehouse_scoping_hides_other_plants(self, rows_client, barns, pp_headers):
        resp = rows_client.get("/api/ingredient-rows/", headers=pp_headers)
        ids = {r["id"] for r in resp.json()}
        assert "row-far-a12" not in ids

    def test_location_filter(self, rows_client, barns, pp_headers):
        resp = rows_client.get(
            "/api/ingredient-rows/", params={"location_id": "loc-apple"}, headers=pp_headers
        )
        assert resp.status_code == 200, resp.text
        assert {r["id"] for r in resp.json()} == {"row-apple-a12"}

    def test_q_matches_name_or_barcode(self, rows_client, barns, pp_headers):
        by_name = rows_client.get(
            "/api/ingredient-rows/", params={"q": "Q-1"}, headers=pp_headers
        ).json()
        assert {r["id"] for r in by_name} == {"row-blue-q1"}

        by_barcode = rows_client.get(
            "/api/ingredient-rows/", params={"q": "APP-"}, headers=pp_headers
        ).json()
        assert {r["id"] for r in by_barcode} == {"row-apple-a12"}

    def test_inactive_rows_are_not_listed(self, rows_client, db_session, barns, pp_headers):
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-blue-q1").first()
        row.is_active = False
        db_session.commit()

        ids = {r["id"] for r in rows_client.get("/api/ingredient-rows/", headers=pp_headers).json()}
        assert "row-blue-q1" not in ids

    def test_rows_with_null_is_active_are_listed(self, rows_client, db_session, barns, pp_headers):
        """`is_active` has only a Python-side default, so rows inserted by raw
        SQL carry NULL. `== True` would silently drop them."""
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-blue-q1").first()
        row.is_active = None
        db_session.commit()

        ids = {r["id"] for r in rows_client.get("/api/ingredient-rows/", headers=pp_headers).json()}
        assert "row-blue-q1" in ids


# ─────────────────────────────────────────────────────────────────────────────
# Barcode minting
# ─────────────────────────────────────────────────────────────────────────────

class TestAssignBarcodes:
    def test_mints_the_migration_scheme_for_new_rows(
        self, rows_client, db_session, barns, pp_headers
    ):
        db_session.add(
            StorageRow(id="row-new", name="C-4", sub_location_id="sub-blueberry", pallet_capacity=0)
        )
        db_session.commit()

        resp = rows_client.post("/api/ingredient-rows/assign-barcodes", headers=pp_headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["assigned_count"] == 1
        assert body["assigned"][0]["barcode"] == "BLU-C-4"

        db_session.expire_all()
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-new").first()
        assert row.barcode == "BLU-C-4"

    def test_never_re_mints_an_existing_barcode(self, rows_client, db_session, barns, pp_headers):
        """A label already stuck to a rack has to keep resolving."""
        resp = rows_client.post("/api/ingredient-rows/assign-barcodes", headers=pp_headers)
        assert resp.json()["assigned_count"] == 0

        db_session.expire_all()
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-blue-a12").first()
        assert row.barcode == "BLU-A-12"

    def test_collisions_get_an_ordinal_suffix(self, rows_client, db_session, barns, pp_headers):
        """Two rows that would mint the same code: the second takes `-2`, the
        same disambiguation alembic u6v7w8x9y0z1 used.

        "D-1" and "D-1!" are DIFFERENT row names that normalise to the SAME code,
        because the migration's `[^A-Z0-9-]` strip deletes punctuation rather than
        substituting it. (A space is deleted too, so "D 1" would mint "BLU-D1" and
        NOT collide — that is why this fixture does not use one.)
        """
        db_session.add_all([
            StorageRow(id="row-dup-1", name="D-1", sub_location_id="sub-blueberry"),
            StorageRow(id="row-dup-2", name="D-1!", sub_location_id="sub-blueberry"),
        ])
        db_session.commit()

        resp = rows_client.post(
            "/api/ingredient-rows/assign-barcodes",
            json={"row_ids": ["row-dup-1", "row-dup-2"]},
            headers=pp_headers,
        )
        assert resp.status_code == 200, resp.text
        minted = sorted(r["barcode"] for r in resp.json()["assigned"])
        assert minted == ["BLU-D-1", "BLU-D-1-2"]

    def test_collides_against_barcodes_already_in_the_table(
        self, rows_client, db_session, barns, pp_headers
    ):
        db_session.add(StorageRow(id="row-clash", name="Q-1*", sub_location_id="sub-blueberry"))
        db_session.commit()

        resp = rows_client.post(
            "/api/ingredient-rows/assign-barcodes",
            json={"row_ids": ["row-clash"]},
            headers=pp_headers,
        )
        # "BLU-Q-1" is taken by row-blue-q1, which nobody may re-label.
        assert resp.json()["assigned"][0]["barcode"] == "BLU-Q-1-2"

    def test_unusable_names_are_skipped_not_given_a_bare_prefix(
        self, rows_client, db_session, barns, pp_headers
    ):
        """"BLU-" is not a label anyone can act on, and every unnamed row in a
        barn would generate the same one."""
        db_session.add(StorageRow(id="row-blank", name="***", sub_location_id="sub-blueberry"))
        db_session.commit()

        resp = rows_client.post(
            "/api/ingredient-rows/assign-barcodes",
            json={"row_ids": ["row-blank"]},
            headers=pp_headers,
        )
        body = resp.json()
        assert body["assigned_count"] == 0
        assert body["skipped_count"] == 1
        assert body["skipped"][0]["id"] == "row-blank"

        db_session.expire_all()
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-blank").first()
        assert row.barcode is None

    def test_cannot_mint_into_another_warehouse(self, rows_client, db_session, barns, pp_headers):
        db_session.add(StorageRow(id="row-far-new", name="F-9", sub_location_id="sub-far"))
        db_session.commit()

        resp = rows_client.post(
            "/api/ingredient-rows/assign-barcodes",
            json={"row_ids": ["row-far-new"]},
            headers=pp_headers,
        )
        assert resp.json()["assigned_count"] == 0

        db_session.expire_all()
        row = db_session.query(StorageRow).filter(StorageRow.id == "row-far-new").first()
        assert row.barcode is None

    def test_forklift_cannot_mint(self, rows_client, db_session, barns):
        _user(
            db_session,
            user_id="user-fk2",
            username="forkie2",
            role="forklift",
            warehouse_id="wh-paw-paw",
        )
        resp = rows_client.post(
            "/api/ingredient-rows/assign-barcodes", headers=_headers("forkie2")
        )
        assert resp.status_code == 403, resp.text


# ─────────────────────────────────────────────────────────────────────────────
# Container occupancy on the payload
# ─────────────────────────────────────────────────────────────────────────────

class TestContainerCount:
    def _container(self, db_session, container_id, row_id, status, is_deleted=False):
        from app.models import Container, IngredientIntake, IntakeLot
        from app.models import Category, CategoryGroup, Product

        if not db_session.query(CategoryGroup).filter(CategoryGroup.id == "grp").first():
            db_session.add(CategoryGroup(id="grp", name="Sunberry"))
            db_session.add(Category(id="cat-ing", name="Ingredients", type="ingredient", parent_id="grp"))
            db_session.add(Product(id="prod-ing", name="Blueberry Puree", category_id="cat-ing"))
            db_session.add(IngredientIntake(id="intake-1", intake_number="IN-1"))
            db_session.add(
                IntakeLot(
                    id="lot-1",
                    intake_id="intake-1",
                    product_id="prod-ing",
                    category_id="cat-ing",
                    container_type="barrel",
                )
            )
            db_session.commit()

        db_session.add(
            Container(
                id=container_id,
                serial=container_id.upper(),
                sequence=int(container_id.rsplit("-", 1)[-1]),
                intake_id="intake-1",
                intake_lot_id="lot-1",
                product_id="prod-ing",
                container_type="barrel",
                status=status,
                storage_row_id=row_id,
                is_deleted=is_deleted,
            )
        )
        db_session.commit()

    def test_counts_only_present_undeleted_containers(
        self, rows_client, db_session, barns, pp_headers
    ):
        from app.enums import ContainerStatus

        self._container(db_session, "c-1", "row-blue-q1", ContainerStatus.IN_STOCK.value)
        self._container(db_session, "c-2", "row-blue-q1", ContainerStatus.OPENED.value)
        # Left the building — must not count.
        self._container(db_session, "c-3", "row-blue-q1", ContainerStatus.EMPTY.value)
        # Soft-deleted — `containers` inherits no base filter, so an omitted
        # is_deleted check is a silent leak.
        self._container(
            db_session, "c-4", "row-blue-q1", ContainerStatus.IN_STOCK.value, is_deleted=True
        )

        resp = rows_client.get("/api/ingredient-rows/", headers=pp_headers)
        by_id = {r["id"]: r for r in resp.json()}
        assert by_id["row-blue-q1"]["container_count"] == 2
        assert by_id["row-blue-a12"]["container_count"] == 0
