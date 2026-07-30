from typing import List
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models import (
    Location, SubLocation, StorageArea, StorageRow,
    ProductionShift, ProductionLine, Warehouse, WarehouseCategoryAccess, CategoryGroup,
    PalletLicence, PackageSize, ShipToLocation, Carrier, PalletType,
)
from app.enums import PalletStatus
from app.schemas import (
    Location as LocationSchema, LocationCreate, LocationUpdate,
    SubLocation as SubLocationSchema, SubLocationCreate, SubLocationUpdate,
    StorageArea as StorageAreaSchema, StorageAreaCreate, StorageAreaUpdate,
    StorageRow as StorageRowSchema, StorageRowCreate, StorageRowUpdate,
    ProductionShift as ProductionShiftSchema, ProductionShiftCreate, ProductionShiftUpdate,
    ProductionLine as ProductionLineSchema, ProductionLineCreate, ProductionLineUpdate,
    WarehouseFull, WarehouseCreate, WarehouseUpdate,
    WarehouseCategoryAccessOut, WarehouseCategoryAccessCreate,
    PackageSize as PackageSizeSchema, PackageSizeCreate, PackageSizeUpdate,
    ShipToLocationOut, CarrierOut, PalletTypeOut,
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
def _attach_live_row_aggregates(db: Session, storage_areas: list) -> None:
    """Populate live_pallets / live_cases / live_products on each StorageRow ORM
    instance by aggregating in_stock pallet_licences. FG-only — RM rows don't
    use pallet_licences, so this is called only for storage_areas.rows.

    Mutates the ORM instances in place; Pydantic picks the fields up via
    from_attributes. Two grouped queries (totals + per-product breakdown), no
    N+1 over rows."""
    row_ids: list[str] = []
    for area in storage_areas:
        for row in (area.rows or []):
            row_ids.append(row.id)
    if not row_ids:
        return

    totals_q = (
        db.query(
            PalletLicence.storage_row_id,
            func.count(PalletLicence.id),
            func.coalesce(func.sum(PalletLicence.cases), 0),
        )
        .filter(
            PalletLicence.storage_row_id.in_(row_ids),
            PalletLicence.status == PalletStatus.IN_STOCK,
            PalletLicence.is_held == False,  # noqa: E712
            PalletLicence.is_deleted == False,  # noqa: E712
        )
        .group_by(PalletLicence.storage_row_id)
        .all()
    )
    totals = {row_id: (int(n), float(cases)) for row_id, n, cases in totals_q}

    breakdown_q = (
        db.query(
            PalletLicence.storage_row_id,
            PalletLicence.product_id,
            PalletLicence.lot_number,
            func.count(PalletLicence.id),
            func.coalesce(func.sum(PalletLicence.cases), 0),
        )
        .filter(
            PalletLicence.storage_row_id.in_(row_ids),
            PalletLicence.status == PalletStatus.IN_STOCK,
            PalletLicence.is_held == False,  # noqa: E712
            PalletLicence.is_deleted == False,  # noqa: E712
        )
        .group_by(
            PalletLicence.storage_row_id,
            PalletLicence.product_id,
            PalletLicence.lot_number,
        )
        .all()
    )
    breakdown: dict[str, list[dict]] = defaultdict(list)
    for row_id, product_id, lot_number, n, cases in breakdown_q:
        if not product_id:
            continue
        breakdown[row_id].append({
            "product_id": product_id,
            "lot_number": lot_number,
            "pallets": int(n),
            "cases": float(cases),
        })

    for area in storage_areas:
        for row in (area.rows or []):
            pallets, cases = totals.get(row.id, (0, 0.0))
            # Set on the ORM instance so Pydantic (from_attributes=True) reads it
            row.live_pallets = float(pallets)
            row.live_cases = float(cases)
            row.live_products = breakdown.get(row.id, [])


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
    _attach_live_row_aggregates(db, storage_areas)
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


# ---------------------------------------------------------------------------
# Package sizes (SPEC §7.1) — case weight is set once per size; every product
# of that size inherits it. List is open to any authed user (product form
# dropdown); mutations are admin-only.
# ---------------------------------------------------------------------------
import uuid as _uuid


@router.get("/package-sizes", response_model=List[PackageSizeSchema])
async def get_package_sizes(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return (
        db.query(PackageSize)
        .order_by(PackageSize.sort_order, PackageSize.label)
        .all()
    )


@router.post("/package-sizes", response_model=PackageSizeSchema)
async def create_package_size(
    data: PackageSizeCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin")),
):
    if db.query(PackageSize).filter(func.lower(PackageSize.label) == data.label.lower()).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A package size with that label already exists")
    ps = PackageSize(id=f"pkgsize-{_uuid.uuid4().hex[:12]}", **data.dict())
    db.add(ps)
    db.commit()
    db.refresh(ps)
    return ps


@router.put("/package-sizes/{size_id}", response_model=PackageSizeSchema)
async def update_package_size(
    size_id: str,
    data: PackageSizeUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin")),
):
    ps = db.query(PackageSize).filter(PackageSize.id == size_id).first()
    if not ps:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Package size not found")
    for field, value in data.dict(exclude_unset=True).items():
        setattr(ps, field, value)
    db.commit()
    db.refresh(ps)
    return ps


# ---------------------------------------------------------------------------
# Self-populating ship-out master data (SPEC §7.2) — read lists feed the
# scheduled-order form's type-aheads/dropdowns. Rows are created on first use
# by the order-create endpoint, so no create endpoints here.
# ---------------------------------------------------------------------------
@router.get("/ship-to-locations", response_model=List[ShipToLocationOut])
async def get_ship_to_locations(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return (
        db.query(ShipToLocation)
        .filter(ShipToLocation.is_active == True)
        .order_by(ShipToLocation.customer_name, ShipToLocation.location_name)
        .all()
    )


@router.get("/carriers", response_model=List[CarrierOut])
async def get_carriers(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return (
        db.query(Carrier)
        .filter(Carrier.is_active == True)
        .order_by(Carrier.name)
        .all()
    )


@router.get("/pallet-types", response_model=List[PalletTypeOut])
async def get_pallet_types(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return (
        db.query(PalletType)
        .filter(PalletType.is_active == True)
        .order_by(PalletType.is_default.desc(), PalletType.name)
        .all()
    )
