"""Ingredient intake + container endpoints (INGREDIENT-SERIALIZATION-SPEC.md Phase 1).

Thin router: all business logic lives in ingredient_intake_service. This module
owns the transaction boundary — the service never commits (see its docstring).

Permissions (spec §21 / audit B11):
  create / edit / mint / print   warehouse and up, plus forklift (they scan on the gun)
  scan a drum                    forklift or warehouse — the scanning roles
  submit                         the scanning roles
  approve / reject               require_approval_access + self-approval block, in the service
  reprint                        anyone who can scan; deliberately ungated (§5)
  void                           free with zero scans, approval role once drums are scanned
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.constants import ADMIN_ROLES, APPROVAL_ROLES, ROLE_FORKLIFT, ROLE_WAREHOUSE
from app.database import get_db
from app.exceptions import ForbiddenError, NotFoundError
from app.models import Container, ContainerEvent, IngredientIntake, IntakeLot, Product, StorageRow, Vendor
from app.schemas.ingredient import (
    CacheDriftReport,
    ContainerList,
    ContainerScanRequest,
    ContainerScanResponse,
    IngredientIntake as IngredientIntakeSchema,
    IngredientIntakeCreate,
    IngredientIntakeList,
    IngredientIntakeUpdate,
    IntakeCloseShortRequest,
    IntakeLotCreate,
    IntakeLotUpdate,
    IntakeRejectRequest,
    IntakeVoidRequest,
    LabelSheet,
    MintSerialsRequest,
)
from app.services import ingredient_intake_service as svc
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()

# Roles that may run a receiving session. Forklift is included deliberately:
# the drum scanning happens on the gun, and ROLE_FORKLIFT is absent from
# APPROVAL_ROLES, so it has to be named explicitly here.
SCAN_ROLES = frozenset({ROLE_FORKLIFT, ROLE_WAREHOUSE}) | APPROVAL_ROLES

# Hard cap on any container list. §18.9: a bounded list must say what it dropped.
MAX_CONTAINER_PAGE = 500


def _require_scan_role(current_user):
    if current_user.role not in SCAN_ROLES:
        raise ForbiddenError("You are not authorized to run an ingredient intake")
    return current_user


def _get_intake(db: Session, intake_id: str) -> IngredientIntake:
    intake = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.id == intake_id,
            IngredientIntake.is_deleted == False,  # noqa: E712
        )
        .first()
    )
    if not intake:
        raise NotFoundError("Intake", intake_id)
    return intake


# ─── serialization helpers ────────────────────────────────────────────────────

def _row_label(db: Session, row: Optional[StorageRow]) -> tuple:
    """(row name, human location path).

    Resolved through EITHER parent: finished-goods rows hang off storage_area,
    ingredient rows off sub_location. Resolving only through storage_area — as
    the finished-goods scanner does — yields an empty path for every drum.
    """
    if row is None:
        return (None, None)
    parts = []
    if getattr(row, "sub_location", None) is not None:
        sub = row.sub_location
        if getattr(sub, "location", None) is not None:
            parts.append(sub.location.name)
        parts.append(sub.name)
    elif getattr(row, "storage_area", None) is not None:
        area = row.storage_area
        if getattr(area, "location", None) is not None:
            parts.append(area.location.name)
        parts.append(area.name)
    return (row.name, " / ".join(p for p in parts if p) or None)


def _serialize_container(db: Session, c: Container) -> dict:
    row_name, path = _row_label(db, c.storage_row)
    return {
        "id": c.id, "serial": c.serial, "sequence": c.sequence,
        "intake_id": c.intake_id, "intake_lot_id": c.intake_lot_id,
        "product_id": c.product_id,
        "product_name": c.product.name if c.product else None,
        "warehouse_id": c.warehouse_id, "container_type": c.container_type,
        "status": c.status, "remaining_qty": c.remaining_qty,
        "net_weight": c.net_weight, "qty_unit": c.qty_unit,
        "vendor_lot": c.vendor_lot, "bbd": c.bbd,
        "storage_row_id": c.storage_row_id,
        "storage_row_name": row_name, "location_path": path,
        "pallet_group_id": c.pallet_group_id,
        "is_held": c.is_held, "hold_reason": c.hold_reason,
        "staged_for_request_id": c.staged_for_request_id,
        "consumed_by_batch_uid": c.consumed_by_batch_uid,
        "opened_at": c.opened_at, "scanned_at": c.scanned_at,
        "created_at": c.created_at,
    }


def _serialize_intake(db: Session, intake: IngredientIntake) -> dict:
    from sqlalchemy import func as sa_func
    from app.enums import ContainerStatus

    lots = []
    for lot in (intake.lots or []):
        minted = (
            db.query(sa_func.count(Container.id))
            .filter(Container.intake_lot_id == lot.id, Container.is_deleted == False)  # noqa: E712
            .scalar() or 0
        )
        scanned = (
            db.query(sa_func.count(Container.id))
            .filter(
                Container.intake_lot_id == lot.id,
                Container.is_deleted == False,  # noqa: E712
                Container.status != ContainerStatus.PRINTED_UNAPPLIED.value,
                Container.status != ContainerStatus.VOIDED.value,
            ).scalar() or 0
        )
        lots.append({
            "id": lot.id, "intake_id": lot.intake_id, "product_id": lot.product_id,
            "category_id": lot.category_id, "container_type": lot.container_type,
            "vendor_lot": lot.vendor_lot, "lot_unknown": lot.lot_unknown,
            "bbd": lot.bbd, "expected_count": lot.expected_count, "brix": lot.brix,
            "net_weight_per_container": lot.net_weight_per_container,
            "weight_unit": lot.weight_unit, "created_at": lot.created_at,
            "minted_count": minted, "scanned_count": scanned,
            "product_name": lot.product.name if lot.product else None,
            "product_sid": getattr(lot.product, "sid", None) if lot.product else None,
        })

    breakdown = []
    rows = (
        db.query(Container.storage_row_id, sa_func.count(Container.id))
        .filter(
            Container.intake_id == intake.id,
            Container.is_deleted == False,  # noqa: E712
            Container.storage_row_id.isnot(None),
            Container.status != ContainerStatus.PRINTED_UNAPPLIED.value,
        )
        .group_by(Container.storage_row_id).all()
    )
    for row_id, count in rows:
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        name, path = _row_label(db, row)
        breakdown.append({
            "storage_row_id": row_id, "storage_row_name": name,
            "location_path": path, "count": count,
        })

    minted_total = sum(l["minted_count"] for l in lots)
    scanned_total = sum(l["scanned_count"] for l in lots)

    return {
        "id": intake.id, "intake_number": intake.intake_number,
        "vendor_id": intake.vendor_id,
        "vendor_name": intake.vendor.name if intake.vendor else None,
        "bol": intake.bol, "purchase_order": intake.purchase_order,
        "receipt_date": intake.receipt_date, "warehouse_id": intake.warehouse_id,
        "status": intake.status, "source": intake.source,
        "expected_count": intake.expected_count or 0,
        "received_count": intake.received_count or 0,
        "short_count": intake.short_count or 0, "short_reason": intake.short_reason,
        "over_received": intake.over_received, "over_reason": intake.over_reason,
        "damaged_count": intake.damaged_count or 0,
        "submitted_by": intake.submitted_by, "submitted_at": intake.submitted_at,
        "approved_by": intake.approved_by, "approved_at": intake.approved_at,
        "rejected_at": intake.rejected_at, "rejection_reason": intake.rejection_reason,
        "rejection_disposition": intake.rejection_disposition,
        "voided_at": intake.voided_at, "void_reason": intake.void_reason,
        "notes": intake.notes, "created_at": intake.created_at,
        "lots": lots,
        # Never "cases" — derived from the container type (§6.3/§19.1).
        "count_unit": svc._intake_count_unit(intake),
        "minted_count": minted_total, "scanned_count": scanned_total,
        "row_breakdown": breakdown,
    }


# ─── intakes ──────────────────────────────────────────────────────────────────

@router.post("/", response_model=IngredientIntakeSchema)
async def create_intake(
    payload: IngredientIntakeCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = svc.create_intake(db, payload, current_user)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.get("/", response_model=IngredientIntakeList)
async def list_intakes(
    status: Optional[str] = None,
    skip: int = 0,
    limit: int = Query(50, le=200),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    from sqlalchemy import func as sa_func

    q = db.query(IngredientIntake).filter(IngredientIntake.is_deleted == False)  # noqa: E712
    wh = warehouse_filter(current_user)
    if wh:
        q = q.filter(IngredientIntake.warehouse_id == wh)
    if status:
        q = q.filter(IngredientIntake.status == status)

    total = q.with_entities(sa_func.count(IngredientIntake.id)).scalar() or 0
    items = (
        q.order_by(IngredientIntake.created_at.desc()).offset(skip).limit(limit).all()
    )
    return {
        "items": [_serialize_intake(db, i) for i in items],
        "total": total,
        "truncated": (skip + len(items)) < total,
    }


@router.get("/{intake_id}", response_model=IngredientIntakeSchema)
async def get_intake(
    intake_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    return _serialize_intake(db, _get_intake(db, intake_id))


@router.patch("/{intake_id}", response_model=IngredientIntakeSchema)
async def update_intake(
    intake_id: str,
    payload: IngredientIntakeUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Edit header fields while the intake is open (I-8: a BBD/lot typo is fixed
    on the record — lookup is truth and labels self-correct at scan — never by
    editing a printed label)."""
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    for field, value in payload.dict(exclude_unset=True).items():
        setattr(intake, field, value)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


# ─── lot lines ────────────────────────────────────────────────────────────────

@router.post("/{intake_id}/lots", response_model=IngredientIntakeSchema)
async def add_lot(
    intake_id: str,
    payload: IntakeLotCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    lot = svc._build_lot(db, intake, payload)
    db.add(lot)
    db.flush()
    intake.expected_count = (intake.expected_count or 0) + (lot.expected_count or 0)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.patch("/{intake_id}/lots/{lot_id}", response_model=IngredientIntakeSchema)
async def update_lot(
    intake_id: str,
    lot_id: str,
    payload: IntakeLotUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """I-4: the per-lot split was wrong (58/22 actual vs 60/20 expected).

    Editing vendor_lot or bbd fans the change out to this lot's containers,
    because those two are denormalized onto the container for the scan hot path.
    """
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    lot = db.query(IntakeLot).filter(IntakeLot.id == lot_id, IntakeLot.intake_id == intake.id).first()
    if not lot:
        raise NotFoundError("Intake lot", lot_id)

    changes = payload.dict(exclude_unset=True)
    old_expected = lot.expected_count or 0
    for field, value in changes.items():
        setattr(lot, field, value)

    if "expected_count" in changes:
        intake.expected_count = (intake.expected_count or 0) - old_expected + (lot.expected_count or 0)

    if "vendor_lot" in changes or "bbd" in changes:
        for c in db.query(Container).filter(
            Container.intake_lot_id == lot.id,
            Container.is_deleted == False,  # noqa: E712
        ).all():
            c.vendor_lot = lot.vendor_lot
            c.bbd = lot.bbd

    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


# ─── minting & labels ─────────────────────────────────────────────────────────

@router.post("/{intake_id}/mint", response_model=LabelSheet)
async def mint(
    intake_id: str,
    payload: MintSerialsRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    lot = db.query(IntakeLot).filter(
        IntakeLot.id == payload.intake_lot_id, IntakeLot.intake_id == intake.id
    ).first()
    if not lot:
        raise NotFoundError("Intake lot", payload.intake_lot_id)

    containers = svc.mint_serials(db, intake, lot, payload.count, current_user)
    db.commit()
    total = svc._active_containers(db, intake_id=intake.id).count()
    return {
        "intake_id": intake.id,
        "intake_number": intake.intake_number,
        "labels": [_label_for(db, c, total) for c in containers],
        "lot_boundaries": [],
    }


def _label_for(db: Session, c: Container, intake_total: int) -> dict:
    lot = c.intake_lot
    return {
        "serial": c.serial, "sequence": c.sequence, "intake_total": intake_total,
        "product_name": c.product.name if c.product else None,
        "product_sid": getattr(c.product, "sid", None) if c.product else None,
        "vendor_name": c.intake.vendor.name if c.intake and c.intake.vendor else None,
        "vendor_lot": c.vendor_lot, "bbd": c.bbd,
        "net_weight": c.net_weight,
        "weight_unit": lot.weight_unit if lot else c.qty_unit,
        "receipt_date": c.intake.receipt_date if c.intake else None,
        "container_type": c.container_type, "intake_lot_id": c.intake_lot_id,
    }


@router.get("/{intake_id}/labels", response_model=LabelSheet)
async def labels(
    intake_id: str,
    scope: str = Query("intake", pattern="^(intake|lot|selection)$"),
    lot_id: Optional[str] = None,
    serials: Optional[str] = Query(None, description="comma-separated"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Reprint at any scope, always the SAME serials. No supervisor gate (§5):
    a worker blocked from reprinting invents workarounds. Each reprint writes a
    `relabeled` event so excess is visible after the fact instead."""
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    serial_list = [s.strip() for s in serials.split(",") if s.strip()] if serials else None

    containers, boundaries = svc.label_sheet(
        db, intake, scope=scope, lot_id=lot_id, serials=serial_list,
        current_user=current_user,
    )
    db.commit()
    total = svc._active_containers(db, intake_id=intake.id).count()
    return {
        "intake_id": intake.id,
        "intake_number": intake.intake_number,
        "labels": [_label_for(db, c, total) for c in containers],
        "lot_boundaries": boundaries,
    }


# ─── scanning ─────────────────────────────────────────────────────────────────

@router.post("/{intake_id}/scan", response_model=ContainerScanResponse)
async def scan(
    intake_id: str,
    payload: ContainerScanRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Receive one drum onto one row.

    A full row produces a `warning` on an OTHERWISE SUCCESSFUL response — it
    never fails the scan (§8.1). The finished-goods path raises here; copying
    that would 400 an 80-drum unload mid-truck.
    """
    _require_scan_role(current_user)
    intake = _get_intake(db, intake_id)
    result = svc.scan_container(
        db, intake, payload.serial, payload.storage_row_id, current_user,
        idempotency_key=payload.idempotency_key,
        confirm_move=payload.confirm_move,
    )
    db.commit()
    container = result.get("container")
    if container is not None:
        db.refresh(container)
        result["container"] = _serialize_container(db, container)
    return result


# ─── lifecycle ────────────────────────────────────────────────────────────────

@router.post("/{intake_id}/close-short", response_model=IngredientIntakeSchema)
async def close_short(
    intake_id: str,
    payload: IntakeCloseShortRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = svc.close_short(db, _get_intake(db, intake_id), payload.short_reason, current_user)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.post("/{intake_id}/submit", response_model=IngredientIntakeSchema)
async def submit(
    intake_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = svc.submit_intake(db, _get_intake(db, intake_id), current_user)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.post("/{intake_id}/approve", response_model=IngredientIntakeSchema)
async def approve(
    intake_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    intake = svc.approve_intake(db, _get_intake(db, intake_id), current_user)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.post("/{intake_id}/reject", response_model=IngredientIntakeSchema)
async def reject(
    intake_id: str,
    payload: IntakeRejectRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    intake = svc.reject_intake(
        db, _get_intake(db, intake_id), payload.reason, payload.disposition, current_user
    )
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


@router.post("/{intake_id}/void", response_model=IngredientIntakeSchema)
async def void(
    intake_id: str,
    payload: IntakeVoidRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _require_scan_role(current_user)
    intake = svc.void_intake(db, _get_intake(db, intake_id), payload.reason, current_user)
    db.commit()
    db.refresh(intake)
    return _serialize_intake(db, intake)


# Container list/lookup and the audits live in routers/ingredient_containers.py
# (mounted at /api/ingredient-containers): they are queried ACROSS intakes —
# lot-wide holds, row contents and the recall trace all start from a product or
# a lot, not from a truck. SCAN_ROLES, MAX_CONTAINER_PAGE and
# _serialize_container are imported from here by that module.
