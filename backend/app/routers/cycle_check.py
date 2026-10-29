"""Gun cycle check + Find Pallet (FG-PALLET-LIFECYCLE-SPEC §4.1).

Open to the forklift role (it is a gun screen) and to warehouse staff and up.
"Not here" applies immediately — no approval step, by design.

The web count sheet by rack row (count_sheet_service) lives here too: it
applies through the same row check, and the same roles may run it.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import Field
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES, ROLE_FORKLIFT, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import NotFoundError, ValidationError
from app.schemas.base import BaseSchema
from app.services import count_sheet_service as sheets
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
    # The count session this row belongs to (minted by the server on the
    # walk's first row). Unknown / foreign / stale ids start a new session.
    session_id: Optional[str] = Field(None, max_length=40)


class FindPalletAction(BaseSchema):
    licence_number: str = Field(..., max_length=100)
    action: str = Field(..., max_length=20)
    row_id: str = Field(..., max_length=50)
    # Explicit confirm tap for creating the first pallet of a lot the system
    # has never seen.
    confirmed: bool = False


class SheetCreate(BaseSchema):
    kind: str = Field(..., max_length=20)
    client_id: Optional[str] = Field(None, max_length=50)
    sub_location_id: Optional[str] = Field(None, max_length=50)
    storage_area_id: Optional[str] = Field(None, max_length=50)


class SheetLineCount(BaseSchema):
    placement_id: str = Field(..., max_length=50)
    # Counted sealed units; None = not counted.
    counted_units: Optional[int] = Field(None, ge=0)


class SheetRowCount(BaseSchema):
    row_id: str = Field(..., max_length=50)
    # "Row counted" — rows left off are skipped.
    counted: bool = False
    not_here_pallet_ids: List[str] = Field(default_factory=list, max_length=2000)
    extra_licences: List[str] = Field(default_factory=list, max_length=500)
    lines: List[SheetLineCount] = Field(default_factory=list, max_length=2000)


class SheetLegacyCount(BaseSchema):
    receipt_id: str = Field(..., max_length=50)
    counted: Optional[float] = Field(None, ge=0)


class SheetSubmit(BaseSchema):
    rows: List[SheetRowCount] = Field(default_factory=list, max_length=2000)
    legacy: List[SheetLegacyCount] = Field(default_factory=list, max_length=2000)


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
            session_id=data.session_id,
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
def find_pallet(
    licence_number: str = Query(..., max_length=100),
    db: Session = Depends(get_db), current_user=Depends(_require_checker),
):
    return svc.find_pallet(db, licence_number, _write_warehouse(current_user))


@router.post("/cycle-check/find")
def find_pallet_action(data: FindPalletAction, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        out = svc.find_pallet_action(
            db, licence=data.licence_number, action=data.action, row_id=data.row_id,
            user=current_user, warehouse_id=_write_warehouse(current_user), confirmed=data.confirmed,
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out


# ---------------------------------------------------------------------------
# Count sheet by rack row (web)
# ---------------------------------------------------------------------------

@router.get("/cycle-check/sheet")
def count_sheet_preview(
    kind: str = Query(..., max_length=20),
    client_id: Optional[str] = Query(None, max_length=50),
    sub_location_id: Optional[str] = Query(None, max_length=50),
    storage_area_id: Optional[str] = Query(None, max_length=50),
    db: Session = Depends(get_db), current_user=Depends(_require_checker),
):
    """The sheet from live data, without saving it."""
    try:
        return sheets.build_sheet(
            db, _write_warehouse(current_user), kind, client_id, sub_location_id, storage_area_id,
        )
    except Exception as e:  # noqa: BLE001
        _http(e)


@router.post("/cycle-check/sheets")
def count_sheet_create(data: SheetCreate, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        out = sheets.create_open_sheet(
            db, user=current_user, warehouse_id=_write_warehouse(current_user), kind=data.kind,
            client_id=data.client_id, sub_location_id=data.sub_location_id,
            storage_area_id=data.storage_area_id,
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out


@router.get("/cycle-check/sheets")
def count_sheet_list(
    status_filter: Optional[str] = Query(None, alias="status", max_length=20),
    db: Session = Depends(get_db), current_user=Depends(_require_checker),
):
    return sheets.list_sheets(db, _write_warehouse(current_user), status_filter)


@router.get("/cycle-check/sheets/{sheet_id}")
def count_sheet_get(sheet_id: str, db: Session = Depends(get_db), current_user=Depends(_require_checker)):
    try:
        return sheets.get_sheet(db, sheet_id, _write_warehouse(current_user))
    except Exception as e:  # noqa: BLE001
        _http(e)


@router.post("/cycle-check/sheets/{sheet_id}/submit")
def count_sheet_submit(
    sheet_id: str, data: SheetSubmit, db: Session = Depends(get_db), current_user=Depends(_require_checker),
):
    try:
        out = sheets.submit_sheet(
            db, sheet_id, data.model_dump(), current_user, _write_warehouse(current_user),
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        _http(e)
    db.commit()
    return out
