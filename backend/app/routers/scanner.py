"""
Scanner API for forklift pallet scanning and forklift requests.

Route handlers are thin — all business logic lives in services/scanner_service.py.
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import User, ForkliftRequest
from app.schemas import (
    ForkliftRequest as ForkliftRequestSchema,
    ForkliftRequestCreate,
    ForkliftRequestUpdate,
    PalletLicenceUpdate,
    ScanPalletRequest,
    MarkMissingRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.constants import ROLE_FORKLIFT, ROLE_ADMIN, ROLE_SUPERVISOR
from app.services import scanner_service


router = APIRouter()


def require_forklift_or_admin(current_user: User = Depends(get_current_active_user)) -> User:
    """Allow forklift (for scanning) or admin/supervisor (for approvals)."""
    if current_user.role not in (ROLE_FORKLIFT, ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forklift or admin/supervisor access required"
        )
    return current_user


@router.post("/requests", response_model=ForkliftRequestSchema)
async def create_forklift_request(
    data: ForkliftRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create new forklift request (start scanning session)."""
    return scanner_service.create_forklift_request(db, data.licence_number, current_user)


@router.get("/requests/active")
async def get_active_request(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin),
):
    """Return the current user's active SCANNING session with pallets, or null if none."""
    return scanner_service.get_active_scanning_session(db, current_user)


@router.post("/requests/{request_id}/scan")
async def scan_pallet(
    request_id: str,
    data: ScanPalletRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Scan a pallet into the current request."""
    return scanner_service.scan_pallet(
        db,
        request_id,
        data.licence_number,
        data.storage_row_id,
        data.is_partial,
        data.partial_cases,
        current_user,
    )


@router.post("/requests/{request_id}/mark-missing")
async def mark_missing_pallets(
    request_id: str,
    data: MarkMissingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Mark pallets as missing (damaged sticker)."""
    return scanner_service.mark_missing_pallets(db, request_id, data.licence_numbers, current_user)


@router.post("/requests/{request_id}/submit")
async def submit_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Submit completed scan session for approval."""
    return scanner_service.submit_forklift_request(db, request_id)


@router.get("/requests", response_model=List[ForkliftRequestSchema])
async def list_forklift_requests(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List forklift requests (for approvals page)."""
    query = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(ForkliftRequest.warehouse_id == wh_id)
    if status_filter:
        query = query.filter(ForkliftRequest.status == status_filter)
    if current_user.role == ROLE_FORKLIFT:
        query = query.filter(ForkliftRequest.scanned_by == str(current_user.id))
    return query.order_by(ForkliftRequest.created_at.desc()).all()


@router.get("/requests/{request_id}", response_model=ForkliftRequestSchema)
async def get_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Get forklift request with pallet licences."""
    fr = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
        joinedload(ForkliftRequest.shift),
        joinedload(ForkliftRequest.line),
    ).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    return fr


@router.put("/requests/{request_id}", response_model=ForkliftRequestSchema)
async def update_forklift_request(
    request_id: str,
    data: ForkliftRequestUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Update forklift request (checker corrections)."""
    update_data = data.dict(exclude_unset=True)
    return scanner_service.update_forklift_request(db, request_id, update_data, current_user)


@router.post("/requests/{request_id}/approve")
async def approve_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Approve forklift request - creates receipt and links pallet licences."""
    return scanner_service.approve_forklift_request(db, request_id, current_user)


@router.post("/requests/{request_id}/reject")
async def reject_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Reject forklift request - marks all pallet licences as cancelled."""
    return scanner_service.reject_forklift_request(db, request_id, current_user)


@router.delete("/requests/{request_id}/pallet-licences/{licence_id}")
async def remove_pallet_licence(
    request_id: str,
    licence_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Remove a pallet licence from a forklift request (supervisor correction)."""
    return scanner_service.remove_pallet_licence(db, request_id, licence_id, current_user)


@router.put("/requests/{request_id}/pallet-licences/{licence_id}")
async def update_pallet_licence(
    request_id: str,
    licence_id: str,
    data: PalletLicenceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Update a pallet licence within a forklift request (supervisor correction)."""
    update_data = data.dict(exclude_unset=True)
    return scanner_service.update_pallet_licence(db, request_id, licence_id, update_data, current_user)


@router.post("/requests/{request_id}/add-pallet")
async def add_pallet_to_request(
    request_id: str,
    data: ScanPalletRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Add a pallet licence to a forklift request (supervisor correction for missed scans)."""
    return scanner_service.add_pallet_to_request(
        db, request_id, data.licence_number, data.storage_row_id,
        data.is_partial, data.partial_cases, current_user,
    )


@router.post("/internal-transfer")
async def create_internal_transfer(
    data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create internal transfer from scanner."""
    moves = data.get("moves") or []
    return scanner_service.create_internal_transfer(db, moves, current_user)


@router.get("/storage-rows")
async def list_storage_rows_with_capacity(
    request_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List storage rows with available capacity for scanner dropdown."""
    return scanner_service.list_storage_rows_with_capacity(db)
