"""
Scanner API for forklift pallet scanning and forklift requests.

Route handlers are thin — all business logic lives in services/scanner_service.py.
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import User, ForkliftRequest, PalletLicence
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
from app.enums import PalletStatus
from app.services import scanner_service


# Statuses that mean "this sequence is accounted for and should NOT appear as missing".
# Includes NOT_PRODUCED (supervisor confirmed the line skipped that sticker).
# Excludes CANCELLED (those sequences are still missing — someone has to refill).
_COVERED_PALLET_STATUSES = (
    PalletStatus.PENDING,
    PalletStatus.MISSING_STICKER,
    PalletStatus.IN_STOCK,
    PalletStatus.RESERVED,
    PalletStatus.PLACED,
    PalletStatus.TRANSFERRED,
    PalletStatus.SHIPPED,
    PalletStatus.NOT_PRODUCED,
)


def _sequences_covered_for_lot(db: Session, fr: ForkliftRequest, lot: str) -> list[int]:
    """Sequences for `lot` + this request's product that live on OTHER sessions."""
    if not lot or not fr.product_id:
        return []
    rows = (
        db.query(PalletLicence.sequence)
        .filter(
            PalletLicence.lot_number == lot,
            PalletLicence.product_id == fr.product_id,
            PalletLicence.forklift_request_id != fr.id,
            PalletLicence.status.in_(_COVERED_PALLET_STATUSES),
            PalletLicence.sequence.isnot(None),
        )
        .distinct()
        .all()
    )
    return sorted({int(seq) for (seq,) in rows if seq is not None})


def _compute_covered_sequences(db: Session, fr: ForkliftRequest) -> list[int]:
    """Coverage for the request's own lot_number only.

    Superseded by _compute_covered_sequences_by_prefix, and kept so a browser
    still running the previous bundle behaves exactly as it did before. Remove
    once the frontend has been deployed for long enough that no cached client
    reads it.
    """
    return _sequences_covered_for_lot(db, fr, fr.lot_number)


def _compute_covered_sequences_by_prefix(db: Session, fr: ForkliftRequest) -> dict:
    """Coverage keyed by licence prefix (lot + product code).

    A session spans two lots whenever production runs through midnight, but
    ForkliftRequest.lot_number holds only one of them. Asking for coverage by
    that single field meant the secondary lot was never looked up at all, so
    every sequence below its highest one was reported missing: one pallet at
    sequence 195 produced 194 phantom gaps on a 27-pallet session, while the
    183 real pallets sat in stock from two earlier sessions.

    Keying by prefix asks the question once per lot, and keeps one lot's
    coverage from being applied to another's sequence numbers.
    """
    prefixes = set()
    for pl in (fr.pallet_licences or []):
        lic = pl.licence_number or ""
        cut = lic.rfind("-")
        if cut > 0 and pl.sequence is not None:
            prefixes.add(lic[:cut])

    out: dict = {}
    for prefix in prefixes:
        cut = prefix.rfind("-")
        lot = prefix[:cut] if cut > 0 else prefix
        out[prefix] = _sequences_covered_for_lot(db, fr, lot)
    return out


def _attach_covered_sequences(db: Session, frs: list[ForkliftRequest]) -> None:
    """Mutate each ForkliftRequest in-place so pydantic picks up the coverage fields."""
    for fr in frs:
        fr.covered_sequences = _compute_covered_sequences(db, fr)
        fr.covered_sequences_by_prefix = _compute_covered_sequences_by_prefix(db, fr)


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
def create_forklift_request(
    data: ForkliftRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create new forklift request (start scanning session)."""
    return scanner_service.create_forklift_request(db, data.licence_number, current_user)


@router.get("/requests/active")
def get_active_request(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin),
):
    """Return the current user's active SCANNING session with pallets, or null if none."""
    return scanner_service.get_active_scanning_session(db, current_user)


@router.post("/requests/{request_id}/scan")
def scan_pallet(
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
        idempotency_key=data.idempotency_key,
        allow_overfill=data.allow_overfill,
    )


@router.post("/requests/{request_id}/mark-missing")
def mark_missing_pallets(
    request_id: str,
    data: MarkMissingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Mark pallets as missing (damaged sticker)."""
    return scanner_service.mark_missing_pallets(db, request_id, data.licence_numbers, current_user)


@router.post("/requests/{request_id}/mark-not-produced")
def mark_not_produced(
    request_id: str,
    data: MarkMissingRequest,  # same shape: { licence_numbers: [...] }
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Supervisor marks pallet slots as 'never produced by the production line'.
    Removes them from the missing-pallets list in this card and any other card
    for the same lot. Final action — undo requires DB intervention."""
    if current_user.role == ROLE_FORKLIFT:
        # Only approvers should be able to declare "not produced"
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only supervisors/admins can mark pallets as not produced",
        )
    return scanner_service.mark_not_produced(db, request_id, data.licence_numbers, current_user)


@router.post("/requests/{request_id}/submit")
def submit_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Submit completed scan session for approval."""
    return scanner_service.submit_forklift_request(db, request_id)


@router.get("/requests", response_model=List[ForkliftRequestSchema])
def list_forklift_requests(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List forklift requests (for approvals page)."""
    # Surface abandoned sessions: any SCANNING session idle past the 3h window
    # is auto-submitted (or auto-cancelled if empty) before we build the list.
    scanner_service.auto_close_stale_sessions(db)
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
    frs = query.order_by(ForkliftRequest.created_at.desc()).all()
    _attach_covered_sequences(db, frs)
    return frs


@router.get("/requests/{request_id}", response_model=ForkliftRequestSchema)
def get_forklift_request(
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
    fr.covered_sequences = _compute_covered_sequences(db, fr)
    fr.covered_sequences_by_prefix = _compute_covered_sequences_by_prefix(db, fr)
    return fr


@router.put("/requests/{request_id}", response_model=ForkliftRequestSchema)
def update_forklift_request(
    request_id: str,
    data: ForkliftRequestUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Update forklift request (checker corrections)."""
    update_data = data.dict(exclude_unset=True)
    return scanner_service.update_forklift_request(db, request_id, update_data, current_user)


@router.post("/requests/{request_id}/approve")
def approve_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Approve forklift request - creates receipt and links pallet licences."""
    return scanner_service.approve_forklift_request(db, request_id, current_user)


@router.post("/requests/{request_id}/reject")
def reject_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Reject forklift request - marks all pallet licences as cancelled."""
    return scanner_service.reject_forklift_request(db, request_id, current_user)


@router.delete("/requests/{request_id}/pallet-licences/{licence_id}")
def remove_pallet_licence(
    request_id: str,
    licence_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Remove a pallet licence from a forklift request (supervisor correction)."""
    return scanner_service.remove_pallet_licence(db, request_id, licence_id, current_user)


@router.put("/requests/{request_id}/pallet-licences/{licence_id}")
def update_pallet_licence(
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
def add_pallet_to_request(
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
def create_internal_transfer(
    data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create internal transfer from scanner."""
    moves = data.get("moves") or []
    return scanner_service.create_internal_transfer(db, moves, current_user)


@router.get("/storage-rows")
def list_storage_rows_with_capacity(
    request_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List storage rows with available capacity for scanner dropdown."""
    return scanner_service.list_storage_rows_with_capacity(db)
