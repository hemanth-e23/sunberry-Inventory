"""Row barcode labels and scan-to-location resolution — SPEC §8.3, audit B9.

Mount with:  app.include_router(ingredient_rows.router, prefix="/api/ingredient-rows",
                                tags=["Ingredient Rows"])

Route handlers are thin — everything lives in services/ingredient_row_service.py.

Auth shape, and why it differs per endpoint:
  * GET /            — any active user. The label print page is run by warehouse
                       staff and supervisors; the manual row picker on the gun is
                       run by forklift. Both need the same list.
  * GET /resolve     — any active user, for the same reason: §18.2 R-3 blocks
                       every drum scan until row resolution succeeds, and the
                       role doing that scanning is `forklift`, which is absent
                       from APPROVAL_ROLES and from require_role("admin").
  * POST /assign-barcodes — mutates master data (it decides what is physically
                       printed on a rack), so it takes the same role set that
                       approves records, following scanner.py's local-dependency
                       idiom rather than require_role, which would exclude
                       supervisors and corporate_admin.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import ForbiddenError
from app.models import User
from app.services import ingredient_row_service
from app.utils.auth import get_current_active_user

router = APIRouter()


def require_row_label_manager(
    current_user: User = Depends(get_current_active_user),
) -> User:
    """Warehouse staff and above may mint row barcodes. Forklift may not — a
    label minted mid-scan would print nothing and resolve to a rack nobody
    labelled."""
    if current_user.role not in APPROVAL_ROLES and current_user.role != ROLE_WAREHOUSE:
        raise ForbiddenError("You are not authorized to assign row barcodes")
    return current_user


class AssignBarcodesRequest(BaseModel):
    """Both fields optional. Empty body = every unlabelled row in the caller's
    warehouse scope."""

    row_ids: Optional[List[str]] = None
    location_id: Optional[str] = None


@router.get("/")
def list_ingredient_rows(
    q: Optional[str] = Query(None, description="Substring match on row name or barcode"),
    location_id: Optional[str] = None,
    warehouse_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Rows for label printing and manual selection.

    Unlike `GET /scanner/storage-rows` this applies NO `pallet_capacity > 0`
    filter and derives the location path through `sub_location` as well as
    `storage_area` — without both, every ingredient row is invisible (audit B9).
    """
    return ingredient_row_service.list_rows(
        db, current_user, q=q, location_id=location_id, warehouse_id=warehouse_id
    )


@router.get("/resolve")
def resolve_ingredient_row(
    code: str = Query(..., description="Scanned row barcode, or an exact row name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Resolve a scanned code to exactly one row.

    Barcode first, then exact name within the caller's warehouse. Two name
    matches is a 400 naming both candidates, never a silent pick.
    """
    return ingredient_row_service.resolve_row(db, current_user, code)


@router.post("/assign-barcodes")
def assign_row_barcodes(
    payload: Optional[AssignBarcodesRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_row_label_manager),
):
    """Mint `{LOC3}-{NAME}` barcodes for rows created after the backfill
    migration. Rows that already have one are left alone."""
    body = payload or AssignBarcodesRequest()
    return ingredient_row_service.assign_barcodes(
        db,
        current_user,
        row_ids=body.row_ids,
        location_id=body.location_id,
    )
