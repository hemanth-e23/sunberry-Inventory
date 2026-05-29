"""Supervisor-facing endpoints for declaring the currently-active production
on each line of a plant. Plant scope is derived from the authenticated user.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo

from app.constants import APPROVAL_ROLES, CATEGORY_FINISHED, ROLE_WAREHOUSE
from app.database import get_db
from app.models import (
    ActiveLineProduction, Category, Product, ProductionLine, User, Warehouse,
)
from app.schemas import (
    ActiveLineProductionRead, ProductionLineMini, ProductionLineWithActive,
    ProductMini, SetActiveProductionRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.utils.lot_number import lot_for_today, plant_local_date


router = APIRouter()


def _require_approval_role(current_user: User = Depends(get_current_active_user)) -> User:
    # Active production is editable by anyone in the warehouse, not just
    # approval roles — warehouse staff need to switch the line over when
    # production rolls to a new product. Forklift remains locked out.
    allowed = set(APPROVAL_ROLES) | {ROLE_WAREHOUSE}
    if current_user.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Warehouse, supervisor, or admin access required",
        )
    return current_user


def _resolve_warehouse_id(user: User) -> str:
    """Pick the warehouse the user is operating against. Plant users -> their own.
    Corporate users -> X-View-Warehouse selection.
    """
    wh_id = warehouse_filter(user)
    if not wh_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Select a specific warehouse to use this feature.",
        )
    return wh_id


def _ensure_today(active: ActiveLineProduction, plant_tz: str) -> bool:
    """Lazy day-rollover: if the active row is from a previous plant-local
    day, refresh it in-place (caller commits) so the same product continues
    on the new day with a fresh lot number and pallet sequence reset to 0.
    The supervisor's product choice is preserved — only midnight triggers
    this, not the supervisor.

    Returns True if a rollover happened."""
    if not active or not active.is_active:
        return False
    set_at_date = plant_local_date(plant_tz, active.set_at)
    today_local = datetime.now(ZoneInfo(plant_tz or "UTC")).date()
    if set_at_date < today_local:
        line_name = active.line.name if active.line else ""
        active.lot_number = lot_for_today(plant_tz, line_name)
        active.last_printed_seq = 0
        active.set_at = datetime.now(timezone.utc)
        return True
    return False


def _to_active_read(active: ActiveLineProduction) -> ActiveLineProductionRead:
    product_mini = None
    if active.product is not None:
        product_mini = ProductMini(
            id=active.product.id,
            name=active.product.name,
            short_code=active.product.short_code,
            fcc_code=active.product.fcc_code,
            default_cases_per_pallet=active.product.default_cases_per_pallet,
            expire_years=active.product.expire_years,
        )
    return ActiveLineProductionRead(
        id=active.id,
        line_id=active.line_id,
        product_id=active.product_id,
        lot_number=active.lot_number,
        last_printed_seq=active.last_printed_seq,
        set_at=active.set_at,
        set_by_user_id=active.set_by_user_id,
        is_active=active.is_active,
        product=product_mini,
    )


@router.get("/lines", response_model=List[ProductionLineWithActive])
def list_lines_with_active(
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_approval_role),
):
    """List production lines for the user's plant, each with its current active row (if any)."""
    wh_id = _resolve_warehouse_id(current_user)
    warehouse = db.query(Warehouse).filter(Warehouse.id == wh_id).first()
    plant_tz = (warehouse.timezone if warehouse else None) or "UTC"

    lines = (
        db.query(ProductionLine)
        .filter(ProductionLine.warehouse_id == wh_id)
        .order_by(ProductionLine.name)
        .all()
    )

    if not lines:
        return []

    line_ids = [l.id for l in lines]
    actives = (
        db.query(ActiveLineProduction)
        .filter(
            ActiveLineProduction.line_id.in_(line_ids),
            ActiveLineProduction.is_active.is_(True),
        )
        .all()
    )

    # Lazy reset
    dirty = False
    by_line = {}
    for a in actives:
        if _ensure_today(a, plant_tz):
            dirty = True
        if a.is_active:
            by_line[a.line_id] = a
    if dirty:
        db.commit()

    out: List[ProductionLineWithActive] = []
    for l in lines:
        active = by_line.get(l.id)
        out.append(
            ProductionLineWithActive(
                line=ProductionLineMini(id=l.id, name=l.name, warehouse_id=l.warehouse_id),
                active=(_to_active_read(active) if active else None),
            )
        )
    return out


@router.post("/lines/{line_id}/set", response_model=ActiveLineProductionRead)
def set_active_production(
    line_id: str,
    body: SetActiveProductionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_approval_role),
):
    """Set the currently-producing product for a line in the user's plant."""
    wh_id = _resolve_warehouse_id(current_user)
    warehouse = db.query(Warehouse).filter(Warehouse.id == wh_id).first()
    plant_tz = (warehouse.timezone if warehouse else None) or "UTC"

    line = (
        db.query(ProductionLine)
        .filter(ProductionLine.id == line_id, ProductionLine.warehouse_id == wh_id)
        .first()
    )
    if not line:
        raise HTTPException(status_code=404, detail="Production line not found")

    product = db.query(Product).filter(Product.id == body.product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    category = db.query(Category).filter(Category.id == product.category_id).first()
    if not category or category.type != CATEGORY_FINISHED:
        raise HTTPException(
            status_code=400,
            detail="Active production can only be set for finished-goods products",
        )

    # Compute today's lot number
    try:
        lot_number = lot_for_today(plant_tz, line.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Deactivate any existing active row for this line
    existing = (
        db.query(ActiveLineProduction)
        .filter(
            ActiveLineProduction.line_id == line.id,
            ActiveLineProduction.is_active.is_(True),
        )
        .all()
    )
    for row in existing:
        row.is_active = False
    if existing:
        db.flush()

    new_row = ActiveLineProduction(
        id=f"alp-{uuid.uuid4().hex[:12]}",
        line_id=line.id,
        product_id=product.id,
        lot_number=lot_number,
        last_printed_seq=0,
        set_at=datetime.now(timezone.utc),
        set_by_user_id=current_user.id,
        is_active=True,
    )
    db.add(new_row)
    db.commit()
    db.refresh(new_row)
    return _to_active_read(new_row)


@router.delete("/lines/{line_id}/active", status_code=204)
def clear_active_production(
    line_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_approval_role),
):
    """Clear the active production for a line (manual override)."""
    wh_id = _resolve_warehouse_id(current_user)

    line = (
        db.query(ProductionLine)
        .filter(ProductionLine.id == line_id, ProductionLine.warehouse_id == wh_id)
        .first()
    )
    if not line:
        raise HTTPException(status_code=404, detail="Production line not found")

    rows = (
        db.query(ActiveLineProduction)
        .filter(
            ActiveLineProduction.line_id == line.id,
            ActiveLineProduction.is_active.is_(True),
        )
        .all()
    )
    for row in rows:
        row.is_active = False
    db.commit()
    return None
