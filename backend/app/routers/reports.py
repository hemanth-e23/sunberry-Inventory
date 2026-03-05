from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import and_
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, InventoryAdjustment, InventoryHoldAction,
    Category, Product, Vendor, User, CycleCount, Location, SubLocation, StorageRow,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.enums import TransferStatus, AdjustmentStatus, HoldStatus
from app.constants import CATEGORY_FINISHED

router = APIRouter()

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_dt_start(d: str) -> datetime:
    return datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _parse_dt_end(d: str) -> datetime:
    dt = datetime.strptime(d, "%Y-%m-%d")
    return dt.replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)


def _product_info(db: Session, product_id: Optional[str]):
    if not product_id:
        return "Unknown", ""
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return "Unknown", ""
    code = p.fcc_code or p.sid or p.short_code or ""
    return p.name or "Unknown", code


def _category_info(db: Session, category_id: Optional[str]):
    if not category_id:
        return "Unknown", None
    c = db.query(Category).filter(Category.id == category_id).first()
    if not c:
        return "Unknown", None
    return c.name or "Unknown", c.type


def _vendor_name(db: Session, vendor_id: Optional[str]) -> Optional[str]:
    if not vendor_id:
        return None
    v = db.query(Vendor).filter(Vendor.id == vendor_id).first()
    return v.name if v else None


def _user_name(db: Session, user_id: Optional[str]) -> Optional[str]:
    if not user_id:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return u.name if u else None


def _resolve_row_name(db: Session, row_key: str) -> str:
    """Given 'row-{id}' or 'floor', return the storage row name."""
    if not row_key or row_key == "floor":
        return "Floor"
    row_id = row_key.replace("row-", "", 1)
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    return row.name if row else row_key


def _breakdown_rows(db: Session, breakdown, unit: str = "cases") -> list:
    """Convert a source/destination breakdown JSON into list of {row, qty} dicts."""
    if not breakdown or not isinstance(breakdown, list):
        return []
    rows = []
    for item in breakdown:
        row_name = _resolve_row_name(db, item.get("id", ""))
        qty = round(float(item.get("quantity", 0)), 2)
        rows.append({"row": row_name, "qty": qty, "unit": unit})
    return rows


def _receipt_initial_rows(receipt, db: Session) -> list:
    """Return row-level storage info for when a receipt was first put away."""
    unit = receipt.unit or "cases"
    # Multi-row raw material allocations
    if receipt.raw_material_row_allocations and isinstance(receipt.raw_material_row_allocations, list):
        rows = []
        for alloc in receipt.raw_material_row_allocations:
            row_id = alloc.get("row_id") or alloc.get("rowId")
            if row_id:
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                row_name = row.name if row else row_id
            else:
                row_name = "Unknown Row"
            qty = round(float(alloc.get("cases", alloc.get("pallets", 0))), 2)
            rows.append({"row": row_name, "qty": qty, "unit": unit})
        if rows:
            return rows
    # Finished goods allocation plan
    if receipt.allocation and isinstance(receipt.allocation, dict):
        plan = receipt.allocation.get("plan", [])
        rows = []
        for item in plan:
            row_id = item.get("rowId") or item.get("row_id")
            if row_id:
                row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
                row_name = row.name if row else row_id
            else:
                row_name = item.get("rowName") or "Unknown Row"
            qty = round(float(item.get("cases", 0)), 2)
            rows.append({"row": row_name, "qty": qty, "unit": unit})
        if rows:
            return rows
    # Single storage row
    if receipt.storage_row_id:
        row = db.query(StorageRow).filter(StorageRow.id == receipt.storage_row_id).first()
        if row:
            return [{"row": row.name, "qty": round(float(receipt.quantity or 0), 2), "unit": unit}]
    return []


def _qty_on_date(receipt: Receipt, as_of_dt: datetime, db: Session) -> float:
    """Reconstruct quantity for a receipt as of a specific datetime."""
    shipped_after = db.query(InventoryTransfer).filter(
        InventoryTransfer.receipt_id == receipt.id,
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status == TransferStatus.APPROVED,
        InventoryTransfer.approved_at > as_of_dt,
    ).all()

    adj_after = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.receipt_id == receipt.id,
        InventoryAdjustment.status == AdjustmentStatus.APPROVED,
        InventoryAdjustment.approved_at > as_of_dt,
    ).all()

    return (
        float(receipt.quantity or 0)
        + sum(float(t.quantity or 0) for t in shipped_after)
        + sum(float(a.quantity or 0) for a in adj_after)
    )


def _initial_receipt_qty(receipt: Receipt, db: Session) -> float:
    """Estimate the original quantity when the receipt was first created."""
    shipped = db.query(InventoryTransfer).filter(
        InventoryTransfer.receipt_id == receipt.id,
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status == TransferStatus.APPROVED,
    ).all()
    adjs = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.receipt_id == receipt.id,
        InventoryAdjustment.status == AdjustmentStatus.APPROVED,
    ).all()
    return (
        float(receipt.quantity or 0)
        + sum(float(t.quantity or 0) for t in shipped)
        + sum(float(a.quantity or 0) for a in adjs)
    )


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
        as_of_dt = _parse_dt_end(as_of_date)
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")

    query = db.query(Receipt).filter(Receipt.receipt_date <= as_of_dt)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)

    if product_id:
        query = query.filter(Receipt.product_id == product_id)
    if category_id:
        query = query.filter(Receipt.category_id == category_id)
    if category_type:
        cat_ids = [c.id for c in db.query(Category).filter(Category.type == category_type).all()]
        if not cat_ids:
            return {"as_of_date": as_of_date, "rows": [], "totals": {}}
        query = query.filter(Receipt.category_id.in_(cat_ids))

    receipts = query.all()
    rows = []
    for r in receipts:
        qty = _qty_on_date(r, as_of_dt, db)
        if qty <= 0:
            continue
        pname, pcode = _product_info(db, r.product_id)
        cname, ctype = _category_info(db, r.category_id)
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_id": r.product_id,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "vendor_name": _vendor_name(db, r.vendor_id),
            "receipt_date": r.receipt_date,
            "production_date": r.production_date,
            "expiration_date": r.expiration_date,
            "quantity": round(qty, 2),
            "unit": r.unit or "cases",
        })

    totals_by_type: dict = {}
    for row in rows:
        key = row["category_type"] or row["category_name"]
        totals_by_type[key] = totals_by_type.get(key, 0) + row["quantity"]

    return {
        "as_of_date": as_of_date,
        "rows": sorted(rows, key=lambda x: x["product_name"]),
        "totals": {
            "lots": len(rows),
            "by_category": {k: round(v, 2) for k, v in totals_by_type.items()},
        },
    }


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
        start_dt = _parse_dt_start(start_date)
        end_dt = _parse_dt_end(end_date)
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD.")

    # Collect all product_ids with activity in range
    product_ids: set = set()

    # Receipts created in range
    rq = db.query(Receipt).filter(
        Receipt.receipt_date >= start_dt,
        Receipt.receipt_date <= end_dt,
    )
    if product_id:
        rq = rq.filter(Receipt.product_id == product_id)
    if category_id:
        rq = rq.filter(Receipt.category_id == category_id)
    if category_type:
        cat_ids = [c.id for c in db.query(Category).filter(Category.type == category_type).all()]
        if cat_ids:
            rq = rq.filter(Receipt.category_id.in_(cat_ids))
    range_receipts = rq.all()
    for r in range_receipts:
        product_ids.add(r.product_id)

    # Transfers approved in range
    tq = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status == TransferStatus.APPROVED,
        InventoryTransfer.approved_at >= start_dt,
        InventoryTransfer.approved_at <= end_dt,
    )
    range_transfers = tq.all()
    for t in range_transfers:
        r = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
        if r:
            product_ids.add(r.product_id)

    # Adjustments approved in range
    aq = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.status == AdjustmentStatus.APPROVED,
        InventoryAdjustment.approved_at >= start_dt,
        InventoryAdjustment.approved_at <= end_dt,
    )
    range_adjustments = aq.all()
    for a in range_adjustments:
        if a.product_id:
            product_ids.add(a.product_id)

    if product_id:
        product_ids = {product_id} if product_id in product_ids else set()

    rows = []
    for pid in product_ids:
        if not pid:
            continue
        pname, pcode = _product_info(db, pid)

        # Find category from most recent receipt for this product
        sample_receipt = db.query(Receipt).filter(Receipt.product_id == pid).order_by(Receipt.receipt_date.desc()).first()
        cname, ctype = _category_info(db, sample_receipt.category_id if sample_receipt else None)

        # Skip if category filter doesn't match
        if category_id and sample_receipt and sample_receipt.category_id != category_id:
            continue
        if category_type and ctype != category_type:
            continue

        # Received in range: initial quantity of receipts created in range
        p_receipts = [r for r in range_receipts if r.product_id == pid]
        received = sum(_initial_receipt_qty(r, db) for r in p_receipts)

        # Consumed in production (production-consumption adjustments)
        consumed = sum(
            float(a.quantity or 0)
            for a in range_adjustments
            if a.product_id == pid and a.adjustment_type == "production-consumption"
        )

        # Shipped out
        shipped = 0.0
        for t in range_transfers:
            r = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
            if r and r.product_id == pid:
                shipped += float(t.quantity or 0)

        # Other adjustments (damage, donation, trash, quality-rejection, stock-correction)
        other_adj = sum(
            float(a.quantity or 0)
            for a in range_adjustments
            if a.product_id == pid and a.adjustment_type != "production-consumption"
        )

        # Current on hand
        current_receipts = db.query(Receipt).filter(
            Receipt.product_id == pid,
            Receipt.quantity > 0,
        ).all()
        current_on_hand = sum(float(r.quantity or 0) for r in current_receipts)

        lot_numbers = sorted(set(r.lot_number for r in p_receipts if r.lot_number))

        rows.append({
            "product_id": pid,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "receipts_count": len(p_receipts),
            "lot_numbers": lot_numbers,
            "received": round(received, 2),
            "consumed_in_production": round(consumed, 2),
            "shipped_out": round(shipped, 2),
            "other_adjustments": round(other_adj, 2),
            "current_on_hand": round(current_on_hand, 2),
        })

    rows.sort(key=lambda x: (x["category_type"] or "", x["product_name"]))

    totals = {
        "received": round(sum(r["received"] for r in rows), 2),
        "consumed_in_production": round(sum(r["consumed_in_production"] for r in rows), 2),
        "shipped_out": round(sum(r["shipped_out"] for r in rows), 2),
        "other_adjustments": round(sum(r["other_adjustments"] for r in rows), 2),
        "current_on_hand": round(sum(r["current_on_hand"] for r in rows), 2),
    }

    return {"start_date": start_date, "end_date": end_date, "rows": rows, "totals": totals}


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
    query = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status == TransferStatus.APPROVED,
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryTransfer.warehouse_id == wh_id)
    if start_date:
        query = query.filter(InventoryTransfer.approved_at >= _parse_dt_start(start_date))
    if end_date:
        query = query.filter(InventoryTransfer.approved_at <= _parse_dt_end(end_date))

    transfers = query.order_by(InventoryTransfer.approved_at.desc()).all()

    rows = []
    for t in transfers:
        receipt = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
        if not receipt:
            continue
        if product_id and receipt.product_id != product_id:
            continue
        pname, pcode = _product_info(db, receipt.product_id)
        cname, ctype = _category_info(db, receipt.category_id)
        rows.append({
            "transfer_id": t.id,
            "ship_date": t.approved_at,
            "order_number": t.order_number,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "lot_number": receipt.lot_number,
            "cases": round(float(t.quantity or 0), 2),
            "unit": t.unit or "cases",
            "approved_by": _user_name(db, t.approved_by),
            "requested_by": _user_name(db, t.requested_by),
        })

    totals = {
        "shipment_count": len(rows),
        "total_cases": round(sum(r["cases"] for r in rows), 2),
    }

    return {"rows": rows, "totals": totals}


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
    pname, pcode = _product_info(db, product_id)
    receipts = db.query(Receipt).filter(Receipt.product_id == product_id).all()
    receipt_ids = [r.id for r in receipts]

    start_dt = _parse_dt_start(start_date) if start_date else None
    end_dt = _parse_dt_end(end_date) if end_date else None

    events = []

    # Receipts
    for r in receipts:
        ts = r.receipt_date or r.created_at
        if start_dt and ts and ts < start_dt:
            continue
        if end_dt and ts and ts > end_dt:
            continue
        cname, _ = _category_info(db, r.category_id)
        events.append({
            "timestamp": ts,
            "event_type": "Receipt",
            "lot_number": r.lot_number,
            "category": cname,
            "qty_in": _initial_receipt_qty(r, db),
            "qty_out": 0,
            "reference": r.bol or r.purchase_order or "",
            "notes": r.note or "",
            "by_user": _user_name(db, r.submitted_by),
        })

    # Transfers
    if receipt_ids:
        tq = db.query(InventoryTransfer).filter(
            InventoryTransfer.receipt_id.in_(receipt_ids),
            InventoryTransfer.status == TransferStatus.APPROVED,
        )
        for t in tq.all():
            ts = t.approved_at or t.submitted_at
            if start_dt and ts and ts < start_dt:
                continue
            if end_dt and ts and ts > end_dt:
                continue
            r = next((x for x in receipts if x.id == t.receipt_id), None)
            events.append({
                "timestamp": ts,
                "event_type": "Transfer" if t.transfer_type == "warehouse-transfer" else "Shipped Out" if t.transfer_type == "shipped-out" else "Staging",
                "lot_number": r.lot_number if r else "",
                "category": "",
                "qty_in": 0,
                "qty_out": round(float(t.quantity or 0), 2),
                "reference": t.order_number or "",
                "notes": t.reason or "",
                "by_user": _user_name(db, t.approved_by),
            })

    # Adjustments
    aq = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.product_id == product_id,
        InventoryAdjustment.status == AdjustmentStatus.APPROVED,
    )
    for a in aq.all():
        ts = a.approved_at or a.submitted_at
        if start_dt and ts and ts < start_dt:
            continue
        if end_dt and ts and ts > end_dt:
            continue
        events.append({
            "timestamp": ts,
            "event_type": f"Adjustment ({a.adjustment_type})",
            "lot_number": "",
            "category": "",
            "qty_in": 0,
            "qty_out": round(float(a.quantity or 0), 2),
            "reference": "",
            "notes": a.reason or "",
            "by_user": _user_name(db, a.approved_by),
        })

    events.sort(key=lambda e: (e["timestamp"] or datetime.min))

    # Running balance
    balance = 0.0
    for e in events:
        balance += e["qty_in"] - e["qty_out"]
        e["running_balance"] = round(balance, 2)

    return {
        "product_id": product_id,
        "product_name": pname,
        "product_code": pcode,
        "events": events,
    }


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
    receipts = db.query(Receipt).filter(
        Receipt.lot_number.ilike(f"%{lot_number}%")
    ).all()

    if not receipts:
        return {"lot_number": lot_number, "receipts": []}

    result = []
    for r in receipts:
        pname, pcode = _product_info(db, r.product_id)
        cname, ctype = _category_info(db, r.category_id)
        vname = _vendor_name(db, r.vendor_id)

        transfers = db.query(InventoryTransfer).filter(
            InventoryTransfer.receipt_id == r.id,
            InventoryTransfer.status == TransferStatus.APPROVED,
        ).order_by(InventoryTransfer.approved_at).all()

        adjustments = db.query(InventoryAdjustment).filter(
            InventoryAdjustment.receipt_id == r.id,
            InventoryAdjustment.status == AdjustmentStatus.APPROVED,
        ).order_by(InventoryAdjustment.approved_at).all()

        holds = db.query(InventoryHoldAction).filter(
            InventoryHoldAction.receipt_id == r.id,
            InventoryHoldAction.status == HoldStatus.APPROVED,
        ).order_by(InventoryHoldAction.approved_at).all()

        initial_qty = _initial_receipt_qty(r, db)

        def _loc_str(loc, subloc):
            parts = [l for l in [loc.name if loc else None, subloc.name if subloc else None] if l]
            return " › ".join(parts) if parts else None

        timeline = []
        timeline.append({
            "event": "Received",
            "event_type": "received",
            "date": r.receipt_date or r.created_at,
            "qty": round(initial_qty, 2),
            "notes": None,
            "submitted_by": _user_name(db, r.submitted_by),
            "submitted_at": r.submitted_at,
            "approved_by": _user_name(db, r.approved_by),
            "approved_at": r.approved_at,
            "purchase_order": r.purchase_order,
            "bol": r.bol,
            "from_location": None,
            "from_rows": [],
            "to_location": _loc_str(r.location, r.sub_location),
            "to_rows": _receipt_initial_rows(r, db),
            "order_number": None,
            "recipient": None,
        })
        for t in transfers:
            timeline.append({
                "event": t.transfer_type.replace("-", " ").title(),
                "event_type": t.transfer_type,
                "date": t.approved_at,
                "qty": round(float(t.quantity or 0), 2),
                "notes": t.reason or None,
                "submitted_by": _user_name(db, t.requested_by),
                "submitted_at": t.submitted_at,
                "approved_by": _user_name(db, t.approved_by),
                "approved_at": t.approved_at,
                "from_location": _loc_str(t.from_location, t.from_sub_location),
                "from_rows": _breakdown_rows(db, t.source_breakdown, r.unit or "cases"),
                "to_location": _loc_str(t.to_location, t.to_sub_location),
                "to_rows": _breakdown_rows(db, t.destination_breakdown, r.unit or "cases"),
                "order_number": t.order_number,
                "purchase_order": None,
                "bol": None,
                "recipient": None,
            })
        for a in adjustments:
            timeline.append({
                "event": a.adjustment_type.replace("-", " ").title(),
                "event_type": a.adjustment_type,
                "date": a.approved_at,
                "qty": round(float(a.quantity or 0), 2),
                "notes": a.reason or None,
                "submitted_by": _user_name(db, a.submitted_by),
                "submitted_at": a.submitted_at,
                "approved_by": _user_name(db, a.approved_by),
                "approved_at": a.approved_at,
                "from_location": None,
                "from_rows": [],
                "to_location": None,
                "to_rows": [],
                "order_number": None,
                "purchase_order": None,
                "bol": None,
                "recipient": a.recipient,
            })
        for h in holds:
            timeline.append({
                "event": f"Hold {h.action.title()}",
                "event_type": f"hold-{h.action}",
                "date": h.approved_at,
                "qty": h.total_quantity or 0,
                "notes": h.reason or None,
                "submitted_by": _user_name(db, h.submitted_by),
                "submitted_at": h.submitted_at,
                "approved_by": _user_name(db, h.approved_by),
                "approved_at": h.approved_at,
                "from_location": None,
                "from_rows": [],
                "to_location": None,
                "to_rows": [],
                "order_number": None,
                "purchase_order": None,
                "bol": None,
                "recipient": None,
            })

        timeline.sort(key=lambda e: (e["date"] or datetime.min))

        result.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "vendor_name": vname,
            "receipt_date": r.receipt_date,
            "production_date": r.production_date,
            "expiration_date": r.expiration_date,
            "initial_quantity": round(initial_qty, 2),
            "current_quantity": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "status": r.status,
            "on_hold": r.hold,
            "submitted_by": _user_name(db, r.submitted_by),
            "approved_by": _user_name(db, r.approved_by),
            "submitted_at": r.submitted_at,
            "approved_at": r.approved_at,
            "purchase_order": r.purchase_order,
            "bol": r.bol,
            "timeline": timeline,
        })

    return {"lot_number": lot_number, "receipts": result}


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
    query = db.query(InventoryHoldAction).filter(
        InventoryHoldAction.status == HoldStatus.APPROVED
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryHoldAction.warehouse_id == wh_id)
    if start_date:
        query = query.filter(InventoryHoldAction.approved_at >= _parse_dt_start(start_date))
    if end_date:
        query = query.filter(InventoryHoldAction.approved_at <= _parse_dt_end(end_date))
    if action and action != "all":
        query = query.filter(InventoryHoldAction.action == action)

    hold_actions = query.order_by(InventoryHoldAction.approved_at.desc()).all()

    rows = []
    for h in hold_actions:
        receipt = db.query(Receipt).filter(Receipt.id == h.receipt_id).first()
        if not receipt:
            continue
        if product_id and receipt.product_id != product_id:
            continue
        pname, pcode = _product_info(db, receipt.product_id)
        rows.append({
            "hold_id": h.id,
            "action_date": h.approved_at,
            "action": h.action,
            "product_name": pname,
            "product_code": pcode,
            "lot_number": receipt.lot_number,
            "quantity": h.total_quantity or receipt.quantity,
            "reason": h.reason,
            "submitted_by": _user_name(db, h.submitted_by),
            "approved_by": _user_name(db, h.approved_by),
            "hold_location": receipt.hold_location,
            "current_hold_status": receipt.hold,
        })

    return {
        "rows": rows,
        "totals": {
            "holds": sum(1 for r in rows if r["action"] == "hold"),
            "releases": sum(1 for r in rows if r["action"] == "release"),
        },
    }


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
    fg_cat_ids = [c.id for c in db.query(Category).filter(Category.parent_id == "group-finished").all()]
    if not fg_cat_ids:
        fg_cat_ids = [c.id for c in db.query(Category).filter(Category.type == CATEGORY_FINISHED).all()]

    if not fg_cat_ids:
        return {"rows": [], "daily": [], "totals": {}}

    query = db.query(Receipt).filter(
        Receipt.category_id.in_(fg_cat_ids),
        Receipt.status.notin_(["rejected"]),
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)
    if start_date:
        query = query.filter(Receipt.production_date >= _parse_dt_start(start_date))
    if end_date:
        query = query.filter(Receipt.production_date <= _parse_dt_end(end_date))
    if product_id:
        query = query.filter(Receipt.product_id == product_id)

    receipts = query.order_by(Receipt.production_date.asc()).all()

    # Per-receipt rows
    rows = []
    for r in receipts:
        pname, pcode = _product_info(db, r.product_id)
        initial_qty = _initial_receipt_qty(r, db)
        shipped_total = sum(
            float(t.quantity or 0)
            for t in db.query(InventoryTransfer).filter(
                InventoryTransfer.receipt_id == r.id,
                InventoryTransfer.transfer_type == "shipped-out",
                InventoryTransfer.status == TransferStatus.APPROVED,
            ).all()
        )
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "production_date": r.production_date,
            "receipt_date": r.receipt_date,
            "cases_produced": round(initial_qty, 2),
            "cases_shipped": round(shipped_total, 2),
            "cases_on_hand": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "status": r.status,
        })

    # Daily aggregation
    daily_map: dict = {}
    for r in rows:
        prod_date = r["production_date"]
        if not prod_date:
            continue
        day_key = prod_date.date().isoformat() if hasattr(prod_date, "date") else str(prod_date)[:10]
        if day_key not in daily_map:
            daily_map[day_key] = {"date": day_key, "cases_produced": 0, "cases_shipped": 0, "cases_on_hand": 0}
        daily_map[day_key]["cases_produced"] += r["cases_produced"]
        daily_map[day_key]["cases_shipped"] += r["cases_shipped"]
        daily_map[day_key]["cases_on_hand"] += r["cases_on_hand"]

    daily = sorted(daily_map.values(), key=lambda d: d["date"])

    return {
        "rows": rows,
        "daily": daily,
        "totals": {
            "total_produced": round(sum(r["cases_produced"] for r in rows), 2),
            "total_shipped": round(sum(r["cases_shipped"] for r in rows), 2),
            "total_on_hand": round(sum(r["cases_on_hand"] for r in rows), 2),
        },
    }


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
    query = db.query(Receipt).filter(
        Receipt.quantity > 0,
        Receipt.status.notin_(["depleted", "rejected"]),
        Receipt.expiration_date.isnot(None),
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)
    if product_id:
        query = query.filter(Receipt.product_id == product_id)
    if category_type:
        cat_ids = [c.id for c in db.query(Category).filter(Category.type == category_type).all()]
        if cat_ids:
            query = query.filter(Receipt.category_id.in_(cat_ids))

    receipts = query.order_by(Receipt.expiration_date.asc()).all()

    today = datetime.now(timezone.utc)
    rows = []
    for r in receipts:
        if not r.expiration_date:
            continue
        exp_dt = r.expiration_date
        days_until = (exp_dt - today).days

        if not include_expired and days_until < 0:
            continue
        if days_ahead is not None and days_until > days_ahead:
            continue

        if days_until < 0:
            bucket = "expired"
        elif days_until <= 30:
            bucket = "0-30 days"
        elif days_until <= 60:
            bucket = "31-60 days"
        elif days_until <= 90:
            bucket = "61-90 days"
        else:
            bucket = "90+ days"

        pname, pcode = _product_info(db, r.product_id)
        cname, ctype = _category_info(db, r.category_id)
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "expiration_date": exp_dt,
            "days_until_expiry": days_until,
            "urgency_bucket": bucket,
            "quantity": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "on_hold": r.hold,
        })

    bucket_order = ["expired", "0-30 days", "31-60 days", "61-90 days", "90+ days"]
    rows.sort(key=lambda x: (bucket_order.index(x["urgency_bucket"]), x["expiration_date"] or datetime.max))

    bucket_summary: dict = {}
    for r in rows:
        b = r["urgency_bucket"]
        if b not in bucket_summary:
            bucket_summary[b] = {"lots": 0, "quantity": 0}
        bucket_summary[b]["lots"] += 1
        bucket_summary[b]["quantity"] += r["quantity"]

    return {"rows": rows, "buckets": bucket_summary}


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
    query = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.status == AdjustmentStatus.APPROVED
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryAdjustment.warehouse_id == wh_id)
    if start_date:
        query = query.filter(InventoryAdjustment.approved_at >= _parse_dt_start(start_date))
    if end_date:
        query = query.filter(InventoryAdjustment.approved_at <= _parse_dt_end(end_date))
    if adjustment_type and adjustment_type != "all":
        query = query.filter(InventoryAdjustment.adjustment_type == adjustment_type)
    if product_id:
        query = query.filter(InventoryAdjustment.product_id == product_id)

    adjustments = query.order_by(InventoryAdjustment.approved_at.desc()).all()

    rows = []
    for a in adjustments:
        pname, pcode = _product_info(db, a.product_id)
        cname, _ = _category_info(db, a.category_id)
        receipt = db.query(Receipt).filter(Receipt.id == a.receipt_id).first()
        rows.append({
            "adjustment_id": a.id,
            "date": a.approved_at,
            "adjustment_type": a.adjustment_type,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "lot_number": receipt.lot_number if receipt else "",
            "quantity": round(float(a.quantity or 0), 2),
            "qty_before": a.original_quantity,
            "qty_after": a.new_quantity,
            "reason": a.reason,
            "submitted_by": _user_name(db, a.submitted_by),
            "approved_by": _user_name(db, a.approved_by),
        })

    type_summary: dict = {}
    for r in rows:
        t = r["adjustment_type"]
        type_summary[t] = type_summary.get(t, 0) + r["quantity"]

    return {
        "rows": rows,
        "totals": {
            "count": len(rows),
            "total_quantity": round(sum(r["quantity"] for r in rows), 2),
            "by_type": {k: round(v, 2) for k, v in type_summary.items()},
        },
    }


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
    query = db.query(Receipt)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(Receipt.warehouse_id == wh_id)
    if start_date:
        query = query.filter(Receipt.receipt_date >= _parse_dt_start(start_date))
    if end_date:
        query = query.filter(Receipt.receipt_date <= _parse_dt_end(end_date))
    if vendor_id:
        if vendor_id == "none":
            query = query.filter(Receipt.vendor_id.is_(None))
        else:
            query = query.filter(Receipt.vendor_id == vendor_id)

    receipts = query.order_by(Receipt.receipt_date.desc()).all()

    rows = []
    for r in receipts:
        pname, pcode = _product_info(db, r.product_id)
        cname, _ = _category_info(db, r.category_id)
        vname = _vendor_name(db, r.vendor_id)
        rows.append({
            "receipt_id": r.id,
            "receipt_date": r.receipt_date,
            "vendor_id": r.vendor_id,
            "vendor_name": vname or "No Vendor",
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "lot_number": r.lot_number,
            "quantity": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "bol": r.bol,
            "purchase_order": r.purchase_order,
            "status": r.status,
        })

    vendor_summary: dict = {}
    for r in rows:
        v = r["vendor_name"]
        if v not in vendor_summary:
            vendor_summary[v] = {"receipts": 0, "quantity": 0}
        vendor_summary[v]["receipts"] += 1
        vendor_summary[v]["quantity"] += r["quantity"]

    return {"rows": rows, "by_vendor": vendor_summary}


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
    query = db.query(CycleCount)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(CycleCount.warehouse_id == wh_id)
    # count_date is stored as a string (YYYY-MM-DD)
    if start_date:
        query = query.filter(CycleCount.count_date >= start_date)
    if end_date:
        query = query.filter(CycleCount.count_date <= end_date)
    if location_id:
        query = query.filter(CycleCount.location_id == location_id)

    counts = query.order_by(CycleCount.count_date.desc()).all()

    rows = []
    for c in counts:
        location = db.query(Location).filter(Location.id == c.location_id).first() if c.location_id else None
        items = c.items if isinstance(c.items, list) else []
        for item in items:
            product_id = item.get("productId") or item.get("product_id")
            pname, pcode = _product_info(db, product_id)
            system_count = item.get("systemCount") or item.get("system_count")
            actual_count = item.get("actualCount") or item.get("actual_count")
            variance = None
            variance_pct = None
            if system_count is not None and actual_count is not None:
                variance = float(actual_count) - float(system_count)
                if float(system_count) != 0:
                    variance_pct = round(variance / float(system_count) * 100, 1)

            rows.append({
                "count_id": c.id,
                "count_date": c.count_date,
                "product_name": pname,
                "product_code": pcode,
                "location": location.name if location else c.location_id,
                "system_count": system_count,
                "actual_count": actual_count,
                "variance": round(variance, 2) if variance is not None else None,
                "variance_pct": variance_pct,
                "counted_by": c.performed_by,
                "notes": item.get("notes") or "",
            })

    total_variance = sum(r["variance"] for r in rows if r["variance"] is not None)
    rows_with_variance = [r for r in rows if r["variance"] is not None and abs(r["variance"]) > 0]

    return {
        "rows": rows,
        "totals": {
            "count_events": len(counts),
            "item_rows": len(rows),
            "total_variance": round(total_variance, 2),
            "rows_with_discrepancy": len(rows_with_variance),
        },
    }
