"""
Report query builders and aggregation helpers.

Each public function accepts a db session, filter parameters, and an optional
warehouse_id, then returns a plain dict ready for the router to return as JSON.
"""

from typing import List, Optional
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models import (
    Receipt, InventoryTransfer, InventoryTransferLine, InventoryAdjustment, InventoryHoldAction,
    Category, Product, Vendor, User, CycleCount, Location, SubLocation, StorageRow,
    InterWarehouseTransfer, Warehouse, PalletLicence,
)
from app.enums import (
    TransferStatus, AdjustmentStatus, HoldStatus, InterWarehouseStatus, ReceiptStatus,
    ShipOutLifecycle,
)
from app.constants import CATEGORY_FINISHED
from app.services.availability import container_qty_for_product
from app.utils.calendar_dates import calendar_day
from app.utils.warehouse_time import DEFAULT_WAREHOUSE_TIMEZONE, warehouse_timezone, zone

# A ship-out order counts as a COMPLETED shipment for display reports once it's
# an approved legacy ad-hoc order OR a scheduled order whose BOL was generated
# (locked). The scheduled flow (2026-07 cutover) never sets
# status='approved'/approved_at, so reports keyed only on those miss every
# scheduled shipment.
SHIPPED_OUT_DONE_STATUSES = [
    TransferStatus.APPROVED.value,
    ShipOutLifecycle.DOCS_GENERATED.value,
    ShipOutLifecycle.COMPLETE.value,
]

# Statuses where a ship-out has already REMOVED cases from stock — used to
# reconstruct historical / original receipt quantities (which add shipped cases
# back to the live, already-decremented receipt.quantity). Stock leaves at SCAN
# time (scan_pick_v2 decrements receipt.quantity), so this set starts at
# 'scanning', earlier than the "completed" set above. 'approved' covers legacy.
SHIPPED_OUT_STOCK_REMOVED_STATUSES = [
    TransferStatus.APPROVED.value,
    ShipOutLifecycle.SCANNING.value,
    ShipOutLifecycle.RECONCILED.value,
    ShipOutLifecycle.DOCS_GENERATED.value,
    ShipOutLifecycle.COMPLETE.value,
]



_AWARE_MIN = datetime.min.replace(tzinfo=timezone.utc)


def _sort_dt(value):
    """Sort key for timelines mixing aware datetimes, naive ones and None.
    `x or datetime.min` compared a naive minimum with aware timestamps and
    500'd the lot trace (the recall report) for any lot consumed through
    staging, whose auto-made adjustment had no approved_at (2026-10-01)."""
    if value is None:
        return _AWARE_MIN
    if not isinstance(value, datetime):
        value = datetime(value.year, value.month, value.day)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value

def _ship_ts_col():
    """SQL expression for a ship-out's ship timestamp across both flows: legacy
    orders stamp approved_at; scheduled orders stamp time_out / docs_generated_at
    (never approved_at)."""
    return func.coalesce(
        InventoryTransfer.time_out,
        InventoryTransfer.docs_generated_at,
        InventoryTransfer.approved_at,
    )


def _ship_dt(t):
    """Python-side ship timestamp for a loaded transfer (mirror of _ship_ts_col)."""
    return t.time_out or t.docs_generated_at or t.approved_at


# ─────────────────────────────────────────────────────────────────────────────
# Low-level lookup helpers
# ─────────────────────────────────────────────────────────────────────────────

# A report day is the WAREHOUSE's day, not UTC's. Before 2026-10 these helpers
# pinned both ends to UTC midnight, so in an America/New_York plant anything
# that happened after 8 PM (EDT) fell into "tomorrow": a truck received at
# 20:13 vanished from today's Activity Ledger and Vendor Receipts.
#
# Only INSTANT columns (receipt_date, approved_at, ship timestamps) go through
# these. Calendar fields (best-by, FG production_date, cycle-count count_date)
# are stored as the typed day and are filtered as such — never shifted.
DEFAULT_REPORT_TIMEZONE = DEFAULT_WAREHOUSE_TIMEZONE
_zone = zone


def report_timezone(db: Session, warehouse_id: Optional[str] = None,
                    fallback_warehouse_id: Optional[str] = None) -> str:
    """The timezone whose calendar days a report's date filters mean.

    The filtered warehouse's timezone; else the viewer's own warehouse (a
    corporate user looking at "All Warehouses"); else, if every active
    warehouse agrees on one timezone, that one; else the Warehouse default.
    """
    for wid in (warehouse_id, fallback_warehouse_id):
        tz = warehouse_timezone(db, wid)
        if tz:
            return tz
    zones = {
        z for (z,) in db.query(Warehouse.timezone)
        .filter(Warehouse.is_active.isnot(False)).distinct().all() if z
    }
    if len(zones) == 1:
        return zones.pop()
    return DEFAULT_REPORT_TIMEZONE


def parse_dt_start(d: str, tz_name: Optional[str] = None) -> datetime:
    """First instant of local day `d` (YYYY-MM-DD) in `tz_name`, as UTC."""
    day = datetime.strptime(d, "%Y-%m-%d")
    return day.replace(tzinfo=_zone(tz_name)).astimezone(timezone.utc)


def parse_dt_end(d: str, tz_name: Optional[str] = None) -> datetime:
    """Last instant of local day `d` in `tz_name`, as UTC (inclusive bound)."""
    day = datetime.strptime(d, "%Y-%m-%d")
    nxt = (day + timedelta(days=1)).replace(tzinfo=_zone(tz_name))
    return nxt.astimezone(timezone.utc) - timedelta(microseconds=1)


def parse_calendar_start(d: str) -> datetime:
    """Start of a CALENDAR day (stored as midnight UTC) — no zone shift."""
    return datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def parse_calendar_end(d: str) -> datetime:
    dt = datetime.strptime(d, "%Y-%m-%d")
    return dt.replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)


def local_today(tz_name: Optional[str] = None):
    return datetime.now(_zone(tz_name)).date()


def product_info(db: Session, product_id: Optional[str]):
    if not product_id:
        return "Unknown", ""
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        return "Unknown", ""
    code = p.fcc_code or p.sid or p.short_code or ""
    return p.name or "Unknown", code


def category_info(db: Session, category_id: Optional[str]):
    if not category_id:
        return "Unknown", None
    c = db.query(Category).filter(Category.id == category_id).first()
    if not c:
        return "Unknown", None
    return c.name or "Unknown", c.type


def vendor_name(db: Session, vendor_id: Optional[str]) -> Optional[str]:
    if not vendor_id:
        return None
    v = db.query(Vendor).filter(Vendor.id == vendor_id).first()
    return v.name if v else None


def user_name(db: Session, user_id: Optional[str]) -> Optional[str]:
    if not user_id:
        return None
    u = db.query(User).filter(User.id == user_id).first()
    return u.name if u else None


def resolve_row_name(db: Session, row_key: str) -> str:
    """Given 'row-{id}' or 'floor', return the storage row name."""
    if not row_key or row_key == "floor":
        return "Floor"
    row_id = row_key.replace("row-", "", 1)
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    return row.name if row else row_key


def breakdown_rows(db: Session, breakdown, unit: str = "cases") -> list:
    """Convert a source/destination breakdown JSON into list of {row, qty} dicts."""
    if not breakdown or not isinstance(breakdown, list):
        return []
    rows = []
    for item in breakdown:
        row_name = resolve_row_name(db, item.get("id", ""))
        qty = round(float(item.get("quantity", 0)), 2)
        rows.append({"row": row_name, "qty": qty, "unit": unit})
    return rows


def receipt_initial_rows(receipt, db: Session) -> list:
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


def _shipped_cases_for_receipt(
    db: Session,
    receipt_id: str,
    approved_after: Optional[datetime] = None,
) -> float:
    """Sum cases shipped from a receipt across BOTH legacy single-receipt ship-outs
    AND new multi-product ship-out lines. Optionally filtered to approvals after a
    given timestamp.
    """
    legacy_q = db.query(InventoryTransfer).filter(
        InventoryTransfer.receipt_id == receipt_id,
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status.in_(SHIPPED_OUT_STOCK_REMOVED_STATUSES),
    )
    if approved_after is not None:
        legacy_q = legacy_q.filter(_ship_ts_col() > approved_after)
    legacy_total = sum(float(t.quantity or 0) for t in legacy_q.all())

    line_q = (
        db.query(InventoryTransferLine, InventoryTransfer)
        .join(InventoryTransfer, InventoryTransfer.id == InventoryTransferLine.transfer_id)
        .filter(
            InventoryTransferLine.receipt_id == receipt_id,
            InventoryTransfer.transfer_type == "shipped-out",
            InventoryTransfer.status.in_(SHIPPED_OUT_STOCK_REMOVED_STATUSES),
        )
    )
    if approved_after is not None:
        line_q = line_q.filter(_ship_ts_col() > approved_after)
    line_total = sum(float(ln.cases_picked or 0) for ln, _t in line_q.all())

    return legacy_total + line_total


def qty_on_date(receipt: Receipt, as_of_dt: datetime, db: Session) -> float:
    """Reconstruct quantity for a receipt as of a specific datetime."""
    shipped_after = _shipped_cases_for_receipt(db, receipt.id, approved_after=as_of_dt)

    # Includes Finished Goods adjustments, which carry no receipt_id — without
    # them an as-of-date snapshot understated FG stock by everything that had
    # been adjusted away since.
    adj_after = approved_adjustments_for_receipt(db, receipt, approved_after=as_of_dt)

    return (
        float(receipt.quantity or 0)
        + shipped_after
        + sum(float(a.quantity or 0) for a in adj_after)
    )


def approved_adjustments_for_receipt(
    db: Session,
    receipt: Receipt,
    approved_after: Optional[datetime] = None,
) -> list:
    """Every approved adjustment that drew this receipt down.

    Lot-based (raw material / packaging) adjustments carry `receipt_id`.
    Pallet-based (Finished Goods) ones do not: the form sends
    `pallet_licence_ids` *instead of* a receipt (InventoryContext.jsx:664) and
    the router never derives one, so every FG adjustment row has receipt_id
    NULL. Approval still decrements the correct receipt — adjustment_service
    reaches it through `pallet.receipt_id` — so on-hand was always right, but
    the reports only ever looked at the column. A donated FG lot therefore
    reported "Initial Qty 0" and showed no donation on its timeline, which read
    as though the adjustment had wiped the lot out.

    Reaching them through their pallets repairs lots already adjusted, with no
    migration. Collected by id so an adjustment found down both paths is
    counted once — that keeps this correct if `receipt_id` is later populated
    at creation time.

    `approved_after` narrows to adjustments approved after a timestamp, for
    reconstructing what a receipt held on a past date.
    """
    def _restrict(q):
        q = q.filter(InventoryAdjustment.status == AdjustmentStatus.APPROVED)
        if approved_after is not None:
            q = q.filter(InventoryAdjustment.approved_at > approved_after)
        return q

    found = {
        a.id: a
        for a in _restrict(
            db.query(InventoryAdjustment).filter(
                InventoryAdjustment.receipt_id == receipt.id,
            )
        ).all()
    }

    # pallet_licence_ids is a JSON array, so the intersection is resolved in
    # Python. Scoped to this receipt's product to keep the candidate set small.
    pallet_ids = {
        row[0] for row in db.query(PalletLicence.id).filter(
            PalletLicence.receipt_id == receipt.id
        ).all()
    }
    if pallet_ids:
        candidates = _restrict(
            db.query(InventoryAdjustment).filter(
                InventoryAdjustment.receipt_id.is_(None),
                InventoryAdjustment.product_id == receipt.product_id,
            )
        ).all()
        for a in candidates:
            if any(pid in pallet_ids for pid in (a.pallet_licence_ids or [])):
                found[a.id] = a

    return list(found.values())



_PRODUCTION_USE_TYPES = frozenset({"production-consumption", "used-in-production"})


def _receiptless_placement_qty(db: Session, product_id: str) -> float:
    """Weight on racks for lots of this product that have no receipt — the
    cutover opening balances. Every other lot is counted through its paper."""
    from app.models import LotPlacement, MaterialLot

    has_receipt = db.query(Receipt.id).filter(
        Receipt.material_lot_id == MaterialLot.id
    ).exists()
    rows = (
        db.query(LotPlacement, MaterialLot)
        .join(MaterialLot, MaterialLot.id == LotPlacement.material_lot_id)
        .filter(MaterialLot.product_id == product_id, ~has_receipt)
        .all()
    )
    return sum(
        int(p.full_units or 0) * float(lot.weight_per_unit or 0)
        + float(p.open_remaining_qty or 0)
        for p, lot in rows
    )

def initial_receipt_qty(receipt: Receipt, db: Session) -> float:
    """Estimate the original quantity when the receipt was first created."""
    # A receipt that recorded what arrived (drums × lbs per drum) says so
    # directly. Rebuilding it from the adjustments booked to THIS receipt is
    # wrong for a multi-truck lot: consumption spills across the trucks, so
    # one read as having delivered 5,800 lb and the other 4,240 when each
    # brought 5,020 (2026-10-01 e2e).
    count = float(receipt.container_count or 0)
    per = float(receipt.weight_per_container or 0)
    if count > 0 and per > 0:
        return count * per
    shipped = _shipped_cases_for_receipt(db, receipt.id, approved_after=None)
    adjs = approved_adjustments_for_receipt(db, receipt)
    # Inter-warehouse transfers where this receipt was the source
    iw_transfers = db.query(InterWarehouseTransfer).filter(
        InterWarehouseTransfer.source_receipt_id == receipt.id,
        InterWarehouseTransfer.status.in_([
            InterWarehouseStatus.RECEIVED,
            InterWarehouseStatus.COMPLETED,
        ]),
    ).all()
    return (
        float(receipt.quantity or 0)
        + shipped
        + sum(float(a.quantity or 0) for a in adjs)
        + sum(float(iwt.quantity or 0) for iwt in iw_transfers)
    )


def _category_ids_for_type(db: Session, category_type: str) -> list[str]:
    """Return list of category IDs matching a given category type."""
    return [c.id for c in db.query(Category).filter(Category.type == category_type).all()]


def _loc_str(loc, subloc) -> Optional[str]:
    parts = [l for l in [loc.name if loc else None, subloc.name if subloc else None] if l]
    return " \u203a ".join(parts) if parts else None


# ─────────────────────────────────────────────────────────────────────────────
# 1. Point-in-Time Inventory Snapshot
# ─────────────────────────────────────────────────────────────────────────────

def build_point_in_time_snapshot(
    db: Session,
    as_of_date: str,
    warehouse_id: Optional[str] = None,
    product_id: Optional[str] = None,
    category_id: Optional[str] = None,
    category_type: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    as_of_dt = parse_dt_end(as_of_date, tz or report_timezone(db, warehouse_id))

    query = db.query(Receipt).filter(
        Receipt.receipt_date <= as_of_dt,
        Receipt.status.in_([ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED]),
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    if product_id:
        query = query.filter(Receipt.product_id == product_id)
    if category_id:
        query = query.filter(Receipt.category_id == category_id)
    if category_type:
        cat_ids = _category_ids_for_type(db, category_type)
        if not cat_ids:
            return {"as_of_date": as_of_date, "rows": [], "totals": {}}
        query = query.filter(Receipt.category_id.in_(cat_ids))

    receipts = query.all()
    rows = []
    for r in receipts:
        qty = qty_on_date(r, as_of_dt, db)
        if qty <= 0:
            continue
        pname, pcode = product_info(db, r.product_id)
        cname, ctype = category_info(db, r.category_id)
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_id": r.product_id,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "vendor_name": vendor_name(db, r.vendor_id),
            "receipt_date": r.receipt_date,
            "production_date": r.production_date,
            "expiration_date": calendar_day(r.expiration_date),
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
# 2. Activity Ledger
# ─────────────────────────────────────────────────────────────────────────────

def build_activity_ledger(
    db: Session,
    start_date: str,
    end_date: str,
    product_id: Optional[str] = None,
    category_id: Optional[str] = None,
    category_type: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    tz = tz or report_timezone(db)
    start_dt = parse_dt_start(start_date, tz)
    end_dt = parse_dt_end(end_date, tz)

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
        cat_ids = _category_ids_for_type(db, category_type)
        if cat_ids:
            rq = rq.filter(Receipt.category_id.in_(cat_ids))
    range_receipts = rq.all()
    for r in range_receipts:
        product_ids.add(r.product_id)

    # Ship-outs completed in range (covers both legacy single-receipt and
    # multi-product; ship date spans approved_at / time_out / docs_generated_at).
    tq = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
        _ship_ts_col() >= start_dt,
        _ship_ts_col() <= end_dt,
    )
    range_transfers = tq.all()
    for t in range_transfers:
        if t.receipt_id:
            r = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
            if r:
                product_ids.add(r.product_id)
        for ln in t.lines or []:
            if ln.product_id:
                product_ids.add(ln.product_id)

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
        pname, pcode = product_info(db, pid)

        # Find category from most recent receipt for this product
        sample_receipt = db.query(Receipt).filter(
            Receipt.product_id == pid
        ).order_by(Receipt.receipt_date.desc()).first()
        cname, ctype = category_info(db, sample_receipt.category_id if sample_receipt else None)

        # Skip if category filter doesn't match
        if category_id and sample_receipt and sample_receipt.category_id != category_id:
            continue
        if category_type and ctype != category_type:
            continue

        # Received in range: initial quantity of receipts created in range
        p_receipts = [r for r in range_receipts if r.product_id == pid]
        received = sum(initial_receipt_qty(r, db) for r in p_receipts)

        # Consumed in production. Production use is written as
        # production-consumption (staging mark-used / production sync) or
        # used-in-production (a desk write-off); counting only the first showed
        # 0 lb consumed with 7,306 lb used (2026-10-01).
        consumed = sum(
            float(a.quantity or 0)
            for a in range_adjustments
            if a.product_id == pid and a.adjustment_type in _PRODUCTION_USE_TYPES
        )

        # Shipped out (both legacy and multi-product paths)
        shipped = 0.0
        for t in range_transfers:
            if t.lines:
                for ln in t.lines:
                    if ln.product_id == pid:
                        shipped += float(ln.cases_picked or 0)
            elif t.receipt_id:
                r = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
                if r and r.product_id == pid:
                    shipped += float(t.quantity or 0)

        # Other adjustments (damage, donation, trash, quality-rejection, stock-correction)
        other_adj = sum(
            float(a.quantity or 0)
            for a in range_adjustments
            if a.product_id == pid and a.adjustment_type not in _PRODUCTION_USE_TYPES
        )

        # Current on hand. Legacy receipt quantity PLUS live serialized
        # containers, or an ingredient's on-hand would fall to zero in this
        # report as the cutover sweep converts drums (audit B4).
        #
        # The container term deliberately comes from container_qty_for_product
        # rather than on_hand_for_product: this sum has its own, looser legacy
        # semantics (any status, no warehouse scope, holds ignored), and
        # re-basing it onto the check-availability semantics would silently
        # change every existing number in this report. include_held=True matches
        # "holds ignored"; pending stays out because an unapproved intake is not
        # yet on the books.
        current_receipts = db.query(Receipt).filter(
            Receipt.product_id == pid,
            Receipt.quantity > 0,
        ).all()
        current_on_hand = sum(float(r.quantity or 0) for r in current_receipts)
        # Rack placements are NOT added on top: a lot-tracked lot is already in
        # the sum above through its receipts' paper (racked + staged), and
        # adding the racks again showed 13,500 lb for 6,750 on hand
        # (2026-10-01). Only a lot with no receipt at all — an opening balance
        # counted at cutover — is known solely by its placements.
        current_on_hand += container_qty_for_product(
            db, pid, include_held=True, include_placements=False
        )
        current_on_hand += _receiptless_placement_qty(db, pid)

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

def build_shipments_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    product_id: Optional[str] = None,
    order_number: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    order_number = (order_number or "").strip()
    # Ship timestamp works for both flows: legacy approved orders stamp
    # approved_at; scheduled orders stamp time_out (truck left) and/or
    # docs_generated_at (BOL printed) but never approved_at.
    ship_ts = func.coalesce(
        InventoryTransfer.time_out,
        InventoryTransfer.docs_generated_at,
        InventoryTransfer.approved_at,
    )
    query = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
    )
    if warehouse_id:
        query = query.filter(InventoryTransfer.warehouse_id == warehouse_id)
    # When searching by order number, ignore the date range so the order can be
    # pulled up regardless of when it shipped.
    if order_number:
        query = query.filter(InventoryTransfer.order_number.ilike(f"%{order_number}%"))
    else:
        if start_date:
            query = query.filter(ship_ts >= parse_dt_start(
                start_date, tz or report_timezone(db, warehouse_id)))
        if end_date:
            query = query.filter(ship_ts <= parse_dt_end(
                end_date, tz or report_timezone(db, warehouse_id)))

    transfers = query.order_by(ship_ts.desc()).all()

    rows = []
    for t in transfers:
        # Ship date + "approved by" per transfer, spanning both flows: scheduled
        # orders have no approver (approved_by is null) — the person who generated
        # the BOL (docs_generated_by) is the effective sign-off.
        ship_dt = t.time_out or t.docs_generated_at or t.approved_at
        approver = user_name(db, t.approved_by or getattr(t, "docs_generated_by", None))
        # Multi-product/multi-receipt ship-out: emit one row per line
        if t.lines:
            for ln in t.lines:
                # Skip lines that shipped nothing: scheduled-order planning lines
                # (receipt_id NULL) and drained drift sub-lines carry 0 picked
                # cases and would otherwise emit empty rows on a shipments report.
                if float(ln.cases_picked or 0) <= 0:
                    continue
                receipt = db.query(Receipt).filter(Receipt.id == ln.receipt_id).first()
                if not receipt:
                    continue
                if product_id and ln.product_id != product_id:
                    continue
                pname, pcode = product_info(db, ln.product_id)
                cname, ctype = category_info(db, receipt.category_id)
                rows.append({
                    "transfer_id": t.id,
                    "line_id": ln.id,
                    "ship_date": ship_dt,
                    "order_number": t.order_number,
                    "product_name": pname,
                    "product_code": pcode,
                    "category_name": cname,
                    "lot_number": receipt.lot_number,
                    "cases": round(float(ln.cases_picked or 0), 2),
                    "cases_requested": round(float(ln.cases_requested or 0), 2),
                    "unit": t.unit or "cases",
                    "approved_by": approver,
                    "requested_by": user_name(db, t.requested_by),
                    "is_multi_product": True,
                })
            continue

        # Legacy single-receipt ship-out
        if not t.receipt_id:
            continue
        receipt = db.query(Receipt).filter(Receipt.id == t.receipt_id).first()
        if not receipt:
            continue
        if product_id and receipt.product_id != product_id:
            continue
        pname, pcode = product_info(db, receipt.product_id)
        cname, ctype = category_info(db, receipt.category_id)
        rows.append({
            "transfer_id": t.id,
            "line_id": None,
            "ship_date": ship_dt,
            "order_number": t.order_number,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "lot_number": receipt.lot_number,
            "cases": round(float(t.quantity or 0), 2),
            "cases_requested": round(float(t.quantity or 0), 2),
            "unit": t.unit or "cases",
            "approved_by": approver,
            "requested_by": user_name(db, t.requested_by),
            "is_multi_product": False,
        })

    totals = {
        "shipment_count": len(rows),
        "total_cases": round(sum(r["cases"] for r in rows), 2),
    }

    return {"rows": rows, "totals": totals}


def build_shipment_detail(
    db: Session,
    transfer_id: str,
    warehouse_id: Optional[str] = None,
) -> Optional[dict]:
    """Full provenance for a single approved ship-out order: who created /
    approved it, plus every line with its pallet-level picks (licence number,
    origin rack, lot, cases, and the forklift worker who scanned each pallet)."""
    query = db.query(InventoryTransfer).filter(
        InventoryTransfer.id == transfer_id,
        InventoryTransfer.transfer_type == "shipped-out",
        InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
    )
    if warehouse_id:
        query = query.filter(InventoryTransfer.warehouse_id == warehouse_id)
    transfer = query.first()
    if not transfer:
        return None

    # Per-order lookup caches to avoid N+1 across many picks.
    row_name_cache: dict = {}
    user_name_cache: dict = {}
    pallet_cache: dict = {}

    def cached_row_name(row_id: Optional[str]) -> Optional[str]:
        if not row_id:
            return None
        if row_id not in row_name_cache:
            row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
            row_name_cache[row_id] = row.name if row else row_id
        return row_name_cache[row_id]

    def cached_user_name(user_id: Optional[str]) -> Optional[str]:
        if not user_id:
            return None
        if user_id not in user_name_cache:
            user_name_cache[user_id] = user_name(db, user_id)
        return user_name_cache[user_id]

    def cached_pallet(pallet_id: Optional[str]):
        if not pallet_id:
            return None
        if pallet_id not in pallet_cache:
            pallet_cache[pallet_id] = (
                db.query(PalletLicence).filter(PalletLicence.id == pallet_id).first()
            )
        return pallet_cache[pallet_id]

    # Aggregate the transfer's lines by PRODUCT, not by line. A single product
    # is often split into several lines: the FIFO suggestion proposes one line
    # per lot, and a forklift scanning a non-suggested lot adds a drift line.
    # We collapse them so each product shows once, with requested = sum of the
    # planned cases (across all its suggested lines) and shipped = what was
    # actually scanned. Un-scanned suggestion lots stop appearing as products;
    # they only feed the product's requested total. This is how "Short" is
    # surfaced: requested 500 / shipped 300 → short 200.
    products: dict = {}  # insertion-ordered (py3.7+): preserves line order
    pallet_count = 0
    sorted_lines = sorted(transfer.lines or [], key=lambda ln: (ln.line_seq or 0))
    for ln in sorted_lines:
        receipt = db.query(Receipt).filter(Receipt.id == ln.receipt_id).first()
        key = ln.product_id or f"line-{ln.id}"
        if key not in products:
            pname, pcode = product_info(db, ln.product_id)
            products[key] = {
                "product_id": ln.product_id,
                "product_name": pname,
                "product_code": pcode,
                "cases_requested": 0.0,
                "cases_picked": 0.0,
                "lots": [],
                "picks": [],
            }
        pr = products[key]
        pr["cases_requested"] += float(ln.cases_requested or 0)
        pr["cases_picked"] += float(ln.cases_picked or 0)

        for pk in (ln.picks or []):
            pallet = cached_pallet(pk.get("pallet_licence_id"))
            lot = (pallet.lot_number if pallet else None) or (receipt.lot_number if receipt else None)
            pr["picks"].append({
                "licence_number": pallet.licence_number if pallet else None,
                "lot_number": lot,
                "rack": cached_row_name(pk.get("storage_row_id")),
                "cases": round(float(pk.get("cases_consumed") or 0), 2),
                "was_partial": bool(pk.get("was_partial")),
                "scanned_by": cached_user_name(pk.get("scanned_by")),
                "scanned_at": pk.get("scanned_at"),
            })
            if lot and lot not in pr["lots"]:
                pr["lots"].append(lot)
            pallet_count += 1

    lines = []
    for pr in products.values():
        pr["picks"].sort(key=lambda p: p.get("scanned_at") or "")
        requested = round(pr["cases_requested"], 2)
        shipped = round(pr["cases_picked"], 2)
        lines.append({
            "product_id": pr["product_id"],
            "product_name": pr["product_name"],
            "product_code": pr["product_code"],
            "lots": pr["lots"],
            "cases_requested": requested,
            "cases_picked": shipped,
            "cases_short": round(max(0.0, requested - shipped), 2),
            "cases_over": round(max(0.0, shipped - requested), 2),
            "picks": pr["picks"],
        })

    total_requested = round(sum(l["cases_requested"] for l in lines), 2)
    total_shipped = round(sum(l["cases_picked"] for l in lines), 2)

    return {
        "transfer_id": transfer.id,
        "order_number": transfer.order_number,
        "created_by": user_name(db, transfer.requested_by),
        "created_at": transfer.submitted_at or transfer.created_at,
        # Scheduled orders have no approver — the BOL generator is the sign-off,
        # and the ship moment is time_out / docs_generated_at, not approved_at.
        "approved_by": user_name(db, transfer.approved_by or getattr(transfer, "docs_generated_by", None)),
        "approved_at": transfer.approved_at or transfer.time_out or transfer.docs_generated_at,
        "unit": transfer.unit or "cases",
        "totals": {
            "cases_requested": total_requested,
            "cases_picked": total_shipped,
            "cases_short": round(max(0.0, total_requested - total_shipped), 2),
            "cases_over": round(max(0.0, total_shipped - total_requested), 2),
            "product_count": len(lines),
            "pallet_count": pallet_count,
        },
        "lines": lines,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. Per-Product Movement Ledger
# ─────────────────────────────────────────────────────────────────────────────

def build_movement_ledger(
    db: Session,
    product_id: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    pname, pcode = product_info(db, product_id)
    receipts = db.query(Receipt).filter(Receipt.product_id == product_id).all()
    receipt_ids = [r.id for r in receipts]

    tz = tz or report_timezone(db)
    start_dt = parse_dt_start(start_date, tz) if start_date else None
    end_dt = parse_dt_end(end_date, tz) if end_date else None

    events = []

    # Receipts
    for r in receipts:
        ts = r.receipt_date or r.created_at
        if start_dt and ts and ts < start_dt:
            continue
        if end_dt and ts and ts > end_dt:
            continue
        cname, _ = category_info(db, r.category_id)
        events.append({
            "timestamp": ts,
            "event_type": "Receipt",
            "lot_number": r.lot_number,
            "category": cname,
            "qty_in": initial_receipt_qty(r, db),
            "qty_out": 0,
            "reference": r.bol or r.purchase_order or "",
            "notes": r.note or "",
            "by_user": user_name(db, r.submitted_by),
        })

    # Transfers — single-receipt (parent carries receipt_id): warehouse-transfer,
    # staging, and legacy single-receipt ship-outs.
    if receipt_ids:
        tq = db.query(InventoryTransfer).filter(
            InventoryTransfer.receipt_id.in_(receipt_ids),
            InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
        )
        for t in tq.all():
            ts = _ship_dt(t) or t.submitted_at
            if start_dt and ts and ts < start_dt:
                continue
            if end_dt and ts and ts > end_dt:
                continue
            r = next((x for x in receipts if x.id == t.receipt_id), None)
            # Only a ship-out leaves the building. A rack-to-rack move or a
            # pull to staging is still stock on hand (staged material leaves
            # the books when production's consumption adjustment lands), so
            # counting them as OUT drove the running balance negative
            # (2026-10-01 e2e). They stay listed, with the moved amount noted.
            leaves = t.transfer_type == "shipped-out"
            moved = round(float(t.quantity or 0), 2)
            notes = t.reason or ""
            if not leaves:
                notes = f"{notes} (moved {moved:g}, still on hand)".strip()
            events.append({
                "timestamp": ts,
                "event_type": (
                    "Transfer" if t.transfer_type == "warehouse-transfer"
                    else "Shipped Out" if leaves
                    else "Staging"
                ),
                "lot_number": r.lot_number if r else "",
                "category": "",
                "qty_in": 0,
                "qty_out": moved if leaves else 0,
                # The amount a move carried, kept out of in/out so the running
                # balance stays right but the line no longer reads "0 / 0".
                "qty_moved": 0 if leaves else moved,
                "reference": t.order_number or "",
                "notes": notes,
                "by_user": user_name(db, t.approved_by or getattr(t, "docs_generated_by", None)),
            })

        # Multi-product ship-outs draw from this product's receipts via their
        # LINES (the parent transfer's receipt_id is NULL). Without this, every
        # scheduled / multi-product shipment is invisible in the ledger.
        line_rows = (
            db.query(InventoryTransferLine, InventoryTransfer)
            .join(InventoryTransfer, InventoryTransfer.id == InventoryTransferLine.transfer_id)
            .filter(
                InventoryTransferLine.receipt_id.in_(receipt_ids),
                InventoryTransfer.transfer_type == "shipped-out",
                InventoryTransfer.receipt_id.is_(None),
                InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
            )
        )
        for ln, t in line_rows.all():
            if float(ln.cases_picked or 0) <= 0:
                continue
            ts = _ship_dt(t) or t.submitted_at
            if start_dt and ts and ts < start_dt:
                continue
            if end_dt and ts and ts > end_dt:
                continue
            r = next((x for x in receipts if x.id == ln.receipt_id), None)
            events.append({
                "timestamp": ts,
                "event_type": "Shipped Out",
                "lot_number": r.lot_number if r else "",
                "category": "",
                "qty_in": 0,
                "qty_out": round(float(ln.cases_picked or 0), 2),
                "reference": t.order_number or "",
                "notes": t.reason or "",
                "by_user": user_name(db, t.approved_by or getattr(t, "docs_generated_by", None)),
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
        # The lot the adjustment was booked to — the line said nothing about
        # WHICH lot lost the stock (2026-10-01).
        adj_receipt = next((x for x in receipts if x.id == a.receipt_id), None)
        events.append({
            "timestamp": ts,
            "event_type": f"Adjustment ({a.adjustment_type})",
            "lot_number": adj_receipt.lot_number if adj_receipt else "",
            "category": "",
            "qty_in": 0,
            "qty_out": round(float(a.quantity or 0), 2),
            "reference": "",
            "notes": a.reason or "",
            "by_user": user_name(db, a.approved_by),
        })

    events.sort(key=lambda e: _sort_dt(e["timestamp"]))

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

def build_lot_trace(db: Session, lot_number: str, warehouse_id: Optional[str] = None) -> dict:
    """Recall trace for a lot: legacy receipts AND serialized containers.

    This used to search `Receipt.lot_number` alone and return `{"receipts": []}`
    on no match. Serialized ingredient lots live on `intake_lots.vendor_lot` with
    no Receipt behind them, so QA asking "where did lot 389641 go" would get an
    empty result that reads as CLEAN rather than as UNSUPPORTED — and a
    half-converted lot would return only its unconverted half with nothing
    saying the answer was partial. On a recall that is the worst possible
    failure mode, so the response now always carries `coverage` naming exactly
    which sources were searched and what each returned.
    """
    query = db.query(Receipt).filter(
        Receipt.lot_number.ilike(f"%{lot_number}%")
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    receipts = query.all()

    # NOTE: no early return on an empty receipt set — the container side below
    # may still have the answer.
    result = []
    for r in receipts:
        pname, pcode = product_info(db, r.product_id)
        cname, ctype = category_info(db, r.category_id)
        vname = vendor_name(db, r.vendor_id)

        # "completed" is how staging pulls and staging returns are written;
        # without it material visibly left a rack for staging and came back
        # with nothing on the recall timeline (2026-10-01).
        legacy_transfers = db.query(InventoryTransfer).filter(
            InventoryTransfer.receipt_id == r.id,
            InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES + ["completed"]),
        ).order_by(_ship_ts_col()).all()

        # Multi-product ship-outs that drew from this receipt via their lines
        line_transfer_ids = [
            tid for (tid,) in db.query(InventoryTransferLine.transfer_id)
            .filter(InventoryTransferLine.receipt_id == r.id)
            .distinct()
            .all()
        ]
        multi_transfers = []
        if line_transfer_ids:
            multi_transfers = db.query(InventoryTransfer).filter(
                InventoryTransfer.id.in_(line_transfer_ids),
                InventoryTransfer.status.in_(SHIPPED_OUT_DONE_STATUSES),
                InventoryTransfer.receipt_id.is_(None),  # exclude legacy already captured
            ).order_by(_ship_ts_col()).all()
        # Combined, sorted by ship timestamp (approved_at for legacy, time_out /
        # docs_generated_at for scheduled).
        transfers = sorted(
            list(legacy_transfers) + list(multi_transfers),
            key=lambda t: _ship_dt(t) or datetime.min.replace(tzinfo=timezone.utc),
        )

        # Includes Finished Goods adjustments, which carry no receipt_id and so
        # never appeared on the timeline. The timeline is sorted by date below.
        adjustments = sorted(
            approved_adjustments_for_receipt(db, r),
            key=lambda a: (a.approved_at is None, _sort_dt(a.approved_at)),
        )

        holds = db.query(InventoryHoldAction).filter(
            InventoryHoldAction.receipt_id == r.id,
            InventoryHoldAction.status == HoldStatus.APPROVED,
        ).order_by(InventoryHoldAction.approved_at).all()

        iw_transfers = db.query(InterWarehouseTransfer).filter(
            InterWarehouseTransfer.source_receipt_id == r.id,
            InterWarehouseTransfer.status.in_([
                InterWarehouseStatus.RECEIVED,
                InterWarehouseStatus.COMPLETED,
            ]),
        ).order_by(InterWarehouseTransfer.received_at).all()

        init_qty = initial_receipt_qty(r, db)
        arrival = _arrival_rows(db, r)

        timeline = []
        timeline.append({
            "event": "Received",
            "event_type": "received",
            "date": r.receipt_date or r.created_at,
            "qty": round(init_qty, 2),
            "notes": None,
            "submitted_by": user_name(db, r.submitted_by),
            "submitted_at": r.submitted_at,
            "approved_by": user_name(db, r.approved_by),
            "approved_at": r.approved_at,
            "purchase_order": r.purchase_order,
            "bol": r.bol,
            "from_location": None,
            "from_rows": [],
            # Where the receiving scans actually put it, when the ledger says.
            # A walk-in or truck receipt carries no location of its own, so
            # deliveries 1, 3 and 4 of A-0925 showed no arrival at all while
            # delivery 2 (which had one) did (browser test PART 2, U11).
            "to_location": _arrival_location(db, arrival) or _loc_str(r.location, r.sub_location),
            "to_rows": arrival or receipt_initial_rows(r, db),
            "order_number": None,
            "recipient": None,
            "direction": "in",
        })
        for t in transfers:
            # For multi-product ship-outs, report only this receipt's portion (line.cases_picked)
            if t.lines and t.receipt_id is None:
                line_for_this_receipt = next((ln for ln in t.lines if ln.receipt_id == r.id), None)
                line_qty = float(line_for_this_receipt.cases_picked or 0) if line_for_this_receipt else 0.0
            else:
                line_qty = float(t.quantity or 0)
            timeline.append({
                "event": t.transfer_type.replace("-", " ").title(),
                "event_type": t.transfer_type,
                "date": _ship_dt(t),
                "qty": round(line_qty, 2),
                "notes": t.reason or None,
                "submitted_by": user_name(db, t.requested_by),
                "submitted_at": t.submitted_at,
                "approved_by": user_name(db, t.approved_by or getattr(t, "docs_generated_by", None)),
                "approved_at": _ship_dt(t),
                "from_location": _loc_str(t.from_location, t.from_sub_location),
                "from_rows": breakdown_rows(db, t.source_breakdown, r.unit or "cases"),
                "to_location": _loc_str(t.to_location, t.to_sub_location),
                "to_rows": breakdown_rows(db, t.destination_breakdown, r.unit or "cases"),
                "order_number": t.order_number,
                "purchase_order": None,
                "bol": None,
                "recipient": None,
                # Only a ship-out leaves stock. A rack move, a staging pull or a
                # return is the same material somewhere else; showing them as
                # minus made one truck's timeline sum to -4,518 lb.
                "direction": "out" if t.transfer_type == "shipped-out" else "move",
            })
        # Rejected requests moved nothing, but a recall reader still wants to
        # see that one was asked for and refused (browser test PART 2, U11).
        # No rejection timestamp is stored; the request time stands in, and the
        # rejecter's name is already in the reason ("[Rejected by …]: …").
        rejected = db.query(InventoryTransfer).filter(
            InventoryTransfer.receipt_id == r.id,
            InventoryTransfer.status == TransferStatus.REJECTED.value,
        ).order_by(InventoryTransfer.submitted_at).all()
        for t in rejected:
            label = "Shipped Out" if t.transfer_type == "shipped-out" else (
                (t.transfer_type or "transfer").replace("-", " ").title()
            )
            timeline.append({
                "event": f"{label} (rejected)",
                "event_type": "transfer-rejected",
                "date": t.submitted_at or t.created_at,
                "qty": round(float(t.quantity or 0), 2),
                "notes": t.reason or None,
                "submitted_by": user_name(db, t.requested_by),
                "submitted_at": t.submitted_at,
                "approved_by": None,
                "approved_at": None,
                "from_location": _loc_str(t.from_location, t.from_sub_location),
                "from_rows": breakdown_rows(db, t.source_breakdown, r.unit or "cases"),
                "to_location": _loc_str(t.to_location, t.to_sub_location),
                "to_rows": breakdown_rows(db, t.destination_breakdown, r.unit or "cases"),
                "order_number": t.order_number,
                "purchase_order": None,
                "bol": None,
                "recipient": None,
                # Nothing moved: neither in, out nor a move.
                "direction": "rejected",
                "rejected": True,
            })
        for a in adjustments:
            timeline.append({
                "event": a.adjustment_type.replace("-", " ").title(),
                "event_type": a.adjustment_type,
                "date": a.approved_at,
                "qty": round(abs(float(a.quantity or 0)), 2),
                "notes": a.reason or None,
                "submitted_by": user_name(db, a.submitted_by),
                "submitted_at": a.submitted_at,
                "approved_by": user_name(db, a.approved_by),
                "approved_at": a.approved_at,
                "from_location": None,
                "from_rows": [],
                "to_location": None,
                "to_rows": [],
                "order_number": None,
                "purchase_order": None,
                "bol": None,
                "recipient": a.recipient,
                # A negative quantity is a correction that put stock back.
                "direction": "in" if float(a.quantity or 0) < 0 else "out",
            })
        for h in holds:
            timeline.append({
                "event": f"Hold {h.action.title()}",
                "event_type": f"hold-{h.action}",
                "date": h.approved_at,
                "qty": h.total_quantity or 0,
                "direction": "none",
                "notes": h.reason or None,
                "submitted_by": user_name(db, h.submitted_by),
                "submitted_at": h.submitted_at,
                "approved_by": user_name(db, h.approved_by),
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
        for iwt in iw_transfers:
            to_wh = db.query(Warehouse).filter(Warehouse.id == iwt.to_warehouse_id).first()
            timeline.append({
                "event": "Inter-Warehouse Transfer",
                "event_type": "inter-warehouse-transfer",
                "direction": "out",
                "date": iwt.received_at or iwt.confirmed_at or iwt.initiated_at,
                "qty": round(float(iwt.quantity or 0), 2),
                "notes": iwt.notes or None,
                "submitted_by": user_name(db, iwt.initiated_by),
                "submitted_at": iwt.initiated_at,
                "approved_by": user_name(db, iwt.received_by),
                "approved_at": iwt.received_at,
                "from_location": None,
                "from_rows": breakdown_rows(db, iwt.source_breakdown, r.unit or "cases"),
                "to_location": to_wh.name if to_wh else iwt.to_warehouse_id,
                "to_rows": [],
                "order_number": iwt.reference_number,
                "purchase_order": None,
                "bol": None,
                "recipient": None,
            })

        timeline.sort(key=lambda e: _sort_dt(e["date"]))

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
            "expiration_date": calendar_day(r.expiration_date),
            "initial_quantity": round(init_qty, 2),
            "current_quantity": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "status": r.status,
            "on_hold": r.hold,
            "submitted_by": user_name(db, r.submitted_by),
            "approved_by": user_name(db, r.approved_by),
            "submitted_at": r.submitted_at,
            "approved_at": r.approved_at,
            "purchase_order": r.purchase_order,
            "bol": r.bol,
            "timeline": timeline,
        })

    result = _merge_lot_deliveries(db, receipts, result)

    containers = _lot_trace_containers(db, lot_number, warehouse_id)

    return {
        "lot_number": lot_number,
        "receipts": result,
        "containers": containers,
        # §18.9: a report that bounds or partially answers must say so. An empty
        # trace now means "searched both, found nothing", never "unsupported".
        "coverage": {
            "sources_searched": ["legacy_receipts", "serialized_containers"],
            "legacy_receipts_found": len(result),
            "serialized_containers_found": len(containers),
            "partial": bool(result) and bool(containers),
        },
    }


def _arrival_rows(db: Session, receipt: Receipt) -> list:
    """Where a lot-tracked receipt's drums ARRIVED, from the receiving ledger.

    The allocation JSON is the lot's CURRENT rack picture, so the "Received"
    entry used to list wherever the drums happen to be today (2026-10-01).
    Receiving scans are ledger events keyed to the receipt — undo events net
    out — so they say where each truck was put away."""
    if not receipt.material_lot_id:
        return []
    from app.models import LotPlacementEvent, MaterialLot

    events = (
        db.query(LotPlacementEvent)
        .filter(
            LotPlacementEvent.ref_type.in_(("receipt", "receiving")),
            LotPlacementEvent.ref_id == receipt.id,
        )
        .all()
    )
    units_by_row: dict = {}
    for ev in events:
        units_by_row[ev.storage_row_id] = units_by_row.get(ev.storage_row_id, 0) + int(
            ev.full_units_delta or 0
        )
    lot = db.query(MaterialLot).filter(MaterialLot.id == receipt.material_lot_id).first()
    per = float(receipt.weight_per_container or 0) or float(getattr(lot, "weight_per_unit", 0) or 0)
    unit = receipt.unit or "lbs"
    rows = []
    for row_id, units in units_by_row.items():
        if units <= 0:
            continue
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        rows.append({
            "row": row.name if row else row_id,
            "row_id": row_id,
            "qty": round(units * per, 2) if per else units,
            "unit": unit if per else (getattr(lot, "unit_label", None) or "units"),
        })
    return rows


def _arrival_location(db: Session, arrival_rows: list) -> Optional[str]:
    """"Barn › Room" for the racks a delivery was scanned onto.

    Taken from the racks themselves rather than the receipt's own location
    fields, which a truck or walk-in receipt never sets and an older one could
    name a different room from the one the gun actually used. Several rooms are
    joined with a comma, in first-seen order."""
    labels: list = []
    for entry in arrival_rows or []:
        row_id = entry.get("row_id")
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first() if row_id else None
        if row is None:
            continue
        sub = row.sub_location
        loc = sub.location if sub is not None else None
        if sub is None and row.storage_area is not None:
            loc = row.storage_area.location
            sub = row.storage_area.sub_location
        label = _loc_str(loc, sub)
        if label and label not in labels:
            labels.append(label)
    return ", ".join(labels) or None


def _merge_lot_deliveries(db: Session, receipts: list, entries: list) -> list:
    """One trace entry per LOT for lot-tracked material, not one per truck.

    Drums within a lot are interchangeable and consumption spills across its
    receipts, so per-truck timelines could not add up: the 5,800 lb staging
    use was booked against a truck that brought 5,020 (2026-10-01). Each
    delivery keeps its own "Received" event; everything else is the lot's.
    Legacy receipts (no material lot) are left exactly as they were."""
    by_id = {r.id: r for r in receipts}
    groups: dict = {}
    order: list = []
    for e in entries:
        lot_id = getattr(by_id.get(e["receipt_id"]), "material_lot_id", None)
        key = lot_id or e["receipt_id"]
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(e)

    merged = []
    for key in order:
        group = groups[key]
        if len(group) == 1:
            merged.append(group[0])
            continue
        group.sort(key=lambda e: _sort_dt(e.get("receipt_date") or e.get("submitted_at")))
        first = dict(group[0])
        for e in group:
            for ev in e["timeline"]:
                if ev.get("event_type") == "received" and len(group) > 1:
                    ev["event"] = f"Received (delivery {group.index(e) + 1} of {len(group)})"
        first["timeline"] = sorted(
            (ev for e in group for ev in e["timeline"]),
            key=lambda ev: _sort_dt(ev["date"]),
        )
        first["receipt_ids"] = [e["receipt_id"] for e in group]
        first["deliveries"] = len(group)
        first["initial_quantity"] = round(sum(e["initial_quantity"] for e in group), 2)
        first["current_quantity"] = round(sum(e["current_quantity"] for e in group), 2)
        first["on_hold"] = any(e["on_hold"] for e in group)
        live = [e for e in group if e["status"] != ReceiptStatus.DEPLETED]
        first["status"] = (live or group)[0]["status"]
        for field in ("bol", "purchase_order"):
            vals = [e[field] for e in group if e.get(field)]
            first[field] = ", ".join(dict.fromkeys(vals)) or None
        merged.append(first)
    return merged


def _lot_trace_containers(
    db: Session, lot_number: str, warehouse_id: Optional[str] = None
) -> List[dict]:
    """Serialized containers matching a vendor lot, with their full event trail.

    Matches BOTH `Container.vendor_lot` (the denormalized copy on the hot path)
    and `IntakeLot.vendor_lot` (the source of truth), so a lot correction that
    has not yet fanned out to the containers cannot hide a drum from a recall.

    `consumed_by_batch_uid` is the point of the whole exercise: it answers
    "which batches did this lot go into", which was previously a spreadsheet
    exercise.
    """
    from app.models import Container, ContainerEvent, IngredientIntake, IntakeLot

    pattern = f"%{lot_number}%"
    q = (
        db.query(Container)
        .join(IntakeLot, Container.intake_lot_id == IntakeLot.id)
        .outerjoin(IngredientIntake, Container.intake_id == IngredientIntake.id)
        .filter(Container.is_deleted == False)  # noqa: E712
        .filter(
            or_(
                Container.vendor_lot.ilike(pattern),
                IntakeLot.vendor_lot.ilike(pattern),
            )
        )
    )
    if warehouse_id:
        q = q.filter(Container.warehouse_id == warehouse_id)

    rows = []
    for c in q.order_by(Container.intake_id, Container.sequence).all():
        events = (
            db.query(ContainerEvent)
            .filter(ContainerEvent.container_id == c.id)
            .order_by(ContainerEvent.seq)
            .all()
        )
        rows.append({
            "serial": c.serial,
            "sequence": c.sequence,
            "product_name": product_info(db, c.product_id)[0],
            "vendor_lot": c.vendor_lot,
            "bbd": calendar_day(c.bbd),
            "status": c.status,
            "is_held": c.is_held,
            "net_weight": c.net_weight,
            "remaining_qty": c.remaining_qty,
            "qty_unit": c.qty_unit,
            "storage_row_id": c.storage_row_id,
            # The recall answer for a consumed drum.
            "consumed_by_batch_uid": c.consumed_by_batch_uid,
            "intake_number": c.intake.intake_number if c.intake else None,
            "intake_id": c.intake_id,
            "timeline": [
                {
                    "event": e.event_type,
                    "date": e.occurred_at,
                    "from_status": e.from_status,
                    "to_status": e.to_status,
                    "qty_delta": e.qty_delta,
                    "actor": user_name(db, e.actor_id) if e.actor_id else None,
                    "reason": e.reason,
                    "reason_code": e.reason_code,
                    "ref_type": e.ref_type,
                    "ref_id": e.ref_id,
                    # False when a production scan fell back to the printed
                    # label because the lookup was unreachable.
                    "verified": e.verified,
                }
                for e in events
            ],
        })
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# 6. Hold & Release Report
# ─────────────────────────────────────────────────────────────────────────────

def build_holds_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    product_id: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    tz = tz or report_timezone(db, warehouse_id)
    query = db.query(InventoryHoldAction).filter(
        InventoryHoldAction.status == HoldStatus.APPROVED
    )
    if warehouse_id:
        query = query.filter(InventoryHoldAction.warehouse_id == warehouse_id)
    if start_date:
        query = query.filter(InventoryHoldAction.approved_at >= parse_dt_start(start_date, tz))
    if end_date:
        query = query.filter(InventoryHoldAction.approved_at <= parse_dt_end(end_date, tz))
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
        pname, pcode = product_info(db, receipt.product_id)
        rows.append({
            "hold_id": h.id,
            "action_date": h.approved_at,
            "action": h.action,
            "product_name": pname,
            "product_code": pcode,
            "lot_number": receipt.lot_number,
            "quantity": h.total_quantity or receipt.quantity,
            "reason": h.reason,
            "submitted_by": user_name(db, h.submitted_by),
            "approved_by": user_name(db, h.approved_by),
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

def build_finished_goods_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    product_id: Optional[str] = None,
) -> dict:
    fg_cat_ids = [c.id for c in db.query(Category).filter(Category.parent_id == "group-finished").all()]
    if not fg_cat_ids:
        fg_cat_ids = [c.id for c in db.query(Category).filter(Category.type == CATEGORY_FINISHED).all()]

    if not fg_cat_ids:
        return {"rows": [], "daily": [], "totals": {}}

    query = db.query(Receipt).filter(
        Receipt.category_id.in_(fg_cat_ids),
        Receipt.status.notin_(["rejected"]),
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    if start_date:
        query = query.filter(Receipt.production_date >= parse_calendar_start(start_date))
    if end_date:
        query = query.filter(Receipt.production_date <= parse_calendar_end(end_date))
    if product_id:
        query = query.filter(Receipt.product_id == product_id)

    receipts = query.order_by(Receipt.production_date.asc()).all()

    # Per-receipt rows
    rows = []
    for r in receipts:
        pname, pcode = product_info(db, r.product_id)
        init_qty = initial_receipt_qty(r, db)
        # Count BOTH legacy single-receipt and multi-product / scheduled ship-out
        # lines (the helper handles both) so cases_shipped stays consistent with
        # cases_produced (= on_hand + shipped + adjustments + IW transfers).
        shipped_total = _shipped_cases_for_receipt(db, r.id)
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "production_date": r.production_date,
            "receipt_date": r.receipt_date,
            "cases_produced": round(init_qty, 2),
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

def build_expiry_alerts(
    db: Session,
    warehouse_id: Optional[str] = None,
    days_ahead: Optional[int] = None,
    include_expired: bool = True,
    product_id: Optional[str] = None,
    category_type: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    query = db.query(Receipt).filter(
        Receipt.quantity > 0,
        Receipt.status.notin_(["depleted", "rejected"]),
        Receipt.expiration_date.isnot(None),
    )
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    if product_id:
        query = query.filter(Receipt.product_id == product_id)
    if category_type:
        cat_ids = _category_ids_for_type(db, category_type)
        if cat_ids:
            query = query.filter(Receipt.category_id.in_(cat_ids))

    receipts = query.order_by(Receipt.expiration_date.asc()).all()

    # Calendar arithmetic: the best-by DAY against the warehouse's TODAY.
    # Subtracting instants made a lot expiring tomorrow read "expired" after
    # 8 PM Eastern (UTC had already rolled over) and "0 days" all afternoon.
    today = local_today(tz or report_timezone(db, warehouse_id))
    rows = []
    for r in receipts:
        if not r.expiration_date:
            continue
        exp_dt = r.expiration_date
        days_until = (date.fromisoformat(calendar_day(exp_dt)) - today).days

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

        pname, pcode = product_info(db, r.product_id)
        cname, ctype = category_info(db, r.category_id)
        rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "category_type": ctype,
            "expiration_date": calendar_day(exp_dt),
            "days_until_expiry": days_until,
            "urgency_bucket": bucket,
            "quantity": round(float(r.quantity or 0), 2),
            "unit": r.unit or "cases",
            "on_hold": r.hold,
        })

    bucket_order = ["expired", "0-30 days", "31-60 days", "61-90 days", "90+ days"]
    rows.sort(key=lambda x: (bucket_order.index(x["urgency_bucket"]), x["expiration_date"] or "9999-12-31"))

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

def build_adjustments_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    adjustment_type: Optional[str] = None,
    product_id: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    tz = tz or report_timezone(db, warehouse_id)
    query = db.query(InventoryAdjustment).filter(
        InventoryAdjustment.status == AdjustmentStatus.APPROVED
    )
    if warehouse_id:
        query = query.filter(InventoryAdjustment.warehouse_id == warehouse_id)
    if start_date:
        query = query.filter(InventoryAdjustment.approved_at >= parse_dt_start(start_date, tz))
    if end_date:
        query = query.filter(InventoryAdjustment.approved_at <= parse_dt_end(end_date, tz))
    if adjustment_type and adjustment_type != "all":
        query = query.filter(InventoryAdjustment.adjustment_type == adjustment_type)
    if product_id:
        query = query.filter(InventoryAdjustment.product_id == product_id)

    adjustments = query.order_by(InventoryAdjustment.approved_at.desc()).all()

    rows = []
    for a in adjustments:
        pname, pcode = product_info(db, a.product_id)
        cname, _ = category_info(db, a.category_id)
        receipt = db.query(Receipt).filter(Receipt.id == a.receipt_id).first()
        # Prefer the adjustment's own recorded unit (added in Task 2.5); fall
        # back to the receipt's unit. Adjustments span cases/lbs/units, so the
        # report must keep the unit per row and never sum across units.
        unit = getattr(a, "unit", None) or (receipt.unit if receipt else None) or "units"
        rows.append({
            "adjustment_id": a.id,
            "date": a.approved_at,
            "adjustment_type": a.adjustment_type,
            "product_name": pname,
            "product_code": pcode,
            "category_name": cname,
            "lot_number": receipt.lot_number if receipt else "",
            "quantity": round(float(a.quantity or 0), 2),
            "unit": unit,
            "qty_before": a.original_quantity,
            "qty_after": a.new_quantity,
            "reason": a.reason,
            "submitted_by": user_name(db, a.submitted_by),
            "approved_by": user_name(db, a.approved_by),
        })

    # Totals grouped by unit so cases/lbs/units never get added together.
    total_by_unit: dict = {}
    by_type_unit: dict = {}
    for r in rows:
        u = r["unit"]
        total_by_unit[u] = round(total_by_unit.get(u, 0) + r["quantity"], 2)
        t = r["adjustment_type"]
        by_type_unit.setdefault(t, {})
        by_type_unit[t][u] = round(by_type_unit[t].get(u, 0) + r["quantity"], 2)

    return {
        "rows": rows,
        "totals": {
            "count": len(rows),
            "total_by_unit": total_by_unit,
            "by_type_unit": by_type_unit,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# 10. Vendor Receipt Report
# ─────────────────────────────────────────────────────────────────────────────

def build_vendor_receipts_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    vendor_id: Optional[str] = None,
    tz: Optional[str] = None,
) -> dict:
    tz = tz or report_timezone(db, warehouse_id)
    query = db.query(Receipt)
    if warehouse_id:
        query = query.filter(Receipt.warehouse_id == warehouse_id)
    if start_date:
        query = query.filter(Receipt.receipt_date >= parse_dt_start(start_date, tz))
    if end_date:
        query = query.filter(Receipt.receipt_date <= parse_dt_end(end_date, tz))
    if vendor_id:
        if vendor_id == "none":
            query = query.filter(Receipt.vendor_id.is_(None))
        else:
            query = query.filter(Receipt.vendor_id == vendor_id)

    receipts = query.order_by(Receipt.receipt_date.desc()).all()

    rows = []
    for r in receipts:
        pname, pcode = product_info(db, r.product_id)
        cname, _ = category_info(db, r.category_id)
        vname = vendor_name(db, r.vendor_id)
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

def build_cycle_count_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    location_id: Optional[str] = None,
) -> dict:
    query = db.query(CycleCount)
    if warehouse_id:
        query = query.filter(CycleCount.warehouse_id == warehouse_id)
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
            pid = item.get("productId") or item.get("product_id")
            pname, pcode = product_info(db, pid)
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


# ─────────────────────────────────────────────────────────────────────────────
# 13. Receipts ↔ Placements Reconciliation (2026-09 audit — the standing alarm)
# ─────────────────────────────────────────────────────────────────────────────

def build_reconciliation_report(
    db: Session,
    warehouse_id: Optional[str] = None,
    transfer_days: int = 30,
) -> dict:
    """Does the paper agree with the racks? Three sections, each a class of
    silent failure from the 2026-09 incident:

    * ``phantom_receipts`` — approved non-FG receipts whose quantity is in the
      books with no intake placements of their own (the ~170 phantom drums).
    * ``noop_transfers`` — approved RM transfers that produced zero ledger
      events (the five 09-15 no-ops).
    * ``lot_imbalances`` — lots whose racked units disagree with the summed
      container counts of their approved receipts.

    Empty everywhere = the books can be trusted. Run weekly, and after any
    incident. The approval gates make NEW entries here impossible; this
    report exists to prove that stays true.
    """
    from sqlalchemy import and_, exists
    from app.models import LotPlacement, LotPlacementEvent, MaterialLot

    ev = LotPlacementEvent

    # 1 ─ phantom receipts
    intake_exists = exists().where(and_(
        ev.ref_type.in_(("receipt", "receiving")),
        ev.ref_id == Receipt.id,
        ev.full_units_delta > 0,
    ))
    phantom_q = (
        db.query(Receipt)
        .join(Category, Category.id == Receipt.category_id)
        .filter(
            Receipt.status == ReceiptStatus.APPROVED,
            Receipt.quantity > 0,
            Category.type != CATEGORY_FINISHED,
            or_(Receipt.material_lot_id.is_(None), ~intake_exists),
        )
    )
    if warehouse_id:
        phantom_q = phantom_q.filter(Receipt.warehouse_id == warehouse_id)
    phantom_rows = []
    for r in phantom_q.order_by(Receipt.submitted_at.desc()).all():
        pname, pcode = product_info(db, r.product_id)
        phantom_rows.append({
            "receipt_id": r.id,
            "lot_number": r.lot_number,
            "product_name": pname,
            "product_code": pcode,
            "quantity": r.quantity,
            "unit": r.unit,
            "container_count": r.container_count,
            "has_lot": bool(r.material_lot_id),
            "submitted_at": r.submitted_at,
            "approved_at": r.approved_at,
            "approved_by": user_name(db, r.approved_by),
        })

    # 2 ─ approved transfers with no ledger events
    event_exists = exists().where(or_(
        ev.ref_id == InventoryTransfer.id,
        ev.ref_id.like(InventoryTransfer.id.concat(":%")),
    ))
    cutoff = datetime.now(timezone.utc) - timedelta(days=transfer_days)
    noop_q = (
        db.query(InventoryTransfer, Receipt)
        .join(Receipt, Receipt.id == InventoryTransfer.receipt_id)
        .join(Category, Category.id == Receipt.category_id)
        .filter(
            InventoryTransfer.status == TransferStatus.APPROVED,
            InventoryTransfer.approved_at >= cutoff,
            Category.type != CATEGORY_FINISHED,
            ~event_exists,
        )
    )
    if warehouse_id:
        noop_q = noop_q.filter(InventoryTransfer.warehouse_id == warehouse_id)
    noop_rows = []
    for t, r in noop_q.order_by(InventoryTransfer.approved_at.desc()).all():
        pname, _pcode = product_info(db, r.product_id)
        noop_rows.append({
            "transfer_id": t.id,
            "transfer_type": t.transfer_type,
            "lot_number": r.lot_number,
            "product_name": pname,
            "quantity": t.quantity,
            "unit": t.unit,
            "approved_at": t.approved_at,
            "approved_by": user_name(db, t.approved_by),
        })

    # 3 ─ per-lot paper vs physical, in containers.
    #
    # Paper is what the receipts still claim NOW (quantity ÷ that receipt's
    # own lbs per drum, approved AND depleted), and physical is what is
    # racked plus what is out in staging (still on paper until production's
    # consumption lands). The old check summed the frozen as-delivered
    # container_count of approved receipts only, so every lot that had any
    # consumption, write-off or drums in staging raised a false alarm
    # (2026-10-01 e2e). Open drums count by their remaining weight, and a
    # gap under half a drum is rounding across mixed-weight deliveries.
    from app.models import StagingItem

    lots_q = db.query(MaterialLot).filter(MaterialLot.is_deleted == False)  # noqa: E712
    if warehouse_id:
        lots_q = lots_q.filter(MaterialLot.warehouse_id == warehouse_id)
    imbalance_rows = []
    for lot in lots_q.all():
        receipts = db.query(Receipt).filter(
            Receipt.material_lot_id == lot.id,
            Receipt.status.in_((ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED)),
        ).all()
        if not receipts:
            continue
        lot_w = float(lot.weight_per_unit or 0)
        paper_units = 0.0
        staged_units = 0.0
        unpriced = False
        for r in receipts:
            w = float(r.weight_per_container or 0) or lot_w
            if w <= 0:
                unpriced = True
                break
            paper_units += float(r.quantity or 0) / w
            for si in db.query(StagingItem).filter(
                StagingItem.receipt_id == r.id,
                StagingItem.status.in_(("staged", "partially_used", "partially_returned")),
            ).all():
                staged_units += max(0.0, (
                    float(si.quantity_staged or 0) - float(si.quantity_used or 0)
                    - float(si.quantity_returned or 0)
                ) / w)
        if not unpriced and lot_w > 0:
            from app.services.staging_pull_service import on_cart_quantity_for_lot
            staged_units += on_cart_quantity_for_lot(db, lot.id) / lot_w
        if unpriced:
            # No weight anywhere: fall back to whole containers as delivered.
            paper_units = float(sum(int(r.container_count or 0) for r in receipts
                                    if r.status == ReceiptStatus.APPROVED))
        racked_units = 0.0
        for p in db.query(LotPlacement).filter(LotPlacement.material_lot_id == lot.id).all():
            racked_units += int(p.full_units or 0)
            if int(p.open_units or 0):
                racked_units += (float(p.open_remaining_qty or 0) / lot_w) if lot_w > 0 \
                    else int(p.open_units or 0)
        physical = racked_units + staged_units
        if abs(paper_units - physical) < 0.5:
            continue
        pname, _pcode = product_info(db, lot.product_id)
        imbalance_rows.append({
            "lot_code": lot.lot_code,
            "product_name": pname,
            "unit_label": lot.unit_label,
            "paper_units": int(round(paper_units)),
            "racked_units": int(round(racked_units)),
            "difference": int(round(physical - paper_units)),
        })

    return {
        "phantom_receipts": phantom_rows,
        "noop_transfers": noop_rows,
        "lot_imbalances": imbalance_rows,
        "totals": {
            "phantom_receipts": len(phantom_rows),
            "noop_transfers": len(noop_rows),
            "lot_imbalances": len(imbalance_rows),
            "clean": not (phantom_rows or noop_rows or imbalance_rows),
        },
    }
