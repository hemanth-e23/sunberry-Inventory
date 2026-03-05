from typing import Optional
from datetime import datetime
from pydantic import EmailStr, Field, field_validator
from app.schemas.base import BaseSchema

VALID_ROLES = {
    "forklift", "warehouse", "supervisor", "admin",
    "corporate_admin", "corporate_viewer", "superadmin"
}

ROLE_HIERARCHY = [
    "forklift", "warehouse", "supervisor", "admin",
    "corporate_admin", "corporate_viewer", "superadmin"
]


class WarehouseBasic(BaseSchema):
    id: str
    name: str
    code: str
    type: str
    is_active: bool
    timezone: Optional[str] = None


class UserBase(BaseSchema):
    username: str = Field(..., min_length=3, max_length=50, description="Username (3-50 characters)")
    name: str = Field(..., min_length=1, max_length=100, description="Full name (1-100 characters)")
    email: EmailStr = Field(..., max_length=100, description="Email address")
    role: str = Field(..., max_length=20, description="User role")

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in VALID_ROLES:
            raise ValueError(f"Invalid role '{v}'. Must be one of: {', '.join(sorted(VALID_ROLES))}")
        return v


class UserCreate(UserBase):
    password: str = Field(..., min_length=8, max_length=128, description="Password (minimum 8 characters)")
    badge_id: Optional[str] = Field(None, max_length=50, description="Badge ID for forklift users")
    warehouse_id: Optional[str] = Field(None, max_length=50, description="Warehouse to assign user to (null = corporate)")


class UserUpdate(BaseSchema):
    username: Optional[str] = Field(None, min_length=3, max_length=50)
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    email: Optional[EmailStr] = Field(None, max_length=100)
    role: Optional[str] = Field(None, max_length=20)
    is_active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=8, max_length=128)
    badge_id: Optional[str] = Field(None, max_length=50)
    warehouse_id: Optional[str] = Field(None, max_length=50)

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_ROLES:
            raise ValueError(f"Invalid role '{v}'. Must be one of: {', '.join(sorted(VALID_ROLES))}")
        return v


class User(UserBase):
    id: str
    is_active: bool
    badge_id: Optional[str] = None
    warehouse_id: Optional[str] = None
    warehouse: Optional[WarehouseBasic] = None
    created_at: datetime
