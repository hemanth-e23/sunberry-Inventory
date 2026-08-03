"""Container endpoints: list, move, hold, damage, dispose, audits.

Phase 2 of INGREDIENT-SERIALIZATION-SPEC.md. Thin router; logic lives in
container_service and ingredient_intake_service. This module owns the
transaction boundary — the services never commit.

Container LISTS live here rather than under /ingredient-intakes because they are
queried across intakes: lot-wide holds, row contents, and the recall trace all
start from a product or a lot, not from a truck.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES, ROLE_FORKLIFT, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import ForbiddenError
from app.models import Container
from app.schemas.ingredient import (
    CacheDriftReport,
    Container as ContainerSchema,
    ContainerBulkHoldRequest,
    ContainerDamageRequest,
    ContainerDisposeRequest,
    ContainerHoldRequest,
    ContainerList,
    ContainerMissingRequest,
    ContainerMoveGroupRequest,
    ContainerMoveRequest,
    ContainerMoveResponse,
    LotHoldPreview,
    RowDriftReport,
)
from app.services import container_service as cs
from app.services import ingredient_intake_service as svc
from app.routers.ingredient_intakes import (
    MAX_CONTAINER_PAGE,
    SCAN_ROLES,
    _serialize_container,
)
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()


def _require_scan_role(current_user):
    if current_user.role not in SCAN_ROLES:
        raise ForbiddenError("You are not authorized to handle containers")
    return current_user


def _ser(db: Session, container) -> Optional[dict]:
    return _serialize_container(db, container) if container is not None else None


# ─── list & lookup ────────────────────────────────────────────────────────────

@router.get("/", response_model=ContainerList)
async def list_containers(
    intake_id: Optional[str] = None,
    intake_lot_id: Optional[str] = None,
    product_id: Optional[str] = None,
    status: Optional[str] = None,
    storage_row_id: Optional[str] = None,
    vendor_lot: Optional[str] = None,
    is_held: Optional[bool] = None,
    q: Optional[str] = None,
    skip: int = 0,
    limit: int = Query(100, le=MAX_CONTAINER_PAGE),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    from sqlalchemy import func as sa_func

    query = db.query(Container).filter(Container.is_deleted == False)  # noqa: E712
    wh = warehouse_filter(current_user)
    if wh:
        query = query.filter(Container.warehouse_id == wh)
    for field, value in (
        ("intake_id", intake_id), ("intake_lot_id", intake_lot_id),
        ("product_id", product_id), ("status", status),
        ("storage_row_id", storage_row_id), ("vendor_lot", vendor_lot),
    ):
        if value is not None:
            query = query.filter(getattr(Container, field) == value)
    if is_held is not None:
        query = query.filter(Container.is_held == is_held)
    if q:
        query = query.filter(Container.serial.ilike(f"%{q}%"))

    total = query.with_entities(sa_func.count(Container.id)).scalar() or 0
    items = query.order_by(Container.serial).offset(skip).limit(limit).all()
    return {
        "items": [_serialize_container(db, c) for c in items],
        "total": total,
        # §18.9: a bounded list states what it dropped.
        "truncated": (skip + len(items)) < total,
    }


@router.get("/{serial}", response_model=ContainerSchema)
async def get_container(
    serial: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return _serialize_container(db, cs._get_by_serial(db, serial))


# ─── moves ────────────────────────────────────────────────────────────────────

@router.post("/move", response_model=ContainerMoveResponse)
async def move(
    payload: ContainerMoveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Move one drum. Atomic by construction: nothing is written until both the
    drum and the destination row are known, so an abandoned move is a no-op."""
    _require_scan_role(current_user)
    result = cs.move_container(
        db, payload.serial, payload.to_row_id, current_user,
        reason=payload.reason, idempotency_key=payload.idempotency_key,
    )
    db.commit()
    result["container"] = _ser(db, result.get("container"))
    return result


@router.post("/move-group")
async def move_group(
    payload: ContainerMoveGroupRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Move drums that travelled together. The group is a convenience, never an
    authority — callers send exactly what is physically on the forks."""
    _require_scan_role(current_user)
    result = cs.move_group(
        db, payload.serials, payload.to_row_id, current_user, reason=payload.reason
    )
    db.commit()
    for entry in result["results"]:
        entry["container"] = _ser(db, entry.get("container"))
    return result


# ─── holds ────────────────────────────────────────────────────────────────────

@router.post("/hold", response_model=ContainerSchema)
async def hold(
    payload: ContainerHoldRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Hold or release one container. Takes effect immediately — unlike the
    legacy lot-level hold, which is approval-gated."""
    _require_scan_role(current_user)
    container = cs.set_hold(
        db, payload.serial, payload.held, current_user, reason=payload.reason
    )
    db.commit()
    db.refresh(container)
    return _serialize_container(db, container)


@router.get("/lot/preview", response_model=LotHoldPreview)
async def lot_preview(
    vendor_lot: str,
    product_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    intake_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """What a lot-wide hold would affect, before anyone confirms.

    Scoped to (product, vendor, lot): vendors reuse lot numbers, and an
    unscoped match would let one tap hold — or release — unrelated material.
    The consumed/shipped lists are the recall trace (§18.6 H-1).
    """
    preview = cs.lot_hold_preview(
        db, vendor_lot=vendor_lot, product_id=product_id,
        vendor_id=vendor_id, intake_id=intake_id,
    )
    for key in ("holdable", "already_held", "consumed", "shipped"):
        preview[key] = [_serialize_container(db, c) for c in preview[key]]
    return preview


@router.post("/bulk-hold")
async def bulk_hold(
    payload: ContainerBulkHoldRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    result = cs.bulk_set_hold(
        db, payload.serials, payload.held, current_user, reason=payload.reason
    )
    db.commit()
    return result


# ─── damage / disposal / missing ──────────────────────────────────────────────

@router.post("/damage", response_model=ContainerSchema)
async def damage(
    payload: ContainerDamageRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Available at any time, not just during receiving — a leak found the day
    after the truck left is the normal case (§18.2 R-8)."""
    _require_scan_role(current_user)
    container = cs.mark_damaged(
        db, payload.serial, current_user,
        reason=payload.reason, quarantine_row_id=payload.quarantine_row_id,
    )
    db.commit()
    db.refresh(container)
    return _serialize_container(db, container)


@router.post("/dispose", response_model=ContainerSchema)
async def dispose(
    payload: ContainerDisposeRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Supervisor-only with a required reason code — the one exit with no
    physical counterparty to reconcile against."""
    container = cs.dispose(
        db, payload.serial, current_user,
        reason_code=payload.reason_code, reason=payload.reason,
    )
    db.commit()
    db.refresh(container)
    return _serialize_container(db, container)


@router.post("/missing", response_model=ContainerSchema)
async def missing(
    payload: ContainerMissingRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Not found where the system says it is. Not a disposal — a later scan
    restores it to stock naturally."""
    _require_scan_role(current_user)
    container = cs.mark_missing(db, payload.serial, current_user, reason=payload.reason)
    db.commit()
    db.refresh(container)
    return _serialize_container(db, container)


# ─── audits ───────────────────────────────────────────────────────────────────

@router.get("/audit/cache-drift", response_model=CacheDriftReport)
async def cache_drift(
    limit: int = Query(500, le=2000),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Container state vs. its own event ledger.

    A reconciliation between two independently-written records, not a recompute.
    Nothing auto-heals: silently healing drift is how the previous
    denormalization bugs stayed invisible for so long.
    """
    if current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError("Only supervisors and above can run the drift audit")
    return svc.cache_drift(db, limit=limit)


@router.get("/audit/row-drift", response_model=RowDriftReport)
async def row_drift(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Rows holding more than their capacity — the weekly walk-list."""
    return cs.row_capacity_drift(db, warehouse_id=warehouse_filter(current_user))
