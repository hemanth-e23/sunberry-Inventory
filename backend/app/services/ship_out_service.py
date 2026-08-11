"""Lot-level finished-goods ship-out flow (v2).

Warehouse worker reserves capacity by (lot_number, cases) on each line.
Forklift commits specific pallets at scan time. Partial pulls split a
pallet's case count (remainder moves to the warehouse's designated
partial-pallet row).

Differs from the v1 flow in `transfer_service` in two key ways:
- pallets stay IN_STOCK until each scan flips them to SHIPPED
- a `ShipOutLotReservation` row holds soft capacity per (product, lot)
  instead of relying on PalletStatus.RESERVED
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import and_ as sa_and, func, or_ as sa_or, text as sa_text
from sqlalchemy.orm import Session

from app.constants import TRANSFER_TYPE_SHIPPED_OUT
from app.enums import PalletStatus, ShipOutScanReason, TransferStatus, ShipOutLifecycle
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    Carrier,
    InventoryTransfer,
    InventoryTransferLine,
    PackageSize,
    PalletLicence,
    PalletType,
    Product,
    Receipt,
    ShipToLocation,
    StorageArea,
    StorageRow,
    TransferScanEvent,
)
from app.models.inventory import ShipOutLotReservation, TransferPalletSwap
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences
from app.utils.locations import warehouse_id_for_row
from app.utils.gs1 import build_bol_number


# ---------------------------------------------------------------------------
# ID generator (mirrors routers/transfers.py:_generate_id)
# ---------------------------------------------------------------------------

def _new_id(prefix: str) -> str:
    import uuid
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Lot availability + reservation math
# ---------------------------------------------------------------------------

def _active_reservation_cases(
    db: Session, product_id: str, lot_number: str, exclude_line_id: Optional[str] = None
) -> float:
    """Sum of cases reserved on active (un-released) reservations for a lot."""
    q = db.query(func.coalesce(func.sum(ShipOutLotReservation.cases_reserved), 0.0)).filter(
        ShipOutLotReservation.product_id == product_id,
        ShipOutLotReservation.lot_number == lot_number,
        ShipOutLotReservation.released_at.is_(None),
    )
    if exclude_line_id:
        q = q.filter(ShipOutLotReservation.transfer_line_id != exclude_line_id)
    return float(q.scalar() or 0.0)


def _active_product_reservation_cases(
    db: Session, product_id: str, exclude_line_ids: Optional[list] = None
) -> float:
    """Sum of cases reserved on active reservations for a product across ALL
    lots (Phase D pools reservations at the product level — lot is decided live
    at scan time). Counts legacy per-lot rows too, since the sum ignores
    lot_number."""
    q = db.query(func.coalesce(func.sum(ShipOutLotReservation.cases_reserved), 0.0)).filter(
        ShipOutLotReservation.product_id == product_id,
        ShipOutLotReservation.released_at.is_(None),
    )
    if exclude_line_ids:
        q = q.filter(~ShipOutLotReservation.transfer_line_id.in_(exclude_line_ids))
    return float(q.scalar() or 0.0)


def _pallet_pool_for_product(
    db: Session, product_id: str, warehouse_id: Optional[str], lock: bool = False
):
    """Live pool of in-stock, not-held pallets for a product in a warehouse."""
    q = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.status == PalletStatus.IN_STOCK,
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
    )
    if warehouse_id:
        q = q.filter(PalletLicence.warehouse_id == warehouse_id)
    if lock:
        q = q.with_for_update()
    return q.all()


def _lot_entries_with_availability(
    db: Session, product_id: str, warehouse_id: Optional[str], reserved_pool: float
) -> list[dict]:
    """Lots for a product, oldest first, each with physical cases and a
    `cases_available` computed by subtracting `reserved_pool` (a product-level
    reservation total) from the OLDEST lots first — FIFO is how reservations
    are assumed to consume stock. Used by both the creation and dock pickers."""
    pallets = _pallet_pool_for_product(db, product_id, warehouse_id, lock=False)

    by_lot: dict[str, dict] = {}
    for pl in pallets:
        lot_key = pl.lot_number or ""
        if not lot_key:
            continue  # pallets with no lot number aren't pickable in this flow
        entry = by_lot.setdefault(lot_key, {
            "pallets": [],
            "oldest_at": None,
            "rows": {},
        })
        entry["pallets"].append(pl)
        created = pl.created_at
        if created and (entry["oldest_at"] is None or created < entry["oldest_at"]):
            entry["oldest_at"] = created
        row_key = pl.storage_row_id or ""
        row_agg = entry["rows"].setdefault(row_key, {"cases": 0.0, "pallets": 0})
        row_agg["cases"] += float(pl.cases or 0)
        row_agg["pallets"] += 1

    row_ids = {rid for entry in by_lot.values() for rid in entry["rows"].keys() if rid}
    row_lookup: dict[str, StorageRow] = {}
    if row_ids:
        for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all():
            row_lookup[r.id] = r

    entries = []
    for lot_number, entry in by_lot.items():
        entries.append({
            "lot_number": lot_number,
            "physical_cases": sum(float(p.cases or 0) for p in entry["pallets"]),
            "pallets_available": len(entry["pallets"]),
            "oldest_at": entry["oldest_at"],
            "rows": [
                {
                    "row_id": rid or None,
                    "row_name": (row_lookup.get(rid).name if rid and row_lookup.get(rid) else "Floor"),
                    "cases": agg["cases"],
                    "pallets": agg["pallets"],
                }
                for rid, agg in entry["rows"].items()
            ],
        })

    entries.sort(key=lambda x: (x["oldest_at"] or datetime.max.replace(tzinfo=timezone.utc), x["lot_number"]))

    # Attribute the reservation pool to the oldest lots first.
    remaining = max(0.0, reserved_pool)
    for e in entries:
        take = min(remaining, e["physical_cases"])
        e["cases_available"] = max(0.0, e["physical_cases"] - take)
        remaining -= take
    return entries


def available_lots_for_product(
    db: Session, product_id: str, warehouse_id: Optional[str]
) -> list[dict]:
    """Lots for a product with capacity net of the product-level reservation
    pool. Used by the creation-time lot picker (hides fully-spoken-for lots)."""
    reserved = _active_product_reservation_cases(db, product_id)
    entries = _lot_entries_with_availability(db, product_id, warehouse_id, reserved)
    return [
        {
            "lot_number": e["lot_number"],
            "cases_available": e["cases_available"],
            "pallets_available": e["pallets_available"],
            "oldest_at": e["oldest_at"],
            "rows": e["rows"],
        }
        for e in entries
        if e["cases_available"] > 0
    ]


# ---------------------------------------------------------------------------
# Phase 1 — create pick list
# ---------------------------------------------------------------------------

def _resolve_ship_to(db: Session, ship_to) -> Optional[str]:
    """Resolve a ship-to input to a ShipToLocation id. Uses the existing row when
    an id is given; otherwise self-populates a new one (SPEC §7.2)."""
    if ship_to is None:
        return None
    if getattr(ship_to, "id", None):
        loc = db.query(ShipToLocation).filter(ShipToLocation.id == ship_to.id).first()
        if not loc:
            raise NotFoundError(f"Ship-to location not found: {ship_to.id}")
        return loc.id
    if not (ship_to.location_name and ship_to.customer_name):
        return None
    # Find-or-create by (customer, location) so repeated "new" entries for the
    # same place don't pile up duplicate rows.
    existing = db.query(ShipToLocation).filter(
        func.lower(ShipToLocation.customer_name) == ship_to.customer_name.strip().lower(),
        func.lower(ShipToLocation.location_name) == ship_to.location_name.strip().lower(),
    ).first()
    if existing:
        return existing.id
    loc = ShipToLocation(
        id=_new_id("shipto"),
        customer_name=ship_to.customer_name.strip(),
        location_name=ship_to.location_name.strip(),
        address_line1=(ship_to.address_line1 or None),
        address_line2=(ship_to.address_line2 or None),
        city=(ship_to.city or None),
        state=(ship_to.state or None),
        zip_code=(ship_to.zip_code or None),
    )
    db.add(loc)
    db.flush()
    return loc.id


def _resolve_carrier_name(db: Session, name: Optional[str]) -> Optional[str]:
    """Find-or-create a Carrier by name (self-populating) and return the canonical
    name string stored on the order (SPEC §7.2)."""
    if not name or not name.strip():
        return None
    name = name.strip()
    existing = db.query(Carrier).filter(func.lower(Carrier.name) == name.lower()).first()
    if existing:
        return existing.name
    db.add(Carrier(id=_new_id("carrier"), name=name))
    db.flush()
    return name


def create_scheduled_order(
    db: Session, data, current_user, target_warehouse_id: Optional[str]
) -> InventoryTransfer:
    """Create a SCHEDULED ship-out order (SPEC Task 2).

    Corporate/warehouse plans an order in advance: order number, date + appointment,
    ship-to, PO, carrier, pallet type, and product lines (product + cases — NO lots;
    lots are chosen live at scan time). One "planning" line per product carries the
    requested cases with a NULL receipt. Status is SCHEDULED, so the order does NOT
    appear on the forklift gun until yard check-in (Task 3).
    """
    if not data.lines:
        raise ValidationError("Scheduled order has no lines")

    # Validate products + cases.
    product_ids = {ln.product_id for ln in data.lines}
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()}
    for ln in data.lines:
        if ln.product_id not in products:
            raise ValidationError(f"Product not found: {ln.product_id}")
        if float(ln.cases_requested) <= 0:
            raise ValidationError(f"Line for {ln.product_id}: cases must be > 0")
    if len(product_ids) != len(data.lines):
        raise ValidationError("Duplicate product on multiple lines — combine into one line")

    # Validate pallet type if provided.
    if data.pallet_type_id:
        if not db.query(PalletType).filter(PalletType.id == data.pallet_type_id).first():
            raise ValidationError(f"Pallet type not found: {data.pallet_type_id}")

    ship_to_id = _resolve_ship_to(db, data.ship_to)
    carrier_name = _resolve_carrier_name(db, data.carrier)

    transfer_id = _new_id("transfer")
    total_cases = float(sum(float(ln.cases_requested) for ln in data.lines))

    transfer = InventoryTransfer(
        id=transfer_id,
        receipt_id=None,
        quantity=total_cases,
        unit="cases",
        transfer_type=TRANSFER_TYPE_SHIPPED_OUT,
        order_number=data.order_number,
        pallet_licence_ids=[],
        requested_by=str(current_user.id),
        scheduled_by=str(current_user.id),
        warehouse_id=target_warehouse_id,
        status=ShipOutLifecycle.SCHEDULED.value,
        scheduled_date=data.scheduled_date,
        appointment_time=(data.appointment_time or None),
        po_number=(data.po_number or None),
        carrier=carrier_name,
        pallet_type_id=(data.pallet_type_id or None),
        ship_to_location_id=ship_to_id,
    )
    db.add(transfer)

    # One planning line per product: NULL receipt, empty lot_allocations. Actual
    # picks attach as receipt-pinned drift sub-lines at scan time.
    #
    # line_seq is UI_LINE_INDEX * 1000 (matching create_pick_list_v2): the
    # scanner view groups sub-lines into UI lines by `line_seq // 1000`, so a
    # bare `i` (0,1,2,…) would collapse every product into group 0 — merging a
    # multi-product order into a single line that never reads complete. Drift
    # sub-lines added at scan time use line_seq=1_000_000 and fold into their
    # product's group.
    for i, line in enumerate(data.lines):
        db.add(InventoryTransferLine(
            id=_new_id("trln"),
            transfer_id=transfer_id,
            product_id=line.product_id,
            receipt_id=None,
            cases_requested=float(line.cases_requested),
            cases_picked=0.0,
            pallet_licence_ids=[],
            lot_allocations=[],
            picks=[],
            lot_swap_history=[],
            line_seq=i * 1000,
        ))

    db.flush()
    return transfer


# ---------------------------------------------------------------------------
# Outgoing dashboard (SPEC Task 3): list by day, overdue, reschedule, cancel.
# ---------------------------------------------------------------------------

# Lifecycle → display label for the dashboard.
_STATUS_LABELS = {
    ShipOutLifecycle.SCHEDULED.value: "Scheduled",
    ShipOutLifecycle.CHECKED_IN.value: "Checked In",
    ShipOutLifecycle.SCANNING.value: "Loading",
    ShipOutLifecycle.RECONCILED.value: "Reconciled",
    ShipOutLifecycle.COMPLETE.value: "Complete",
    ShipOutLifecycle.DOCS_GENERATED.value: "Shipped",
    ShipOutLifecycle.CANCELLED.value: "Cancelled",
}

# Reschedule/cancel are allowed only before loading starts. Mid-scan changes
# would strand already-shipped pallets (handled by manual SQL, SPEC §3).
_RESCHEDULABLE = {ShipOutLifecycle.SCHEDULED.value, ShipOutLifecycle.CHECKED_IN.value}

# Statuses at which a ship-out order is open for forklift scanning / on the gun.
# Includes legacy PENDING so the old lot-based flow keeps working until it is
# retired at Task 9 (clean cutover).
_SCANNABLE_STATUSES = {
    TransferStatus.PENDING.value,
    ShipOutLifecycle.CHECKED_IN.value,
    ShipOutLifecycle.SCANNING.value,
}


def _assert_scannable(transfer: InventoryTransfer) -> None:
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")
    if transfer.status not in _SCANNABLE_STATUSES:
        raise ValidationError("This order isn't open for scanning — check the truck in first.")


def check_in_order(db: Session, transfer: InventoryTransfer, data, user) -> InventoryTransfer:
    """Task 4: yard check-in. Captures driver/trailer/time-in and releases the
    order to the forklift gun (status -> CHECKED_IN). Driver fields are optional
    here and required only at doc generation.

    Also serves as "Edit Check-In": details can be completed/corrected while the
    order is CHECKED_IN, SCANNING or RECONCILED (docs require driver/trailer/seal,
    so there must be a path to fill them after loading starts). Editing never
    regresses the lifecycle status and never bumps the original time-in."""
    editable = (
        ShipOutLifecycle.SCHEDULED.value, ShipOutLifecycle.CHECKED_IN.value,
        ShipOutLifecycle.SCANNING.value, ShipOutLifecycle.RECONCILED.value,
    )
    if transfer.status not in editable:
        raise ValidationError("Check-in details can't be changed on this order anymore.")
    # Carrier is pre-filled from the schedule; update it if the yard corrects it
    # (resolve so a new name joins the type-ahead master list).
    if data.carrier is not None:
        transfer.carrier = _resolve_carrier_name(db, data.carrier)
    transfer.driver_name = (data.driver_name or None)
    transfer.driver_license = (data.driver_license or None)
    transfer.truck_number = (data.truck_number or None)
    transfer.truck_license = (data.truck_license or None)
    transfer.trailer_number = (data.trailer_number or None)
    transfer.trailer_license = (data.trailer_license or None)
    # time_in: explicit value wins; otherwise stamp once at first check-in and
    # preserve it on later edits.
    if data.time_in is not None:
        transfer.time_in = data.time_in
    elif not transfer.time_in:
        transfer.time_in = datetime.now(timezone.utc)
    if transfer.status == ShipOutLifecycle.SCHEDULED.value:
        transfer.checked_in_at = datetime.now(timezone.utc)
        transfer.checked_in_by = str(user.id)
        transfer.status = ShipOutLifecycle.CHECKED_IN.value
    return transfer


def list_gun_orders(db: Session, warehouse_id: Optional[str]) -> list:
    """Task 4: the forklift gun queue — every order currently open for scanning
    in this warehouse, regardless of scheduled date (check-in proves the truck is
    here; SPEC §5.6). Returns ORM transfers, newest-checked-in first; the router
    maps them to the response shape the scanner expects."""
    q = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == TRANSFER_TYPE_SHIPPED_OUT,
        InventoryTransfer.status.in_(list(_SCANNABLE_STATUSES)),
    )
    if warehouse_id:
        q = q.filter(InventoryTransfer.warehouse_id == warehouse_id)
    return q.order_by(InventoryTransfer.checked_in_at.desc().nullslast(),
                      InventoryTransfer.submitted_at.desc()).all()


def gun_order_extras(t: InventoryTransfer) -> dict:
    """Display extras merged onto the transfer response for the gun queue."""
    loc = t.ship_to_location
    return {
        "status_label": _STATUS_LABELS.get(t.status, (t.status or "").replace("_", " ").title()),
        "appointment_time": t.appointment_time,
        "carrier": t.carrier,
        "customer_name": loc.customer_name if loc else None,
        "location": (f"{loc.city}, {loc.state}" if loc and loc.city else (loc.location_name if loc else None)),
    }


def _scheduled_order_summary(db: Session, t: InventoryTransfer) -> dict:
    """Compact row for the Outgoing dashboard."""
    loc = t.ship_to_location
    lines = list(t.lines or [])
    # Collapse by PRODUCT, not by line. FIFO picking splits one ordered product
    # across a sub-line per source lot/receipt, so a single-product order can
    # carry several lines — counting lines would misreport "3 products" for one
    # Mango order shipped from 3 lots.
    by_product: dict = {}
    total_cases = 0.0
    for ln in lines:
        cases = float(ln.cases_requested or 0)
        total_cases += cases
        pname = ln.product.name if ln.product else ln.product_id
        entry = by_product.setdefault(ln.product_id, {"product": pname, "cases": 0.0})
        entry["cases"] += cases
    detail = list(by_product.values())
    status = t.status or ""
    label = _STATUS_LABELS.get(status, status.replace("_", " ").title())
    if status == ShipOutLifecycle.DOCS_GENERATED.value and t.ship_short:
        label = "Shipped Short"
    return {
        "id": t.id,
        "order_number": t.order_number,
        "status": status,
        "status_label": label,
        "scheduled_date": t.scheduled_date.isoformat() if t.scheduled_date else None,
        "appointment_time": t.appointment_time,
        "carrier": t.carrier,
        "po_number": t.po_number,
        "customer_name": loc.customer_name if loc else None,
        "ship_to_name": loc.location_name if loc else None,
        "location": (
            f"{loc.city}, {loc.state}" if loc and loc.city else (loc.location_name if loc else None)
        ),
        "total_cases": total_cases,
        "detail": detail,
        "can_modify": status in _RESCHEDULABLE,
        # Check-in details so the dashboard can pre-fill the edit modal.
        "driver_name": t.driver_name,
        "driver_license": t.driver_license,
        "truck_number": t.truck_number,
        "truck_license": t.truck_license,
        "trailer_number": t.trailer_number,
        "trailer_license": t.trailer_license,
    }


def _scheduled_base_query(db: Session, warehouse_id: Optional[str]):
    q = db.query(InventoryTransfer).filter(
        InventoryTransfer.transfer_type == TRANSFER_TYPE_SHIPPED_OUT,
        InventoryTransfer.scheduled_date.isnot(None),
    )
    if warehouse_id:
        q = q.filter(InventoryTransfer.warehouse_id == warehouse_id)
    return q


def list_scheduled_orders(db: Session, warehouse_id: Optional[str], on_date) -> list:
    rows = (
        _scheduled_base_query(db, warehouse_id)
        .filter(InventoryTransfer.scheduled_date == on_date)
        .order_by(InventoryTransfer.appointment_time, InventoryTransfer.order_number)
        .all()
    )
    return [_scheduled_order_summary(db, t) for t in rows]


def list_overdue_scheduled(db: Session, warehouse_id: Optional[str], before_date) -> list:
    """Orders whose ship date has passed but never checked in (still SCHEDULED)."""
    rows = (
        _scheduled_base_query(db, warehouse_id)
        .filter(
            InventoryTransfer.scheduled_date < before_date,
            InventoryTransfer.status == ShipOutLifecycle.SCHEDULED.value,
        )
        .order_by(InventoryTransfer.scheduled_date, InventoryTransfer.order_number)
        .all()
    )
    return [_scheduled_order_summary(db, t) for t in rows]


def reschedule_order(db: Session, transfer: InventoryTransfer, new_date, new_appointment, user) -> InventoryTransfer:
    """Postpone/prepone a scheduled order. Rescheduling a checked-in order returns
    it to SCHEDULED and clears yard check-in (it leaves the gun) — a new truck
    checks in on the new day (SPEC test 11)."""
    if transfer.status not in _RESCHEDULABLE:
        raise ValidationError(
            "This order is already being loaded or completed and can't be rescheduled from the dashboard."
        )
    if new_date is not None:
        transfer.scheduled_date = new_date
    if new_appointment is not None:
        transfer.appointment_time = new_appointment or None
    # Returning to SCHEDULED removes it from the gun and drops stale check-in.
    transfer.status = ShipOutLifecycle.SCHEDULED.value
    transfer.driver_name = None
    transfer.driver_license = None
    transfer.truck_number = None
    transfer.truck_license = None
    transfer.trailer_number = None
    transfer.trailer_license = None
    transfer.time_in = None
    transfer.checked_in_at = None
    transfer.checked_in_by = None
    return transfer


def cancel_scheduled_order(db: Session, transfer: InventoryTransfer, user) -> InventoryTransfer:
    if transfer.status not in _RESCHEDULABLE:
        raise ValidationError(
            "This order is already being loaded or completed and can't be cancelled from the dashboard."
        )
    transfer.status = ShipOutLifecycle.CANCELLED.value
    transfer.voided_at = datetime.now(timezone.utc)
    transfer.voided_by = str(user.id)
    transfer.voided_reason = "Cancelled from Outgoing dashboard"
    return transfer


def restore_cancelled_order(db: Session, transfer: InventoryTransfer, user) -> InventoryTransfer:
    """Undo an accidental cancel: the order returns to SCHEDULED on its original
    date (cancelled rows stay visible on the dashboard, so this is one click)."""
    if transfer.status != ShipOutLifecycle.CANCELLED.value:
        raise ValidationError("Only a cancelled order can be restored.")
    transfer.status = ShipOutLifecycle.SCHEDULED.value
    transfer.voided_at = None
    transfer.voided_by = None
    transfer.voided_reason = None
    return transfer


# ---------------------------------------------------------------------------
# Task 6: worker pallet-select (desktop rescue for unscanned loads).
# ---------------------------------------------------------------------------
def list_selectable_pallets(db: Session, transfer: InventoryTransfer, product_id: str, query: Optional[str]) -> list:
    """Pallets of a product available to add to this order by licence — IN_STOCK
    plus PENDING (live-load). Whole pallets only (SPEC §5.8)."""
    q = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
        PalletLicence.status.in_([PalletStatus.IN_STOCK, PalletStatus.PENDING]),
    )
    if transfer.warehouse_id:
        q = q.filter(PalletLicence.warehouse_id == transfer.warehouse_id)
    if query:
        q = q.filter(PalletLicence.licence_number.ilike(f"%{query.strip()}%"))
    rows = q.order_by(PalletLicence.lot_number, PalletLicence.sequence).limit(500).all()
    out = []
    for pl in rows:
        row = pl.storage_row
        out.append({
            "pallet_licence_id": pl.id,
            "licence_number": pl.licence_number,
            "lot_number": pl.lot_number,
            "cases": int(pl.cases or 0),
            "row": (row.name if row else None),
            "status": pl.status,
            "is_live": pl.status == PalletStatus.PENDING,
        })
    return out


def select_pallet(db: Session, transfer: InventoryTransfer, licence_number: str, current_user) -> dict:
    """Add an exact pallet to the order by licence — SAME pick routine as a gun
    scan (SHIPPED, receipt decremented, rack freed) tagged picked_via=manual_select.
    Allows PENDING (live-load) pallets."""
    return scan_pick_v2(
        db, transfer, licence_number, None, current_user,
        allow_live_load=True, picked_via="manual_select",
    )


def adjust_scanned_pallet_cases(
    db: Session, transfer: InventoryTransfer, pallet_licence_id: str,
    cases: int, current_user,
) -> dict:
    """Trim a fully-scanned pallet down to a PARTIAL so a load isn't stuck over.

    Example: 28 pallets × 40 cases = 1,120 scanned against a 1,100 order (+20).
    Whole pallets can't be un-shipped case-by-case, so this reduces one pallet to
    `cases` on the truck and returns the remainder to the warehouse Partials rack
    (SPEC §5.8 partial-pull). Mechanically: full un-scan (restore the pallet) then
    a partial re-pick of `cases`. Caller owns commit/rollback."""
    _assert_not_locked(transfer)
    _assert_scannable(transfer)
    pl = db.query(PalletLicence).filter(PalletLicence.id == pallet_licence_id).first()
    if not pl:
        raise NotFoundError("PalletLicence", pallet_licence_id)

    # Locate the pick entry so we know how many cases it currently ships.
    pick = None
    for ln in (transfer.lines or []):
        for p in (ln.picks or []):
            if p.get("pallet_licence_id") == pallet_licence_id:
                pick = p
                break
        if pick:
            break
    if pick is None:
        raise ValidationError("That pallet isn't on this order's scanned list.")
    if pick.get("was_partial"):
        raise ValidationError(
            "This pallet already shipped as a partial — correct the remainder with "
            "an inventory adjustment instead."
        )

    current = int(round(float(pick.get("cases_consumed") or 0)))
    try:
        cases = int(cases)
    except (TypeError, ValueError):
        raise ValidationError("Enter a whole number of cases.")
    if cases <= 0:
        raise ValidationError("To take the whole pallet off the truck, use Remove instead.")
    if cases > current:
        raise ValidationError(f"This pallet only has {current} cases on the truck.")
    if cases == current:
        return {"ok": True, "shipped": cases, "returned": 0, "message": "No change."}

    # Fail before mutating if there's nowhere to home the remainder.
    if not _partial_pallet_row(db, transfer.warehouse_id):
        raise ValidationError(
            "No partial-pallet rack is configured for this warehouse. Set "
            "`is_partial_pallet_location = true` on one storage row, then retry."
        )

    licence = pl.licence_number
    unscan_pick_v2(db, transfer, pallet_licence_id, "wrong_pallet", current_user)
    db.flush()
    res = scan_pick_v2(
        db, transfer, licence, float(cases), current_user,
        allow_live_load=True, picked_via="manual_select",
    )
    if not res.get("ok"):
        raise ValidationError(res.get("message") or "Could not adjust this pallet.")

    returned = current - cases
    return {
        "ok": True, "shipped": cases, "returned": returned,
        "message": f"{cases} cs stay on the truck · {returned} cs returned to the Partials rack.",
    }


# ---------------------------------------------------------------------------
# Task 7: reconcile + manual attribution.
# ---------------------------------------------------------------------------
def _line_shipped_cases(line: InventoryTransferLine) -> float:
    scanned = float(line.cases_picked or 0)
    manual = sum(float(m.get("cases") or 0) for m in (line.manual_attributions or []))
    return scanned + manual


def order_reconcile_summary(db: Session, transfer: InventoryTransfer) -> dict:
    """Per-product ordered / scanned / manual / shipped / remaining, collapsed to
    the planning line so multi sub-line orders read cleanly."""
    import math
    by_product: dict = {}
    cpp_by_product: dict = {}
    for ln in (transfer.lines or []):
        p = by_product.setdefault(ln.product_id, {
            "product_id": ln.product_id,
            "product_name": (ln.product.name if ln.product else ln.product_id),
            "ordered": 0.0, "scanned": 0.0, "manual": 0.0,
            "manual_attributions": [], "line_ids": [],
        })
        if ln.product_id not in cpp_by_product and ln.product:
            cpp_by_product[ln.product_id] = ln.product.default_cases_per_pallet
        p["ordered"] += float(ln.cases_requested or 0)
        p["scanned"] += float(ln.cases_picked or 0)
        for m in (ln.manual_attributions or []):
            p["manual"] += float(m.get("cases") or 0)
            p["manual_attributions"].append({**m, "line_id": ln.id})
        p["line_ids"].append(ln.id)
    lines = []
    any_short = any_over = False
    # Auto pallet count = Σ ceil(shipped / cases-per-pallet) per product — the
    # same figure generate_documents() puts on the BOL when Pallet Override is
    # left blank. Surfaced here so the "Seal & Generate" modal can show it.
    computed_pallet_count = 0
    for p in by_product.values():
        shipped = p["scanned"] + p["manual"]
        remaining = max(0.0, p["ordered"] - shipped)
        if shipped < p["ordered"]:
            any_short = True
        if shipped > p["ordered"]:
            any_over = True
        cpp = cpp_by_product.get(p["product_id"])
        if cpp and shipped > 0:
            computed_pallet_count += int(math.ceil(shipped / cpp))
        lines.append({**p, "shipped": shipped, "remaining": remaining})
    loc = transfer.ship_to_location
    return {
        "id": transfer.id, "order_number": transfer.order_number, "status": transfer.status,
        "lines": lines, "any_short": any_short, "any_over": any_over,
        "computed_pallet_count": computed_pallet_count,
        # Header context so the order-detail page can render customer/truck info
        # without a second request.
        "customer_name": loc.customer_name if loc else None,
        "ship_to_name": loc.location_name if loc else None,
        "location": (
            f"{loc.city}, {loc.state}" if loc and loc.city else (loc.location_name if loc else None)
        ),
        "scheduled_date": transfer.scheduled_date.isoformat() if transfer.scheduled_date else None,
        "appointment_time": transfer.appointment_time,
        "carrier": transfer.carrier,
        "po_number": transfer.po_number,
        "driver_name": transfer.driver_name,
        "driver_license": transfer.driver_license,
        "truck_number": transfer.truck_number,
        "truck_license": transfer.truck_license,
        "trailer_number": transfer.trailer_number,
        "trailer_license": transfer.trailer_license,
        "seal_number": transfer.seal_number,
        "time_in": transfer.time_in.isoformat() if transfer.time_in else None,
        "time_out": transfer.time_out.isoformat() if transfer.time_out else None,
        "bol_number": transfer.bol_number,
        "ship_short": bool(transfer.ship_short),
    }


def _assert_not_locked(transfer: InventoryTransfer) -> None:
    if transfer.is_locked or transfer.status == ShipOutLifecycle.DOCS_GENERATED.value:
        raise ValidationError(
            "This order is locked — documents were generated. Void & regenerate to make changes."
        )


def add_manual_attribution(db: Session, transfer: InventoryTransfer, product_id: str,
                           lot_number: str, cases: float, reason: str, current_user) -> None:
    """Record unscanned cases by lot — paperwork only, NO inventory deduction
    (SPEC §5.3). Attaches to the product's planning line."""
    _assert_not_locked(transfer)
    if cases <= 0:
        raise ValidationError("Manual attribution cases must be > 0")
    if not lot_number:
        raise ValidationError("A lot number is required for manual attribution")
    line = next((ln for ln in (transfer.lines or [])
                 if ln.product_id == product_id and ln.receipt_id is None), None)
    if line is None:
        line = next((ln for ln in (transfer.lines or []) if ln.product_id == product_id), None)
    if line is None:
        raise ValidationError("Product is not on this order")
    entry = {
        "lot_number": lot_number, "cases": float(cases), "reason": (reason or None),
        "who": str(current_user.id), "at": datetime.now(timezone.utc).isoformat(),
    }
    line.manual_attributions = list(line.manual_attributions or []) + [entry]


def remove_manual_attribution(db: Session, transfer: InventoryTransfer, line_id: str, index: int) -> None:
    _assert_not_locked(transfer)
    line = next((ln for ln in (transfer.lines or []) if ln.id == line_id), None)
    if line is None:
        raise ValidationError("Line not found")
    ma = list(line.manual_attributions or [])
    if 0 <= index < len(ma):
        ma.pop(index)
        line.manual_attributions = ma


def reconcile_order(db: Session, transfer: InventoryTransfer, confirm_short: bool,
                    confirm_over: bool, current_user) -> InventoryTransfer:
    """Close the ordered-vs-shipped gap. Short/over require explicit confirmation
    (SPEC step 5). Sets status RECONCILED and the ship_short flag."""
    if transfer.status not in (ShipOutLifecycle.SCANNING.value, ShipOutLifecycle.CHECKED_IN.value,
                               ShipOutLifecycle.RECONCILED.value):
        raise ValidationError("Order isn't in a state that can be reconciled.")
    summary = order_reconcile_summary(db, transfer)
    if summary["any_short"] and not confirm_short:
        raise ValidationError("SHORT_CONFIRM_REQUIRED")
    if summary["any_over"] and not confirm_over:
        raise ValidationError("OVER_CONFIRM_REQUIRED")
    transfer.ship_short = bool(summary["any_short"])
    transfer.reconciled_at = datetime.now(timezone.utc)
    transfer.reconciled_by = str(current_user.id)
    transfer.status = ShipOutLifecycle.RECONCILED.value
    return transfer


# ---------------------------------------------------------------------------
# Task 8: seal + document generation (Packing Slip + BOL).
# ---------------------------------------------------------------------------
_SHIP_FROM = {
    "name": "SUNBERRY PAW PAW BEVERAGES LIMITED LLC",
    "address": "815 S KALAMAZOO ST", "city_state_zip": "PAW PAW, MI 49079",
}
_BILL_TO = {
    "name": "SUNBERRY LIMITED, LLC",
    "lines": ["PO BOX 426", "BRIGHTON MI 48116 US"],
}
_NMFC = "73227"
_FREIGHT_CLASS = "60"
_FREIGHT_DESC = "FOODSTUFF OTHER THAN FROZEN"


def _shipped_by_product_lot(transfer: InventoryTransfer):
    """Returns (rows_by_product_lot, cases_by_product). rows: {(pid,lot): cases}
    from scanned lot_allocations + manual attributions."""
    rows: dict = {}
    by_product: dict = {}
    for ln in (transfer.lines or []):
        pid = ln.product_id
        for a in (ln.lot_allocations or []):
            picked = float(a.get("cases_picked") or 0)
            if picked > 0:
                lot = a.get("lot_number") or ""
                rows[(pid, lot)] = rows.get((pid, lot), 0.0) + picked
                by_product[pid] = by_product.get(pid, 0.0) + picked
        for m in (ln.manual_attributions or []):
            c = float(m.get("cases") or 0)
            if c > 0:
                lot = m.get("lot_number") or ""
                rows[(pid, lot)] = rows.get((pid, lot), 0.0) + c
                by_product[pid] = by_product.get(pid, 0.0) + c
    return rows, by_product


def _computed_pallet_count(db: Session, by_product: dict, products: dict) -> int:
    import math
    total = 0
    for pid, cases in by_product.items():
        cpp = products[pid].default_cases_per_pallet
        total += int(math.ceil(cases / cpp)) if cpp else 0
    return total


def generate_documents(db: Session, transfer: InventoryTransfer, seal_number: Optional[str],
                       time_out, pallet_count_override: Optional[int], current_user) -> dict:
    """Generate Packing Slip + BOL from ACTUAL shipped, freeze a snapshot, assign
    a BOL number, and lock the order (SPEC step 6 / §5.4/5.9)."""
    if transfer.is_locked and transfer.document_snapshot:
        return transfer.document_snapshot
    if transfer.status not in (ShipOutLifecycle.RECONCILED.value, ShipOutLifecycle.COMPLETE.value):
        raise ValidationError("Reconcile the order before generating documents.")

    # Kickoff decision: driver name/license and seal are REQUIRED here — a BOL
    # must not print with blank driver or seal fields. Tractor/truck # and
    # trailer # are OPTIONAL: some loads (e.g. customer pickups) have no
    # tractor/trailer to record, so they print blank rather than block the BOL.
    effective_seal = seal_number or transfer.seal_number
    missing_info = []
    if not (transfer.driver_name or "").strip():
        missing_info.append("driver name")
    if not (transfer.driver_license or "").strip():
        missing_info.append("driver license #")
    if not (effective_seal or "").strip():
        missing_info.append("seal #")
    if missing_info:
        raise ValidationError(
            "Missing required info for the BOL: " + ", ".join(missing_info)
            + ". Use Edit Check-In to complete driver details."
        )

    rows, by_product = _shipped_by_product_lot(transfer)
    if not by_product:
        raise ValidationError("Nothing has shipped on this order yet.")
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(list(by_product))).all()}

    # §5.9: fail loudly on missing master data.
    missing = []
    for pid in by_product:
        p = products.get(pid)
        weight = p.package_size.case_weight if (p and p.package_size) else None
        if not weight:
            missing.append(f"{p.name if p else pid} (case weight)")
        if not (p and p.default_cases_per_pallet):
            missing.append(f"{p.name if p else pid} (cases per pallet)")
    if missing:
        raise ValidationError("Missing master data — set it before generating docs: " + "; ".join(sorted(set(missing))))

    pallet_count = pallet_count_override if pallet_count_override is not None else _computed_pallet_count(db, by_product, products)
    if pallet_count_override is not None:
        transfer.pallet_count_override = pallet_count_override

    pallet_weight = transfer.pallet_type.pallet_weight if transfer.pallet_type else 60.0
    product_weight = sum(cases * (products[pid].package_size.case_weight) for pid, cases in by_product.items())
    total_weight = round(product_weight + pallet_count * pallet_weight, 1)

    # Packing-slip lines: one per (item, lot), grouped.
    slip_lines = []
    for (pid, lot), cases in sorted(rows.items(), key=lambda kv: (products[kv[0][0]].name, kv[0][1])):
        p = products[pid]
        slip_lines.append({
            "order_number": transfer.order_number, "po_number": transfer.po_number,
            "item": p.fcc_code or p.short_code or p.id, "description": p.name,
            "quantity": int(cases), "uom": "CS", "lot_number": lot or None,
        })
    # Pallet line on the slip (chargeable pallets).
    pt = transfer.pallet_type
    if pt and pallet_count:
        slip_lines.append({
            "order_number": None, "po_number": None,
            "item": pt.item_code, "description": pt.description,
            "quantity": pallet_count, "uom": "EA", "lot_number": None,
        })

    loc = transfer.ship_to_location
    if transfer.bol_number:
        bol_number = transfer.bol_number
    else:
        # A GSIN, not a counter — see app/utils/gs1.py. nextval() is atomic, so
        # two orders sealed at the same moment cannot draw the same serial.
        seq = db.execute(sa_text("SELECT nextval('bol_number_seq')")).scalar()
        bol_number = build_bol_number(seq)

    snapshot = {
        "bol_number": bol_number,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ship_from": _SHIP_FROM, "bill_to": _BILL_TO,
        "ship_to": ({
            "customer_name": loc.customer_name, "location_name": loc.location_name,
            "address_line1": loc.address_line1, "address_line2": loc.address_line2,
            "city": loc.city, "state": loc.state, "zip_code": loc.zip_code,
        } if loc else None),
        "order_number": transfer.order_number, "po_number": transfer.po_number,
        "carrier": transfer.carrier, "appointment_time": transfer.appointment_time,
        "ship_date": transfer.scheduled_date.isoformat() if transfer.scheduled_date else None,
        "slip_lines": slip_lines,
        "total_cases": int(sum(by_product.values())),
        "pallet_count": pallet_count,
        "weight": {"product": round(product_weight, 1), "pallets": round(pallet_count * pallet_weight, 1), "total": total_weight},
        "nmfc": _NMFC, "freight_class": _FREIGHT_CLASS, "freight_description": _FREIGHT_DESC,
        "driver_name": transfer.driver_name, "driver_license": transfer.driver_license,
        "truck_number": transfer.truck_number, "truck_license": transfer.truck_license,
        "trailer_number": transfer.trailer_number,
        "trailer_license": transfer.trailer_license, "seal_number": (seal_number or transfer.seal_number),
        "time_in": transfer.time_in.isoformat() if transfer.time_in else None,
        "time_out": (time_out.isoformat() if time_out else (transfer.time_out.isoformat() if transfer.time_out else None)),
        "ship_short": bool(transfer.ship_short),
    }

    transfer.bol_number = bol_number
    transfer.document_snapshot = snapshot
    transfer.seal_number = seal_number or transfer.seal_number
    if time_out is not None:
        transfer.time_out = time_out
    transfer.docs_generated_at = datetime.now(timezone.utc)
    transfer.docs_generated_by = str(current_user.id)
    transfer.status = ShipOutLifecycle.DOCS_GENERATED.value
    transfer.is_locked = True
    return snapshot


def void_documents(db: Session, transfer: InventoryTransfer, reason: str, current_user) -> InventoryTransfer:
    """SPEC §5.4: explicitly void generated documents so the order can be
    corrected and regenerated. The old snapshot is archived and its BOL number
    BURNED (the sequence only moves forward); the order returns to RECONCILED
    unlocked."""
    if not (transfer.is_locked and transfer.document_snapshot):
        raise ValidationError("This order has no generated documents to void.")
    if not (reason or "").strip():
        raise ValidationError("A reason is required to void documents.")
    archive = list(transfer.voided_documents or [])
    archive.append({
        "snapshot": transfer.document_snapshot,
        "voided_by": str(current_user.id),
        "voided_at": datetime.now(timezone.utc).isoformat(),
        "reason": reason.strip(),
    })
    transfer.voided_documents = archive
    transfer.document_snapshot = None
    transfer.bol_number = None  # burned — regeneration draws a fresh number
    transfer.is_locked = False
    transfer.docs_generated_at = None
    transfer.docs_generated_by = None
    transfer.status = ShipOutLifecycle.RECONCILED.value
    return transfer


def create_pick_list_v2(
    db: Session, data, current_user, target_warehouse_id: Optional[str]
) -> InventoryTransfer:
    """Submit a lot-level ship-out order. Locks candidate pallet rows of each
    (product, lot) before inserting reservations, so concurrent submits on
    the same lot serialize."""

    if not data.lines:
        raise ValidationError("Ship-out has no lines")

    # 1. Validate each line's per-lot allocations sum to cases_requested.
    for li, line in enumerate(data.lines):
        alloc_sum = sum(float(la.cases_requested) for la in line.lot_allocations)
        if abs(alloc_sum - float(line.cases_requested)) > 0.001:
            raise ValidationError(
                f"Line {li + 1}: lot allocations sum to {alloc_sum} but "
                f"line requests {line.cases_requested}"
            )
        if any(la.cases_requested <= 0 for la in line.lot_allocations):
            raise ValidationError(
                f"Line {li + 1}: lot allocations must each request > 0 cases"
            )

    # 2. Fetch the live pallet pool per product (used only to split each lot
    # allocation across its real receipts below).
    #
    # Ship-out orders are ADVISORY targets, not stock locks. A pick list can sit
    # pending for days — the truck may arrive late or never — so creating an
    # order must never reserve capacity or hide stock from other orders. We
    # therefore do NOT gate on available capacity here and do NOT create any
    # ShipOutLotReservation below: an order can be created whether the stock is
    # on hand or not, and every lot/row stays freely visible to every order.
    # Correctness is enforced at SCAN time instead (right product, in stock, not
    # on hold; a shipped pallet can't be scanned twice, so there's no oversell).
    product_ids = {ln.product_id for ln in data.lines}
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()}
    for pid in product_ids:
        if pid not in products:
            raise ValidationError(f"Product not found: {pid}")

    pallet_pools: dict[str, list[PalletLicence]] = {}
    for pid in product_ids:
        pallet_pools[pid] = _pallet_pool_for_product(db, pid, target_warehouse_id, lock=False)

    # 3. Persist parent + lines (no reservations — see note above).
    transfer_id = _new_id("transfer")
    total_cases = float(sum(float(ln.cases_requested) for ln in data.lines))

    transfer = InventoryTransfer(
        id=transfer_id,
        receipt_id=None,
        quantity=total_cases,
        unit="cases",
        transfer_type=TRANSFER_TYPE_SHIPPED_OUT,
        order_number=data.order_number,
        source_breakdown=None,  # source rows are dynamic; resolved at scan time
        pallet_licence_ids=[],  # filled as scans happen
        requested_by=str(current_user.id),
        warehouse_id=target_warehouse_id,
        status=TransferStatus.PENDING,
    )
    db.add(transfer)

    # 4. Create the parent transfer. Then for each UI line, resolve every lot
    # allocation into per-receipt portions, then group BY RECEIPT and persist
    # one InventoryTransferLine per (product, receipt). The line's
    # lot_allocations JSON can hold multiple lots when a single receipt feeds
    # more than one of the line's lots.
    #
    # Why group by receipt and not by (lot, receipt)? The DB has a unique
    # constraint on (transfer_id, product_id, receipt_id) inherited from v1.
    # Consolidating per receipt respects it and keeps reports correct (each
    # row still has a real receipt_id).
    line_seq_counter = 0
    for ui_li, line in enumerate(data.lines):
        pool = pallet_pools[line.product_id]

        # by_receipt: {receipt_id: [{lot_number, cases}, ...]}
        by_receipt: dict[str, list[dict]] = {}
        for la in line.lot_allocations:
            chunks = _split_lot_allocation_by_receipt(
                db, pool, line.product_id, la.lot_number,
                float(la.cases_requested),
            )
            if not chunks:
                raise ValidationError(
                    f"Could not resolve any receipts for lot {la.lot_number}"
                )
            for receipt_id, alloc_cases in chunks:
                by_receipt.setdefault(receipt_id, []).append({
                    "lot_number": la.lot_number,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                })

        for receipt_id, lot_entries in by_receipt.items():
            sub_id = _new_id("trln")
            sub_total = sum(e["cases_requested"] for e in lot_entries)
            db.add(InventoryTransferLine(
                id=sub_id,
                transfer_id=transfer_id,
                product_id=line.product_id,
                receipt_id=receipt_id,
                cases_requested=sub_total,
                cases_picked=0.0,
                pallet_licence_ids=[],
                lot_allocations=lot_entries,
                picks=[],
                lot_swap_history=[],
                # line_seq groups sub-lines that share a UI line so the
                # response/approver UI can collapse them visually.
                line_seq=ui_li * 1000 + line_seq_counter,
            ))
            line_seq_counter += 1

            # NOTE: intentionally NO ShipOutLotReservation is created. Ship-out
            # orders are advisory targets, not stock locks — reserving here would
            # silently hide the oldest lots/rows from other orders (FIFO
            # attribution) while a truck is delayed, which is exactly the
            # behaviour we want to avoid. Stock stays freely visible to every
            # order; oversell is prevented at scan time, not by reservations.

    db.flush()
    return transfer


def _split_lot_allocation_by_receipt(
    db: Session,
    pallet_pool: list,
    product_id: str,
    lot_number: str,
    cases_requested: float,
) -> list:
    """Split `cases_requested` of a (product, lot) across the receipts that
    contribute pallets to that lot, oldest-receipt first (FIFO).

    Returns a list of (receipt_id, cases_allocated) tuples summing to
    cases_requested. Pallets from the locked pool are filtered to the lot,
    grouped by receipt, sorted by each receipt's earliest pallet date as a
    proxy for receipt age.
    """
    in_lot = [
        pl for pl in pallet_pool
        if pl.product_id == product_id and (pl.lot_number or "") == lot_number
    ]
    by_receipt: dict[str, dict] = {}
    for pl in in_lot:
        rid = pl.receipt_id
        if not rid:
            continue
        entry = by_receipt.setdefault(rid, {"cases": 0.0, "oldest": None})
        entry["cases"] += float(pl.cases or 0)
        if pl.created_at and (entry["oldest"] is None or pl.created_at < entry["oldest"]):
            entry["oldest"] = pl.created_at

    if not by_receipt:
        return []

    # Cross-check the receipts' own dates so the FIFO order reflects when
    # inventory was received, not just when individual pallets were scanned.
    receipts = {
        r.id: r
        for r in db.query(Receipt).filter(Receipt.id.in_(list(by_receipt.keys()))).all()
    }

    def receipt_sort_key(rid: str):
        r = receipts.get(rid)
        if r and r.receipt_date:
            return (r.receipt_date, rid)
        if r and r.created_at:
            return (r.created_at, rid)
        return (by_receipt[rid]["oldest"] or datetime.max.replace(tzinfo=timezone.utc), rid)

    ordered_rids = sorted(by_receipt.keys(), key=receipt_sort_key)

    out: list = []
    remaining = float(cases_requested)
    for rid in ordered_rids:
        if remaining <= 0:
            break
        avail = by_receipt[rid]["cases"]
        take = min(remaining, avail)
        if take > 0:
            out.append((rid, take))
            remaining -= take
    return out


# ---------------------------------------------------------------------------
# Phase 2 — scanner view
# ---------------------------------------------------------------------------

def _partial_pallet_row(db: Session, warehouse_id: Optional[str]) -> Optional[StorageRow]:
    """The single storage row designated as the partial-pallet destination
    for this warehouse, if one exists."""
    rows = db.query(StorageRow).filter(
        StorageRow.is_partial_pallet_location == True,  # noqa: E712
        StorageRow.is_active == True,  # noqa: E712
    ).all()
    if not warehouse_id:
        return rows[0] if rows else None
    # StorageRow has no direct warehouse_id; resolve via the storage area /
    # sub-location → location → warehouse chain so a partial pull never homes
    # the remainder pallet into another warehouse's row.
    for row in rows:
        if warehouse_id_for_row(db, row.id) == warehouse_id:
            return row
    return None


def _blocked_rows_for_line(line: InventoryTransferLine) -> dict[str, set[str]]:
    """Build a {lot_number -> {row_ids}} map of rows this line has marked
    inaccessible via the escape hatch. Used to skip those rows in the
    scanner view."""
    out: dict[str, set[str]] = {}
    for entry in (line.lot_swap_history or []):
        from_lot = entry.get("from_lot")
        blocked = entry.get("blocked_row_ids") or []
        if not from_lot:
            continue
        out.setdefault(from_lot, set()).update(blocked)
    return out


def scanner_view_for_transfer(
    db: Session, transfer: InventoryTransfer
) -> dict:
    """Render the forklift's view of a transfer: per-line, per-open-lot,
    per-row, with pallets inside each row sorted by sequence ASC."""
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")

    partial_row = _partial_pallet_row(db, transfer.warehouse_id)
    partial_row_view = (
        {
            "row_id": partial_row.id,
            "row_name": partial_row.name,
            "cases": float(partial_row.occupied_cases or 0),
            "pallets": int(partial_row.occupied_pallets or 0),
        }
        if partial_row
        else None
    )

    # Aggregate DB sub-lines into UI-level lines by (line_seq // 1000) —
    # that's the UI line index we encoded at submit. Falls back to product_id
    # grouping for any sub-lines whose line_seq doesn't follow the scheme
    # (e.g. drift sub-lines created at scan time, line_seq=1_000_000).
    grouped: dict = {}
    for sub in sorted(list(transfer.lines or []), key=lambda l: l.line_seq or 0):
        ui_key = (sub.line_seq or 0) // 1000
        # Drift sub-lines (line_seq=1_000_000) should fold into whichever UI
        # line already has this product. If none, they form their own group.
        if (sub.line_seq or 0) >= 1_000_000:
            existing = next(
                (k for k, g in grouped.items() if g["product_id"] == sub.product_id),
                None,
            )
            if existing is not None:
                ui_key = existing
        g = grouped.setdefault(ui_key, {
            "product_id": sub.product_id,
            "subs": [],
        })
        g["subs"].append(sub)

    lines_payload = []
    for ui_key, group in grouped.items():
        sub_lines = group["subs"]
        product_id = group["product_id"]
        product = db.query(Product).filter(Product.id == product_id).first()

        # Sum allocations per lot across sub-lines so the forklift sees ONE
        # entry per (product, lot) regardless of how many receipts back it.
        lot_totals: dict[str, dict] = {}
        for sub in sub_lines:
            for alloc in (sub.lot_allocations or []):
                lot = alloc.get("lot_number") or ""
                if not lot:
                    continue
                e = lot_totals.setdefault(lot, {"requested": 0.0, "picked": 0.0})
                e["requested"] += float(alloc.get("cases_requested") or 0)
                e["picked"] += float(alloc.get("cases_picked") or 0)

        # Union of blocked rows across sub-lines (per lot).
        blocked_combined: dict[str, set] = {}
        for sub in sub_lines:
            for lot, rows in _blocked_rows_for_line(sub).items():
                blocked_combined.setdefault(lot, set()).update(rows)

        lots_payload = []
        line_cases_requested = sum(float(s.cases_requested or 0) for s in sub_lines)
        line_cases_picked = sum(float(s.cases_picked or 0) for s in sub_lines)
        # Remaining is a PRODUCT-level figure: max(0, Σrequested − Σpicked)
        # across every sub-line/lot — NOT the sum of per-lot clamped remainders.
        # Lots are advisory under soft totals, so a pick that lands on one lot
        # (a lot the forklift switched to mid-pick, or a drift lot whose
        # cases_requested is 0) must still credit the product's outstanding
        # total. Summing per-lot max(0, requested − picked) instead clamps those
        # picks away, leaving the product looking under-picked forever and
        # blocking the forklift — the 640/960 bug.
        line_remaining_total = max(0.0, line_cases_requested - line_cases_picked)
        product_complete = line_remaining_total <= 0.001

        # Scheduled orders plan by product+cases only (no lot allocations), so
        # there is nothing in lot_totals to render. Surface LIVE lots for the
        # product — oldest first (FIFO) — as advisory guidance so the forklift
        # knows which lot/rack to pull from, exactly like the old flow's
        # "FIFO or specific lot" view. Any lot is acceptable at scan time.
        advisory_mode = not any(
            float(a.get("cases_requested") or 0) > 0
            for s in sub_lines for a in (s.lot_allocations or [])
        )
        fifo_first_lot = None
        if advisory_mode and not product_complete:
            for entry in available_lots_for_product(db, product_id, transfer.warehouse_id):
                lot = entry.get("lot_number") or ""
                if not lot:
                    continue
                if fifo_first_lot is None:
                    fifo_first_lot = lot
                lot_totals.setdefault(lot, {"requested": 0.0, "picked": 0.0})

        for lot_number, totals in lot_totals.items():
            cases_remaining = max(0.0, totals["requested"] - totals["picked"])
            has_picks = float(totals["picked"] or 0) > 0
            # Visibility is gated at the PRODUCT level, not per lot. While the
            # product still owes cases, every lot keeps surfacing its fresh
            # pallets so the forklift can fulfill from whichever lot is
            # physically on the floor. Once the product's total is met, show
            # only already-picked pallets (so a leaker can still be Removed),
            # not fresh ones.
            if product_complete and not has_picks:
                continue

            # Live pallets matching this product+lot+warehouse — both
            # IN_STOCK (still pending pick) AND SHIPPED-via-this-transfer
            # (already picked, shown as checkmark in the UI).
            pq = db.query(PalletLicence).filter(
                PalletLicence.product_id == product_id,
                PalletLicence.lot_number == lot_number,
                PalletLicence.is_held == False,  # noqa: E712
                PalletLicence.is_deleted == False,  # noqa: E712,
                sa_or(
                    PalletLicence.status == PalletStatus.IN_STOCK,
                    sa_and(
                        PalletLicence.status == PalletStatus.SHIPPED,
                        PalletLicence.transfer_id == transfer.id,
                    ),
                ),
            )
            if transfer.warehouse_id:
                pq = pq.filter(PalletLicence.warehouse_id == transfer.warehouse_id)
            pallets = pq.all()

            # Map pallet_licence_id -> picked entry from any sub-line for
            # this lot, so we can show consumed-cases on the UI line.
            picked_lookup: dict[str, dict] = {}
            for sub in sub_lines:
                for pick in (sub.picks or []):
                    pid = pick.get("pallet_licence_id")
                    if pid:
                        picked_lookup[pid] = pick

            blocked_rows_for_lot = blocked_combined.get(lot_number, set())
            rows_map: dict[str, list[PalletLicence]] = {}
            for pl in pallets:
                # Pallets that shipped under THIS transfer keep their
                # original storage row visible (they've moved physically,
                # but the forklift wants to see them where they were before
                # they got pulled). The scanner-view shows them grouped
                # under that row with a "picked" flag.
                rid = pl.storage_row_id or ""
                rows_map.setdefault(rid, []).append(pl)

            row_ids = [r for r in rows_map.keys() if r]
            row_lookup = {
                r.id: r
                for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
            } if row_ids else {}

            rows_payload = []
            for rid, pl_list in rows_map.items():
                pl_list_sorted = sorted(pl_list, key=lambda p: (p.sequence or 0))
                row_obj = row_lookup.get(rid) if rid else None
                pallets_view = []
                pending_pallets = 0
                pending_cases = 0.0
                for pl in pl_list_sorted:
                    pick = picked_lookup.get(pl.id)
                    is_picked = pick is not None
                    # Once the product's total is met, only surface the
                    # already-picked pallets (for Remove) — hide fresh ones.
                    if product_complete and not is_picked:
                        continue
                    pallets_view.append({
                        "pallet_licence_id": pl.id,
                        "licence_number": pl.licence_number or "",
                        "sequence": pl.sequence or 0,
                        "cases": float(pl.cases or 0),
                        "lot_number": pl.lot_number or "",
                        "is_picked": is_picked,
                        "cases_consumed": float(pick.get("cases_consumed") or 0) if pick else None,
                        "was_partial": bool(pick.get("was_partial")) if pick else False,
                    })
                    if not is_picked:
                        pending_pallets += 1
                        pending_cases += float(pl.cases or 0)
                # When the product is complete, drop rows that have nothing
                # picked to show.
                if product_complete and not pallets_view:
                    continue
                rows_payload.append({
                    "row_id": rid or None,
                    "row_name": row_obj.name if row_obj else "Floor",
                    "is_blocked": rid in blocked_rows_for_lot,
                    "pallets": pallets_view,
                    # Counts and totals reflect what's LEFT to pick in this
                    # row — already-picked pallets don't inflate the number.
                    "cases_total": pending_cases,
                    "pallets_total": pending_pallets,
                })
            rows_payload.sort(key=lambda r: (r["is_blocked"], r["row_name"] or ""))

            # Advisory lots (scheduled orders): per-lot "remaining" is
            # meaningless — show what's physically AVAILABLE in the lot.
            if advisory_mode:
                cases_remaining = sum(float(r["cases_total"] or 0) for r in rows_payload)

            lots_payload.append({
                "lot_number": lot_number,
                "cases_remaining": cases_remaining,
                "rows": rows_payload,
                "is_suggested_swap": False,
                "is_advisory": advisory_mode,
                "is_fifo_suggested": advisory_mode and lot_number == fifo_first_lot,
            })

        lines_payload.append({
            # Use the first sub-line's id as the stable UI line key — escape
            # hatch resolves it to (product_id) and then operates across all
            # sibling sub-lines.
            "line_id": sub_lines[0].id,
            "product_id": product_id,
            "product_name": product.name if product else None,
            "product_short_code": product.short_code if product else None,
            "cases_requested": line_cases_requested,
            "cases_remaining": line_remaining_total,
            "lots": lots_payload,
        })

    return {
        "transfer_id": transfer.id,
        "order_number": transfer.order_number or "",
        "lines": lines_payload,
        "partial_pallet_row": partial_row_view,
    }


# ---------------------------------------------------------------------------
# Phase 2 — scan-pick
# ---------------------------------------------------------------------------

def _find_open_allocation_for_lot(line: InventoryTransferLine, lot_number: str) -> Optional[dict]:
    for alloc in (line.lot_allocations or []):
        if alloc.get("lot_number") == lot_number:
            cases_remaining = float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0)
            if cases_remaining > 0:
                return alloc
    return None


def _route_pick_to_sub_line(
    db: Session, transfer: InventoryTransfer, pl: PalletLicence,
    candidate_allocs: list,
) -> tuple:
    """Pick the sub-line whose receipt_id matches the scanned pallet's
    receipt_id. Fall back to:
      (a) any existing sub-line for (transfer, product, receipt_id) — add
          the lot allocation entry if needed
      (b) create a brand-new sub-line for that (product, receipt_id) when
          no matching sub-line was created at submit (drift case — pallet's
          receipt wasn't in the original lot split).

    Returns (sub_line, allocation_dict). The allocation dict is the entry
    inside sub_line.lot_allocations for the pallet's lot.
    """
    pl_receipt = pl.receipt_id
    pl_product = pl.product_id
    pl_lot = pl.lot_number or ""

    # 1. Best path: a candidate sub-line where receipt_id matches.
    for ln, alloc in candidate_allocs:
        if ln.receipt_id == pl_receipt:
            return ln, alloc

    # 2. A sub-line for (product, receipt) exists. Prefer an existing allocation
    # for this lot — even a fully-picked one — so an over-pull adds onto it
    # instead of creating a duplicate entry; otherwise add a fresh allocation.
    receipt_sub = next(
        (ln for ln in transfer.lines
         if ln.product_id == pl_product and ln.receipt_id == pl_receipt),
        None,
    )
    if receipt_sub is not None:
        for alloc in (receipt_sub.lot_allocations or []):
            if alloc.get("lot_number") == pl_lot:
                return receipt_sub, alloc
        new_alloc = {
            "lot_number": pl_lot,
            "cases_requested": 0.0,
            "cases_picked": 0.0,
        }
        receipt_sub.lot_allocations = list(receipt_sub.lot_allocations or []) + [new_alloc]
        return receipt_sub, new_alloc

    # 3. Drift: pallet's receipt wasn't in the plan at all. Create a fresh
    # sub-line so the pick is attributed to the right receipt for reports.
    new_alloc = {
        "lot_number": pl_lot,
        "cases_requested": 0.0,
        "cases_picked": 0.0,
    }
    new_sub = InventoryTransferLine(
        id=_new_id("trln"),
        transfer_id=transfer.id,
        product_id=pl_product,
        receipt_id=pl_receipt,
        cases_requested=0.0,
        cases_picked=0.0,
        pallet_licence_ids=[],
        lot_allocations=[new_alloc],
        picks=[],
        lot_swap_history=[],
        # Sort drift sub-lines after pre-planned ones in the response.
        line_seq=1_000_000,
    )
    db.add(new_sub)
    db.flush()
    return new_sub, new_alloc


def _release_row_capacity(db: Session, pl: PalletLicence, cases_to_remove: float) -> None:
    """Decrement the pallet's current row counters by N cases / 1 pallet."""
    if not pl.storage_row_id:
        return
    row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
    if not row:
        return
    row.occupied_pallets = max(0, (row.occupied_pallets or 0) - 1)
    row.occupied_cases = max(0, (row.occupied_cases or 0) - cases_to_remove)
    if row.occupied_pallets <= 0:
        row.product_id = None


def _add_to_row(row: StorageRow, pl: PalletLicence, cases_added: float) -> None:
    row.occupied_pallets = (row.occupied_pallets or 0) + 1
    row.occupied_cases = (row.occupied_cases or 0) + cases_added
    if not row.product_id:
        row.product_id = pl.product_id


def _record_scan_event(
    db: Session,
    transfer_id: str,
    pallet: Optional[PalletLicence],
    licence_number: str,
    on_list: bool,
    scanned_by: Optional[str],
) -> None:
    db.add(TransferScanEvent(
        id=_new_id("scan"),
        transfer_id=transfer_id,
        licence_number=licence_number,
        licence_id=pallet.id if pallet else None,
        on_list=on_list,
        scanned_by=scanned_by,
    ))


def _build_swap_suggestion(
    db: Session, transfer: InventoryTransfer, product_id: str, scanned_lot: str
) -> Optional[dict]:
    """When the scanned pallet's lot isn't on any line, suggest swapping the
    line(s) for this product over to the scanned lot — if it's actually
    available."""
    pq = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.lot_number == scanned_lot,
        PalletLicence.status == PalletStatus.IN_STOCK,
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
    )
    if transfer.warehouse_id:
        pq = pq.filter(PalletLicence.warehouse_id == transfer.warehouse_id)
    pallets = pq.all()
    if not pallets:
        return None

    rows_map: dict[str, list[PalletLicence]] = {}
    for pl in pallets:
        rows_map.setdefault(pl.storage_row_id or "", []).append(pl)
    row_ids = [r for r in rows_map.keys() if r]
    row_lookup = {
        r.id: r for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
    } if row_ids else {}

    rows_payload = []
    for rid, pl_list in rows_map.items():
        pl_list_sorted = sorted(pl_list, key=lambda p: (p.sequence or 0))
        row_obj = row_lookup.get(rid) if rid else None
        rows_payload.append({
            "row_id": rid or None,
            "row_name": row_obj.name if row_obj else "Floor",
            "is_blocked": False,
            "pallets": [
                {
                    "pallet_licence_id": pl.id,
                    "licence_number": pl.licence_number or "",
                    "sequence": pl.sequence or 0,
                    "cases": float(pl.cases or 0),
                    "lot_number": pl.lot_number or "",
                }
                for pl in pl_list_sorted
            ],
            "cases_total": sum(float(pl.cases or 0) for pl in pl_list_sorted),
            "pallets_total": len(pl_list_sorted),
        })

    return {
        "lot_number": scanned_lot,
        "cases_remaining": sum(float(pl.cases or 0) for pl in pallets),
        "rows": rows_payload,
        "is_suggested_swap": True,
    }


def scan_pick_v2(
    db: Session, transfer: InventoryTransfer, licence_number: str,
    cases_to_consume: Optional[float], current_user,
    allow_live_load: bool = False, picked_via: str = "scan",
) -> dict:
    """Process a forklift scan against a v2 ship-out transfer.

    Returns a dict matching `ScanPickResponseV2`. Caller is responsible for
    commit/rollback.
    """
    _assert_scannable(transfer)
    # First scan of a checked-in truck flips it to "loading" (stays on the gun).
    if transfer.status == ShipOutLifecycle.CHECKED_IN.value:
        transfer.status = ShipOutLifecycle.SCANNING.value

    user_id = str(current_user.id) if current_user else None

    # 1. Normalize the licence number — strip leading/trailing whitespace and
    # collapse any internal whitespace (copy-paste sometimes injects an
    # invisible space, e.g. 'MP14426L1-GVN128C -079'). DB values never
    # contain whitespace, so this is always safe.
    licence_number = "".join((licence_number or "").split())

    pl = (
        db.query(PalletLicence)
        .filter(PalletLicence.licence_number == licence_number)
        .with_for_update()
        .first()
    )
    if not pl:
        _record_scan_event(db, transfer.id, None, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_NOT_FOUND.value,
            "message": f"Pallet licence not found: {licence_number}",
        }

    label = pl.licence_number or pl.id

    # 2. Pallet hygiene checks.
    if pl.is_held:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {label} is on hold",
        }
    # Live-load (SPEC §5.7): a PENDING pallet is fresh off the palletizer (its
    # receipt isn't approved yet). Accept it behind a one-tap confirm instead of
    # rejecting. On confirm it ships direct; next-day receipt approval only
    # touches still-PENDING pallets, so this one is naturally skipped.
    is_live_load = pl.status == PalletStatus.PENDING
    if is_live_load and not allow_live_load:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.LIVE_LOAD_NEEDS_CONFIRM.value,
            "message": f"Pallet {label} is from today's production. Live-load it onto the truck?",
        }
    if pl.status not in (PalletStatus.IN_STOCK, PalletStatus.PENDING):
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        # Distinguish "the worker already scanned this pallet onto THIS order"
        # (a harmless double-scan — reassure, don't alarm) from "it shipped on a
        # different order" (a genuine unavailable pallet).
        if pl.status == PalletStatus.SHIPPED and pl.transfer_id == transfer.id:
            return {
                "ok": False,
                "reject_reason": ShipOutScanReason.ALREADY_ON_THIS_ORDER.value,
                "message": f"Pallet {label} is already on this load — you scanned it already.",
            }
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": (
                f"Pallet {label} already shipped out on another order"
                if pl.status == PalletStatus.SHIPPED
                else f"Pallet {label} is not in stock (status: {pl.status})"
            ),
        }
    # Reject pallets that don't belong to this order's warehouse — including
    # NULL-warehouse pallets — to match _pallet_pool_for_product's filter, so a
    # pallet the picker can't see can't be force-scanned either.
    if transfer.warehouse_id and pl.warehouse_id != transfer.warehouse_id:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {label} belongs to another warehouse",
        }

    # 3. Confirm the order has at least one open allocation for (product, lot).
    # The pick routes by receipt later — here we just check that the lot is
    # on the order at all.
    lines = list(transfer.lines or [])
    lines_for_product = [ln for ln in lines if ln.product_id == pl.product_id]
    if not lines_for_product:
        _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
        return {
            "ok": False,
            "reject_reason": ShipOutScanReason.WRONG_PRODUCT.value,
            "message": f"Pallet {label} is for a product not on this order",
        }

    # Aggregate every allocation for (product, lot) across all sub-lines.
    # The "is the lot fully picked?" check has to look at the **lot-level**
    # sum — picks may have accumulated on a drift sub-line whose
    # `cases_requested` is zero, while the planned sub-line still appears
    # to have remaining capacity. Per-sub-line evaluation lets over-scans
    # slip through.
    total_planned = 0.0
    total_picked_for_lot = 0.0
    lot_was_planned = False
    candidate_allocs: list = []  # allocs that still have room — used to satisfy fresh picks
    for ln in lines_for_product:
        for alloc in (ln.lot_allocations or []):
            if alloc.get("lot_number") != (pl.lot_number or ""):
                continue
            req = float(alloc.get("cases_requested") or 0)
            picked = float(alloc.get("cases_picked") or 0)
            # Drift allocs (created BY earlier scans, cases_requested == 0) are
            # not plans — treating them as planned made every second scan of a
            # lot read as "over the ordered amount" on scheduled orders.
            if req > 0:
                lot_was_planned = True
            total_planned += req
            total_picked_for_lot += picked
            if req - picked > 0:
                candidate_allocs.append((ln, alloc))

    # Scheduled orders (SPEC Task 2) plan by PRODUCT + cases only — lots are
    # chosen live at scan time. When no lot was ever planned for this product,
    # any lot is acceptable and "over" means the product's ordered total is
    # exceeded, not some per-lot number.
    product_ordered = sum(float(ln.cases_requested or 0) for ln in lines_for_product)
    product_picked = sum(float(ln.cases_picked or 0) for ln in lines_for_product)
    has_planned_lots = any(
        float(a.get("cases_requested") or 0) > 0
        for ln in lines_for_product for a in (ln.lot_allocations or [])
    )

    if has_planned_lots:
        lot_remaining = max(0.0, total_planned - total_picked_for_lot)
        # Lots are advisory under soft totals — nothing here rejects the scan.
        is_overage = bool(lot_was_planned and lot_remaining <= 0.001)
        lot_hint = (
            None if lot_was_planned
            else _build_swap_suggestion(db, transfer, pl.product_id, pl.lot_number or "")
        )
    else:
        lot_remaining = max(0.0, product_ordered - product_picked)
        is_overage = False  # finalized below once `consumed` is known
        lot_hint = None

    # 3b. Hard stop at the ordered quantity — GUN ONLY, scheduled orders.
    # The forklift scanner stops the loader once a product's ordered cases are
    # met (mirrors the legacy v1 scanner's "quantity reached / line complete").
    # Two behaviours:
    #   (a) product already at/over its ordered total  → refuse the scan.
    #   (b) this whole pallet would overshoot the total → offer a partial pull
    #       of exactly what's still needed; the remainder goes to the Partials
    #       rack once the forklift confirms (client re-scans with
    #       cases_to_consume = suggested_partial_cases).
    # Scoped deliberately:
    #   • picked_via == "scan"      → gun only; office paths (Select-pallets,
    #     Fix-over-ship) use picked_via="manual_select" and stay permissive so
    #     supervisors can still correct a load.
    #   • not has_planned_lots      → scheduled orders (plan by product+cases).
    #     Lot-planned orders keep the soft-total behaviour they were built with.
    #   • cases_to_consume is None  → only the first, whole-pallet scan; the
    #     partial-confirm re-scan (cases_to_consume set) passes straight through.
    if (
        picked_via == "scan"
        and not has_planned_lots
        and cases_to_consume is None
        and product_ordered > 0.001
    ):
        product_remaining_before = max(0.0, product_ordered - product_picked)
        prod = db.query(Product).filter(Product.id == pl.product_id).first()
        prod_label = (prod.short_code or prod.name) if prod else "this product"
        ordered_i = int(round(product_ordered))
        picked_i = int(round(product_picked))

        # (a) Line already complete — quantity reached.
        if product_remaining_before <= 0.001:
            _record_scan_event(db, transfer.id, pl, licence_number, on_list=False, scanned_by=user_id)
            return {
                "ok": False,
                "reject_reason": ShipOutScanReason.LINE_COMPLETE.value,
                "message": (
                    f"Quantity reached for {prod_label} — "
                    f"{picked_i}/{ordered_i} cases already loaded."
                ),
            }

        # (b) This pallet would push the product past its ordered total — offer
        # a partial pull of just what's needed (remainder → Partials rack).
        pallet_cases_now = float(pl.cases or 0)
        needed = int(round(product_remaining_before))
        if pallet_cases_now > product_remaining_before + 0.001 and needed > 0:
            leftover = int(round(pallet_cases_now - needed))
            return {
                "ok": False,
                "needs_partial_confirm": True,
                "suggested_partial_cases": float(needed),
                "line_id": lines_for_product[0].id,
                "message": (
                    f"{prod_label} needs {needed} more cs to finish "
                    f"({picked_i}/{ordered_i}). This pallet has "
                    f"{int(round(pallet_cases_now))} cs — pull {needed} and move "
                    f"{leftover} cs to the Partials rack?"
                ),
            }

    # 4. Full pull by default — whole pallets are never force-broken to hit an
    # exact lot/line total. A partial pull happens only when the forklift
    # explicitly asks for one (sends cases_to_consume).
    pallet_cases = float(pl.cases or 0)

    if cases_to_consume is not None:
        consumed = float(cases_to_consume)
        # Cases are discrete — a fractional partial pull would desync the receipt
        # from the rounded pallet remainder (minting or destroying cases).
        if consumed != int(consumed):
            raise ValidationError(
                f"Partial cases must be a whole number, got {consumed}"
            )
        consumed = int(consumed)
        if consumed <= 0 or consumed > pallet_cases + 0.001:
            raise ValidationError(
                f"Invalid partial cases: {consumed} (pallet has {pallet_cases})"
            )
        was_partial = consumed < pallet_cases
    else:
        consumed = pallet_cases
        was_partial = False

    # Scheduled orders: over = this pull pushes the PRODUCT past its ordered
    # total (judged post-pick, since any lot is acceptable).
    if not has_planned_lots:
        is_overage = (product_picked + consumed) > product_ordered + 0.001

    # 5. Route the pick to the sub-line whose receipt_id matches this pallet's,
    # so receipt-filtered reports stay accurate. Drift case (pallet's receipt
    # wasn't in the original split) creates a fresh sub-line.
    target_line, target_alloc = _route_pick_to_sub_line(db, transfer, pl, candidate_allocs)

    # 6. Apply the pick.
    now = datetime.now(timezone.utc)
    pick_entry = {
        "pallet_licence_id": pl.id,
        "cases_consumed": consumed,
        "was_partial": was_partial,
        # Capture the origin row BEFORE the pallet is mutated below, so an
        # unscan can restore the pallet to exactly where it came from.
        "storage_row_id": pl.storage_row_id,
        "scanned_at": now.isoformat(),
        "scanned_by": user_id,
        # SPEC §5.7/§5.8: how this pallet joined the order and whether it was a
        # fresh-off-the-line (PENDING) pallet loaded direct to the truck.
        "picked_via": picked_via,
        "live_loaded": bool(is_live_load),
    }

    # Append to the line's picks (JSON column — copy + reassign so SQLAlchemy
    # detects the mutation).
    new_picks = list(target_line.picks or []) + [pick_entry]
    target_line.picks = new_picks
    target_line.cases_picked = float(target_line.cases_picked or 0) + consumed

    # Mirror the picked pallet onto the line's denormalized pallet_licence_ids
    # so the approver UI's per-line pallet count reflects actual scans.
    line_ids = list(target_line.pallet_licence_ids or [])
    if pl.id not in line_ids:
        line_ids.append(pl.id)
    target_line.pallet_licence_ids = line_ids

    new_allocs = []
    for a in (target_line.lot_allocations or []):
        if a.get("lot_number") == target_alloc.get("lot_number") and (a is target_alloc or a == target_alloc):
            new_allocs.append({**a, "cases_picked": float(a.get("cases_picked") or 0) + consumed})
        else:
            new_allocs.append(a)
    target_line.lot_allocations = new_allocs

    # Update the parent transfer's denormalized pallet_licence_ids
    parent_ids = list(transfer.pallet_licence_ids or [])
    if pl.id not in parent_ids:
        parent_ids.append(pl.id)
    transfer.pallet_licence_ids = parent_ids

    # 6. Mutate the pallet itself.
    row_emptied: Optional[str] = None
    remaining_after = int(max(0, round(pallet_cases - consumed)))
    if was_partial and remaining_after > 0:
        # Normal partial: cases left over → move to Partials row.
        partial_row = _partial_pallet_row(db, transfer.warehouse_id)
        if not partial_row:
            raise ValidationError(
                "No partial-pallet row configured for this warehouse — set "
                "`is_partial_pallet_location=true` on one storage row first."
            )
        # Free original row of the FULL original case count (before decrement).
        _release_row_capacity(db, pl, pallet_cases)
        prev_row_id = pl.storage_row_id
        pl.cases = remaining_after
        pl.is_partial = True
        pl.storage_row_id = partial_row.id
        pl.storage_area_id = partial_row.storage_area_id
        _add_to_row(partial_row, pl, float(remaining_after))
        # Check whether the original row hit zero (only meaningful if the
        # pallet actually moved; pulling a partial pallet that was already
        # at the Partials row won't empty anything new).
        if prev_row_id and prev_row_id != partial_row.id:
            prev = db.query(StorageRow).filter(StorageRow.id == prev_row_id).first()
            if prev and (prev.occupied_pallets or 0) <= 0:
                row_emptied = prev_row_id
    else:
        # Either a full-pull (consumed == pallet_cases) or a partial-pull
        # that happened to drain the pallet to zero — both end the same
        # way: pallet is gone, mark SHIPPED, free the row.
        _release_row_capacity(db, pl, pallet_cases)
        prev_row_id = pl.storage_row_id
        pl.cases = 0 if was_partial else pl.cases  # zero out for drain-from-partial
        pl.status = PalletStatus.SHIPPED
        pl.transfer_id = transfer.id
        if prev_row_id:
            prev = db.query(StorageRow).filter(StorageRow.id == prev_row_id).first()
            if prev and (prev.occupied_pallets or 0) <= 0:
                row_emptied = prev_row_id

    # 7. Rebuild receipt allocation so the FG occupancy view stays in sync.
    if pl.receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == pl.receipt_id).first()
        if receipt:
            _rebuild_receipt_allocation_from_licences(db, receipt)
            # Decrement receipt's overall quantity by the cases that shipped
            # (only the shipped portion; partials keep their remainder).
            receipt.quantity = max(0.0, float(receipt.quantity or 0) - consumed)

    # 8. Release reservation capacity by the consumed amount. Reservations pool
    # at the product level (Phase D), so we drain this order's reservations for
    # the pallet's product FIFO — regardless of lot — by `consumed`. The min()
    # clamp means an over-pull simply drains the order's reservations to zero
    # (never negative); over-pull is against real stock, so no oversell.
    product_line_ids = [
        ln.id for ln in transfer.lines if ln.product_id == pl.product_id
    ]
    remaining_to_release = consumed
    if product_line_ids:
        sibling_reservations = (
            db.query(ShipOutLotReservation)
            .filter(
                ShipOutLotReservation.transfer_line_id.in_(product_line_ids),
                ShipOutLotReservation.released_at.is_(None),
            )
            .order_by(ShipOutLotReservation.created_at)
            .all()
        )
        # Drain target_line's own reservation first if it has one.
        sibling_reservations.sort(key=lambda r: 0 if r.transfer_line_id == target_line.id else 1)
        for r in sibling_reservations:
            if remaining_to_release <= 0.001:
                break
            take = min(remaining_to_release, float(r.cases_reserved))
            new_reserved = float(r.cases_reserved) - take
            if new_reserved <= 0.001:
                r.released_at = now
                r.cases_reserved = 0.0
            else:
                r.cases_reserved = new_reserved
            remaining_to_release -= take

    # 9. Audit scan event.
    _record_scan_event(db, transfer.id, pl, licence_number, on_list=True, scanned_by=user_id)

    # Compute remaining at the UI-line (product) level: clamp ONCE on the
    # summed totals — max(0, Σrequested − Σpicked) — not as a sum of per-sub-line
    # clamped remainders. The latter discards picks that landed on a drift or
    # retargeted sub-line whose cases_requested is 0, wrongly keeping the line
    # under-picked (mirrors scanner_view_for_transfer's product-level math).
    line_req_total = sum(
        float(ln.cases_requested or 0)
        for ln in transfer.lines if ln.product_id == pl.product_id
    )
    line_picked_total = sum(
        float(ln.cases_picked or 0)
        for ln in transfer.lines if ln.product_id == pl.product_id
    )
    line_remaining_after = max(0.0, line_req_total - line_picked_total)
    lot_remaining_after = lot_remaining - consumed

    return {
        "ok": True,
        "pick": pick_entry,
        "line_id": target_line.id,
        "line_remaining": max(0.0, line_remaining_after),
        "lot_remaining": max(0.0, lot_remaining_after),
        "row_emptied": row_emptied,
        "partial_pallet_remaining": float(pl.cases or 0) if was_partial else None,
        "is_overage": is_overage,
        "lot_hint": lot_hint,
        "message": (
            f"Pulled {consumed:g} cases from pallet {label}"
            + (" (partial)" if was_partial else "")
            + (" — over the ordered amount" if is_overage else "")
            + (
                f" — note: lot {pl.lot_number} isn't the recommended (oldest) lot"
                if lot_hint else ""
            )
        ),
    }


def unscan_pick_v2(
    db: Session, transfer: InventoryTransfer, pallet_licence_id: str,
    reason: str, current_user
) -> dict:
    """Reverse a single recorded pick on an open (PENDING) v2 ship-out.

    The forklift uses this when a pallet was scanned by mistake, or when a
    scanned pallet turns out to be damaged (a leaker). Both reasons take the
    cases back off the order and return the physical pallet to its origin row;
    the difference is what happens to the pallet afterwards:

      - ``wrong_pallet``  → fully back in shippable stock, free to re-scan.
      - ``leaker_damaged`` → a PENDING pallet hold is created so a supervisor
        reviews it; the pallet stays in inventory but is blocked from shipping.

    Receipt on-hand is re-credited in both cases (the physical pallet still
    exists), and the lot reservation is restored (the order still owes those
    cases — the driver will pick a replacement). Partial-pull picks can't be
    unscanned here (they'd require reconstituting a split pallet) — use an
    inventory adjustment instead. Caller owns commit/rollback.
    """
    _assert_scannable(transfer)
    if reason not in ("wrong_pallet", "leaker_damaged"):
        raise ValidationError("reason must be 'wrong_pallet' or 'leaker_damaged'")

    user_id = str(current_user.id) if current_user else None

    # 1. Locate the pick across all sub-lines.
    target_line = None
    pick_entry = None
    pick_index = -1
    for ln in (transfer.lines or []):
        for i, p in enumerate(ln.picks or []):
            if p.get("pallet_licence_id") == pallet_licence_id:
                target_line, pick_entry, pick_index = ln, p, i
                break
        if pick_entry is not None:
            break

    if pick_entry is None:
        raise ValidationError("That pallet is not on this order's picked list")
    if pick_entry.get("was_partial"):
        raise ValidationError(
            "Partial pulls can't be removed here — correct with an inventory "
            "adjustment instead."
        )

    consumed = float(pick_entry.get("cases_consumed") or 0)
    pl = (
        db.query(PalletLicence)
        .filter(PalletLicence.id == pallet_licence_id)
        .with_for_update()
        .first()
    )
    if not pl:
        raise NotFoundError("PalletLicence", pallet_licence_id)
    lot_key = pl.lot_number or ""

    # 2. Remove the pick from the sub-line (copy+reassign for JSON mutation).
    target_line.picks = [
        p for j, p in enumerate(target_line.picks or []) if j != pick_index
    ]
    target_line.cases_picked = max(0.0, float(target_line.cases_picked or 0) - consumed)

    # Decrement the matching lot allocation's cases_picked (first match only).
    new_allocs, decremented = [], False
    for a in (target_line.lot_allocations or []):
        if not decremented and a.get("lot_number") == lot_key:
            new_allocs.append({
                **a,
                "cases_picked": max(0.0, float(a.get("cases_picked") or 0) - consumed),
            })
            decremented = True
        else:
            new_allocs.append(a)
    target_line.lot_allocations = new_allocs

    # Drop the pallet from the line + parent denormalized id lists.
    target_line.pallet_licence_ids = [
        x for x in (target_line.pallet_licence_ids or []) if x != pl.id
    ]
    transfer.pallet_licence_ids = [
        x for x in (transfer.pallet_licence_ids or []) if x != pl.id
    ]

    # 3. Restore the pallet to its origin row, IN_STOCK.
    pl.status = PalletStatus.IN_STOCK
    pl.transfer_id = None
    pl.cases = consumed  # full pull → the pallet held exactly `consumed` cases
    origin_row_id = pick_entry.get("storage_row_id") or pl.storage_row_id
    if origin_row_id:
        row = db.query(StorageRow).filter(StorageRow.id == origin_row_id).first()
        if row:
            pl.storage_row_id = row.id
            pl.storage_area_id = row.storage_area_id
            _add_to_row(row, pl, consumed)

    # 4. Re-credit the receipt's on-hand and rebuild its row allocation
    # (inverse of the scan-time decrement).
    if pl.receipt_id:
        receipt = db.query(Receipt).filter(Receipt.id == pl.receipt_id).first()
        if receipt:
            receipt.quantity = float(receipt.quantity or 0) + consumed
            _rebuild_receipt_allocation_from_licences(db, receipt)

    # 5. Restore reservation capacity (product-level) — the order still owes
    # these cases, so keep the product pool soft-locked against other orders.
    db.add(ShipOutLotReservation(
        id=_new_id("solr"),
        transfer_line_id=target_line.id,
        product_id=pl.product_id,
        lot_number=None,
        cases_reserved=consumed,
    ))

    # 6. Leaker → block the pallet from shipping via a PENDING pallet hold
    # (supervisor reviews it; existing hold-approval flow flips is_held).
    hold_created = False
    if reason == "leaker_damaged":
        import uuid as _uuid
        from types import SimpleNamespace
        from app.services import hold_service
        from app.models import InventoryHoldAction
        from app.enums import HoldStatus

        hold_input = SimpleNamespace(
            action="hold",
            reason=f"Damaged at ship-out (order {transfer.order_number})",
            pallet_licence_ids=[pl.id],
            hold_items=None,
            receipt_id=None,
            total_quantity=None,
        )
        hold_dict = hold_service.validate_and_build_hold_dict(db, hold_input)
        db.add(InventoryHoldAction(
            id=f"hold-{_uuid.uuid4().hex[:12]}",
            **hold_dict,
            submitted_by=user_id,
            warehouse_id=transfer.warehouse_id,
            status=HoldStatus.PENDING,
        ))
        hold_created = True

    # 7. Audit: a removal is recorded as a one-sided pallet swap (removed only).
    db.add(TransferPalletSwap(
        id=_new_id("swap"),
        transfer_id=transfer.id,
        transfer_line_id=target_line.id,
        removed_pallet_id=pl.id,
        added_pallet_id=None,
        swapped_by=user_id,
        reason=reason,
        source="forklift",
    ))

    line_remaining_after = sum(
        max(0.0, float(ln.cases_requested or 0) - float(ln.cases_picked or 0))
        for ln in transfer.lines
        if ln.product_id == pl.product_id
    )

    return {
        "ok": True,
        "removed_pallet_licence_id": pl.id,
        "licence_number": pl.licence_number or pl.id,
        "reason": reason,
        "hold_created": hold_created,
        "line_id": target_line.id,
        "line_remaining": max(0.0, line_remaining_after),
        "message": (
            f"Removed pallet {pl.licence_number or pl.id} ({consumed:g} cases)"
            + (" — placed on hold for review" if hold_created else "")
        ),
    }


# ---------------------------------------------------------------------------
# Phase 2 — escape hatch
# ---------------------------------------------------------------------------

def lot_escape_hatch(
    db: Session, transfer: InventoryTransfer, line_id: str,
    blocked_lot_number: str, blocked_row_ids: list[str],
    reason: Optional[str], current_user
) -> dict:
    """Swap a blocked lot allocation for the next-oldest lot.

    Operates on (transfer, product_id of the named line, blocked_lot_number)
    across ALL sub-lines that share the product — because a single UI line
    can fan out to multiple DB sub-lines (one per receipt). All those
    sub-lines' allocations for the blocked lot get capped at cases_picked
    (closing them out), and the outstanding cases are re-split across the
    new lot's receipts.
    """
    _assert_scannable(transfer)

    target_line: Optional[InventoryTransferLine] = None
    for ln in (transfer.lines or []):
        if ln.id == line_id:
            target_line = ln
            break
    if target_line is None:
        raise NotFoundError("Transfer line", line_id)

    product_id = target_line.product_id
    sibling_subs = [
        ln for ln in (transfer.lines or [])
        if ln.product_id == product_id
    ]

    # Sum outstanding cases across all sub-lines for (product, blocked_lot).
    outstanding = 0.0
    for sub in sibling_subs:
        for alloc in (sub.lot_allocations or []):
            if alloc.get("lot_number") == blocked_lot_number:
                outstanding += max(
                    0.0,
                    float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0),
                )

    if outstanding <= 0:
        raise ValidationError(
            f"Nothing left to swap for lot {blocked_lot_number} on this product"
        )

    # Collect every lot this line has already escaped from in past swaps
    # (across all sibling sub-lines, since lot_swap_history can be split).
    # Once a lot is in this set, the forklift has explicitly given up on it
    # — it must not surface as the next candidate, otherwise consecutive
    # "Try next lot" clicks can bounce back to a lot we already rejected.
    previously_escaped: set = {blocked_lot_number}
    for sub in sibling_subs:
        for entry in (sub.lot_swap_history or []):
            from_lot = entry.get("from_lot")
            if from_lot:
                previously_escaped.add(from_lot)

    # Find next-oldest lot of the same product, excluding any lot we've
    # already escaped from and any pallets in rows the forklift just
    # marked inaccessible.
    pool = _pallet_pool_for_product(db, product_id, transfer.warehouse_id, lock=True)
    by_lot: dict[str, dict] = {}
    blocked_row_set = set(blocked_row_ids or [])
    for pl in pool:
        lot_key = pl.lot_number or ""
        if not lot_key or lot_key in previously_escaped:
            continue
        if pl.storage_row_id and pl.storage_row_id in blocked_row_set:
            continue
        e = by_lot.setdefault(lot_key, {"cases": 0.0, "oldest": None})
        e["cases"] += float(pl.cases or 0)
        if pl.created_at and (e["oldest"] is None or pl.created_at < e["oldest"]):
            e["oldest"] = pl.created_at

    candidates = []
    for lot, agg in by_lot.items():
        reserved = _active_reservation_cases(db, product_id, lot)
        free = max(0.0, agg["cases"] - reserved)
        if free + 0.001 >= outstanding:
            candidates.append((lot, free, agg["oldest"]))
    candidates.sort(
        key=lambda x: (x[2] or datetime.max.replace(tzinfo=timezone.utc), x[0])
    )

    now = datetime.now(timezone.utc)
    new_lot: Optional[str] = candidates[0][0] if candidates else None

    swap_entry = {
        "from_lot": blocked_lot_number,
        "to_lot": new_lot,
        "reason": reason,
        "at": now.isoformat(),
        "by": str(current_user.id) if current_user else None,
        "blocked_row_ids": list(blocked_row_ids),
    }
    target_line.lot_swap_history = list(target_line.lot_swap_history or []) + [swap_entry]

    if new_lot is None:
        return {
            "swapped_to_lot": None,
            "new_line_view": None,
            "message": (
                f"No alternative lot found for product with at least "
                f"{outstanding:g} cases available. Manual intervention required."
            ),
        }

    # 1. Close out the blocked lot on every sub-line that had it: requested → picked.
    for sub in sibling_subs:
        allocs = list(sub.lot_allocations or [])
        changed = False
        for i, alloc in enumerate(allocs):
            if alloc.get("lot_number") == blocked_lot_number:
                allocs[i] = {
                    "lot_number": blocked_lot_number,
                    "cases_requested": float(alloc.get("cases_picked") or 0),
                    "cases_picked": float(alloc.get("cases_picked") or 0),
                }
                changed = True
        if changed:
            sub.lot_allocations = allocs

    # Release all (sibling, blocked_lot) reservations.
    db.query(ShipOutLotReservation).filter(
        ShipOutLotReservation.transfer_line_id.in_([s.id for s in sibling_subs]),
        ShipOutLotReservation.lot_number == blocked_lot_number,
        ShipOutLotReservation.released_at.is_(None),
    ).update(
        {"released_at": now, "cases_reserved": 0.0},
        synchronize_session=False,
    )

    # 2. Split the outstanding cases across the new lot's receipts and either
    # attach an allocation entry to an existing (product, receipt) sub-line
    # or create a new one.
    chunks = _split_lot_allocation_by_receipt(
        db, pool, product_id, new_lot, outstanding,
    )
    if not chunks:
        # Shouldn't happen — we just verified `free >= outstanding`.
        raise ValidationError(
            f"Could not split {outstanding:g} cases across receipts for lot {new_lot}"
        )

    for receipt_id, alloc_cases in chunks:
        existing_sub = next(
            (s for s in sibling_subs if s.receipt_id == receipt_id),
            None,
        )
        if existing_sub is None:
            new_sub = InventoryTransferLine(
                id=_new_id("trln"),
                transfer_id=transfer.id,
                product_id=product_id,
                receipt_id=receipt_id,
                cases_requested=alloc_cases,
                cases_picked=0.0,
                pallet_licence_ids=[],
                lot_allocations=[{
                    "lot_number": new_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                }],
                picks=[],
                lot_swap_history=[],
                line_seq=(target_line.line_seq or 0),
            )
            db.add(new_sub)
            sibling_subs.append(new_sub)
            db.add(ShipOutLotReservation(
                id=_new_id("solr"),
                transfer_line_id=new_sub.id,
                product_id=product_id,
                lot_number=new_lot,
                cases_reserved=alloc_cases,
            ))
        else:
            # Append (or merge into) an existing allocation entry on this sub-line.
            allocs = list(existing_sub.lot_allocations or [])
            merged = False
            for i, alloc in enumerate(allocs):
                if alloc.get("lot_number") == new_lot:
                    allocs[i] = {
                        "lot_number": new_lot,
                        "cases_requested": float(alloc.get("cases_requested") or 0) + alloc_cases,
                        "cases_picked": float(alloc.get("cases_picked") or 0),
                    }
                    merged = True
                    break
            if not merged:
                allocs.append({
                    "lot_number": new_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                })
            existing_sub.lot_allocations = allocs
            existing_sub.cases_requested = float(existing_sub.cases_requested or 0) + alloc_cases
            db.add(ShipOutLotReservation(
                id=_new_id("solr"),
                transfer_line_id=existing_sub.id,
                product_id=product_id,
                lot_number=new_lot,
                cases_reserved=alloc_cases,
            ))

    db.flush()
    refreshed = scanner_view_for_transfer(db, transfer)
    line_view = next(
        (l for l in refreshed["lines"] if l["product_id"] == product_id),
        None,
    )
    return {
        "swapped_to_lot": new_lot,
        "new_line_view": line_view,
        "message": f"Swapped lot {blocked_lot_number} → {new_lot} ({outstanding:g} cases)",
    }


def available_lots_for_line(
    db: Session, transfer: InventoryTransfer, line_id: str
) -> dict:
    """All lots of a line's product, oldest first, for the reversible lot
    picker. Unlike the old escape hatch this hides nothing — a lot the forklift
    previously moved away from is still listed, so going back is just selecting
    it again. Capacity nets out OTHER orders' product reservations (this order's
    own free up when it retargets), attributed to the oldest lots first."""
    if transfer.transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
        raise ValidationError("Not a ship-out transfer")
    target_line = next((ln for ln in (transfer.lines or []) if ln.id == line_id), None)
    if target_line is None:
        raise NotFoundError("Transfer line", line_id)

    product_id = target_line.product_id
    sibling_ids = [ln.id for ln in (transfer.lines or []) if ln.product_id == product_id]

    # Lots the line still has open allocations for (to flag "current").
    current_lots: set = set()
    for ln in (transfer.lines or []):
        if ln.product_id != product_id:
            continue
        for alloc in (ln.lot_allocations or []):
            open_cases = float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0)
            if open_cases > 0.001:
                current_lots.add(alloc.get("lot_number") or "")

    reserved_other = _active_product_reservation_cases(db, product_id, exclude_line_ids=sibling_ids)
    entries = _lot_entries_with_availability(db, product_id, transfer.warehouse_id, reserved_other)

    lots = []
    for e in entries:
        lots.append({
            "lot_number": e["lot_number"],
            "cases_available": e["cases_available"],
            "pallets_available": e["pallets_available"],
            "oldest_at": e["oldest_at"],
            "is_current": e["lot_number"] in current_lots,
            "is_recommended": False,  # set below
            "rows": e["rows"],
        })

    # Recommended = oldest lot that actually has capacity to switch into.
    for lot in lots:
        if lot["cases_available"] > 0.001:
            lot["is_recommended"] = True
            break

    return {"line_id": line_id, "product_id": product_id, "lots": lots}


def retarget_lot(
    db: Session, transfer: InventoryTransfer, line_id: str,
    from_lot: str, to_lot: str, reason: Optional[str], current_user
) -> dict:
    """Move a line's outstanding cases from one lot to another, chosen
    explicitly by the forklift. Reversible replacement for the one-way escape
    hatch: any lot (including one previously left) can be the target, and if the
    target can't cover everything we move what's available and leave the rest
    open on the original lot (soft totals make that safe). Operates across all
    sub-lines of the line's product."""
    _assert_scannable(transfer)
    if from_lot == to_lot:
        raise ValidationError("Choose a different lot to move to")

    target_line = next((ln for ln in (transfer.lines or []) if ln.id == line_id), None)
    if target_line is None:
        raise NotFoundError("Transfer line", line_id)
    product_id = target_line.product_id
    sibling_subs = [ln for ln in (transfer.lines or []) if ln.product_id == product_id]

    # Outstanding cases still owed on from_lot across all sub-lines.
    outstanding = 0.0
    for sub in sibling_subs:
        for alloc in (sub.lot_allocations or []):
            if alloc.get("lot_number") == from_lot:
                outstanding += max(
                    0.0,
                    float(alloc.get("cases_requested") or 0) - float(alloc.get("cases_picked") or 0),
                )
    if outstanding <= 0.001:
        raise ValidationError(f"Nothing left to move for lot {from_lot}")

    # How much can the target lot absorb? Capacity nets out OTHER orders'
    # product reservations (this order's own free up as it moves), attributed
    # FIFO to the oldest lots — same model the picker shows.
    pool = _pallet_pool_for_product(db, product_id, transfer.warehouse_id, lock=True)
    sibling_ids = [s.id for s in sibling_subs]
    reserved_other = _active_product_reservation_cases(db, product_id, exclude_line_ids=sibling_ids)
    entries = _lot_entries_with_availability(db, product_id, transfer.warehouse_id, reserved_other)
    to_lot_free = next((e["cases_available"] for e in entries if e["lot_number"] == to_lot), 0.0)
    if to_lot_free <= 0.001:
        raise ValidationError(f"Lot {to_lot} has no available capacity to move into")

    moved = min(outstanding, to_lot_free)
    now = datetime.now(timezone.utc)

    # 1. Reduce from_lot's open allocation by `moved`, walking sub-lines.
    to_reduce = moved
    for sub in sibling_subs:
        if to_reduce <= 0.001:
            break
        allocs = list(sub.lot_allocations or [])
        changed = False
        for i, alloc in enumerate(allocs):
            if to_reduce <= 0.001:
                break
            if alloc.get("lot_number") != from_lot:
                continue
            req = float(alloc.get("cases_requested") or 0)
            picked = float(alloc.get("cases_picked") or 0)
            open_cases = max(0.0, req - picked)
            if open_cases <= 0:
                continue
            take = min(to_reduce, open_cases)
            allocs[i] = {
                "lot_number": from_lot,
                "cases_requested": req - take,
                "cases_picked": picked,
            }
            sub.cases_requested = max(0.0, float(sub.cases_requested or 0) - take)
            to_reduce -= take
            changed = True
        if changed:
            sub.lot_allocations = allocs

    # 2. Reservations pool at the product level, and the order's total cases for
    # this product is unchanged by a lot move — so no reservation change here.

    # 3. Split `moved` across to_lot receipts and attach to sub-lines.
    chunks = _split_lot_allocation_by_receipt(db, pool, product_id, to_lot, moved)
    if not chunks:
        raise ValidationError(
            f"Could not split {moved:g} cases across receipts for lot {to_lot}"
        )
    for receipt_id, alloc_cases in chunks:
        existing_sub = next((s for s in sibling_subs if s.receipt_id == receipt_id), None)
        if existing_sub is None:
            new_sub = InventoryTransferLine(
                id=_new_id("trln"),
                transfer_id=transfer.id,
                product_id=product_id,
                receipt_id=receipt_id,
                cases_requested=alloc_cases,
                cases_picked=0.0,
                pallet_licence_ids=[],
                lot_allocations=[{
                    "lot_number": to_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                }],
                picks=[],
                lot_swap_history=[],
                line_seq=(target_line.line_seq or 0),
            )
            db.add(new_sub)
            sibling_subs.append(new_sub)
        else:
            allocs = list(existing_sub.lot_allocations or [])
            merged = False
            for i, alloc in enumerate(allocs):
                if alloc.get("lot_number") == to_lot:
                    allocs[i] = {
                        "lot_number": to_lot,
                        "cases_requested": float(alloc.get("cases_requested") or 0) + alloc_cases,
                        "cases_picked": float(alloc.get("cases_picked") or 0),
                    }
                    merged = True
                    break
            if not merged:
                allocs.append({
                    "lot_number": to_lot,
                    "cases_requested": alloc_cases,
                    "cases_picked": 0.0,
                })
            existing_sub.lot_allocations = allocs
            existing_sub.cases_requested = float(existing_sub.cases_requested or 0) + alloc_cases

    # 4. Audit only — record the move but do NOT block any lot or row, so the
    # forklift can move back later.
    swap_entry = {
        "from_lot": from_lot,
        "to_lot": to_lot,
        "cases": moved,
        "reason": reason,
        "at": now.isoformat(),
        "by": str(current_user.id) if current_user else None,
        "blocked_row_ids": [],
    }
    target_line.lot_swap_history = list(target_line.lot_swap_history or []) + [swap_entry]

    db.flush()
    refreshed = scanner_view_for_transfer(db, transfer)
    line_view = next((l for l in refreshed["lines"] if l["product_id"] == product_id), None)
    leftover = outstanding - moved
    return {
        "moved_to_lot": to_lot,
        "cases_moved": moved,
        "cases_left_on_from_lot": max(0.0, leftover),
        "new_line_view": line_view,
        "message": (
            f"Moved {moved:g} cases from lot {from_lot} → {to_lot}"
            + (f"; {leftover:g} cases left on {from_lot}" if leftover > 0.001 else "")
        ),
    }


# ---------------------------------------------------------------------------
# Void guard
# ---------------------------------------------------------------------------

def transfer_has_picks(transfer: InventoryTransfer) -> bool:
    """True if any pallet on this transfer has been scanned (full or partial).

    Used by the void endpoint to block voiding after picking has started —
    those pallets are physically gone from the shelf or split between two
    rows, and a void can't put them back."""
    for ln in (transfer.lines or []):
        if ln.picks:
            return True
    return False


# ---------------------------------------------------------------------------
# Release reservations on void / reject (no pallet status changes — pallets
# in v2 stay IN_STOCK until scanned, so no inventory mutation is required).
# ---------------------------------------------------------------------------

def release_reservations(db: Session, transfer: InventoryTransfer) -> None:
    now = datetime.now(timezone.utc)
    line_ids = [ln.id for ln in (transfer.lines or [])]
    if not line_ids:
        return
    db.query(ShipOutLotReservation).filter(
        ShipOutLotReservation.transfer_line_id.in_(line_ids),
        ShipOutLotReservation.released_at.is_(None),
    ).update(
        {"released_at": now, "cases_reserved": 0.0},
        synchronize_session=False,
    )
