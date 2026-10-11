"""Gun cycle check + Find Pallet (FG-PALLET-LIFECYCLE-SPEC §4.1).

Open to the forklift role (it is a gun screen) and to warehouse staff and up.
"Not here" applies immediately — no approval step, by design.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES, ROLE_FORKLIFT, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import NotFoundError, ValidationError
from app.schemas.base import BaseSchema
from app.services import cycle_check_service as svc
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()

_ALLOWED = set(APPROVAL_ROLES) | {ROLE_WAREHOUSE, ROLE_FORKLIFT}


def _require_checker(current_user=Depends(get_current_active_user)):
    if current_user.role not in _ALLOWED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed to run a cycle check")
    return current_user


def _write_warehouse(user) -> Optional[str]:
    # Plant users (forklift included) write to their own warehouse; a corporate
    # user to the one they are viewing.
    return warehouse_filter(user) or user.warehouse_id


class RowCheckSubmit(BaseSchema):
    row_id: str = Field(..., max_length=50)
    scanned: List[str] = Field(default_factory=list, max_length=500)
    not_here_pallet_ids: List[str] = Field(default_factory=list, max_length=2000)
    # The checker already answered "N pallets not here — sure?".
    confirmed: bool = False


class FindPalletAction(BaseSchema):
    licence_number: str = Field(..., max_length=100)
    action: str = Field(..., max_length=20)
    row_id: str = Field(..., max_length=50)


def _http(e: Exception):
    if isinstance(e, NotFoundError):
        raise HTTPException(status_code=404, detail=e.detail)
    if isinstance(e, ValidationError):
        raise HTTPException(status_code=400, detail=e.detail)
    raise e


@router.get("/cycle-check/rows")
def cycle_rows(db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    return svc.list_rows(db, _write_warehouse(current_user))


@router.get("/cycle-check/rows/{row_id}")
def cycle_row_contents(row_id: str, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        return svc.row_contents(db, row_id, _write_warehouse(current_user))
    except Exception as e:  # noqa: BLE001
        _http(e)


@router.post("/cycle-check/submit")
def cycle_submit(data: RowCheckSubmit, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        out = svc.submit_row_check(
            db, row_id=data.row_id, scanned=data.scanned,
            not_here_pallet_ids=data.not_here_pallet_ids, confirmed=data.confirmed,
            user=current_user, warehouse_id=_write_warehouse(current_user),
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    if out.get("status") == "needs_confirm":
        db.rollback()
        return out
    db.commit()
    return out


@router.get("/cycle-check/find")
def find_pallet(licence_number: str, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    return svc.find_pallet(db, licence_number, _write_warehouse(current_user))


@router.post("/cycle-check/find")
def find_pallet_action(data: FindPalletAction, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        out = svc.find_pallet_action(
            db, licence=data.licence_number, action=data.action, row_id=data.row_id,
            user=current_user, warehouse_id=_write_warehouse(current_user),
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out
