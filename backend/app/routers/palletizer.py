"""Palletizer kiosk endpoints — no JWT, protected by SERVICE_API_KEY.

The palletizer is a bookmarked URL on a kiosk system at the production line.
Access control is by network + a service API key embedded in the URL.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo

from app.config import settings
from app.constants import CATEGORY_FINISHED
from app.database import get_db
from app.models import (
    ActiveLineProduction, Category, Product, ProductionLine, Warehouse,
)
from app.schemas import (
    ActiveLineProductionRead, MintedPallet, MintPalletsRequest,
    MintPalletsResponse, ProductionLineMini, ProductionLineWithActive,
    ProductMini, RecentPalletsResponse,
)
from app.utils.lot_number import plant_local_date


router = APIRouter()


def verify_kiosk_key(
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
):
    """Strict API key check for kiosk endpoints. No JWT fallback."""
    if not settings.SERVICE_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="Palletizer service not configured (SERVICE_API_KEY missing).",
        )
    if not x_api_key or x_api_key != settings.SERVICE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return True


def _product_code(product: Product) -> str:
    """Derive the pallet-id product code segment.

    Matches the convention used in routers/receipts.py: short_code -> fcc_code
    -> name -> 'PRD', truncated to 10 chars, spaces stripped, uppercased.
    """
    base = product.short_code or product.fcc_code or product.name or "PRD"
    return base[:10].replace(" ", "").upper()


def _build_licence(lot_number: str, product: Product, seq: int) -> str:
    return f"{lot_number}-{_product_code(product)}-{seq:03d}"


def _ensure_today(active: ActiveLineProduction, plant_tz: str) -> bool:
    if not active or not active.is_active:
        return False
    set_at_date = plant_local_date(plant_tz, active.set_at)
    today_local = datetime.now(ZoneInfo(plant_tz or "UTC")).date()
    if set_at_date < today_local:
        active.is_active = False
        return True
    return False


def _to_product_mini(product: Product) -> ProductMini:
    return ProductMini(
        id=product.id,
        name=product.name,
        short_code=product.short_code,
        fcc_code=product.fcc_code,
        default_cases_per_pallet=product.default_cases_per_pallet,
        expire_years=product.expire_years,
    )


def _bbd_for_today(plant_tz: str, expire_years: Optional[int]) -> Optional[str]:
    if not expire_years:
        return None
    today_local = datetime.now(ZoneInfo(plant_tz or "UTC")).date()
    try:
        bbd = today_local.replace(year=today_local.year + int(expire_years))
    except ValueError:
        # Feb 29 + N years where target year is not leap; back off to Feb 28
        bbd = today_local.replace(month=2, day=28, year=today_local.year + int(expire_years))
    return bbd.isoformat()


@router.get("/lines", response_model=List[ProductionLineWithActive])
def kiosk_list_lines(
    warehouse_id: str = Query(..., alias="warehouse_id"),
    db: Session = Depends(get_db),
    _ok: bool = Depends(verify_kiosk_key),
):
    warehouse = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    plant_tz = warehouse.timezone or "UTC"

    lines = (
        db.query(ProductionLine)
        .filter(ProductionLine.warehouse_id == warehouse_id)
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
        a = by_line.get(l.id)
        active_read = None
        if a is not None:
            active_read = ActiveLineProductionRead(
                id=a.id,
                line_id=a.line_id,
                product_id=a.product_id,
                lot_number=a.lot_number,
                last_printed_seq=a.last_printed_seq,
                set_at=a.set_at,
                set_by_user_id=a.set_by_user_id,
                is_active=a.is_active,
                product=(_to_product_mini(a.product) if a.product else None),
            )
        out.append(
            ProductionLineWithActive(
                line=ProductionLineMini(id=l.id, name=l.name, warehouse_id=l.warehouse_id),
                active=active_read,
            )
        )
    return out


@router.post("/lines/{line_id}/mint-pallets", response_model=MintPalletsResponse)
def kiosk_mint_pallets(
    line_id: str,
    body: MintPalletsRequest,
    warehouse_id: str = Query(..., alias="warehouse_id"),
    db: Session = Depends(get_db),
    _ok: bool = Depends(verify_kiosk_key),
):
    warehouse = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    plant_tz = warehouse.timezone or "UTC"

    line = (
        db.query(ProductionLine)
        .filter(ProductionLine.id == line_id, ProductionLine.warehouse_id == warehouse_id)
        .first()
    )
    if not line:
        raise HTTPException(status_code=404, detail="Production line not found")

    # Lock the active row so concurrent mints don't double-allocate sequences
    active = (
        db.query(ActiveLineProduction)
        .filter(
            ActiveLineProduction.line_id == line.id,
            ActiveLineProduction.is_active.is_(True),
        )
        .with_for_update()
        .first()
    )
    if not active:
        raise HTTPException(
            status_code=409,
            detail="No active production set for this line. Ask supervisor to set the current product.",
        )

    if _ensure_today(active, plant_tz):
        db.commit()
        raise HTTPException(
            status_code=409,
            detail="Active production has expired (new day). Ask supervisor to set the current product.",
        )

    product = db.query(Product).filter(Product.id == active.product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Active product not found")

    category = db.query(Category).filter(Category.id == product.category_id).first()
    if not category or category.type != CATEGORY_FINISHED:
        raise HTTPException(
            status_code=400,
            detail="Active product is not a finished-good. Aborting.",
        )

    start = active.last_printed_seq + 1
    end = active.last_printed_seq + body.count
    pallets = [
        MintedPallet(
            sequence=seq,
            licence_number=_build_licence(active.lot_number, product, seq),
        )
        for seq in range(start, end + 1)
    ]
    active.last_printed_seq = end
    db.commit()

    return MintPalletsResponse(
        pallets=pallets,
        lot_number=active.lot_number,
        product=_to_product_mini(product),
        bbd=_bbd_for_today(plant_tz, product.expire_years),
    )


@router.get("/lines/{line_id}/recent-pallets", response_model=RecentPalletsResponse)
def kiosk_recent_pallets(
    line_id: str,
    warehouse_id: str = Query(..., alias="warehouse_id"),
    db: Session = Depends(get_db),
    _ok: bool = Depends(verify_kiosk_key),
):
    line = (
        db.query(ProductionLine)
        .filter(ProductionLine.id == line_id, ProductionLine.warehouse_id == warehouse_id)
        .first()
    )
    if not line:
        raise HTTPException(status_code=404, detail="Production line not found")

    active = (
        db.query(ActiveLineProduction)
        .filter(
            ActiveLineProduction.line_id == line.id,
            ActiveLineProduction.is_active.is_(True),
        )
        .first()
    )
    if not active:
        raise HTTPException(status_code=409, detail="No active production set for this line.")

    product = db.query(Product).filter(Product.id == active.product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Active product not found")

    pallets = [
        MintedPallet(
            sequence=seq,
            licence_number=_build_licence(active.lot_number, product, seq),
        )
        for seq in range(1, active.last_printed_seq + 1)
    ]

    return RecentPalletsResponse(
        lot_number=active.lot_number,
        last_printed_seq=active.last_printed_seq,
        pallets=pallets,
    )
