from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    Location, SubLocation, StorageArea, StorageRow,
    ProductionShift, ProductionLine, Warehouse, WarehouseCategoryAccess, CategoryGroup,
)
from app.schemas import (
    Location as LocationSchema, LocationCreate, LocationUpdate,
    SubLocation as SubLocationSchema, SubLocationCreate, SubLocationUpdate,
    StorageArea as StorageAreaSchema, StorageAreaCreate, StorageAreaUpdate,
    StorageRow as StorageRowSchema, StorageRowCreate, StorageRowUpdate,
    ProductionShift as ProductionShiftSchema, ProductionShiftCreate, ProductionShiftUpdate,
    ProductionLine as ProductionLineSchema, ProductionLineCreate, ProductionLineUpdate,
    WarehouseFull, WarehouseCreate, WarehouseUpdate,
    WarehouseCategoryAccessOut, WarehouseCategoryAccessCreate,
)
from app.utils.auth import get_current_active_user, require_role, warehouse_filter, require_superadmin
from app.constants import ROLE_SUPERADMIN

router = APIRouter()


# Warehouse endpoints
@router.get("/warehouses", response_model=List[WarehouseFull])
async def get_warehouses(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """List all warehouses (active + inactive for superadmin, active-only for others)."""
    query = db.query(Warehouse)
    if current_user.role != ROLE_SUPERADMIN:
        query = query.filter(Warehouse.is_active == True)
    return query.order_by(Warehouse.name).all()


@router.post("/warehouses", response_model=WarehouseFull)
async def create_warehouse(
    data: WarehouseCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """Create a new warehouse (superadmin only)."""
    if db.query(Warehouse).filter(Warehouse.id == data.id).first():
        raise HTTPException(status_code=400, detail="Warehouse ID already exists")
    if db.query(Warehouse).filter(Warehouse.code == data.code).first():
        raise HTTPException(status_code=400, detail="Warehouse code already in use")
    wh = Warehouse(**data.model_dump())
    db.add(wh)
    db.commit()
    db.refresh(wh)
    return wh


@router.put("/warehouses/{warehouse_id}", response_model=WarehouseFull)
async def update_warehouse(
    warehouse_id: str,
    data: WarehouseUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """Update a warehouse (superadmin only)."""
    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(wh, field, value)
    db.commit()
    db.refresh(wh)
    return wh


# Warehouse category access endpoints (superadmin only)
@router.get("/warehouses/{warehouse_id}/category-access", response_model=List[WarehouseCategoryAccessOut])
async def get_warehouse_category_access(
    warehouse_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """List category groups assigned to a warehouse."""
    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    return db.query(WarehouseCategoryAccess).filter(
        WarehouseCategoryAccess.warehouse_id == warehouse_id
    ).all()


@router.post("/warehouses/{warehouse_id}/category-access", response_model=WarehouseCategoryAccessOut)
async def assign_category_access(
    warehouse_id: str,
    data: WarehouseCategoryAccessCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """Assign a category group to a warehouse (superadmin only)."""
    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    grp = db.query(CategoryGroup).filter(CategoryGroup.id == data.category_group_id).first()
    if not grp:
        raise HTTPException(status_code=404, detail="Category group not found")
    existing = db.query(WarehouseCategoryAccess).filter(
        WarehouseCategoryAccess.warehouse_id == warehouse_id,
        WarehouseCategoryAccess.category_group_id == data.category_group_id,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Category group already assigned to this warehouse")
    access = WarehouseCategoryAccess(
        warehouse_id=warehouse_id,
        category_group_id=data.category_group_id,
    )
    db.add(access)
    db.commit()
    db.refresh(access)
    return access


@router.delete("/warehouses/{warehouse_id}/category-access/{category_group_id}")
async def remove_category_access(
    warehouse_id: str,
    category_group_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """Remove a category group assignment from a warehouse (superadmin only)."""
    access = db.query(WarehouseCategoryAccess).filter(
        WarehouseCategoryAccess.warehouse_id == warehouse_id,
        WarehouseCategoryAccess.category_group_id == category_group_id,
    ).first()
    if not access:
        raise HTTPException(status_code=404, detail="Assignment not found")
    db.delete(access)
    db.commit()
    return {"message": "Category access removed"}


@router.post("/warehouses/{warehouse_id}/toggle-product-creation", response_model=WarehouseFull)
async def toggle_product_creation(
    warehouse_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(require_superadmin),
):
    """Toggle allow_product_creation flag on a warehouse (superadmin only)."""
    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    wh.allow_product_creation = not wh.allow_product_creation
    db.commit()
    db.refresh(wh)
    return wh


# Location endpoints
@router.get("/locations", response_model=List[LocationSchema])
async def get_locations(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all locations"""
    query = db.query(Location)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Location.warehouse_id == wh_id)
    return query.all()

@router.post("/locations", response_model=LocationSchema)
async def create_location(
    location_data: LocationCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new location (admin/supervisor only)"""
    existing_location = db.query(Location).filter(Location.id == location_data.id).first()
    if existing_location:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Location with this ID already exists"
        )
    
    db_location = Location(**location_data.dict(), warehouse_id=current_user.warehouse_id)
    db.add(db_location)
    db.commit()
    db.refresh(db_location)
    return db_location

@router.put("/locations/{location_id}", response_model=LocationSchema)
async def update_location(
    location_id: str,
    location_update: LocationUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a location (admin/supervisor only)"""
    location = db.query(Location).filter(Location.id == location_id).first()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found"
        )
    
    update_data = location_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(location, field, value)
    
    db.commit()
    db.refresh(location)
    return location

# SubLocation endpoints
@router.get("/sub-locations", response_model=List[SubLocationSchema])
async def get_sub_locations(
    location_id: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all sub-locations with their rows"""
    from sqlalchemy.orm import joinedload
    query = db.query(SubLocation).options(joinedload(SubLocation.rows))

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.join(Location, SubLocation.location_id == Location.id).filter(Location.warehouse_id == wh_id)

    if location_id:
        query = query.filter(SubLocation.location_id == location_id)

    sub_locations = query.all()
    return sub_locations

@router.post("/sub-locations", response_model=SubLocationSchema)
async def create_sub_location(
    sub_location_data: SubLocationCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new sub-location (admin/supervisor only)"""
    existing_sub_location = db.query(SubLocation).filter(SubLocation.id == sub_location_data.id).first()
    if existing_sub_location:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Sub-location with this ID already exists"
        )
    
    db_sub_location = SubLocation(**sub_location_data.dict())
    db.add(db_sub_location)
    db.commit()
    db.refresh(db_sub_location)
    return db_sub_location

@router.put("/sub-locations/{sub_location_id}", response_model=SubLocationSchema)
async def update_sub_location(
    sub_location_id: str,
    sub_location_update: SubLocationUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a sub-location (admin/supervisor only)"""
    sub_location = db.query(SubLocation).filter(SubLocation.id == sub_location_id).first()
    if not sub_location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sub-location not found"
        )
    
    update_data = sub_location_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(sub_location, field, value)
    
    db.commit()
    db.refresh(sub_location)
    return sub_location

# Storage Area endpoints
@router.get("/storage-areas", response_model=List[StorageAreaSchema])
async def get_storage_areas(
    sub_location_id: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all storage areas"""
    query = db.query(StorageArea)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.join(Location, StorageArea.location_id == Location.id).filter(Location.warehouse_id == wh_id)

    if sub_location_id:
        query = query.filter(StorageArea.sub_location_id == sub_location_id)

    storage_areas = query.all()
    return storage_areas

@router.post("/storage-areas", response_model=StorageAreaSchema)
async def create_storage_area(
    storage_area_data: StorageAreaCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new storage area (admin/supervisor only)"""
    existing_storage_area = db.query(StorageArea).filter(StorageArea.id == storage_area_data.id).first()
    if existing_storage_area:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Storage area with this ID already exists"
        )
    
    db_storage_area = StorageArea(**storage_area_data.dict())
    db.add(db_storage_area)
    db.commit()
    db.refresh(db_storage_area)
    return db_storage_area

@router.put("/storage-areas/{storage_area_id}", response_model=StorageAreaSchema)
async def update_storage_area(
    storage_area_id: str,
    storage_area_update: StorageAreaUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a storage area (admin/supervisor only)"""
    storage_area = db.query(StorageArea).filter(StorageArea.id == storage_area_id).first()
    if not storage_area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Storage area not found"
        )
    
    update_data = storage_area_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(storage_area, field, value)
    
    db.commit()
    db.refresh(storage_area)
    return storage_area

# Storage Row endpoints
@router.post("/storage-rows", response_model=StorageRowSchema)
async def create_storage_row(
    row_data: StorageRowCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new storage row (admin/supervisor only)"""
    existing_row = db.query(StorageRow).filter(StorageRow.id == row_data.id).first()
    if existing_row:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Storage row with this ID already exists"
        )
    
    db_row = StorageRow(**row_data.dict())
    db.add(db_row)
    db.commit()
    db.refresh(db_row)
    return db_row

@router.get("/storage-rows/{row_id}", response_model=StorageRowSchema)
async def get_storage_row(
    row_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get a specific storage row by ID"""
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Storage row not found"
        )
    return row

@router.put("/storage-rows/{row_id}", response_model=StorageRowSchema)
async def update_storage_row(
    row_id: str,
    row_update: StorageRowUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a storage row (admin/supervisor only)"""
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Storage row not found"
        )
    
    update_data = row_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(row, field, value)
    
    db.commit()
    db.refresh(row)
    return row

# Production Shift endpoints
@router.get("/production-shifts", response_model=List[ProductionShiftSchema])
async def get_production_shifts(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all production shifts"""
    shifts = db.query(ProductionShift).all()
    return shifts

@router.post("/production-shifts", response_model=ProductionShiftSchema)
async def create_production_shift(
    shift_data: ProductionShiftCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new production shift (admin/supervisor only)"""
    existing_shift = db.query(ProductionShift).filter(ProductionShift.id == shift_data.id).first()
    if existing_shift:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Production shift with this ID already exists"
        )
    
    db_shift = ProductionShift(**shift_data.dict())
    db.add(db_shift)
    db.commit()
    db.refresh(db_shift)
    return db_shift

@router.put("/production-shifts/{shift_id}", response_model=ProductionShiftSchema)
async def update_production_shift(
    shift_id: str,
    shift_update: ProductionShiftUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a production shift (admin/supervisor only)"""
    shift = db.query(ProductionShift).filter(ProductionShift.id == shift_id).first()
    if not shift:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Production shift not found"
        )
    
    update_data = shift_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(shift, field, value)
    
    db.commit()
    db.refresh(shift)
    return shift

# Production Line endpoints
@router.get("/production-lines", response_model=List[ProductionLineSchema])
async def get_production_lines(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all production lines"""
    lines = db.query(ProductionLine).all()
    return lines

@router.post("/production-lines", response_model=ProductionLineSchema)
async def create_production_line(
    line_data: ProductionLineCreate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Create a new production line (admin/supervisor only)"""
    existing_line = db.query(ProductionLine).filter(ProductionLine.id == line_data.id).first()
    if existing_line:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Production line with this ID already exists"
        )
    
    db_line = ProductionLine(**line_data.dict())
    db.add(db_line)
    db.commit()
    db.refresh(db_line)
    return db_line

@router.put("/production-lines/{line_id}", response_model=ProductionLineSchema)
async def update_production_line(
    line_id: str,
    line_update: ProductionLineUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(require_role("admin"))
):
    """Update a production line (admin/supervisor only)"""
    line = db.query(ProductionLine).filter(ProductionLine.id == line_id).first()
    if not line:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Production line not found"
        )
    
    update_data = line_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(line, field, value)
    
    db.commit()
    db.refresh(line)
    return line
