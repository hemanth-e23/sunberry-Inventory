from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime
import uuid

from app.database import get_db
from app.models import (
    Receipt, StagingItem, Product, Location, SubLocation, StorageRow,
    InventoryTransfer, InventoryAdjustment
)
from app.schemas import (
    StagingItem as StagingItemSchema, StagingItemCreate, StagingItemUpdate,
    StagingLotSuggestion, CreateStagingRequest, MarkStagingUsedRequest, ReturnStagingRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.enums import ReceiptStatus, AdjustmentStatus
from app.services import staging_service

router = APIRouter()


@router.get("/staging/suggest-lots", response_model=List[StagingLotSuggestion])
async def suggest_lots_for_staging(
    product_id: str,
    quantity: float,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Suggest lots for staging based on expiry date (FEFO - First Expiry First Out)"""
    wh_id = warehouse_filter(current_user)
    return staging_service.suggest_lots_for_staging(db, product_id, quantity, wh_id)


@router.post("/staging/transfer")
async def create_staging_transfer(
    staging_data: CreateStagingRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create staging transfer for multiple products"""
    result = staging_service.create_staging_transfer(db, staging_data, current_user)
    db.commit()
    return result


@router.get("/staging/items")
async def get_staging_items(
    status_filter: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all staging items with receipt information"""
    try:
        query = db.query(StagingItem)

        wh_id = warehouse_filter(current_user)
        if wh_id:
            query = query.filter(StagingItem.warehouse_id == wh_id)

        if status_filter:
            query = query.filter(StagingItem.status == status_filter)
        else:
            # Default: show only active staging items (not fully used or returned)
            query = query.filter(StagingItem.status.in_(["staged", "partially_used", "partially_returned"]))

        if product_id:
            query = query.filter(StagingItem.product_id == product_id)

        staging_items = query.order_by(StagingItem.staged_at.desc()).all()

        # Include receipt data in response
        result = []
        for item in staging_items:
            try:
                receipt = db.query(Receipt).filter(Receipt.id == item.receipt_id).first()

                item_dict = {
                    "id": item.id,
                    "transfer_id": item.transfer_id,
                    "receipt_id": item.receipt_id,
                    "product_id": item.product_id,
                    "quantity_staged": item.quantity_staged,
                    "quantity_used": item.quantity_used or 0,
                    "quantity_returned": item.quantity_returned or 0,
                    "status": item.status,
                    "staging_batch_id": getattr(item, 'staging_batch_id', None),
                    "staged_at": item.staged_at.isoformat() if item.staged_at else None,
                    "used_at": item.used_at.isoformat() if item.used_at else None,
                    "returned_at": item.returned_at.isoformat() if item.returned_at else None,
                    "receipt": {
                        "id": receipt.id if receipt else None,
                        "lot_number": receipt.lot_number if receipt else None,
                        "location_id": receipt.location_id if receipt else None,
                        "sub_location_id": receipt.sub_location_id if receipt else None,
                        "unit": getattr(receipt, 'unit', None) or "cases",
                        "pallets": getattr(receipt, 'pallets', None),
                        "cases_per_pallet": getattr(receipt, 'cases_per_pallet', None)
                    } if receipt else None,
                    "pallets_staged": getattr(item, 'pallets_staged', None),
                    "pallets_used": getattr(item, 'pallets_used', 0) or 0,
                    "pallets_returned": getattr(item, 'pallets_returned', 0) or 0,
                    "original_storage_row_id": getattr(item, 'original_storage_row_id', None),
                    "staging_storage_row_id": getattr(item, 'staging_storage_row_id', None)
                }
                result.append(item_dict)
            except Exception as e:
                print(f"Error processing staging item {item.id}: {str(e)}")
                import traceback
                traceback.print_exc()
                continue

        return result
    except Exception as e:
        print(f"Error in get_staging_items: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching staging items: {str(e)}"
        )


@router.post("/staging/{staging_item_id}/mark-used")
async def mark_staging_used(
    staging_item_id: str,
    request: MarkStagingUsedRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Mark staged item as used for production"""
    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Staging item not found")

    staging_service.mark_staging_used(db, staging_item, request, current_user)
    db.commit()
    db.refresh(staging_item)
    return staging_item


@router.post("/staging/{staging_item_id}/return")
async def return_staging_item(
    staging_item_id: str,
    request: ReturnStagingRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Return staged item to warehouse"""
    staging_item = db.query(StagingItem).filter(StagingItem.id == staging_item_id).first()
    if not staging_item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Staging item not found")

    staging_service.return_staging_item(db, staging_item, request, current_user)
    db.commit()
    db.refresh(staging_item)
    return staging_item
