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
from app.utils.auth import (
    get_current_active_user, require_role, require_superadmin,
    get_accessible_category_ids, get_accessible_group_ids, can_create_products,
)

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
    """Get products with pagination. Filtered by warehouse category access."""
    query = db.query(Product)

    # Warehouse-scoped filter: None = no filter (superadmin/corporate), [] = see nothing
    accessible = get_accessible_category_ids(db, current_user)
    if accessible is not None:
        if not accessible:
            return {"items": [], "total": 0}
        query = query.filter(Product.category_id.in_(accessible))

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
    current_user = Depends(get_current_active_user)
):
    """Create a new product. Superadmin: any category. Warehouse admin: assigned categories only if flag is on."""
    if not can_create_products(db, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")

    # Non-superadmin must create within their accessible categories
    accessible = get_accessible_category_ids(db, current_user)
    if accessible is not None and product_data.category_id not in accessible:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category not accessible to your warehouse"
        )

    existing_product = db.query(Product).filter(Product.id == product_data.id).first()
    if existing_product:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Product with this ID already exists")

    if product_data.sid:
        if db.query(Product).filter(Product.sid == product_data.sid, Product.id != product_data.id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with SID code '{product_data.sid}' already exists")

    if product_data.fcc_code:
        if db.query(Product).filter(Product.fcc_code == product_data.fcc_code, Product.id != product_data.id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with FCC code '{product_data.fcc_code}' already exists")

    if product_data.short_code:
        if db.query(Product).filter(Product.short_code == product_data.short_code, Product.id != product_data.id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with short code '{product_data.short_code}' already exists")

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
    current_user = Depends(get_current_active_user)
):
    """Update a product. Same permission rules as create."""
    if not can_create_products(db, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")

    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")

    # Non-superadmin can only edit products in their accessible categories
    accessible = get_accessible_category_ids(db, current_user)
    if accessible is not None and product.category_id not in accessible:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category not accessible to your warehouse"
        )

    update_data = product_update.dict(exclude_unset=True)

    if 'sid' in update_data and update_data['sid']:
        if db.query(Product).filter(Product.sid == update_data['sid'], Product.id != product_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with SID code '{update_data['sid']}' already exists")

    if 'fcc_code' in update_data and update_data['fcc_code']:
        if db.query(Product).filter(Product.fcc_code == update_data['fcc_code'], Product.id != product_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with FCC code '{update_data['fcc_code']}' already exists")

    if 'short_code' in update_data and update_data['short_code']:
        if db.query(Product).filter(Product.short_code == update_data['short_code'], Product.id != product_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Product with short code '{update_data['short_code']}' already exists")

    for field, value in update_data.items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)
    return product

@router.post("/products/{product_id}/toggle-status")
async def toggle_product_status(
    product_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(require_superadmin)
):
    """Toggle product active status (superadmin only)"""
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")

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
    """Get category groups. Filtered by warehouse assignment for plant users."""
    group_ids = get_accessible_group_ids(db, current_user)
    query = db.query(CategoryGroup).filter(CategoryGroup.is_active == True)
    if group_ids is not None:
        if not group_ids:
            return []
        query = query.filter(CategoryGroup.id.in_(group_ids))
    return query.all()

@router.post("/category-groups", response_model=CategoryGroupSchema)
async def create_category_group(
    category_group_data: CategoryGroupCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_superadmin)
):
    """Create a new category group (superadmin only)"""
    existing_group = db.query(CategoryGroup).filter(CategoryGroup.id == category_group_data.id).first()
    if existing_group:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category group with this ID already exists")

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
    current_user = Depends(require_superadmin)
):
    """Update a category group (superadmin only)"""
    group = db.query(CategoryGroup).filter(CategoryGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category group not found")

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
    """Get categories. Filtered by warehouse assignment for plant users."""
    query = db.query(Category)

    # Warehouse-scoped filter via group IDs
    group_ids = get_accessible_group_ids(db, current_user)
    if group_ids is not None:
        if not group_ids:
            return []
        query = query.filter(Category.parent_id.in_(group_ids))

    if parent_id:
        query = query.filter(Category.parent_id == parent_id)
    if type:
        query = query.filter(Category.type == type)

    return query.all()

@router.post("/categories", response_model=CategorySchema)
async def create_category(
    category_data: CategoryCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_superadmin)
):
    """Create a new category (superadmin only)"""
    existing_category = db.query(Category).filter(Category.id == category_data.id).first()
    if existing_category:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Category with this ID already exists")

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
    current_user = Depends(require_superadmin)
):
    """Update a category (superadmin only)"""
    category = db.query(Category).filter(Category.id == category_id).first()
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")

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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Vendor with this ID already exists")

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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vendor not found")

    update_data = vendor_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(vendor, field, value)

    db.commit()
    db.refresh(vendor)
    return vendor
