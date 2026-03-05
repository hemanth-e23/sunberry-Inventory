"""
Pallet licence lookup API - search and list pallet licences.
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import PalletLicence, Product, StorageRow, StorageArea
from app.schemas import PalletLicence as PalletLicenceSchema
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()


@router.get("/", response_model=List[PalletLicenceSchema])
async def list_pallet_licences(
    licence_number: Optional[str] = Query(None, description="Search by exact or partial licence number"),
    receipt_id: Optional[str] = Query(None, description="Filter by receipt ID"),
    storage_row_id: Optional[str] = Query(None, description="Filter by storage row ID"),
    product_id: Optional[str] = Query(None, description="Filter by product ID"),
    status: Optional[str] = Query(None, description="Filter by status (e.g. in_stock, shipped)"),
    is_held: Optional[bool] = Query(None, description="Filter by hold status"),
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """List pallet licences with optional filters."""
    query = db.query(PalletLicence).options(
        joinedload(PalletLicence.product),
        joinedload(PalletLicence.storage_row),
        joinedload(PalletLicence.storage_area),
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(PalletLicence.warehouse_id == wh_id)
    if licence_number:
        query = query.filter(PalletLicence.licence_number.ilike(f"%{licence_number}%"))
    if receipt_id:
        query = query.filter(PalletLicence.receipt_id == receipt_id)
    if storage_row_id:
        query = query.filter(PalletLicence.storage_row_id == storage_row_id)
    if product_id:
        query = query.filter(PalletLicence.product_id == product_id)
    if status:
        query = query.filter(PalletLicence.status == status)
    if is_held is not None:
        query = query.filter(PalletLicence.is_held == is_held)
    licences = query.order_by(PalletLicence.sequence).all()
    return licences
