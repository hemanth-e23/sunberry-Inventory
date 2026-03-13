from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.utils.auth import get_current_active_user, warehouse_filter
from app.services.report_builders import (
    build_point_in_time_snapshot,
    build_activity_ledger,
    build_shipments_report,
    build_movement_ledger,
    build_lot_trace,
    build_holds_report,
    build_finished_goods_report,
    build_expiry_alerts,
    build_adjustments_report,
    build_vendor_receipts_report,
    build_cycle_count_report,
)

router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Point-in-Time Inventory Snapshot
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/point-in-time")
async def point_in_time_snapshot(
    as_of_date: str,
    product_id: Optional[str] = None,
    category_id: Optional[str] = None,
    category_type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """
    Reconstruct inventory on hand as of a specific date.
    Works by taking current receipt quantities and adding back
    any transfers/adjustments that were approved AFTER as_of_date.
    """
    try:
        return build_point_in_time_snapshot(
            db,
            as_of_date=as_of_date,
            warehouse_id=warehouse_filter(current_user),
            product_id=product_id,
            category_id=category_id,
            category_type=category_type,
        )
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Activity Ledger (date range)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/activity-ledger")
async def activity_ledger(
    start_date: str,
    end_date: str,
    product_id: Optional[str] = None,
    category_id: Optional[str] = None,
    category_type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """
    Per-product summary of all activity in the date range:
    receipts received, consumed in production, shipped out,
    other adjustments, and current on-hand.
    """
    try:
        return build_activity_ledger(
            db,
            start_date=start_date,
            end_date=end_date,
            product_id=product_id,
            category_id=category_id,
            category_type=category_type,
        )
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Shipment / Ship-Out Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/shipments")
async def shipments_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """All approved shipped-out transfers in the date range."""
    return build_shipments_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        product_id=product_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Per-Product Movement Ledger
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/movement-ledger")
async def movement_ledger(
    product_id: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Chronological list of all events for a specific product."""
    return build_movement_ledger(
        db,
        product_id=product_id,
        start_date=start_date,
        end_date=end_date,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Lot Traceability
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/lot-trace")
async def lot_trace(
    lot_number: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Full life-cycle history for any lot number."""
    return build_lot_trace(db, lot_number=lot_number, warehouse_id=warehouse_filter(current_user))


# ─────────────────────────────────────────────────────────────────────────────
# 6. Hold & Release Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/holds")
async def holds_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """All hold and release actions in the date range."""
    return build_holds_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        action=action,
        product_id=product_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 7. Finished Goods Production Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/finished-goods")
async def finished_goods_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Cases of finished goods logged by production date."""
    return build_finished_goods_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        product_id=product_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 8. Expiry / Shelf Life Alert Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/expiry-alerts")
async def expiry_alerts(
    days_ahead: Optional[int] = None,
    include_expired: bool = True,
    product_id: Optional[str] = None,
    category_type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Active inventory grouped by expiry urgency."""
    return build_expiry_alerts(
        db,
        warehouse_id=warehouse_filter(current_user),
        days_ahead=days_ahead,
        include_expired=include_expired,
        product_id=product_id,
        category_type=category_type,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 9. Adjustment Audit Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/adjustments")
async def adjustments_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    adjustment_type: Optional[str] = None,
    product_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """All approved adjustments with full audit detail."""
    return build_adjustments_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        adjustment_type=adjustment_type,
        product_id=product_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 10. Vendor Receipt Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/vendor-receipts")
async def vendor_receipts_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    vendor_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Receipts grouped by vendor (vendor is optional on receipts)."""
    return build_vendor_receipts_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        vendor_id=vendor_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 11. Cycle Count Variance Report
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/cycle-counts")
async def cycle_count_report(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    location_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Cycle count records with per-item variance analysis."""
    return build_cycle_count_report(
        db,
        warehouse_id=warehouse_filter(current_user),
        start_date=start_date,
        end_date=end_date,
        location_id=location_id,
    )
