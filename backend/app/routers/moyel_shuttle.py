"""Moyel Shuttle — Inventory Actions tab (FG-PALLET-LIFECYCLE-SPEC §1.1).

Thin HTTP layer over services/moyel_shuttle_service.py. Warehouse role and up;
destination edits are admin only.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import Field
from sqlalchemy.orm import Session

from app.constants import ADMIN_ROLES, APPROVAL_ROLES, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import NotFoundError, ValidationError
from app.schemas.base import BaseSchema
from app.services import bol_pdf_service, moyel_shuttle_service as svc
from app.utils.auth import get_current_active_user, resolve_warehouse_for_write, warehouse_filter
from app.utils.warehouse_time import warehouse_timezone

router = APIRouter()

_ALLOWED = set(APPROVAL_ROLES) | {ROLE_WAREHOUSE}


def _require_clerk(current_user=Depends(get_current_active_user)):
    if current_user.role not in _ALLOWED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Warehouse role or higher required")
    return current_user


class ShuttleCreate(BaseSchema):
    trailer_number: str = Field(..., max_length=50)
    seal_number: str = Field(..., max_length=50)
    destination_id: Optional[str] = None
    pallet_ids: List[str] = Field(default_factory=list, max_length=2000)
    # Sequence numbers nobody scanned, ticked as "it went on this trailer".
    missing_licences: List[str] = Field(default_factory=list, max_length=500)


class DestinationSave(BaseSchema):
    name: Optional[str] = Field(None, max_length=100)
    address_line1: Optional[str] = Field(None, max_length=200)
    city: Optional[str] = Field(None, max_length=100)
    state: Optional[str] = Field(None, max_length=20)
    zip_code: Optional[str] = Field(None, max_length=20)
    is_active: Optional[bool] = None


def _http(e: Exception):
    if isinstance(e, NotFoundError):
        raise HTTPException(status_code=404, detail=e.detail)
    if isinstance(e, ValidationError):
        raise HTTPException(status_code=400, detail=e.detail)
    raise e


@router.get("/moyel-shuttle/destinations")
def list_destinations(
    include_inactive: bool = False,
    db: Session = Depends(get_db), current_user=Depends(_require_clerk),
):
    out = svc.list_destinations(db, include_inactive=include_inactive)
    db.commit()  # the default destination may have been (re)created
    return out


@router.post("/moyel-shuttle/destinations")
def create_destination(
    data: DestinationSave, db: Session = Depends(get_db), current_user=Depends(_require_clerk),
):
    if current_user.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Only an admin can edit shuttle destinations")
    try:
        out = svc.save_destination(db, data.dict(exclude_unset=True))
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out


@router.patch("/moyel-shuttle/destinations/{destination_id}")
def update_destination(
    destination_id: str, data: DestinationSave,
    db: Session = Depends(get_db), current_user=Depends(_require_clerk),
):
    if current_user.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Only an admin can edit shuttle destinations")
    try:
        out = svc.save_destination(db, data.dict(exclude_unset=True), destination_id)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out


@router.get("/moyel-shuttle/available")
def available_pallets(
    product_id: str, db: Session = Depends(get_db), current_user=Depends(_require_clerk),
):
    try:
        return svc.available_for_product(db, product_id, warehouse_filter(current_user))
    except Exception as e:  # noqa: BLE001
        _http(e)


@router.get("/moyel-shuttle")
def list_shuttles(db: Session = Depends(get_db), current_user=Depends(_require_clerk)):
    return svc.list_shuttles(db, warehouse_filter(current_user))


@router.post("/moyel-shuttle")
def create_shuttle(
    data: ShuttleCreate, db: Session = Depends(get_db), current_user=Depends(_require_clerk),
):
    wh_id = resolve_warehouse_for_write(current_user)
    try:
        t = svc.create_shuttle(
            db,
            trailer_number=data.trailer_number,
            seal_number=data.seal_number,
            destination_id=data.destination_id,
            pallet_ids=data.pallet_ids,
            missing_licences=data.missing_licences,
            warehouse_id=wh_id,
            current_user=current_user,
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    db.refresh(t)
    return {**svc.shuttle_summary(db, t), "document_snapshot": t.document_snapshot}


@router.get("/moyel-shuttle/{transfer_id}")
def get_shuttle(transfer_id: str, db: Session = Depends(get_db), current_user=Depends(_require_clerk)):
    try:
        t = svc.get_shuttle(db, transfer_id, warehouse_filter(current_user))
    except Exception as e:  # noqa: BLE001
        _http(e)
    return {**svc.shuttle_summary(db, t), "document_snapshot": t.document_snapshot}


@router.get("/moyel-shuttle/{transfer_id}/bol.pdf")
def shuttle_bol_pdf(transfer_id: str, db: Session = Depends(get_db), current_user=Depends(_require_clerk)):
    """Reprint: rendered from the frozen snapshot, so it matches the original."""
    try:
        t = svc.get_shuttle(db, transfer_id, warehouse_filter(current_user))
        pdf = bol_pdf_service.render_bol_pdf(t.document_snapshot, warehouse_timezone(db, t.warehouse_id))
    except Exception as e:  # noqa: BLE001
        _http(e)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{svc.bol_filename(t)}"'},
    )
