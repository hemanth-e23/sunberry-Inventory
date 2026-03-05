from typing import Optional, List
from datetime import datetime
from pydantic import Field
from app.schemas.base import BaseSchema


class CategoryGroupBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)

class CategoryGroupCreate(CategoryGroupBase):
    pass

class CategoryGroupUpdate(BaseSchema):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    is_active: Optional[bool] = None

class CategoryGroup(CategoryGroupBase):
    is_active: bool
    created_at: datetime


class CategoryBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    type: str = Field(..., max_length=50)
    parent_id: Optional[str] = Field(None, max_length=50)

class CategoryCreate(CategoryBase):
    pass

class CategoryUpdate(BaseSchema):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    type: Optional[str] = Field(None, max_length=50)
    parent_id: Optional[str] = Field(None, max_length=50)
    is_active: Optional[bool] = None

class Category(CategoryBase):
    is_active: bool
    created_at: datetime


class VendorBase(BaseSchema):
    id: str = Field(..., max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=20)
    address: Optional[str] = Field(None, max_length=500)

class VendorCreate(VendorBase):
    pass

class VendorUpdate(BaseSchema):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    is_active: Optional[bool] = None

class Vendor(VendorBase):
    is_active: bool
    created_at: datetime


class ProductBase(BaseSchema):
    id: str
    name: str
    short_code: Optional[str] = None
    fcc_code: Optional[str] = None
    sid: Optional[str] = None
    brix: Optional[float] = None
    category_id: str
    vendor_id: Optional[str] = None
    description: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    quantity_uom: Optional[str] = None
    inventory_tracked: bool = True
    gal_per_case: Optional[float] = None

class ProductCreate(ProductBase):
    pass

class ProductUpdate(BaseSchema):
    name: Optional[str] = None
    short_code: Optional[str] = None
    fcc_code: Optional[str] = None
    sid: Optional[str] = None
    brix: Optional[float] = None
    category_id: Optional[str] = None
    vendor_id: Optional[str] = None
    description: Optional[str] = None
    default_cases_per_pallet: Optional[int] = None
    expire_years: Optional[int] = None
    quantity_uom: Optional[str] = None
    is_active: Optional[bool] = None
    inventory_tracked: Optional[bool] = None
    gal_per_case: Optional[float] = None

class Product(ProductBase):
    is_active: bool
    created_at: datetime


class ProductListResponse(BaseSchema):
    """Paginated product list: items for current page and total count."""
    items: List[Product]
    total: int
