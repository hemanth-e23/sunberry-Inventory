"""Serialized-container staging endpoints (SPEC §11, Phase 3).

Thin router over container_staging_service, which owns no transaction.

These endpoints sit alongside the existing staging plumbing rather than
replacing it: a staging request can carry both serialized ingredient lines
(handled here) and legacy quantity lines (handled by staging_request_service)
during dual-mode.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.exceptions import ForbiddenError
from app.schemas.base import BaseSchema
from app.schemas.ingredient import Container as ContainerSchema
from app.routers.ingredient_intakes import SCAN_ROLES, _serialize_container
from app.services import container_staging_service as css
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()


def _require_scan_role(current_user):
    if current_user.role not in SCAN_ROLES:
        raise ForbiddenError("You are not authorized to stage material")
    return current_user


class StageScanRequest(BaseSchema):
    serial: str
    staging_row_id: Optional[str] = None
    # Present when the worker pulled something the FEFO list did not suggest.
    # Allowed — the list is advisory — but the reason is recorded.
    off_list_reason: Optional[str] = None
    idempotency_key: Optional[str] = None


class StageReturnRequest(BaseSchema):
    serial: str
    # Required: without a destination row there is nothing to re-credit, and a
    # return that does not re-credit the rack is how occupancy drifts down.
    to_row_id: str
    reason: Optional[str] = None


class UnclaimRequest(BaseSchema):
    force: bool = False


@router.get("/lines/{item_id}")
def line_detail(
    item_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return css.line_detail(db, item_id)


@router.post("/lines/{item_id}/claim")
def claim(
    item_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Claim a line. Atomic — the loser gets a message naming the holder."""
    _require_scan_role(current_user)
    css.claim_line(db, item_id, current_user)
    db.commit()
    return css.line_detail(db, item_id)


@router.post("/lines/{item_id}/unclaim")
def unclaim(
    item_id: str,
    payload: UnclaimRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Release a claim. Scans already made keep their attribution."""
    _require_scan_role(current_user)
    css.unclaim_line(db, item_id, current_user, force=payload.force)
    db.commit()
    return css.line_detail(db, item_id)


@router.get("/lines/{item_id}/fefo", response_model=List[ContainerSchema])
def fefo(
    item_id: str,
    limit: int = Query(50, le=200),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Advisory pull list. Opened drums first (use-it-up beats FEFO), then by
    BBD with unknowns last."""
    line = css._get_line(db, item_id)
    suggestions = css.fefo_suggestions(
        db, line.product_id,
        warehouse_id=warehouse_filter(current_user),
        limit=limit,
    )
    return [_serialize_container(db, c) for c in suggestions]


@router.post("/lines/{item_id}/scan")
def scan(
    item_id: str,
    payload: StageScanRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Pull one drum onto this line. Over-pull allowed and recorded; a hold is
    re-checked on every scan, so a hold placed mid-pull takes effect at once."""
    _require_scan_role(current_user)
    result = css.stage_container(
        db, item_id, payload.serial, current_user,
        staging_row_id=payload.staging_row_id,
        off_list_reason=payload.off_list_reason,
        idempotency_key=payload.idempotency_key,
    )
    db.commit()
    return result


@router.post("/lines/{item_id}/return")
def return_container(
    item_id: str,
    payload: StageReturnRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    result = css.return_container(
        db, item_id, payload.serial, payload.to_row_id, current_user,
        reason=payload.reason,
    )
    db.commit()
    return result
