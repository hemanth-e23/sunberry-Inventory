"""Forklift staging-pull gun flow.

Same contract as lot receiving (routers/lot_receiving.py docstring):

* Every soft question is a 200 with a `status` discriminator — a 4xx makes
  the offline scan queue park the item as permanently failed.
* One response shape for every scan outcome.
* The idempotency check runs first, inside the service.

Scan/undo are forklift work → plain `get_current_active_user`. Rack codes
are resolved by the existing GET /api/lot-receiving/resolve-row — this
router does not duplicate it.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.schemas.staging_pull import (
    StagingPullScanRequest,
    StagingPullScanResponse,
    StagingPullSubmitRequest,
    StagingPullSubmitResponse,
)
from app.services import staging_pull_service as sps
from app.utils.auth import get_current_active_user

router = APIRouter()


@router.get("/requests")
def list_open_requests(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Open production staging requests, oldest production date first."""
    return sps.open_requests(db)


@router.get("/requests/{request_id}")
def get_request_detail(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Items + FEFO lot / rack suggestions + gun progress for one request."""
    return sps.request_detail(db, request_id)


@router.post("/requests/{request_id}/scan", response_model=StagingPullScanResponse)
def scan(
    request_id: str,
    body: StagingPullScanRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """One pulled container (or N via units). Soft-200 for every outcome."""
    result = sps.scan(db, request_id, body, str(current_user.id))
    db.commit()
    return result


@router.post("/requests/{request_id}/undo", response_model=StagingPullScanResponse)
def undo(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Reverse the newest un-submitted scan — the rack gets it back."""
    result = sps.undo(db, request_id, str(current_user.id))
    db.commit()
    return result


@router.post("/requests/{request_id}/submit", response_model=StagingPullSubmitResponse)
def submit(
    request_id: str,
    body: StagingPullSubmitRequest,
    confirmed: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Convert pending scans into transfers + staging items, atomically.

    `confirmed` mirrors lot receiving's finish: a short pull comes back as
    `needs_confirm` (nothing written) until the worker answers.
    """
    result = sps.submit(
        db, request_id,
        staging_location_id=body.staging_location_id,
        staging_sub_location_id=body.staging_sub_location_id,
        confirmed=confirmed,
        user_id=str(current_user.id),
    )
    # `submit` commits internally on success; needs_confirm writes nothing.
    return result
