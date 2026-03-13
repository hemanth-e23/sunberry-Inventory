"""
Service-to-service API endpoints.

These endpoints are used by other Sunberry applications (e.g. Production)
to read shared data from Inventory. Requires X-Api-Key header matching
SERVICE_API_KEY in .env — intended for internal network use between services.
"""

from datetime import datetime, date, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import Product, Category, Receipt, User
from app.models.product import WarehouseCategoryAccess
from app.enums import ReceiptStatus
from app.services import staging_request_service

import logging
logger = logging.getLogger(__name__)


def verify_service_key(
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """
    Accept either:
    - X-Api-Key header matching SERVICE_API_KEY  (service-to-service)
    - Authorization: Bearer <jwt>               (inventory frontend users)
    """
    # 1. API key check (service-to-service)
    if x_api_key is not None:
        if settings.SERVICE_API_KEY and x_api_key == settings.SERVICE_API_KEY:
            return
        raise HTTPException(status_code=401, detail="Invalid API key")

    # 2. JWT bearer check (frontend)
    if authorization and authorization.lower().startswith("bearer "):
        from app.utils.auth import verify_token
        token = authorization[7:]
        token_data = verify_token(token)
        if token_data:
            user = db.query(User).filter(User.username == token_data.username).first()
            if user and user.is_active:
                return

    raise HTTPException(status_code=401, detail="Authentication required")


# All routes require a valid X-Api-Key header matching SERVICE_API_KEY in .env
router = APIRouter(dependencies=[Depends(verify_service_key)])


# ---------------------------------------------------------------------------
# Request / Response schemas for check-availability
# ---------------------------------------------------------------------------

class AvailabilityItem(BaseModel):
    sid: str
    quantity_needed: float
    unit: Optional[str] = None  # informational only

class AvailabilityRequest(BaseModel):
    items: List[AvailabilityItem]


@router.get("/raw-materials")
async def get_raw_materials(
    warehouse_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    Return all products whose category has type 'raw' or 'raw-material'.
    If warehouse_id is provided, only returns products from category groups
    assigned to that warehouse via WarehouseCategoryAccess.
    """
    query = db.query(Category.id).filter(Category.type.in_(["raw", "raw-material"]))
    if warehouse_id:
        group_ids = [
            row.category_group_id for row in
            db.query(WarehouseCategoryAccess)
            .filter(WarehouseCategoryAccess.warehouse_id == warehouse_id)
            .all()
        ]
        if not group_ids:
            return []
        query = query.filter(Category.parent_id.in_(group_ids))
    raw_category_ids = [cid[0] for cid in query.all()]

    if not raw_category_ids:
        return []

    products = (
        db.query(Product)
        .filter(Product.category_id.in_(raw_category_ids))
        .all()
    )

    return [
        {
            "id": p.id,
            "name": p.name,
            "sid": p.sid,
            "fcc_code": p.fcc_code,
            "description": p.description,
            "category_id": p.category_id,
            "quantity_uom": p.quantity_uom,
            "is_active": p.is_active,
            "inventory_tracked": p.inventory_tracked if p.inventory_tracked is not None else True,
        }
        for p in products
    ]


@router.get("/finished-goods")
async def get_finished_goods(
    warehouse_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    Return all active products whose category has type 'finished'.
    If warehouse_id is provided, only returns products from category groups
    assigned to that warehouse via WarehouseCategoryAccess.
    """
    query = db.query(Category.id).filter(Category.type == "finished")
    if warehouse_id:
        group_ids = [
            row.category_group_id for row in
            db.query(WarehouseCategoryAccess)
            .filter(WarehouseCategoryAccess.warehouse_id == warehouse_id)
            .all()
        ]
        if not group_ids:
            return []
        query = query.filter(Category.parent_id.in_(group_ids))
    fg_category_ids = [cid[0] for cid in query.all()]

    if not fg_category_ids:
        return []

    products = (
        db.query(Product)
        .filter(Product.category_id.in_(fg_category_ids), Product.is_active == True)
        .order_by(Product.name)
        .all()
    )

    return [
        {
            "id": p.id,
            "name": p.name,
            "sid": p.sid,
            "fcc_code": p.fcc_code,
            "description": p.description,
            "category_id": p.category_id,
            "quantity_uom": p.quantity_uom,
        }
        for p in products
    ]


@router.post("/check-availability")
async def check_availability(
    request: AvailabilityRequest,
    db: Session = Depends(get_db),
):
    """
    Check on-hand inventory for a list of products (by SID).

    For each SID, sums the quantity from all approved receipts with quantity > 0
    (i.e. current on-hand). Returns needed vs on_hand and whether it's sufficient.
    """
    results = []

    for item in request.items:
        sid = (item.sid or "").strip()
        if not sid:
            results.append({
                "sid": sid,
                "name": "Unknown",
                "quantity_needed": item.quantity_needed,
                "on_hand": 0,
                "unit": item.unit,
                "sufficient": False,
                "short": item.quantity_needed,
            })
            continue

        # Find the product by SID
        product = db.query(Product).filter(Product.sid == sid).first()

        if not product:
            results.append({
                "sid": sid,
                "name": f"Unknown (SID: {sid})",
                "quantity_needed": item.quantity_needed,
                "on_hand": 0,
                "unit": item.unit,
                "sufficient": False,
                "short": item.quantity_needed,
            })
            continue

        # Non-inventory-tracked items (water, sugar, etc.) are always sufficient
        if product.inventory_tracked is False:
            results.append({
                "sid": sid,
                "name": product.name,
                "quantity_needed": item.quantity_needed,
                "on_hand": None,  # Not tracked
                "unit": item.unit or product.quantity_uom or "",
                "sufficient": True,
                "short": 0,
                "inventory_tracked": False,
            })
            continue

        # Sum on-hand quantity from approved receipts with quantity > 0
        on_hand = (
            db.query(func.coalesce(func.sum(Receipt.quantity), 0))
            .filter(
                Receipt.product_id == product.id,
                Receipt.status == ReceiptStatus.APPROVED,
                Receipt.quantity > 0,
            )
            .scalar()
        )
        on_hand = float(on_hand)

        sufficient = on_hand >= item.quantity_needed
        short = max(0, item.quantity_needed - on_hand) if not sufficient else 0

        results.append({
            "sid": sid,
            "name": product.name,
            "quantity_needed": item.quantity_needed,
            "on_hand": round(on_hand, 2),
            "unit": item.unit or product.quantity_uom or "",
            "sufficient": sufficient,
            "short": round(short, 2),
        })

    all_sufficient = all(r["sufficient"] for r in results)

    return {
        "all_sufficient": all_sufficient,
        "items": results,
    }


# ---------------------------------------------------------------------------
# Staging request schemas
# ---------------------------------------------------------------------------

class StagingRequestItemIn(BaseModel):
    sid: str
    ingredient_name: str
    quantity_needed: float
    unit: Optional[str] = None

class CreateStagingRequestIn(BaseModel):
    production_batch_uid: str            # e.g. "ORG-GUAVA-MANGO-250210-001"
    product_name: Optional[str] = None   # what is being produced
    formula_name: Optional[str] = None
    number_of_batches: int = 1
    production_date: Optional[date] = None  # Planned production date
    items: List[StagingRequestItemIn]

class FulfillItemBody(BaseModel):
    staging_item_ids: Optional[List[str]] = None  # StagingItem IDs created during staging

class MarkUsedBody(BaseModel):
    staging_item_id: str
    quantity: float

class ReturnBody(BaseModel):
    staging_item_id: str
    quantity: float
    to_location_id: str
    to_sub_location_id: Optional[str] = None

class UndoStageBody(BaseModel):
    to_location_id: str
    to_sub_location_id: Optional[str] = None

class IngredientUsedNotification(BaseModel):
    production_batch_uid: str
    ingredient_sid: str
    quantity_used: float
    unit: Optional[str] = None
    lot_barcode: Optional[str] = None


# ---------------------------------------------------------------------------
# Staging request endpoints — thin wrappers delegating to staging_request_service
# ---------------------------------------------------------------------------

@router.post("/staging-requests")
async def create_staging_request(
    payload: CreateStagingRequestIn,
    db: Session = Depends(get_db),
):
    """Called by Production after batch creation. Creates a staging request."""
    return staging_request_service.create_staging_request(db, payload)


@router.get("/staging-requests")
async def list_staging_requests(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """List all staging requests (for the Inventory frontend)."""
    return staging_request_service.list_staging_requests(db, status_filter)


@router.post("/staging-requests/{request_id}/fulfill-item")
async def fulfill_staging_request_item(
    request_id: str,
    item_id: str,
    quantity_fulfilled: float,
    body: Optional[FulfillItemBody] = None,
    db: Session = Depends(get_db),
):
    """Mark a staging request item as (partially) fulfilled."""
    return staging_request_service.fulfill_staging_request_item(
        db,
        request_id,
        item_id,
        quantity_fulfilled,
        staging_item_ids=body.staging_item_ids if body else None,
    )


@router.get("/staging-requests/{request_id}/items/{item_id}/staging-details")
async def get_staging_details(
    request_id: str,
    item_id: str,
    db: Session = Depends(get_db),
):
    """Get detailed staging information for a specific request item."""
    return staging_request_service.get_staging_details(db, request_id, item_id)


@router.post("/staging-requests/{request_id}/items/{item_id}/mark-used")
async def mark_request_item_used(
    request_id: str,
    item_id: str,
    body: MarkUsedBody,
    db: Session = Depends(get_db),
):
    """Mark a quantity of a staged item as used for production."""
    return staging_request_service.mark_request_item_used(
        db, request_id, item_id, body.staging_item_id, body.quantity,
    )


@router.post("/staging-requests/{request_id}/items/{item_id}/return")
async def return_request_item(
    request_id: str,
    item_id: str,
    body: ReturnBody,
    db: Session = Depends(get_db),
):
    """Return unused staged material back to a warehouse location."""
    return staging_request_service.return_request_item(
        db, request_id, item_id,
        body.staging_item_id, body.quantity,
        body.to_location_id, body.to_sub_location_id,
    )


@router.post("/staging-requests/{request_id}/items/{item_id}/undo")
async def undo_staging(
    request_id: str,
    item_id: str,
    body: UndoStageBody,
    db: Session = Depends(get_db),
):
    """Undo all staging for a request item — return everything and reset to pending."""
    return staging_request_service.undo_staging(
        db, request_id, item_id, body.to_location_id, body.to_sub_location_id,
    )


@router.get("/staging-requests/reconciliation")
async def get_reconciliation_summary(
    db: Session = Depends(get_db),
):
    """Get a summary of all staging activity for end-of-day reconciliation."""
    return staging_request_service.get_reconciliation_summary(db)


@router.post("/notify-ingredient-used")
async def notify_ingredient_used(
    payload: IngredientUsedNotification,
    db: Session = Depends(get_db),
):
    """Called by Production when a floor worker scans an ingredient."""
    return staging_request_service.notify_ingredient_used(
        db,
        payload.production_batch_uid,
        payload.ingredient_sid,
        payload.quantity_used,
        payload.unit,
        payload.lot_barcode,
    )


@router.post("/staging-requests/{request_id}/sync")
async def sync_production_usage(
    request_id: str,
    db: Session = Depends(get_db),
):
    """Pull batch completion and ingredient usage data from Production."""
    return await staging_request_service.sync_production_usage(db, request_id)


@router.post("/staging-requests/{request_id}/dismiss")
async def dismiss_staging_request(
    request_id: str,
    db: Session = Depends(get_db),
):
    """Dismiss a staging request when production date has passed and nothing was staged."""
    return staging_request_service.dismiss_staging_request(db, request_id)


@router.get("/staging-requests/{request_id}/close-out-data")
async def get_close_out_data(
    request_id: str,
    db: Session = Depends(get_db),
):
    """Get reconciliation data for Close Out modal."""
    return await staging_request_service.get_close_out_data(db, request_id)


@router.post("/staging-requests/{request_id}/close-out")
async def close_out_staging_request(
    request_id: str,
    db: Session = Depends(get_db),
):
    """Close out a staging request after reconciliation."""
    return staging_request_service.close_out_staging_request(db, request_id)


@router.get("/health")
async def service_health():
    """Simple health-check (no auth required) so Production can verify connectivity."""
    return {"status": "ok", "service": "inventory"}
