"""
Staging Request business logic — extracted from routers/service.py.

Handles create, fulfill, return, undo, sync, dismiss, close-out, and
reconciliation operations for production staging requests.
"""

import json
import uuid
from datetime import datetime, date, timezone
from typing import List, Optional, Dict, Any

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.models import (
    Product, Receipt, StagingRequest, StagingRequestItem,
    StagingItem, InventoryAdjustment, InventoryTransfer,
    Location, SubLocation, StorageRow,
)
from app.enums import ReceiptStatus, AdjustmentStatus, StagingItemStatus, StagingRequestStatus
from app.exceptions import NotFoundError, ValidationError

import logging
logger = logging.getLogger(__name__)

PRODUCTION_API_URL = settings.PRODUCTION_API_URL or ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_staging_item_ids(val) -> list:
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


def _build_inventory_tracked_map(db: Session, items) -> dict:
    """Pre-fetch inventory_tracked status for all referenced products to avoid N+1 queries."""
    all_product_ids = set()
    all_sids = set()
    for i in items:
        if i.product_id:
            all_product_ids.add(i.product_id)
        elif i.sid:
            all_sids.add(i.sid)

    tracked_map = {}
    if all_product_ids:
        rows = db.query(Product.id, Product.inventory_tracked).filter(Product.id.in_(all_product_ids)).all()
        for pid, tracked in rows:
            tracked_map[pid] = tracked if tracked is not None else True
    if all_sids:
        rows = db.query(Product.sid, Product.inventory_tracked).filter(Product.sid.in_(all_sids)).all()
        for sid, tracked in rows:
            tracked_map[sid] = tracked if tracked is not None else True
    return tracked_map


def _is_item_tracked(item, tracked_map: dict) -> bool:
    if item.product_id and item.product_id in tracked_map:
        return tracked_map[item.product_id]
    if item.sid and item.sid in tracked_map:
        return tracked_map[item.sid]
    return True  # Default: tracked


def _update_parent_request_status(db: Session, request_id: str):
    """Recompute and update the parent StagingRequest status based on its items."""
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        return
    all_items = db.query(StagingRequestItem).filter(
        StagingRequestItem.request_id == request_id
    ).all()
    if all(i.status == StagingItemStatus.FULFILLED for i in all_items):
        sr.status = StagingRequestStatus.FULFILLED
    elif any(i.status in (StagingItemStatus.FULFILLED, StagingItemStatus.PARTIALLY_FULFILLED) for i in all_items):
        sr.status = StagingRequestStatus.IN_PROGRESS
    else:
        sr.status = StagingRequestStatus.PENDING
    sr.updated_at = datetime.now(timezone.utc)


def _get_location_names(db: Session, staging_item, receipt) -> tuple:
    """Get (location_name, sub_location_name) for a staging item."""
    loc_name = ""
    sub_loc_name = ""
    if staging_item.original_storage_row_id:
        row = db.query(StorageRow).filter(StorageRow.id == staging_item.original_storage_row_id).first()
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
    return loc_name, sub_loc_name


# ---------------------------------------------------------------------------
# Create staging request
# ---------------------------------------------------------------------------

def create_staging_request(db: Session, payload) -> dict:
    """
    Create a staging request from Production batch data.
    Non-inventory-tracked items are auto-fulfilled.
    """
    request_id = f"sr-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"

    sr = StagingRequest(
        id=request_id,
        production_batch_uid=payload.production_batch_uid,
        product_name=payload.product_name,
        formula_name=payload.formula_name,
        number_of_batches=payload.number_of_batches,
        production_date=payload.production_date,
        status=StagingRequestStatus.PENDING,
    )

    for item in payload.items:
        product = db.query(Product).filter(Product.sid == item.sid).first()

        is_tracked = True
        if product and product.inventory_tracked is False:
            is_tracked = False

        item_id = f"sri-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
        sri = StagingRequestItem(
            id=item_id,
            request_id=request_id,
            product_id=product.id if product else None,
            sid=item.sid,
            ingredient_name=item.ingredient_name,
            quantity_needed=item.quantity_needed,
            unit=item.unit,
            status=StagingRequestStatus.FULFILLED if not is_tracked else StagingRequestStatus.PENDING,
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


# ---------------------------------------------------------------------------
# List staging requests
# ---------------------------------------------------------------------------

def list_staging_requests(db: Session, status_filter: Optional[str] = None) -> list:
    """List all staging requests with their items."""
    query = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    )

    if status_filter and status_filter != "all":
        if status_filter == "active":
            query = query.filter(~StagingRequest.status.in_([StagingRequestStatus.CLOSED, StagingRequestStatus.CANCELLED]))
        else:
            query = query.filter(StagingRequest.status == status_filter)

    requests = query.order_by(StagingRequest.created_at.desc()).all()

    # Build tracked map across all items
    all_items = [i for sr in requests for i in sr.items]
    tracked_map = _build_inventory_tracked_map(db, all_items)

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
                    "inventory_tracked": _is_item_tracked(i, tracked_map),
                }
                for i in sr.items
            ],
        }
        for sr in requests
    ]


# ---------------------------------------------------------------------------
# Fulfill a staging request item
# ---------------------------------------------------------------------------

def fulfill_staging_request_item(
    db: Session,
    request_id: str,
    item_id: str,
    quantity_fulfilled: float,
    staging_item_ids: Optional[List[str]] = None,
) -> dict:
    """Mark a staging request item as (partially) fulfilled."""
    sr = db.query(StagingRequest).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise NotFoundError("Staging request item", item_id)

    item.quantity_fulfilled = min(item.quantity_fulfilled + quantity_fulfilled, item.quantity_needed)
    if item.quantity_fulfilled >= item.quantity_needed:
        item.status = StagingItemStatus.FULFILLED
    else:
        item.status = StagingItemStatus.PARTIALLY_FULFILLED

    # Store staging_item_ids link (append to existing if any)
    if staging_item_ids:
        existing_ids = []
        if item.staging_item_ids:
            try:
                existing_ids = json.loads(item.staging_item_ids)
            except (json.JSONDecodeError, TypeError):
                existing_ids = []
        existing_ids.extend(staging_item_ids)
        item.staging_item_ids = json.dumps(existing_ids)

    # Update parent request status
    _update_parent_request_status(db, request_id)
    db.commit()

    return {"status": "ok", "item_status": item.status, "request_status": sr.status}


# ---------------------------------------------------------------------------
# Get staging details for a request item
# ---------------------------------------------------------------------------

def get_staging_details(db: Session, request_id: str, item_id: str) -> dict:
    """
    Get detailed staging information for a specific request item.
    Returns all linked StagingItems with lot numbers, locations, quantities used/returned.
    """
    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise NotFoundError("Staging request item", item_id)

    staging_item_ids = _parse_staging_item_ids(item.staging_item_ids)

    # If this item has no staging, check sibling items (same SID)
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
        lot_number = receipt.lot_number if receipt else "\u2014"
        expiration_date = receipt.expiration_date.isoformat() if receipt and receipt.expiration_date else None

        loc_name, sub_loc_name = _get_location_names(db, si, receipt)

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
# Mark staged items as used
# ---------------------------------------------------------------------------

def mark_request_item_used(
    db: Session,
    request_id: str,
    item_id: str,
    staging_item_id: str,
    quantity: float,
) -> dict:
    """Mark a quantity of a staged item as used for production."""
    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise NotFoundError("Staging request item", item_id)

    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise NotFoundError("Staging item", staging_item_id)

    available = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if quantity > available + 0.01:
        raise ValidationError(
            f"Cannot use more than available. Available: {round(available, 3)}, Requested: {quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt", staging_item.receipt_id)

    # Create adjustment record
    adj_id = f"adj-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    adjustment = InventoryAdjustment(
        id=adj_id,
        receipt_id=receipt.id,
        product_id=receipt.product_id,
        adjustment_type="stock-correction",
        quantity=quantity,
        reason=f"Used from staging for production (request {request_id})",
        status=AdjustmentStatus.APPROVED,
        original_quantity=receipt.quantity,
        new_quantity=receipt.quantity - quantity,
        submitted_by=None,
        approved_by=None,
    )
    db.add(adjustment)

    # Update receipt quantity
    receipt.quantity = max(0, receipt.quantity - quantity)
    if receipt.quantity <= 0:
        receipt.status = ReceiptStatus.DEPLETED

    # Update staging item
    staging_item.quantity_used += quantity
    if staging_item.quantity_used >= staging_item.quantity_staged - staging_item.quantity_returned:
        staging_item.status = StagingItemStatus.USED
    else:
        staging_item.status = StagingItemStatus.PARTIALLY_USED
    staging_item.used_at = datetime.now(timezone.utc)

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

def return_request_item(
    db: Session,
    request_id: str,
    item_id: str,
    staging_item_id: str,
    quantity: float,
    to_location_id: str,
    to_sub_location_id: Optional[str] = None,
) -> dict:
    """Return unused staged material back to a warehouse location."""
    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise NotFoundError("Staging request item", item_id)

    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise NotFoundError("Staging item", staging_item_id)

    available = staging_item.quantity_staged - staging_item.quantity_used - staging_item.quantity_returned
    if quantity > available + 0.01:
        raise ValidationError(
            f"Cannot return more than available. Available: {round(available, 3)}, Requested: {quantity}"
        )

    receipt = db.query(Receipt).filter(Receipt.id == staging_item.receipt_id).first()
    if not receipt:
        raise NotFoundError("Receipt", staging_item.receipt_id)

    # Get original transfer to know the staging location
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == staging_item.transfer_id).first()

    # Create return transfer record
    return_transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    unit = receipt.unit or "units"
    product = db.query(Product).filter(Product.id == receipt.product_id).first()
    if product and product.quantity_uom:
        unit = product.quantity_uom

    return_transfer = InventoryTransfer(
        id=return_transfer_id,
        receipt_id=staging_item.receipt_id,
        from_location_id=transfer.to_location_id if transfer else receipt.location_id,
        from_sub_location_id=transfer.to_sub_location_id if transfer else receipt.sub_location_id,
        to_location_id=to_location_id,
        to_sub_location_id=to_sub_location_id,
        quantity=quantity,
        unit=unit,
        reason=f"Returned from staging (request {request_id})",
        transfer_type="warehouse-transfer",
        requested_by=None,
        status="completed",
    )
    db.add(return_transfer)

    # Update receipt location to return location
    receipt.location_id = to_location_id
    receipt.sub_location_id = to_sub_location_id

    # Update staging item
    staging_item.quantity_returned += quantity
    if staging_item.quantity_returned >= staging_item.quantity_staged - staging_item.quantity_used:
        staging_item.status = StagingItemStatus.RETURNED if staging_item.quantity_used == 0 else StagingItemStatus.PARTIALLY_RETURNED
    staging_item.returned_at = datetime.now(timezone.utc)

    # Update the request item fulfilled quantity (reduce it)
    item.quantity_fulfilled = max(0, item.quantity_fulfilled - quantity)
    if item.quantity_fulfilled <= 0:
        item.status = StagingItemStatus.PENDING
    elif item.quantity_fulfilled < item.quantity_needed:
        item.status = StagingItemStatus.PARTIALLY_FULFILLED

    # Update parent request status
    _update_parent_request_status(db, request_id)
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

def undo_staging(
    db: Session,
    request_id: str,
    item_id: str,
    to_location_id: str,
    to_sub_location_id: Optional[str] = None,
) -> dict:
    """Undo all staging for a request item — return everything and reset to pending."""
    item = db.query(StagingRequestItem).filter(
        StagingRequestItem.id == item_id,
        StagingRequestItem.request_id == request_id,
    ).first()
    if not item:
        raise NotFoundError("Staging request item", item_id)

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

        return_transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
        return_transfer = InventoryTransfer(
            id=return_transfer_id,
            receipt_id=si.receipt_id,
            from_location_id=transfer.to_location_id if transfer else receipt.location_id,
            from_sub_location_id=transfer.to_sub_location_id if transfer else receipt.sub_location_id,
            to_location_id=to_location_id,
            to_sub_location_id=to_sub_location_id,
            quantity=available,
            unit=unit,
            reason=f"Undo staging (request {request_id})",
            transfer_type="warehouse-transfer",
            requested_by=None,
            status="completed",
        )
        db.add(return_transfer)

        receipt.location_id = to_location_id
        receipt.sub_location_id = to_sub_location_id

        si.quantity_returned += available
        si.status = StagingItemStatus.RETURNED if si.quantity_used == 0 else StagingItemStatus.PARTIALLY_RETURNED
        si.returned_at = datetime.now(timezone.utc)
        returned_count += 1

    # Reset the request item
    item.quantity_fulfilled = 0
    item.status = StagingItemStatus.PENDING
    item.staging_item_ids = None

    # Update parent request status
    _update_parent_request_status(db, request_id)
    db.commit()

    return {
        "status": "ok",
        "returned_items": returned_count,
        "item_status": item.status,
    }


# ---------------------------------------------------------------------------
# Reconciliation summary
# ---------------------------------------------------------------------------

def get_reconciliation_summary(db: Session) -> list:
    """Get a summary of all active staging activity for end-of-day reconciliation."""
    active_requests = db.query(StagingRequest).filter(
        StagingRequest.status.in_([StagingRequestStatus.PENDING, StagingRequestStatus.IN_PROGRESS])
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
                    "lot_number": receipt.lot_number if receipt else "\u2014",
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
# Notify ingredient used (push from Production)
# ---------------------------------------------------------------------------

def notify_ingredient_used(
    db: Session,
    production_batch_uid: str,
    ingredient_sid: str,
    quantity_used: float,
    unit: Optional[str] = None,
    lot_barcode: Optional[str] = None,
) -> dict:
    """
    Handle notification from Production when a floor worker scans an ingredient.
    Best-effort — returns 200 even if no matching staging request is found.
    """
    matching_requests = db.query(StagingRequest).filter(
        StagingRequest.production_batch_uid.contains(production_batch_uid)
    ).all()

    if not matching_requests:
        return {"status": "ok", "message": "No matching staging request found (may not have been staged yet)"}

    marked_count = 0
    for sr in matching_requests:
        items = db.query(StagingRequestItem).filter(
            StagingRequestItem.request_id == sr.id,
            StagingRequestItem.sid == ingredient_sid,
        ).all()

        for item in items:
            if not item.staging_item_ids:
                continue

            staging_item_ids = []
            try:
                staging_item_ids = json.loads(item.staging_item_ids)
            except (json.JSONDecodeError, TypeError):
                continue

            remaining_to_mark = quantity_used
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

                receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
                if not receipt:
                    continue

                adj_id = f"adj-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
                adjustment = InventoryAdjustment(
                    id=adj_id,
                    receipt_id=receipt.id,
                    product_id=receipt.product_id,
                    adjustment_type="stock-correction",
                    quantity=use_qty,
                    reason=f"Used in production scan (batch {production_batch_uid}, lot {lot_barcode or 'N/A'})",
                    status=AdjustmentStatus.APPROVED,
                    original_quantity=receipt.quantity,
                    new_quantity=max(0, receipt.quantity - use_qty),
                    submitted_by=None,
                    approved_by=None,
                )
                db.add(adjustment)

                receipt.quantity = max(0, receipt.quantity - use_qty)
                if receipt.quantity <= 0:
                    receipt.status = ReceiptStatus.DEPLETED

                si.quantity_used += use_qty
                if si.quantity_used >= si.quantity_staged - si.quantity_returned:
                    si.status = "used"
                else:
                    si.status = "partially_used"
                si.used_at = datetime.now(timezone.utc)

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
# Sync production usage (Pull model)
# ---------------------------------------------------------------------------

async def sync_production_usage(db: Session, request_id: str) -> dict:
    """
    Pull batch completion and ingredient usage data from Production.
    Idempotent — only marks the delta between Production totals and already-marked quantities.
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    batch_uids = [u.strip() for u in sr.production_batch_uid.split(",") if u.strip()]
    if not batch_uids:
        return {"status": "ok", "message": "No batch UIDs to sync", "batches_completed": 0, "marked_count": 0}

    if not PRODUCTION_API_URL:
        return {"status": "ok", "message": "Production integration not configured (PRODUCTION_API_URL not set)", "batches_completed": 0, "marked_count": 0}

    # Call Production's batch-usage endpoint
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{PRODUCTION_API_URL}/service/batch-usage",
                params={"batch_uids": ",".join(batch_uids)},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning(f"Failed to sync with Production: {e}")
        raise ValidationError("Production app is not reachable. Please try again later.")

    batches_data = data.get("batches", {})

    batches_completed = sum(1 for b in batches_data.values() if b.get("status") == "Complete")
    batches_not_started = sum(1 for b in batches_data.values() if b.get("status") == "Pending")
    batches_in_progress = sum(1 for b in batches_data.values() if b.get("status") not in ("Complete", "Pending", "not_found"))
    total_marked = 0

    # Aggregate by SID: total quantity Production says was used (from completed batches only)
    sid_total_from_production: Dict[str, float] = {}
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

    def _get_staging_item_ids_for_sid(sid):
        seen = set()
        for item in sr.items:
            if item.sid != sid:
                continue
            for si_id in _parse_staging_item_ids(item.staging_item_ids):
                if si_id not in seen:
                    seen.add(si_id)
                    yield si_id

    for sid, total_from_production in sid_total_from_production.items():
        staging_item_ids_list = list(_get_staging_item_ids_for_sid(sid))
        already_marked = 0
        for si_id in staging_item_ids_list:
            si = db.query(StagingItem).filter(StagingItem.id == si_id).first()
            if si:
                already_marked += si.quantity_used

        delta = total_from_production - already_marked
        if delta == 0:
            continue

        if delta < 0:
            # Over-marked — reduce quantity_used (credit inventory back)
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
                    if receipt.status == ReceiptStatus.DEPLETED:
                        receipt.status = ReceiptStatus.RECORDED
                    adj_id = f"adj-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
                    db.add(InventoryAdjustment(
                        id=adj_id,
                        receipt_id=receipt.id,
                        product_id=receipt.product_id,
                        adjustment_type="stock-correction",
                        quantity=-reduce_qty,
                        reason=f"Sync correction: was over-marked, restored to match Production ({batches_completed} completed batch(es))",
                        status=AdjustmentStatus.APPROVED,
                        original_quantity=receipt.quantity - reduce_qty,
                        new_quantity=receipt.quantity,
                        submitted_by=None,
                        approved_by=None,
                    ))
                avail = si.quantity_staged - si.quantity_used - si.quantity_returned
                si.status = StagingItemStatus.USED if avail <= 0 else StagingItemStatus.PARTIALLY_USED
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

            adj_id = f"adj-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
            adjustment = InventoryAdjustment(
                id=adj_id,
                receipt_id=receipt.id,
                product_id=receipt.product_id,
                adjustment_type="stock-correction",
                quantity=use_qty,
                reason=f"Synced from Production \u2014 {batches_completed} completed batch(es)",
                status=AdjustmentStatus.APPROVED,
                original_quantity=receipt.quantity,
                new_quantity=max(0, receipt.quantity - use_qty),
                submitted_by=None,
                approved_by=None,
            )
            db.add(adjustment)

            receipt.quantity = max(0, receipt.quantity - use_qty)
            if receipt.quantity <= 0:
                receipt.status = ReceiptStatus.DEPLETED

            si.quantity_used += use_qty
            if si.quantity_used >= si.quantity_staged - si.quantity_returned:
                si.status = "used"
            else:
                si.status = "partially_used"
            si.used_at = datetime.now(timezone.utc)

            remaining_to_mark -= use_qty
            total_marked += 1

    sr.last_synced_at = datetime.now(timezone.utc)
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
# Dismiss staging request
# ---------------------------------------------------------------------------

def dismiss_staging_request(db: Session, request_id: str) -> dict:
    """Dismiss a staging request when production date has passed and nothing was staged."""
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

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
        raise ValidationError(
            "Cannot dismiss: some materials were staged. Use Close Out to reconcile leftovers first."
        )

    sr.status = StagingRequestStatus.CANCELLED
    sr.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "ok", "message": "Staging request dismissed"}


# ---------------------------------------------------------------------------
# Close Out — get reconciliation data
# ---------------------------------------------------------------------------

async def get_close_out_data(db: Session, request_id: str) -> dict:
    """
    Get reconciliation data for Close Out modal.
    Returns staged/used/returned/leftover per ingredient (consolidated by SID),
    plus batch completion counts from Production.
    """
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

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
    tracked_map = _build_inventory_tracked_map(db, sr.items)

    # Consolidate by SID and aggregate staging details
    groups: Dict[str, dict] = {}
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
                "inventory_tracked": _is_item_tracked(item, tracked_map),
                "seen_si_ids": set(),
            }
        g = groups[sid]
        g["quantity_needed"] += float(item.quantity_needed or 0)
        g["items"].append(item)
        g["inventory_tracked"] = g["inventory_tracked"] and _is_item_tracked(item, tracked_map)

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

            receipt = db.query(Receipt).filter(Receipt.id == si.receipt_id).first()
            lot_number = receipt.lot_number if receipt else "\u2014"
            loc_name, sub_loc_name = _get_location_names(db, si, receipt)

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


# ---------------------------------------------------------------------------
# Close Out — complete
# ---------------------------------------------------------------------------

def close_out_staging_request(db: Session, request_id: str) -> dict:
    """Close out a staging request after reconciliation. All leftovers must be zero."""
    sr = db.query(StagingRequest).options(
        joinedload(StagingRequest.items)
    ).filter(StagingRequest.id == request_id).first()
    if not sr:
        raise NotFoundError("Staging request", request_id)

    today = date.today()
    prod_date = sr.production_date
    if not prod_date or prod_date >= today:
        raise ValidationError(
            "Close out is only available after the production date has passed."
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
            if leftover > 0.001:
                raise ValidationError(
                    f"Leftover materials remain ({item.ingredient_name}: {leftover:.1f} {item.unit or ''}). Return or mark as used before closing out."
                )

    sr.status = "closed"
    sr.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "ok", "message": "Staging request closed"}
