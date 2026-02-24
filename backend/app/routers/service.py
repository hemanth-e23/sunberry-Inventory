"""
Service-to-service API endpoints.

These endpoints are used by other Sunberry applications (e.g. Production)
to read shared data from Inventory. No JWT required — intended for
internal network use between Docker containers.
"""

import json
import os
import uuid
from datetime import datetime, date
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import Product, Category, Receipt, StagingRequest, StagingRequestItem, StagingItem

import logging
logger = logging.getLogger(__name__)

PRODUCTION_API_URL = os.environ.get("PRODUCTION_API_URL", "http://localhost:8001")

router = APIRouter()


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
    db: Session = Depends(get_db),
):
    """
    Return all products whose category belongs to the 'Raw Materials' group
    (parent_id = 'group-raw').  Used by the Production app to sync ingredients.
    """
    # Step 1: get all category IDs under group-raw
    raw_category_ids = (
        db.query(Category.id)
        .filter(Category.parent_id == "group-raw")
        .all()
    )
    raw_category_ids = [cid[0] for cid in raw_category_ids]

    if not raw_category_ids:
        return []

    # Step 2: get products in those categories
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
                Receipt.status == "approved",
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


# ---------------------------------------------------------------------------
# Staging request endpoints
# ---------------------------------------------------------------------------

@router.post("/staging-requests")
async def create_staging_request(
    payload: CreateStagingRequestIn,
    db: Session = Depends(get_db),
):
    """
    Called by Production after batch creation.
    Creates a staging request so warehouse staff know what to stage.
    """
    request_id = f"sr-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"

    sr = StagingRequest(
        id=request_id,
        production_batch_uid=payload.production_batch_uid,
        product_name=payload.product_name,
        formula_name=payload.formula_name,
        number_of_batches=payload.number_of_batches,
        production_date=payload.production_date,
        status="pending",
    )

    for item in payload.items:
        # Try to match the SID to an Inventory product
        product = db.query(Product).filter(Product.sid == item.sid).first()

        # Check if this product is inventory-tracked
        # Non-tracked items (water, sugar, etc.) are auto-fulfilled — no staging needed
        is_tracked = True
        if product and product.inventory_tracked is False:
            is_tracked = False

        item_id = f"sri-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
        sri = StagingRequestItem(
            id=item_id,
            request_id=request_id,
            product_id=product.id if product else None,
            sid=item.sid,
            ingredient_name=item.ingredient_name,
            quantity_needed=item.quantity_needed,
            unit=item.unit,
            status="fulfilled" if not is_tracked else "pending",
            quantity_fulfilled=item.quantity_needed if not is_tracked else 0,
        )
        sr.items.append(sri)

    db.add(sr)
    db.commit()
    db.refresh(sr)

    return {
        "id": sr.id,
        "production_batch_uid": sr.production_batch_uid,
        "status": sr.status,
        "items_count": len(sr.items),
    }


@router.get("/staging-requests")
async def list_staging_requests(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    List all staging requests (for the Inventory frontend).
    Optional filter: ?status_filter=pending
    """
    query = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    )

    if status_filter and status_filter != "all":
        if status_filter == "active":
            query = query.filter(~StagingRequest.status.in_(["closed", "cancelled"]))
        else:
            query = query.filter(StagingRequest.status == status_filter)

    requests = query.order_by(StagingRequest.created_at.desc()).all()

    # Pre-fetch inventory_tracked status for all referenced products to avoid N+1 queries
    all_product_ids = set()
    all_sids = set()
    for sr in requests:
        for i in sr.items:
            if i.product_id:
                all_product_ids.add(i.product_id)
            elif i.sid:
                all_sids.add(i.sid)

    tracked_map = {}  # product_id or sid -> inventory_tracked bool
    if all_product_ids:
        rows = db.query(Product.id, Product.inventory_tracked).filter(Product.id.in_(all_product_ids)).all()
        for pid, tracked in rows:
            tracked_map[pid] = tracked if tracked is not None else True
    if all_sids:
        rows = db.query(Product.sid, Product.inventory_tracked).filter(Product.sid.in_(all_sids)).all()
        for sid, tracked in rows:
            tracked_map[sid] = tracked if tracked is not None else True

    def _is_tracked(item):
        if item.product_id and item.product_id in tracked_map:
            return tracked_map[item.product_id]
        if item.sid and item.sid in tracked_map:
            return tracked_map[item.sid]
        return True  # Default: tracked

    return [
        {
            "id": sr.id,
            "production_batch_uid": sr.production_batch_uid,
            "product_name": sr.product_name,
            "formula_name": sr.formula_name,
            "number_of_batches": sr.number_of_batches,
            "status": sr.status,
            "production_date": sr.production_date.isoformat() if sr.production_date else None,
            "last_synced_at": sr.last_synced_at.isoformat() if sr.last_synced_at else None,
            "created_at": sr.created_at.isoformat() if sr.created_at else None,
            "items": [
                {
                    "id": i.id,
                    "product_id": i.product_id,
                    "sid": i.sid,
                    "ingredient_name": i.ingredient_name,
                    "quantity_needed": i.quantity_needed,
                    "quantity_fulfilled": i.quantity_fulfilled,
                    "unit": i.unit,
                    "status": i.status,
                    "staging_item_ids": json.loads(i.staging_item_ids) if i.staging_item_ids else [],
                    "inventory_tracked": _is_tracked(i),
                }
                for i in sr.items
            ],
        }
        for sr in requests
    ]


class FulfillItemBody(BaseModel):
    staging_item_ids: Optional[List[str]] = None  # StagingItem IDs created during staging


@router.post("/staging-requests/{request_id}/fulfill-item")
async def fulfill_staging_request_item(
    request_id: str,
    item_id: str,
    quantity_fulfilled: float,
    body: Optional[FulfillItemBody] = None,
    db: Session = Depends(get_db),
):
    """
    Mark a staging request item as (partially) fulfilled.
    Called after warehouse user stages the material using the existing staging flow.
    Optionally accepts staging_item_ids to link the actual StagingItems.
    """
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise HTTPException(status_code=404, detail="Staging request not found")

    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Staging request item not found")

    item.quantity_fulfilled = min(item.quantity_fulfilled + quantity_fulfilled, item.quantity_needed)
    if item.quantity_fulfilled >= item.quantity_needed:
        item.status = "fulfilled"
    else:
        item.status = "partially_fulfilled"

    # Store staging_item_ids link (append to existing if any)
    if body and body.staging_item_ids:
        existing_ids = []
        if item.staging_item_ids:
            try:
                existing_ids = json.loads(item.staging_item_ids)
            except (json.JSONDecodeError, TypeError):
                existing_ids = []
        existing_ids.extend(body.staging_item_ids)
        item.staging_item_ids = json.dumps(existing_ids)

    # Update parent request status
    all_items = db.query(StagingRequestItem).filter(
        StagingRequestItem.request_id == request_id
    ).all()

    if all(i.status == "fulfilled" for i in all_items):
        sr.status = "fulfilled"
    elif any(i.status in ("fulfilled", "partially_fulfilled") for i in all_items):
        sr.status = "in_progress"

    sr.updated_at = datetime.utcnow()
    db.commit()

    return {"status": "ok", "item_status": item.status, "request_status": sr.status}


# ---------------------------------------------------------------------------
# Staging item details for a request item (lot numbers, locations, used/returned)
# ---------------------------------------------------------------------------

def _parse_staging_item_ids(val):
    """Parse staging_item_ids from DB (can be JSON string or list)."""
    if not val:
        return []
    if isinstance(val, list):
        return [x for x in val if x]
    try:
        parsed = json.loads(val) if isinstance(val, str) else val
        return [x for x in (parsed if isinstance(parsed, list) else []) if x]
    except (json.JSONDecodeError, TypeError):
        return []


@router.get("/staging-requests/{request_id}/items/{item_id}/staging-details")
async def get_staging_details(
    request_id: str,
    item_id: str,
    db: Session = Depends(get_db),
):
    """
    Get detailed staging information for a specific request item.
    Returns all linked StagingItems with lot numbers, locations, quantities used/returned.
    If this item has no staging, also checks sibling items (same SID in same request).
    """
    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Staging request item not found")

    staging_item_ids = _parse_staging_item_ids(item.staging_item_ids)

    # If this item has no staging, check sibling items (same SID) - staging may be linked to another
    if not staging_item_ids and item.sid:
        siblings = db.query(StagingRequestItem).filter(
            StagingRequestItem.request_id == request_id,
            StagingRequestItem.sid == item.sid,
        ).all()
        seen = set()
        for sib in siblings:
            for sid in _parse_staging_item_ids(sib.staging_item_ids):
                if sid not in seen:
                    seen.add(sid)
                    staging_item_ids.append(sid)

    if not staging_item_ids:
        return {"staging_items": [], "total_staged": 0, "total_used": 0, "total_returned": 0}

    staging_items = db.query(StagingItem).filter(StagingItem.id.in_(staging_item_ids)).all()

    result = []
    total_staged = 0
    total_used = 0
    total_returned = 0

    for si in staging_items:
        receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
        lot_number = receipt.lot_number if receipt else "—"
        expiration_date = receipt.expiration_date.isoformat() if receipt and receipt.expiration_date else None

        # Get location names
        from app.models import Location, SubLocation
        loc_name = ""
        sub_loc_name = ""
        if si.original_storage_row_id:
            from app.models import StorageRow
            row = db.query(StorageRow).filter(StorageRow.id == si.original_storage_row_id).first()
            if row and row.sub_location:
                sub_loc_name = row.sub_location.name
                if row.sub_location.location:
                    loc_name = row.sub_location.location.name
        if not loc_name and receipt:
            loc = db.query(Location).filter(Location.id == receipt.location_id).first()
            loc_name = loc.name if loc else ""
            if receipt.sub_location_id:
                sub_loc = db.query(SubLocation).filter(SubLocation.id == receipt.sub_location_id).first()
                sub_loc_name = sub_loc.name if sub_loc else ""

        available = si.quantity_staged - si.quantity_used - si.quantity_returned
        total_staged += si.quantity_staged
        total_used += si.quantity_used
        total_returned += si.quantity_returned

        result.append({
            "staging_item_id": si.id,
            "receipt_id": si.receipt_id,
            "lot_number": lot_number,
            "expiration_date": expiration_date,
            "location_name": loc_name,
            "sub_location_name": sub_loc_name,
            "quantity_staged": si.quantity_staged,
            "quantity_used": si.quantity_used,
            "quantity_returned": si.quantity_returned,
            "available": round(available, 3),
            "status": si.status,
            "staged_at": si.staged_at.isoformat() if si.staged_at else None,
        })

    return {
        "staging_items": result,
        "total_staged": round(total_staged, 3),
        "total_used": round(total_used, 3),
        "total_returned": round(total_returned, 3),
    }


# ---------------------------------------------------------------------------
# Mark staged items as used (called from Production Staging Requests UI)
# ---------------------------------------------------------------------------

class MarkUsedBody(BaseModel):
    staging_item_id: str
    quantity: float

@router.post("/staging-requests/{request_id}/items/{item_id}/mark-used")
async def mark_request_item_used(
    request_id: str,
    item_id: str,
    body: MarkUsedBody,
    db: Session = Depends(get_db),
):
    """
    Mark a quantity of a staged item as used for production.
    Updates the StagingItem and creates an adjustment to reduce receipt quantity.
    """
    from app.models import InventoryAdjustment, Location, SubLocation

    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Staging request item not found")

    staging_item = db.query(StagingItem).filter(StagingItem.id == body.staging_item_id).first()
    if not staging_item:
        raise HTTPException(status_code=404, detail="Staging item not found")

    available = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if body.quantity > available + 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot use more than available. Available: {round(available, 3)}, Requested: {body.quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Create adjustment record
    adj_id = f"adj-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    adjustment = InventoryAdjustment(
        id=adj_id,
        receipt_id=receipt.id,
        product_id=receipt.product_id,
        adjustment_type="stock-correction",
        quantity=body.quantity,
        reason=f"Used from staging for production (request {request_id})",
        status="approved",
        original_quantity=receipt.quantity,
        new_quantity=receipt.quantity - body.quantity,
        submitted_by=None,
        approved_by=None,
    )
    db.add(adjustment)

    # Update receipt quantity
    receipt.quantity = max(0, receipt.quantity - body.quantity)
    if receipt.quantity <= 0:
        receipt.status = "depleted"

    # Update staging item
    staging_item.quantity_used += body.quantity
    if staging_item.quantity_used >= staging_item.quantity_staged - staging_item.quantity_returned:
        staging_item.status = "used"
    else:
        staging_item.status = "partially_used"
    staging_item.used_at = datetime.utcnow()

    db.commit()
    return {
        "status": "ok",
        "staging_item_status": staging_item.status,
        "quantity_used": staging_item.quantity_used,
        "remaining": round(staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned, 3),
    }


# ---------------------------------------------------------------------------
# Return staged items to warehouse
# ---------------------------------------------------------------------------

class ReturnBody(BaseModel):
    staging_item_id: str
    quantity: float
    to_location_id: str
    to_sub_location_id: Optional[str] = None

@router.post("/staging-requests/{request_id}/items/{item_id}/return")
async def return_request_item(
    request_id: str,
    item_id: str,
    body: ReturnBody,
    db: Session = Depends(get_db),
):
    """
    Return unused staged material back to a warehouse location.
    """
    from app.models import InventoryTransfer, Location

    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Staging request item not found")

    staging_item = db.query(StagingItem).filter(StagingItem.id == body.staging_item_id).first()
    if not staging_item:
        raise HTTPException(status_code=404, detail="Staging item not found")

    available = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if body.quantity > available + 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot return more than available. Available: {round(available, 3)}, Requested: {body.quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Get original transfer to know the staging location
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()

    # Create return transfer record
    return_transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    unit = receipt.unit or "units"
    product = db.query(Product).filter(Product.id == receipt.product_id).first()
    if product and product.quantity_uom:
        unit = product.quantity_uom

    return_transfer = InventoryTransfer(
        id=return_transfer_id,
        receipt_id=staging_item.receipt_id,
        from_location_id=transfer.to_location_id if transfer else receipt.location_id,
        from_sub_location_id=transfer.to_sub_location_id if transfer else receipt.sub_location_id,
        to_location_id=body.to_location_id,
        to_sub_location_id=body.to_sub_location_id,
        quantity=body.quantity,
        unit=unit,
        reason=f"Returned from staging (request {request_id})",
        transfer_type="warehouse-transfer",
        requested_by=None,
        status="completed",
    )
    db.add(return_transfer)

    # Update receipt location to return location
    receipt.location_id = body.to_location_id
    receipt.sub_location_id = body.to_sub_location_id

    # Update staging item
    staging_item.quantity_returned += body.quantity
    if staging_item.quantity_returned >= staging_item.quantity_staged - staging_item.quantity_used:
        staging_item.status = "returned" if staging_item.quantity_used == 0 else "partially_returned"
    staging_item.returned_at = datetime.utcnow()

    # Update the request item fulfilled quantity (reduce it)
    item.quantity_fulfilled = max(0, item.quantity_fulfilled - body.quantity)
    if item.quantity_fulfilled <= 0:
        item.status = "pending"
    elif item.quantity_fulfilled < item.quantity_needed:
        item.status = "partially_fulfilled"

    # Update parent request status
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if sr:
        all_items = db.query(StagingRequestItem).filter(
            StagingRequestItem.request_id == request_id
        ).all()
        if all(i.status == "fulfilled" for i in all_items):
            sr.status = "fulfilled"
        elif any(i.status in ("fulfilled", "partially_fulfilled") for i in all_items):
            sr.status = "in_progress"
        else:
            sr.status = "pending"
        sr.updated_at = datetime.utcnow()

    db.commit()
    return {
        "status": "ok",
        "staging_item_status": staging_item.status,
        "quantity_returned": staging_item.quantity_returned,
        "item_status": item.status,
    }


# ---------------------------------------------------------------------------
# Undo staging (return everything and reset)
# ---------------------------------------------------------------------------

class UndoStageBody(BaseModel):
    to_location_id: str
    to_sub_location_id: Optional[str] = None

@router.post("/staging-requests/{request_id}/items/{item_id}/undo")
async def undo_staging(
    request_id: str,
    item_id: str,
    body: UndoStageBody,
    db: Session = Depends(get_db),
):
    """
    Undo all staging for a request item — return everything to the specified location
    and reset the item to pending state.
    """
    from app.models import InventoryTransfer

    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Staging request item not found")

    staging_item_ids = []
    if item.staging_item_ids:
        try:
            staging_item_ids = json.loads(item.staging_item_ids)
        except (json.JSONDecodeError, TypeError):
            staging_item_ids = []

    returned_count = 0
    for sid in staging_item_ids:
        si = db.query(StagingItem).filter(StagingItem.id == sid).first()
        if not si:
            continue

        available = si.quantity_staged - si.quantity_used - si.quantity_returned
        if available <= 0:
            continue

        receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
        if not receipt:
            continue

        transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == si.transfer_id).first()

        unit = receipt.unit or "units"
        product = db.query(Product).filter(Product.id == receipt.product_id).first()
        if product and product.quantity_uom:
            unit = product.quantity_uom

        return_transfer_id = f"transfer-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
        return_transfer = InventoryTransfer(
            id=return_transfer_id,
            receipt_id=si.receipt_id,
            from_location_id=transfer.to_location_id if transfer else receipt.location_id,
            from_sub_location_id=transfer.to_sub_location_id if transfer else receipt.sub_location_id,
            to_location_id=body.to_location_id,
            to_sub_location_id=body.to_sub_location_id,
            quantity=available,
            unit=unit,
            reason=f"Undo staging (request {request_id})",
            transfer_type="warehouse-transfer",
            requested_by=None,
            status="completed",
        )
        db.add(return_transfer)

        receipt.location_id = body.to_location_id
        receipt.sub_location_id = body.to_sub_location_id

        si.quantity_returned += available
        si.status = "returned" if si.quantity_used == 0 else "partially_returned"
        si.returned_at = datetime.utcnow()
        returned_count += 1

    # Reset the request item
    item.quantity_fulfilled = 0
    item.status = "pending"
    item.staging_item_ids = None

    # Update parent request status
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if sr:
        all_items = db.query(StagingRequestItem).filter(
            StagingRequestItem.request_id == request_id
        ).all()
        if all(i.status == "fulfilled" for i in all_items):
            sr.status = "fulfilled"
        elif any(i.status in ("fulfilled", "partially_fulfilled") for i in all_items):
            sr.status = "in_progress"
        else:
            sr.status = "pending"
        sr.updated_at = datetime.utcnow()

    db.commit()
    return {
        "status": "ok",
        "returned_items": returned_count,
        "item_status": item.status,
    }


# ---------------------------------------------------------------------------
# End-of-day reconciliation summary
# ---------------------------------------------------------------------------

@router.get("/staging-requests/reconciliation")
async def get_reconciliation_summary(
    db: Session = Depends(get_db),
):
    """
    Get a summary of all staging activity — what's staged, used, and needs to be returned.
    Shows all active (non-returned, non-used) staging items grouped by request.
    """
    from app.models import Location, SubLocation

    # Get all staging requests that are in_progress
    active_requests = db.query(StagingRequest).filter(
        StagingRequest.status.in_(["pending", "in_progress"])
    ).options(joinedload(StagingRequest.items)).order_by(StagingRequest.created_at.desc()).all()

    result = []
    for sr in active_requests:
        items_summary = []
        for item in sr.items:
            staging_item_ids = []
            if item.staging_item_ids:
                try:
                    staging_item_ids = json.loads(item.staging_item_ids)
                except (json.JSONDecodeError, TypeError):
                    pass

            staging_details = []
            for sid in staging_item_ids:
                si = db.query(StagingItem).filter(StagingItem.id == sid).first()
                if not si:
                    continue
                available = si.quantity_staged - si.quantity_used - si.quantity_returned
                if available <= 0:
                    continue

                receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
                staging_details.append({
                    "staging_item_id": si.id,
                    "lot_number": receipt.lot_number if receipt else "—",
                    "quantity_staged": si.quantity_staged,
                    "quantity_used": si.quantity_used,
                    "quantity_returned": si.quantity_returned,
                    "available": round(available, 3),
                    "status": si.status,
                })

            items_summary.append({
                "id": item.id,
                "ingredient_name": item.ingredient_name,
                "sid": item.sid,
                "quantity_needed": item.quantity_needed,
                "quantity_fulfilled": item.quantity_fulfilled,
                "unit": item.unit,
                "status": item.status,
                "staging_details": staging_details,
            })

        result.append({
            "id": sr.id,
            "production_batch_uid": sr.production_batch_uid,
            "product_name": sr.product_name,
            "formula_name": sr.formula_name,
            "status": sr.status,
            "created_at": sr.created_at.isoformat() if sr.created_at else None,
            "items": items_summary,
        })

    return result


# ---------------------------------------------------------------------------
# Receive notification from Production when ingredient is scanned/used
# ---------------------------------------------------------------------------

class IngredientUsedNotification(BaseModel):
    production_batch_uid: str
    ingredient_sid: str
    quantity_used: float
    unit: Optional[str] = None
    lot_barcode: Optional[str] = None

@router.post("/notify-ingredient-used")
async def notify_ingredient_used(
    payload: IngredientUsedNotification,
    db: Session = Depends(get_db),
):
    """
    Called by Production when a floor worker scans an ingredient.
    Attempts to find the matching staging request item and auto-mark
    the corresponding StagingItem as used.

    This is best-effort — if no matching staging request is found, it still returns 200.
    """
    # Find staging request(s) matching this batch UID
    matching_requests = db.query(StagingRequest).filter(
        StagingRequest.production_batch_uid.contains(payload.production_batch_uid)
    ).all()

    if not matching_requests:
        return {"status": "ok", "message": "No matching staging request found (may not have been staged yet)"}

    marked_count = 0
    for sr in matching_requests:
        # Find the matching item by SID
        items = db.query(StagingRequestItem).filter(
            StagingRequestItem.request_id == sr.id,
            StagingRequestItem.sid == payload.ingredient_sid,
        ).all()

        for item in items:
            if not item.staging_item_ids:
                continue

            staging_item_ids = []
            try:
                staging_item_ids = json.loads(item.staging_item_ids)
            except (json.JSONDecodeError, TypeError):
                continue

            # Try to mark used on each staging item until quantity is consumed
            remaining_to_mark = payload.quantity_used
            for sid in staging_item_ids:
                if remaining_to_mark <= 0:
                    break

                si = db.query(StagingItem).filter(StagingItem.id == sid).first()
                if not si:
                    continue

                available = si.quantity_staged - si.quantity_used - si.quantity_returned
                if available <= 0:
                    continue

                use_qty = min(available, remaining_to_mark)

                # Get receipt to create adjustment
                receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
                if not receipt:
                    continue

                # Create adjustment
                from app.models import InventoryAdjustment
                adj_id = f"adj-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
                adjustment = InventoryAdjustment(
                    id=adj_id,
                    receipt_id=receipt.id,
                    product_id=receipt.product_id,
                    adjustment_type="stock-correction",
                    quantity=use_qty,
                    reason=f"Used in production scan (batch {payload.production_batch_uid}, lot {payload.lot_barcode or 'N/A'})",
                    status="approved",
                    original_quantity=receipt.quantity,
                    new_quantity=max(0, receipt.quantity - use_qty),
                    submitted_by=None,
                    approved_by=None,
                )
                db.add(adjustment)

                receipt.quantity = max(0, receipt.quantity - use_qty)
                if receipt.quantity <= 0:
                    receipt.status = "depleted"

                si.quantity_used += use_qty
                if si.quantity_used >= si.quantity_staged - si.quantity_returned:
                    si.status = "used"
                else:
                    si.status = "partially_used"
                si.used_at = datetime.utcnow()

                remaining_to_mark -= use_qty
                marked_count += 1

    if marked_count > 0:
        db.commit()

    return {
        "status": "ok",
        "marked_count": marked_count,
        "message": f"Marked {marked_count} staging item(s) as used" if marked_count > 0 else "No staging items found to mark",
    }


# ---------------------------------------------------------------------------
# Sync production usage (Pull model — Inventory pulls from Production)
# ---------------------------------------------------------------------------

@router.post("/staging-requests/{request_id}/sync")
async def sync_production_usage(
    request_id: str,
    db: Session = Depends(get_db),
):
    """
    Pull batch completion and ingredient usage data from Production.
    For each completed batch, auto-mark staging items as used with final quantities.
    Called when warehouse person clicks "Sync with Production".
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise HTTPException(status_code=404, detail="Staging request not found")

    # Parse batch UIDs (comma-separated)
    batch_uids = [u.strip() for u in sr.production_batch_uid.split(",") if u.strip()]
    if not batch_uids:
        return {"status": "ok", "message": "No batch UIDs to sync", "batches_completed": 0, "marked_count": 0}

    # Call Production's batch-usage endpoint
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{PRODUCTION_API_URL}/service/batch-usage",
                params={"batch_uids": ",".join(batch_uids)},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning(f"Failed to sync with Production: {e}")
        raise HTTPException(status_code=502, detail=f"Could not reach Production app: {str(e)}")

    batches_data = data.get("batches", {})

    # Count results
    batches_completed = sum(1 for b in batches_data.values() if b.get("status") == "Complete")
    batches_not_started = sum(1 for b in batches_data.values() if b.get("status") == "Pending")
    batches_in_progress = sum(1 for b in batches_data.values() if b.get("status") not in ("Complete", "Pending", "not_found"))
    total_marked = 0

    # Aggregate by SID: total quantity Production says was used (from completed batches only)
    # This makes sync IDEMPOTENT - we only mark the delta, never re-mark on multiple sync runs
    sid_total_from_production = {}
    for batch_uid, batch_info in batches_data.items():
        if batch_info.get("status") != "Complete":
            continue
        for ingredient in batch_info.get("ingredients", []):
            if ingredient.get("admin_skipped"):
                continue
            sid = ingredient.get("sid", "")
            final_qty = float(ingredient.get("final_quantity") or 0)
            if not sid or final_qty <= 0:
                continue
            sid_total_from_production[sid] = sid_total_from_production.get(sid, 0) + final_qty

    # Get all StagingItem IDs linked to this request (deduplicated per SID)
    def _get_staging_item_ids_for_sid(sid):
        seen = set()
        for item in sr.items:
            if item.sid != sid:
                continue
            for si_id in _parse_staging_item_ids(item.staging_item_ids):
                if si_id not in seen:
                    seen.add(si_id)
                    yield si_id

    # For each SID, mark only the DELTA: (Production total) - (already marked)
    # If already_marked > total_from_production (over-marked by prior sync runs), correct it
    for sid, total_from_production in sid_total_from_production.items():
        staging_item_ids_list = list(_get_staging_item_ids_for_sid(sid))
        already_marked = 0
        for si_id in staging_item_ids_list:
            si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
            if si:
                already_marked += si.quantity_used

        delta = total_from_production - already_marked
        if delta == 0:
            continue  # Idempotent: already correct
        if delta < 0:
            # Over-marked in the past - reduce quantity_used (credit inventory back)
            from app.models import InventoryAdjustment
            to_reduce = -delta
            for si_id in staging_item_ids_list:
                if to_reduce <= 0:
                    break
                si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
                if not si or si.quantity_used <= 0:
                    continue
                reduce_qty = min(si.quantity_used, to_reduce)
                si.quantity_used -= reduce_qty
                to_reduce -= reduce_qty
                receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
                if receipt:
                    receipt.quantity = (receipt.quantity or 0) + reduce_qty
                    if receipt.status == "depleted":
                        receipt.status = "recorded"
                    adj_id = f"adj-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
                    db.add(InventoryAdjustment(
                        id=adj_id,
                        receipt_id=receipt.id,
                        product_id=receipt.product_id,
                        adjustment_type="stock-correction",
                        quantity=-reduce_qty,  # negative = credit back
                        reason=f"Sync correction: was over-marked, restored to match Production ({batches_completed} completed batch(es))",
                        status="approved",
                        original_quantity=receipt.quantity - reduce_qty,
                        new_quantity=receipt.quantity,
                        submitted_by=None,
                        approved_by=None,
                    ))
                avail = si.quantity_staged - si.quantity_used - si.quantity_returned
                si.status = "used" if avail <= 0 else "partially_used"
                total_marked += 1
            continue
        remaining_to_mark = delta

        for si_id in staging_item_ids_list:
            if remaining_to_mark <= 0:
                break
            si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
            if not si:
                continue
            available = si.quantity_staged - si.quantity_used - si.quantity_returned
            if available <= 0:
                continue

            use_qty = min(available, remaining_to_mark)

            receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
            if not receipt:
                continue

            # Create adjustment
            from app.models import InventoryAdjustment
            adj_id = f"adj-{int(datetime.utcnow().timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            adjustment = InventoryAdjustment(
                id=adj_id,
                receipt_id=receipt.id,
                product_id=receipt.product_id,
                adjustment_type="stock-correction",
                quantity=use_qty,
                reason=f"Synced from Production — {batches_completed} completed batch(es)",
                status="approved",
                original_quantity=receipt.quantity,
                new_quantity=max(0, receipt.quantity - use_qty),
                submitted_by=None,
                approved_by=None,
            )
            db.add(adjustment)

            receipt.quantity = max(0, receipt.quantity - use_qty)
            if receipt.quantity <= 0:
                receipt.status = "depleted"

            si.quantity_used += use_qty
            if si.quantity_used >= si.quantity_staged - si.quantity_returned:
                si.status = "used"
            else:
                si.status = "partially_used"
            si.used_at = datetime.utcnow()

            remaining_to_mark -= use_qty
            total_marked += 1

    # Update last_synced_at
    sr.last_synced_at = datetime.utcnow()
    db.commit()

    return {
        "status": "ok",
        "batches_completed": batches_completed,
        "batches_not_started": batches_not_started,
        "batches_in_progress": batches_in_progress,
        "total_batches": len(batch_uids),
        "marked_count": total_marked,
        "last_synced_at": sr.last_synced_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Dismiss staging request (never staged, production date passed)
# ---------------------------------------------------------------------------

@router.post("/staging-requests/{request_id}/dismiss")
async def dismiss_staging_request(
    request_id: str,
    db: Session = Depends(get_db),
):
    """
    Dismiss a staging request when production date has passed and nothing was staged.
    Sets status to 'cancelled'. Only allowed when no items have staging_item_ids.
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise HTTPException(status_code=404, detail="Staging request not found")

    # Check if anything was staged
    has_staging = False
    for item in sr.items:
        ids = item.staging_item_ids
        if ids:
            try:
                parsed = json.loads(ids) if isinstance(ids, str) else ids
                if parsed and len(parsed) > 0:
                    has_staging = True
                    break
            except (json.JSONDecodeError, TypeError):
                pass

    if has_staging:
        raise HTTPException(
            status_code=400,
            detail="Cannot dismiss: some materials were staged. Use Close Out to reconcile leftovers first."
        )

    sr.status = "cancelled"
    sr.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "ok", "message": "Staging request dismissed"}


# ---------------------------------------------------------------------------
# Close Out — reconciliation data and complete
# ---------------------------------------------------------------------------

@router.get("/staging-requests/{request_id}/close-out-data")
async def get_close_out_data(
    request_id: str,
    db: Session = Depends(get_db),
):
    """
    Get reconciliation data for Close Out modal.
    Returns staged/used/returned/leftover per ingredient (consolidated by SID),
    plus batch completion counts from Production.
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise HTTPException(status_code=404, detail="Staging request not found")

    # Get batch completion counts from Production
    batch_uids = [u.strip() for u in (sr.production_batch_uid or "").split(",") if u.strip()]
    batches_completed = 0
    total_batches = len(batch_uids)
    if batch_uids:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{PRODUCTION_API_URL}/service/batch-usage",
                    params={"batch_uids": ",".join(batch_uids)},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    batches_data = data.get("batches", {})
                    batches_completed = sum(1 for b in batches_data.values() if b.get("status") == "Complete")
        except Exception:
            pass

    # Build inventory_tracked map for items
    all_product_ids = set(i.product_id for i in sr.items if i.product_id)
    all_sids = set(i.sid for i in sr.items if i.sid)
    tracked_map = {}
    if all_product_ids:
        for pid, tracked in db.query(Product.id, Product.inventory_tracked).filter(Product.id.in_(all_product_ids)).all():
            tracked_map[pid] = tracked if tracked is not None else True
    if all_sids:
        for s, tracked in db.query(Product.sid, Product.inventory_tracked).filter(Product.sid.in_(all_sids)).all():
            tracked_map[s] = tracked if tracked is not None else True

    def _is_tracked(item):
        if item.product_id and item.product_id in tracked_map:
            return tracked_map[item.product_id]
        if item.sid and item.sid in tracked_map:
            return tracked_map[item.sid]
        return True

    # Consolidate by SID and aggregate staging details (deduplicate StagingItems - same SI can be linked from multiple request items)
    groups = {}
    for item in sr.items:
        sid = (item.sid or item.ingredient_name or item.id or "unknown").strip() or "unknown"
        if sid not in groups:
            groups[sid] = {
                "ingredient_name": item.ingredient_name,
                "sid": item.sid,
                "unit": item.unit or "",
                "quantity_needed": 0,
                "quantity_staged": 0,
                "quantity_used": 0,
                "quantity_returned": 0,
                "staging_details": [],
                "items": [],
                "inventory_tracked": _is_tracked(item),
                "seen_si_ids": set(),  # dedupe staging items
            }
        g = groups[sid]
        g["quantity_needed"] += float(item.quantity_needed or 0)
        g["items"].append(item)
        g["inventory_tracked"] = g["inventory_tracked"] and _is_tracked(item)

        staging_item_ids = []
        if item.staging_item_ids:
            try:
                staging_item_ids = json.loads(item.staging_item_ids) if isinstance(item.staging_item_ids, str) else item.staging_item_ids
            except (json.JSONDecodeError, TypeError):
                pass

        for si_id in staging_item_ids:
            if si_id in g["seen_si_ids"]:
                continue
            g["seen_si_ids"].add(si_id)
            si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
            if not si:
                continue
            available = si.quantity_staged - si.quantity_used - si.quantity_returned
            g["quantity_staged"] += si.quantity_staged
            g["quantity_used"] += si.quantity_used
            g["quantity_returned"] += si.quantity_returned
            # Include lot/location for Return modal display
            receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
            lot_number = receipt.lot_number if receipt else "—"
            loc_name, sub_loc_name = "", ""
            if si.original_storage_row_id:
                from app.models import StorageRow
                row = db.query(StorageRow).filter(StorageRow.id == si.original_storage_row_id).first()
                if row and row.sub_location:
                    sub_loc_name = row.sub_location.name or ""
                    if row.sub_location.location:
                        loc_name = row.sub_location.location.name or ""
            if not loc_name and receipt:
                from app.models import Location, SubLocation
                loc = db.query(Location).filter(Location.id == receipt.location_id).first()
                loc_name = loc.name if loc else ""
                if receipt.sub_location_id:
                    sub = db.query(SubLocation).filter(SubLocation.id == receipt.sub_location_id).first()
                    sub_loc_name = sub.name if sub else ""
            g["staging_details"].append({
                "staging_item_id": si.id,
                "available": round(available, 3),
                "item_id": item.id,
                "lot_number": lot_number,
                "location_name": loc_name,
                "sub_location_name": sub_loc_name,
            })

    items_list = []
    for sid, g in groups.items():
        # Skip non-tracked items (Water, Sugar) - nothing to reconcile
        if g.get("inventory_tracked") is False:
            continue
        leftover = round(g["quantity_staged"] - g["quantity_used"] - g["quantity_returned"], 3)
        items_list.append({
            "ingredient_name": g["ingredient_name"],
            "sid": g["sid"],
            "unit": g["unit"],
            "quantity_needed": round(g["quantity_needed"], 3),
            "quantity_staged": round(g["quantity_staged"], 3),
            "quantity_used": round(g["quantity_used"], 3),
            "quantity_returned": round(g["quantity_returned"], 3),
            "leftover": leftover,
            "staging_details": g["staging_details"],
            "items": [{"id": i.id} for i in g["items"]],
        })

    return {
        "request": {
            "id": sr.id,
            "production_batch_uid": sr.production_batch_uid,
            "product_name": sr.product_name,
            "formula_name": sr.formula_name,
            "production_date": sr.production_date.isoformat() if sr.production_date else None,
        },
        "batches_completed": batches_completed,
        "total_batches": total_batches,
        "items": items_list,
    }


@router.post("/staging-requests/{request_id}/close-out")
async def close_out_staging_request(
    request_id: str,
    db: Session = Depends(get_db),
):
    """
    Close out a staging request after reconciliation.
    Sets status to 'closed'. Only allowed when production_date < today and all leftovers are zero.
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise HTTPException(status_code=404, detail="Staging request not found")

    today = date.today()
    prod_date = sr.production_date
    if not prod_date or prod_date >= today:
        raise HTTPException(
            status_code=400,
            detail="Close out is only available after the production date has passed."
        )

    # Verify all leftovers are zero
    for item in sr.items:
        staging_item_ids = []
        if item.staging_item_ids:
            try:
                staging_item_ids = json.loads(item.staging_item_ids) if isinstance(item.staging_item_ids, str) else item.staging_item_ids
            except (json.JSONDecodeError, TypeError):
                pass

        for si_id in staging_item_ids:
            si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
            if not si:
                continue
            leftover = si.quantity_staged - si.quantity_used - si.quantity_returned
            if leftover > 0.001:  # small tolerance for float
                raise HTTPException(
                    status_code=400,
                    detail=f"Leftover materials remain ({item.ingredient_name}: {leftover:.1f} {item.unit or ''}). Return or mark as used before closing out."
                )

    sr.status = "closed"
    sr.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "ok", "message": "Staging request closed"}


@router.get("/health")
async def service_health():
    """Simple health-check (no auth required) so Production can verify connectivity."""
    return {"status": "ok", "service": "inventory"}
