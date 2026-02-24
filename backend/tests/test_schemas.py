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
