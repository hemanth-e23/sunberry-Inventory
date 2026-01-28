from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Product, Category, Vendor, CategoryGroup
from app.schemas import (
    Product as ProductSchema, ProductCreate, ProductUpdate, ProductListResponse,
    Category as CategorySchema, CategoryCreate, CategoryUpdate,
    CategoryGroup as CategoryGroupSchema, CategoryGroupCreate, CategoryGroupUpdate,
    Vendor as VendorSchema, VendorCreate, VendorUpdate
)
from app.utils.auth import get_current_active_user, require_role

router = APIRouter()

# Product endpoints – paginated; no default cap on total count
PRODUCTS_PAGE_MAX = 500  # max items per single request

@router.get("/products", response_model=ProductListResponse)
async def get_products(
    skip: int = 0,
    limit: int = 50,
    category_id: str = None,
    vendor_id: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get products with pagination. Returns items for this page and total count."""
    query = db.query(Product)
    
    if category_id:
        query = query.filter(Product.category_id == category_id)
    if vendor_id:
        query = query.filter(Product.vendor_id == vendor_id)
    
    total = query.count()
    effective_limit = min(max(1, limit), PRODUCTS_PAGE_MAX)
    items = query.offset(skip).limit(effective_limit).all()
    return {"items": items, "total": total}

@router.post("/products", response_model=ProductSchema)
async def create_product(
    product_data: ProductCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new product (admin/supervisor only)"""
    # Check if product already exists
    existing_product = db.query(Product).filter(Product.id == product_data.id).first()
    if existing_product:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Product with this ID already exists"
        )
    
    # Check for unique SID code
    if product_data.sid:
        existing_sid = db.query(Product).filter(
            Product.sid == product_data.sid,
            Product.id != product_data.id
        ).first()
        if existing_sid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product with SID code '{product_data.sid}' already exists"
            )
    
    # Check for unique FCC code
    if product_data.fcc_code:
        existing_fcc = db.query(Product).filter(
            Product.fcc_code == product_data.fcc_code,
            Product.id != product_data.id
        ).first()
        if existing_fcc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product with FCC code '{product_data.fcc_code}' already exists"
            )
    
    db_product = Product(**product_data.dict())
    db.add(db_product)
    db.commit()
    db.refresh(db_product)
    return db_product

@router.put("/products/{product_id}", response_model=ProductSchema)
async def update_product(
    product_id: str,
    product_update: ProductUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a product (admin/supervisor only)"""
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found"
        )
    
    update_data = product_update.dict(exclude_unset=True)
    
    # Check for unique SID code (if being updated)
    if 'sid' in update_data and update_data['sid']:
        existing_sid = db.query(Product).filter(
            Product.sid == update_data['sid'],
            Product.id != product_id
        ).first()
        if existing_sid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product with SID code '{update_data['sid']}' already exists"
            )
    
    # Check for unique FCC code (if being updated)
    if 'fcc_code' in update_data and update_data['fcc_code']:
        existing_fcc = db.query(Product).filter(
            Product.fcc_code == update_data['fcc_code'],
            Product.id != product_id
        ).first()
        if existing_fcc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Product with FCC code '{update_data['fcc_code']}' already exists"
            )
    
    for field, value in update_data.items():
        setattr(product, field, value)
    
    db.commit()
    db.refresh(product)
    return product

@router.post("/products/{product_id}/toggle-status")
async def toggle_product_status(
    product_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Toggle product active status (admin/supervisor only)"""
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Product not found"
        )
    
    product.is_active = not product.is_active
    db.commit()
    db.refresh(product)
    
    return {
        "message": f"Product {'activated' if product.is_active else 'deactivated'} successfully",
        "is_active": product.is_active
    }

# Category Group endpoints
@router.get("/category-groups", response_model=List[CategoryGroupSchema])
async def get_category_groups(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all category groups"""
    category_groups = db.query(CategoryGroup).all()
    return category_groups

@router.post("/category-groups", response_model=CategoryGroupSchema)
async def create_category_group(
    category_group_data: CategoryGroupCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new category group (admin/supervisor only)"""
    existing_group = db.query(CategoryGroup).filter(CategoryGroup.id == category_group_data.id).first()
    if existing_group:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category group with this ID already exists"
        )
    
    db_group = CategoryGroup(**category_group_data.dict())
    db.add(db_group)
    db.commit()
    db.refresh(db_group)
    return db_group

@router.put("/category-groups/{group_id}", response_model=CategoryGroupSchema)
async def update_category_group(
    group_id: str,
    group_update: CategoryGroupUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a category group (admin/supervisor only)"""
    group = db.query(CategoryGroup).filter(CategoryGroup.id == group_id).first()
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category group not found"
        )
    
    update_data = group_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(group, field, value)
    
    db.commit()
    db.refresh(group)
    return group

# Category endpoints
@router.get("/categories", response_model=List[CategorySchema])
async def get_categories(
    parent_id: str = None,
    type: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all categories"""
    query = db.query(Category)
    
    if parent_id:
        query = query.filter(Category.parent_id == parent_id)
    if type:
        query = query.filter(Category.type == type)
    
    categories = query.all()
    return categories

@router.post("/categories", response_model=CategorySchema)
async def create_category(
    category_data: CategoryCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new category (admin/supervisor only)"""
    existing_category = db.query(Category).filter(Category.id == category_data.id).first()
    if existing_category:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category with this ID already exists"
        )
    
    db_category = Category(**category_data.dict())
    db.add(db_category)
    db.commit()
    db.refresh(db_category)
    return db_category

@router.put("/categories/{category_id}", response_model=CategorySchema)
async def update_category(
    category_id: str,
    category_update: CategoryUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a category (admin/supervisor only)"""
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found"
        )
    
    update_data = category_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(category, field, value)
    
    db.commit()
    db.refresh(category)
    return category

# Vendor endpoints
@router.get("/vendors", response_model=List[VendorSchema])
async def get_vendors(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all vendors"""
    vendors = db.query(Vendor).all()
    return vendors

@router.post("/vendors", response_model=VendorSchema)
async def create_vendor(
    vendor_data: VendorCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new vendor (admin/supervisor only)"""
    existing_vendor = db.query(Vendor).filter(Vendor.id == vendor_data.id).first()
    if existing_vendor:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Vendor with this ID already exists"
        )
    
    db_vendor = Vendor(**vendor_data.dict())
    db.add(db_vendor)
    db.commit()
    db.refresh(db_vendor)
    return db_vendor

@router.put("/vendors/{vendor_id}", response_model=VendorSchema)
async def update_vendor(
    vendor_id: str,
    vendor_update: VendorUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a vendor (admin/supervisor only)"""
    vendor = db.query(Vendor).filter(Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Vendor not found"
        )
    
    update_data = vendor_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(vendor, field, value)
    
    db.commit()
    db.refresh(vendor)
    return vendor
