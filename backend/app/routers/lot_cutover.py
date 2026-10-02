"""Cutover onto the lot model — zero out, enter today's stock, sticker lazily.

Mount with:
    app.include_router(lot_cutover.router, prefix="/api/lot-cutover",
                       tags=["Lot Cutover"])

Every endpoint here is admin-and-up except the counting one. Zeroing out an
entire warehouse's ingredient receipts is not something a shift should be able to
do by misclicking, and the preview endpoint exists so it is never done blind.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES, ROLE_FORKLIFT
from app.database import get_db
from app.exceptions import ForbiddenError, NotFoundError
from app.models import MaterialLot, User
from app.schemas.lot_cutover import (
    CountRowRequest,
    CountRowResult,
    CutoverStatus,
    OpeningBalanceRequest,
    OpeningBalanceResult,
    UnlabelledLot,
    ZeroOutPreview,
    ZeroOutRequest,
    ZeroOutResult,
)
from app.services import lot_cutover_service as lcs
from app.utils.auth import (
    get_current_active_user,
    require_role,
    resolve_warehouse_for_write,
    warehouse_filter,
)

router = APIRouter()


def require_counter(current_user: User = Depends(get_current_active_user)) -> User:
    """Anyone but forklift may enter a count.

    A physical count is a warehouse-staff job, and restricting it to approvers
    would mean the people who actually walk the racks cannot record what they
    found.
    """
    if current_user.role == ROLE_FORKLIFT:
        raise ForbiddenError("Forklift users cannot enter counts")
    return current_user


def require_cutover_admin(current_user: User = Depends(get_current_active_user)) -> User:
    if current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError("Only a supervisor or above can run the cutover")
    return current_user


@router.get("/status", response_model=CutoverStatus)
def status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return lcs.cutover_status(db, warehouse_filter(current_user))


@router.get("/zero-out/preview", response_model=ZeroOutPreview)
def zero_out_preview(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_cutover_admin),
):
    """What the zero-out would do. Reviewed before it runs, every time.

    `as_received_units_hint` on each product is exactly that — a hint. It is the
    count frozen at delivery and says nothing about what is left, so it must never
    prefill an opening balance.
    """
    return lcs.preview_zero_out(db, warehouse_filter(current_user))


@router.post("/zero-out", response_model=ZeroOutResult)
def zero_out(
    payload: ZeroOutRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """Run step 1. Records are kept; only remaining quantity goes to zero.

    `confirm` is required in the body rather than inferred: this is the one call
    in the cutover that cannot be undone by pressing something else.
    """
    if not payload.confirm:
        from app.exceptions import ValidationError

        raise ValidationError("Set confirm to run the zero-out")

    result = lcs.execute_zero_out(
        db,
        warehouse_id=resolve_warehouse_for_write(current_user),
        user_id=str(current_user.id),
        note=payload.note,
    )
    db.commit()
    return result


@router.post("/opening-balance", response_model=OpeningBalanceResult)
def opening_balance(
    payload: OpeningBalanceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_counter),
):
    """One (lot, rack) counted by hand. Creates the lot and its placement together.

    Nothing here is derived from the old receipts. The pallet counts in the legacy
    allocation JSON have no fixed ratio to drums, and nothing anywhere recorded
    that a drum was opened — both numbers have to come from a person who walked
    the rack.
    """
    warehouse_id = resolve_warehouse_for_write(current_user)
    if current_user.role not in APPROVAL_ROLES:
        # A warehouse user's count waits for a supervisor (owner's decision,
        # 2026-10-02): stock no longer changes the moment anyone types it.
        req = lcs.submit_count_request(
            db, kind="found", user_id=str(current_user.id), warehouse_id=warehouse_id,
            **payload.model_dump(),
        )
        db.commit()
        return _pending_result(db, req)
    result = lcs.create_opening_balance(
        db,
        # Resolved from the caller, never taken from the body — see the schema.
        warehouse_id=warehouse_id,
        user_id=str(current_user.id),
        **payload.model_dump(),
    )
    db.commit()
    return result


@router.post("/count", response_model=CountRowResult)
def count(
    payload: CountRowRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_counter),
):
    """A physical count of one lot in one rack, with its variance.

    The first flow in this system that can legitimately increase stock. The
    variance is signed and in WHOLE UNITS — a count that reads "-0.18 drums" is
    not something anyone can act on, which is exactly what deriving drums from
    weight used to produce.
    """
    # A lot id is guessable, and this endpoint MOVES STOCK. Counting another
    # site's material would silently restate their inventory from here.
    lot = (
        db.query(MaterialLot)
        .filter(MaterialLot.id == payload.material_lot_id)
        .first()
    )
    if not lot:
        raise NotFoundError("Material lot", payload.material_lot_id)
    wh_id = warehouse_filter(current_user)
    if wh_id and lot.warehouse_id != wh_id:
        raise ForbiddenError("Cannot count a different warehouse's lot")

    if current_user.role not in APPROVAL_ROLES:
        req = lcs.submit_count_request(
            db, kind="recount", user_id=str(current_user.id),
            warehouse_id=lot.warehouse_id, **payload.model_dump(),
        )
        db.commit()
        return _pending_result(db, req)
    result = lcs.count_row(
        db, user_id=str(current_user.id), **payload.model_dump()
    )
    db.commit()
    return result


def _pending_result(db: Session, req) -> dict:
    """Same shape the form already reads, flagged as waiting for approval."""
    view = lcs.count_request_view(db, req)
    lot = db.query(MaterialLot).filter(MaterialLot.id == req.material_lot_id).first() if req.material_lot_id else None
    return {
        "material_lot_id": req.material_lot_id or "",
        "lot_code": lot.lot_code if lot else (req.vendor_lot or ""),
        "product_id": req.product_id or "",
        "product_name": view["product_name"],
        "storage_row_id": req.storage_row_id,
        "storage_row_name": view["storage_row_name"],
        "full_units": req.full_units,
        "open_units": req.open_units,
        "unit_label": view["unit_label"],
        "system_units": req.system_full_units or 0,
        "counted_units": req.full_units,
        "variance": view["variance_units"],
        "pending": True,
        "request_id": req.id,
    }


@router.get("/count-requests")
def list_count_requests(
    status: Optional[str] = Query("pending"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_counter),
):
    """Counts waiting for (or past) approval, in the caller's plant."""
    from app.models import LotCountRequest

    q = db.query(LotCountRequest)
    if status and status != "all":
        q = q.filter(LotCountRequest.status == status)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        q = q.filter(LotCountRequest.warehouse_id == wh_id)
    return [lcs.count_request_view(db, r) for r in q.order_by(LotCountRequest.submitted_at.desc()).all()]


def _approvable_request(db: Session, request_id: str, current_user: User):
    from app.models import LotCountRequest

    if current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError("Only a supervisor can approve or reject counts")
    req = db.query(LotCountRequest).filter(LotCountRequest.id == request_id).first()
    if not req:
        raise NotFoundError("Count request", request_id)
    wh_id = warehouse_filter(current_user)
    if wh_id and req.warehouse_id and req.warehouse_id != wh_id:
        raise ForbiddenError("Cannot approve a different warehouse's count")
    return req


@router.post("/count-requests/{request_id}/approve")
def approve_count_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    req = _approvable_request(db, request_id, current_user)
    lcs.approve_count_request(db, req, str(current_user.id))
    db.commit()
    return lcs.count_request_view(db, req)


@router.post("/count-requests/{request_id}/reject")
def reject_count_request(
    request_id: str,
    reason: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    req = _approvable_request(db, request_id, current_user)
    lcs.reject_count_request(db, req, str(current_user.id), reason)
    db.commit()
    return lcs.count_request_view(db, req)


@router.get("/unlabelled-lots", response_model=List[UnlabelledLot])
def unlabelled(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Lots holding stock that have never had a sticker printed.

    Shrinks on its own as material is staged and stickered. A lot that lingers is
    a slow mover to print for on demand, not a mistake — print from
    POST /api/lot-receiving/lots/{lot_id}/print-labels.
    """
    return lcs.unlabelled_lots(db, warehouse_filter(current_user))


@router.get("/lots-on-hand", response_model=List[UnlabelledLot])
def lots_on_hand(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Every lot physically holding stock — what a recount picks from.

    Replacing a figure means naming which lot on which rack, and nobody at a
    keyboard knows a lot code by heart.
    """
    return lcs.lots_on_hand(db, warehouse_filter(current_user))
