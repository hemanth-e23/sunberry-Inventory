from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    Location, SubLocation, StorageArea, StorageRow,
    ProductionShift, ProductionLine
)
from app.schemas import (
    Location as LocationSchema, LocationCreate, LocationUpdate,
    SubLocation as SubLocationSchema, SubLocationCreate, SubLocationUpdate,
    StorageArea as StorageAreaSchema, StorageAreaCreate, StorageAreaUpdate,
    StorageRow as StorageRowSchema, StorageRowCreate, StorageRowUpdate,
    ProductionShift as ProductionShiftSchema, ProductionShiftCreate, ProductionShiftUpdate,
    ProductionLine as ProductionLineSchema, ProductionLineCreate, ProductionLineUpdate
)
from app.utils.auth import get_current_active_user, require_role

router = APIRouter()

# Location endpoints
@router.get("/locations", response_model=List[LocationSchema])
async def get_locations(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all locations"""
    locations = db.query(Location).all()
    return locations

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
    
    db_location = Location(**location_data.dict())
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
