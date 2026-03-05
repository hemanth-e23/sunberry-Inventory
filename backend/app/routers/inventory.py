from typing import Optional
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime
import os
import httpx
import logging

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, InventoryAdjustment,
    StorageArea, Category, Product, ReceiptAllocation
)
from app.utils.auth import get_current_active_user, warehouse_filter, require_role
from app.enums import TransferStatus, AdjustmentStatus, ReceiptStatus
from app.config import settings

router = APIRouter()

PRODUCTION_API_URL = settings.PRODUCTION_API_URL or ""
PRODUCTION_API_KEY = settings.PRODUCTION_API_KEY or ""
BOL_VARIANCE_THRESHOLD_PCT = 3.0  # Within ±3% is OK


@router.get("/overview")
async def get_inventory_overview(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get inventory overview with metrics"""
    wh_id = warehouse_filter(current_user)

    def _wh(q, model):
        return q.filter(model.warehouse_id == wh_id) if wh_id else q

    # Get total receipts count
    total_receipts = _wh(db.query(Receipt), Receipt).count()

    # Get receipts by status
    receipts_by_status = _wh(
        db.query(Receipt.status, func.count(Receipt.id)), Receipt
    ).group_by(Receipt.status).all()

    # Get pending approvals count
    pending_approvals = _wh(db.query(Receipt), Receipt).filter(
        Receipt.status.in_([ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED])
    ).count()

    # Get pending transfers count
    pending_transfers = _wh(db.query(InventoryTransfer), InventoryTransfer).filter(
        InventoryTransfer.status == TransferStatus.PENDING
    ).count()

    # Get pending adjustments count
    pending_adjustments = _wh(db.query(InventoryAdjustment), InventoryAdjustment).filter(
        InventoryAdjustment.status == AdjustmentStatus.PENDING
    ).count()

    return {
        "total_receipts": total_receipts,
        "receipts_by_status": dict(receipts_by_status),
        "pending_approvals": pending_approvals,
        "pending_transfers": pending_transfers,
        "pending_adjustments": pending_adjustments
    }

@router.get("/capacity-summary")
async def get_capacity_summary(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get storage capacity summary"""
    # Get storage areas with their allocations
    storage_areas = db.query(StorageArea).all()

    capacity_data = []
    total_capacity = 0
    total_occupied = 0

    for area in storage_areas:
        # Calculate occupied pallets from allocations
        occupied_pallets = db.query(func.sum(ReceiptAllocation.pallet_quantity)).filter(
            ReceiptAllocation.storage_area_id == area.id
        ).scalar() or 0

        available_pallets = area.pallet_capacity - occupied_pallets

        capacity_data.append({
            "id": area.id,
            "name": area.name,
            "total_capacity": area.pallet_capacity,
            "occupied_pallets": occupied_pallets,
            "available_pallets": available_pallets,
            "utilization_percentage": (occupied_pallets / area.pallet_capacity * 100) if area.pallet_capacity > 0 else 0
        })

        total_capacity += area.pallet_capacity
        total_occupied += occupied_pallets

    overall_utilization = (total_occupied / total_capacity * 100) if total_capacity > 0 else 0

    return {
        "storage_areas": capacity_data,
        "total_capacity": total_capacity,
        "total_occupied": total_occupied,
        "total_available": total_capacity - total_occupied,
        "overall_utilization": overall_utilization
    }


@router.get("/bol-report")
async def get_bol_report(
    production_date_start: Optional[str] = None,
    production_date_end: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin")),
):
    """
    BOL (Batch Output vs Logged) report. Compares actual batch size from Production
    (after lab test, when batch is Complete) to finished goods logged in Inventory.
    Aggregates by production_date and product/flavor. Shows variance and flags if outside ±3%.
    """
    # 1. Fetch batch output summary from Production
    try:
        params = {}
        if production_date_start:
            params["production_date_start"] = production_date_start
        if production_date_end:
            params["production_date_end"] = production_date_end
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{PRODUCTION_API_URL}/service/batch-output-summary",
                params=params,
                headers={"X-Api-Key": PRODUCTION_API_KEY} if PRODUCTION_API_KEY else {},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logging.warning(f"BOL: Could not reach Production API: {e}")
        data = {"rows": []}

    prod_rows = data.get("rows", [])

    # 2. Get finished goods receipts from Inventory, aggregated by (production_date, product_id)
    fg_category_ids = [
        c.id for c in db.query(Category).filter(Category.type == "finished").all()
    ]
    if not fg_category_ids:
        fg_receipts = []
    else:
        fg_receipts = (
            db.query(Receipt)
            .filter(
                Receipt.category_id.in_(fg_category_ids),
                Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.RECORDED, ReceiptStatus.REVIEWED]),
            )
            .all()
        )

    # Aggregate receipts by (production_date_str, product_id)
    receipt_agg = {}
    product_ids_seen = set()
    for r in fg_receipts:
        pd = r.production_date
        pd_str = pd.date().isoformat() if pd else None
        if not pd_str:
            continue
        key = (pd_str, r.product_id)
        if key not in receipt_agg:
            receipt_agg[key] = {"production_date": pd_str, "product_id": r.product_id, "logged_cases": 0}
        receipt_agg[key]["logged_cases"] += float(r.quantity or 0)
        product_ids_seen.add(r.product_id)

    products_by_id = {
        p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids_seen)).all()
    } if product_ids_seen else {}

    # 3. Match Production rows to Inventory data and calculate variance
    result = []
    for pr in prod_rows:
        prod_date = pr.get("production_date") or ""
        prod_name = pr.get("product_name") or "Unknown"
        inv_product_id = pr.get("inventory_product_id")  # set when product is linked
        total_gal = float(pr.get("total_actual_batch_size_gal") or 0)
        batch_count = int(pr.get("batch_count") or 0)

        # Resolve the Inventory product: prefer explicit ID link, fall back to name search
        inv_product = None
        if inv_product_id:
            inv_product = db.query(Product).filter(Product.id == inv_product_id).first()
        if not inv_product:
            inv_product = db.query(Product).filter(Product.name == prod_name).first()
        if not inv_product:
            inv_product = db.query(Product).filter(Product.name.ilike(f"%{prod_name}%")).first()

        gal_per_case = None
        if inv_product and inv_product.gal_per_case and inv_product.gal_per_case > 0:
            gal_per_case = float(inv_product.gal_per_case)
        else:
            gal_per_case = 4.0

        expected_cases = total_gal / gal_per_case if gal_per_case else None

        logged_cases = 0
        for (pd_str, pid), agg in receipt_agg.items():
            # If Production batch has no production_date, skip date filter and match by product only
            if prod_date and pd_str != prod_date:
                continue
            # Match by explicit inventory_product_id link, or by resolved inv_product id
            if inv_product and pid == inv_product.id:
                logged_cases += agg["logged_cases"]

        variance_pct = None
        status_flag = "no_data"
        if expected_cases is not None and expected_cases > 0:
            variance_pct = ((logged_cases - expected_cases) / expected_cases) * 100.0
            if abs(variance_pct) <= BOL_VARIANCE_THRESHOLD_PCT:
                status_flag = "ok"
            elif variance_pct < -BOL_VARIANCE_THRESHOLD_PCT:
                status_flag = "under"
            else:
                status_flag = "over"

        result.append({
            "production_date": prod_date,
            "product_name": prod_name,
            "total_actual_batch_size_gal": round(total_gal, 2),
            "batch_count": batch_count,
            "gal_per_case": gal_per_case,
            "expected_cases": round(expected_cases, 1) if expected_cases is not None else None,
            "logged_cases": round(logged_cases, 1),
            "variance_pct": round(variance_pct, 2) if variance_pct is not None else None,
            "status": status_flag,
        })

    return {"rows": result}
