"""
Unit tests for Pydantic schemas validation
"""
import pytest
from pydantic import ValidationError
from app.schemas import (
    UserCreate,
    UserUpdate,
    LoginRequest,
    CategoryCreate,
    VendorCreate
)


@pytest.mark.unit
class TestUserSchemas:
    """Test user-related schemas"""
    
    def test_user_create_valid(self):
        """Test valid user creation"""
        user_data = {
            "username": "testuser",
            "name": "Test User",
            "email": "test@example.com",
            "password": "password123",
            "role": "warehouse"
        }
        user = UserCreate(**user_data)
        assert user.username == "testuser"
        assert user.email == "test@example.com"
    
    def test_user_create_short_username(self):
        """Test username too short"""
        with pytest.raises(ValidationError):
            UserCreate(
                username="ab",  # Too short (min 3)
                name="Test",
                email="test@example.com",
                password="password123",
                role="warehouse"
            )
    
    def test_user_create_long_username(self):
        """Test username too long"""
        with pytest.raises(ValidationError):
            UserCreate(
                username="a" * 51,  # Too long (max 50)
                name="Test",
                email="test@example.com",
                password="password123",
                role="warehouse"
            )
    
    def test_user_create_short_password(self):
        """Test password too short"""
        with pytest.raises(ValidationError):
            UserCreate(
                username="testuser",
                name="Test",
                email="test@example.com",
                password="short",  # Too short (min 8)
                role="warehouse"
            )
    
    def test_user_create_invalid_email(self):
        """Test invalid email format"""
        with pytest.raises(ValidationError):
            UserCreate(
                username="testuser",
                name="Test",
                email="notanemail",  # Invalid email
                password="password123",
                role="warehouse"
            )
    
    def test_login_request_valid(self):
        """Test valid login request"""
        login = LoginRequest(username="testuser", password="password123")
        assert login.username == "testuser"
        assert login.password == "password123"
    
    def test_login_request_empty_username(self):
        """Test login with empty username"""
        with pytest.raises(ValidationError):
            LoginRequest(username="", password="password123")
    
    def test_user_update_partial(self):
        """Test partial user update"""
        update = UserUpdate(name="New Name")
        assert update.name == "New Name"
        assert update.username is None
    
    def test_user_update_with_validation(self):
        """Test user update with validation"""
        # Valid update
        update = UserUpdate(name="New Name", username="newuser")
        assert update.name == "New Name"
        assert update.username == "newuser"
        
        # Invalid - too short
        with pytest.raises(ValidationError):
            UserUpdate(username="ab")


@pytest.mark.unit
class TestCategorySchemas:
    """Test category schemas"""
    
    def test_category_create_valid(self):
        """Test valid category creation"""
        category = CategoryCreate(
            id="cat-1",
            name="Test Category",
            type="raw"
        )
        assert category.name == "Test Category"
        assert category.type == "raw"
    
    def test_category_name_too_long(self):
        """Test category name too long"""
        with pytest.raises(ValidationError):
            CategoryCreate(
                id="cat-1",
                name="a" * 101,  # Too long (max 100)
                type="raw"
            )


@pytest.mark.unit
class TestVendorSchemas:
    """Test vendor schemas"""
    
    def test_vendor_create_valid(self):
        """Test valid vendor creation"""
        vendor = VendorCreate(
            id="vendor-1",
            name="Test Vendor",
            contact_person="John Doe",
            email="vendor@example.com",
            phone="123-456-7890"
        )
        assert vendor.name == "Test Vendor"
        assert vendor.contact_person == "John Doe"
    
    def test_vendor_name_too_long(self):
        """Test vendor name too long"""
        with pytest.raises(ValidationError):
            VendorCreate(
                id="vendor-1",
                name="a" * 101,  # Too long (max 100)
                contact_person="John"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Create-schema / model contract
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestCreateSchemaModelContract:
    """A create endpoint must never splat a request schema into a model.

    `StorageRow(**row_data.dict())` looks harmless and worked for months. Then
    display-only fields (`live_pallets`, `live_cases`, …) were added to the
    shared base that `StorageRowCreate` inherits from, and every such field went
    straight into the SQLAlchemy constructor, which rejects it:

        TypeError: 'live_pallets' is an invalid keyword argument for StorageRow

    That raises inside the route, becomes a 500 that loses its CORS headers, and
    reaches the browser as a bare "Network Error" with no clue what failed.
    Creating a storage row was impossible from the UI for three months, and
    creating a storage area for six, before anyone traced it.

    The failure is silent at the point it is introduced: whoever added
    `live_pallets` to the RESPONSE schema had no reason to think they had broken
    creation. So the rule is enforced here rather than left to review — request
    payloads must be filtered to real columns via `model_kwargs`.

    Asserting "no create schema has extra fields" would be the wrong rule.
    Several legitimately do — `UserCreate.password` becomes `hashed_password`,
    `ReceiptCreate.allocations` is consumed by the router. Extra fields are
    fine; splatting them at a model is not.
    """

    def _splat_sites(self):
        import ast
        import os

        import app.models as models

        model_names = {
            n for n in dir(models)
            if hasattr(getattr(models, n), "__table__")
        }
        routers_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "app", "routers",
        )
        found = []
        for entry in sorted(os.listdir(routers_dir)):
            if not entry.endswith(".py"):
                continue
            path = os.path.join(routers_dir, entry)
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), path)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if not (isinstance(node.func, ast.Name) and node.func.id in model_names):
                    continue
                for kw in node.keywords:
                    # `**something` is a keyword with arg=None.
                    if kw.arg is not None:
                        continue
                    val = kw.value
                    if isinstance(val, ast.Call) and isinstance(val.func, ast.Attribute) \
                            and val.func.attr in {"dict", "model_dump"}:
                        found.append(f"{entry}:{node.lineno} {node.func.id}(**…{val.func.attr}())")
        return found

    def test_no_router_splats_a_schema_into_a_model(self):
        offenders = self._splat_sites()
        assert not offenders, (
            "These endpoints pass a request schema straight into a model "
            "constructor. Any field on the schema that is not a column raises "
            "TypeError and surfaces as an unexplained 'Network Error'. Filter "
            "with app.utils.schema_filter.model_kwargs instead:\n  "
            + "\n  ".join(offenders)
        )

    def test_model_kwargs_drops_non_columns_and_keeps_columns(self):
        from app.models import StorageRow
        from app.schemas.location import StorageRowCreate
        from app.utils.schema_filter import model_kwargs

        payload = StorageRowCreate(
            id="row-x", name="Row X", pallet_capacity=7, live_pallets=3.0,
        )
        kwargs = model_kwargs(payload, StorageRow)

        assert "live_pallets" not in kwargs, "display-only field must be dropped"
        assert kwargs["name"] == "Row X"
        assert kwargs["pallet_capacity"] == 7
        # The whole point: this must not raise.
        StorageRow(**kwargs)
