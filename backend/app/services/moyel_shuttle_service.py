"""Moyel Shuttle — line → our own trailer → Moyel/RMI warehouse (FG-PALLET-LIFECYCLE-SPEC §1.1).

Some runs never go into our racks: the forklift scans them to Dock 1/2/3 (or
the floor) and they ride our own trailer to the Moyel/RMI warehouse. Before
this, those pallets sat "in stock" until they were adjusted out by hand —
most of September's ~2,240 cancelled pallets.

The clerk builds the trailer from whatever is physically loadable: pallets in
stock, pallets in a submitted forklift request, pallets in a session still
scanning, plus sequence numbers nobody scanned. "Make paperwork" then:

- creates ONE InventoryTransfer of type `moyel-shuttle` — the trailer. It is a
  transfer (not a new table) so every pallet's `transfer_id` points at it the
  way a ship-out's does, and lot trace / "already shipped" read it for free;
- marks every pallet SHIPPED on it. In-stock pallets free their row and come
  off their receipt, as a ship-out does; pending pallets touch neither (they
  were never counted — the forklift approval later attaches them to the lot's
  receipt as produced-and-shipped, §2.2);
- creates a ticked missing number as a pallet that existed and left on this
  trailer;
- freezes a BOL snapshot rendered by bol_pdf_service (and the packing slip
  when there are more lot lines than the BOL has rows).

Callers own commit/rollback.
"""
import re
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from app.constants import (
    DEFAULT_CASES_PER_PALLET, MOYEL_SHUTTLE_CARRIER, MOYEL_SHUTTLE_DEFAULT_DESTINATION_ID,
    TRANSFER_TYPE_MOYEL_SHUTTLE,
)
from app.enums import (
    ForkliftRequestStatus, PalletEventType, PalletStatus, ReceiptStatus, TransferStatus,
)
from app.exceptions import NotFoundError, ValidationError
from app.models import (
    ForkliftRequest, InventoryTransfer, InventoryTransferLine, PalletLicence, PalletType,
    Product, Receipt, ShipToLocation, StorageRow, User,
)
from app.services import pallet_lifecycle_service as plc
from app.services.bol_pdf_service import MAX_ORDER_ROWS
from app.services.ship_out_service import (
    _BILL_TO, _FREIGHT_CLASS, _FREIGHT_DESC, _NMFC, _SHIP_FROM, _release_row_capacity,
)
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences
from app.utils.warehouse_time import warehouse_timezone, zone

# Status labels the clerk sees in the pallet list.
LABEL_IN_STOCK = "in stock"
LABEL_WAITING_REVIEW = "waiting review"
LABEL_SCANNING = "scanning now"
LABEL_NEVER_SCANNED = "never scanned"

_DEFAULT_PALLET_WEIGHT = 60.0


def shuttle_bol_number(db: Session, transfer: InventoryTransfer) -> str:
    """B of L No for a shuttle BOL.

    PLACEHOLDER: the shuttle has its own numbering, which Hemanth will supply.
    Until then every shuttle BOL prints "001". Replace the body of this one
    function — nothing else reads or derives the number. Deliberately NOT the
    ship-out GSIN sequence (bol_number_seq)."""
    return "001"


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]+")


def _clean_text(value: Optional[str]) -> str:
    return " ".join(_CONTROL_CHARS.sub(" ", value or "").split())


def bol_filename(transfer: InventoryTransfer) -> str:
    """Download name for a shuttle BOL — header-safe whatever the trailer # holds."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", transfer.trailer_number or "").strip("_")
    return f"BOL-shuttle-{safe or transfer.id}.pdf"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Destinations
# ---------------------------------------------------------------------------

def ensure_default_destination(db: Session) -> ShipToLocation:
    """RMI WAREHOUSE is seeded by migration f9c8b7a6d5e4; re-create it if a
    database was built without migrations (tests, fresh installs)."""
    d = db.query(ShipToLocation).filter(ShipToLocation.id == MOYEL_SHUTTLE_DEFAULT_DESTINATION_ID).first()
    if d is None:
        d = ShipToLocation(
            id=MOYEL_SHUTTLE_DEFAULT_DESTINATION_ID,
            customer_name="RMI WAREHOUSE", location_name="RMI WAREHOUSE",
            address_line1="39269 W Red Arrow Hwy", city="Paw Paw", state="MI", zip_code="49079",
            is_active=True, is_shuttle_destination=True,
        )
        db.add(d)
        db.flush()
    return d


def list_destinations(db: Session, include_inactive: bool = False) -> list:
    ensure_default_destination(db)
    q = db.query(ShipToLocation).filter(ShipToLocation.is_shuttle_destination == True)  # noqa: E712
    if not include_inactive:
        q = q.filter(ShipToLocation.is_active == True)  # noqa: E712
    return [_destination_dict(d) for d in q.order_by(ShipToLocation.customer_name).all()]


def _destination_dict(d: ShipToLocation) -> dict:
    return {
        "id": d.id, "name": d.customer_name, "location_name": d.location_name,
        "address_line1": d.address_line1, "city": d.city, "state": d.state,
        "zip_code": d.zip_code, "is_active": d.is_active,
        "is_default": d.id == MOYEL_SHUTTLE_DEFAULT_DESTINATION_ID,
    }


def save_destination(db: Session, data: dict, destination_id: Optional[str] = None) -> dict:
    name = (data.get("name") or "").strip()
    if destination_id:
        d = db.query(ShipToLocation).filter(
            ShipToLocation.id == destination_id,
            ShipToLocation.is_shuttle_destination == True,  # noqa: E712
        ).first()
        if d is None:
            raise NotFoundError("Shuttle destination")
    else:
        if not name:
            raise ValidationError("Destination name is required")
        d = ShipToLocation(id=_new_id("shipto"), is_shuttle_destination=True, is_active=True,
                           customer_name=name, location_name=name)
        db.add(d)
    if name:
        d.customer_name = name
        d.location_name = name
    for key in ("address_line1", "city", "state", "zip_code"):
        if key in data:
            d.__setattr__(key, (data.get(key) or "").strip() or None)
    if "is_active" in data and data["is_active"] is not None:
        d.is_active = bool(data["is_active"])
    db.flush()
    return _destination_dict(d)


# ---------------------------------------------------------------------------
# What can go on the trailer
# ---------------------------------------------------------------------------

def _prefix(licence: Optional[str]) -> Optional[str]:
    lic = licence or ""
    cut = lic.rfind("-")
    return lic[:cut] if cut > 0 else None


def available_for_product(db: Session, product_id: str, warehouse_id: Optional[str]) -> dict:
    """Every pallet of a product that can be loaded now, plus the sequence
    numbers inside each open lot run that nobody scanned."""
    from app.services.scanner_service import _COVERED_PALLET_STATUSES_FOR_GAPS

    product = db.query(Product).filter(Product.id == product_id).first()
    if product is None:
        raise NotFoundError("Product")

    q = db.query(PalletLicence).filter(
        PalletLicence.product_id == product_id,
        PalletLicence.status.in_((PalletStatus.IN_STOCK.value, PalletStatus.PENDING.value)),
        PalletLicence.is_held == False,  # noqa: E712
        PalletLicence.is_deleted == False,  # noqa: E712
    )
    if warehouse_id:
        q = q.filter(PalletLicence.warehouse_id == warehouse_id)
    pallets = q.all()

    fr_ids = {p.forklift_request_id for p in pallets if p.forklift_request_id}
    fr_status = {
        fr.id: fr.status for fr in
        db.query(ForkliftRequest).filter(ForkliftRequest.id.in_(fr_ids)).all()
    } if fr_ids else {}
    row_ids = {p.storage_row_id for p in pallets if p.storage_row_id}
    rows = {
        r.id: r.name for r in db.query(StorageRow).filter(StorageRow.id.in_(row_ids)).all()
    } if row_ids else {}

    out = []
    open_lots: dict = {}  # lot -> licence prefix, for lots with pallets still in review/scanning
    for p in pallets:
        if p.status == PalletStatus.IN_STOCK.value:
            label = LABEL_IN_STOCK
        else:
            st = fr_status.get(p.forklift_request_id)
            if st == ForkliftRequestStatus.SCANNING.value:
                label = LABEL_SCANNING
            elif st == ForkliftRequestStatus.SUBMITTED.value:
                label = LABEL_WAITING_REVIEW
            else:
                continue  # a pending pallet with no open session is not loadable
            if _prefix(p.licence_number):
                open_lots.setdefault(p.lot_number, _prefix(p.licence_number))
        out.append({
            "kind": "pallet",
            "id": p.id,
            "licence_number": p.licence_number,
            "lot_number": p.lot_number,
            "sequence": p.sequence,
            "cases": p.cases,
            "is_partial": bool(p.is_partial),
            "status": p.status,
            "status_label": label,
            "row_name": rows.get(p.storage_row_id) or ("Floor" if not p.storage_row_id else p.storage_row_id),
            "forklift_request_id": p.forklift_request_id,
        })

    # Missing numbers: gaps inside each OPEN lot run (a lot with pallets still
    # in review or being scanned), same coverage rule as the forklift review.
    # Older, fully approved lots are left out — their gaps were resolved at
    # approval, and a written-off number there is not "never scanned".
    cpp = product.default_cases_per_pallet or DEFAULT_CASES_PER_PALLET
    for lot, prefix in open_lots.items():
        seqs = {
            int(s) for (s,) in db.query(PalletLicence.sequence).filter(
                PalletLicence.lot_number == lot,
                PalletLicence.product_id == product_id,
                PalletLicence.status.in_(_COVERED_PALLET_STATUSES_FOR_GAPS),
                PalletLicence.sequence.isnot(None),
            ).all() if s is not None
        }
        top = max(seqs) if seqs else 0
        for s in range(1, top + 1):
            if s in seqs:
                continue
            out.append({
                "kind": "missing",
                "id": None,
                "licence_number": f"{prefix}-{str(s).zfill(3)}",
                "lot_number": lot,
                "sequence": s,
                "cases": cpp,
                "is_partial": False,
                "status": None,
                "status_label": LABEL_NEVER_SCANNED,
                "row_name": None,
                "forklift_request_id": None,
            })

    out.sort(key=lambda r: (r["lot_number"] or "", r["sequence"] or 0))
    return {
        "product": {
            "id": product.id, "name": product.name, "short_code": product.short_code,
            "fcc_code": product.fcc_code, "default_cases_per_pallet": cpp,
        },
        "pallets": out,
    }


# ---------------------------------------------------------------------------
# Make paperwork
# ---------------------------------------------------------------------------

def _item_code(p: Product) -> str:
    return p.fcc_code or p.short_code or p.id


def create_shuttle(
    db: Session,
    *,
    trailer_number: str,
    seal_number: str,
    destination_id: Optional[str],
    pallet_ids: Iterable[str],
    missing_licences: Iterable[str],
    warehouse_id: Optional[str],
    current_user: User,
) -> InventoryTransfer:
    from app.services.scanner_service import find_product_by_code, parse_licence_number

    # Control characters (a scanner's CR/LF, tabs) are never part of a trailer
    # or seal number; stored, they broke the BOL reprint's download header.
    trailer_number = _clean_text(trailer_number)
    seal_number = _clean_text(seal_number)
    if not trailer_number:
        raise ValidationError("Enter the trailer #")
    if not seal_number:
        raise ValidationError("Enter the seal #")
    pallet_ids = list(dict.fromkeys(pallet_ids or []))
    missing_licences = list(dict.fromkeys(m.strip() for m in (missing_licences or []) if m and m.strip()))
    if not pallet_ids and not missing_licences:
        raise ValidationError("Select at least one pallet for the trailer")

    ensure_default_destination(db)
    dest = db.query(ShipToLocation).filter(
        ShipToLocation.id == (destination_id or MOYEL_SHUTTLE_DEFAULT_DESTINATION_ID)
    ).first()
    if dest is None:
        raise ValidationError("Pick a destination")

    # 1. Lock + validate every selected pallet BEFORE touching anything.
    pallets = (
        db.query(PalletLicence).filter(PalletLicence.id.in_(pallet_ids)).with_for_update().all()
        if pallet_ids else []
    )
    if len(pallets) != len(pallet_ids):
        raise ValidationError("Some selected pallets no longer exist — refresh the list")
    problems = []
    for p in pallets:
        if p.is_held:
            problems.append(f"{p.licence_number} is on hold")
        elif p.status == PalletStatus.SHIPPED.value:
            problems.append(plc.shipped_detail(db, p))
        elif p.status not in (PalletStatus.IN_STOCK.value, PalletStatus.PENDING.value):
            problems.append(f"{p.licence_number} is {p.status}")
        elif warehouse_id and p.warehouse_id and p.warehouse_id != warehouse_id:
            problems.append(f"{p.licence_number} belongs to another warehouse")
    if problems:
        raise ValidationError("Can't load: " + "; ".join(problems[:5]))

    # Missing numbers: parse, resolve product, refuse ones that exist now.
    # Only a number the list offered may be ticked — a real gap inside an open
    # lot run of THIS warehouse. Otherwise any typed licence string became a
    # shipped pallet (and later a produced one at approval), in any lot.
    planned_missing = []
    offered_gaps: dict = {}  # product_id -> {licence}
    for lic in missing_licences:
        lot, code, seq = parse_licence_number(lic)
        if not lot or seq is None:
            raise ValidationError(f"{lic} is not a pallet number")
        product = find_product_by_code(db, code)
        if product is None:
            raise ValidationError(f"Unknown product in {lic}")
        if product.id not in offered_gaps:
            offered_gaps[product.id] = {
                r["licence_number"] for r in available_for_product(db, product.id, warehouse_id)["pallets"]
                if r["kind"] == "missing"
            }
        existing = db.query(PalletLicence).filter(PalletLicence.licence_number == lic).with_for_update().first()
        if existing is not None and existing.status == PalletStatus.SHIPPED.value:
            raise ValidationError(plc.shipped_detail(db, existing) + " — refresh the list")
        if existing is not None and existing.status == PalletStatus.EMPTIED.value:
            raise ValidationError(plc.emptied_detail(db, existing) + " — refresh the list")
        if existing is not None and existing.status != PalletStatus.CANCELLED.value:
            raise ValidationError(f"{lic} was scanned meanwhile ({existing.status}) — refresh the list")
        if existing is not None and warehouse_id and existing.warehouse_id and existing.warehouse_id != warehouse_id:
            raise ValidationError(f"{lic} belongs to another warehouse")
        if lic not in offered_gaps[product.id]:
            raise ValidationError(f"{lic} is not a never-scanned number of an open lot — refresh the list")
        planned_missing.append((lic, lot, seq, product, existing))

    # 2. Master data the BOL needs (same rule as ship-out docs: fail loudly).
    product_ids = {p.product_id for p in pallets} | {m[3].id for m in planned_missing}
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()}
    missing_md = sorted({
        products[pid].name for pid in product_ids
        if not (products.get(pid) and products[pid].package_size and products[pid].package_size.case_weight)
    })
    if missing_md:
        raise ValidationError(
            "Missing case weight — set the package size for: " + ", ".join(missing_md)
        )

    now = datetime.now(timezone.utc)
    user_id = str(current_user.id)
    wh_id = warehouse_id or next((p.warehouse_id for p in pallets if p.warehouse_id), None)
    transfer = InventoryTransfer(
        id=_new_id("shuttle"),
        quantity=0,
        unit="cases",
        transfer_type=TRANSFER_TYPE_MOYEL_SHUTTLE,
        reason=f"Moyel shuttle trailer {trailer_number}",
        status=TransferStatus.APPROVED.value,
        requested_by=user_id,
        approved_by=user_id,
        approved_at=now,
        warehouse_id=wh_id,
        ship_to_location_id=dest.id,
        carrier=MOYEL_SHUTTLE_CARRIER,
        trailer_number=trailer_number,
        seal_number=seal_number,
        time_out=now,
        docs_generated_at=now,
        docs_generated_by=user_id,
        is_locked=True,
    )
    db.add(transfer)
    db.flush()

    # 3. Ship each pallet. picks grouped per (product, receipt) so receipt
    # reports can find the cases a receipt lost to the trailer.
    shipped: list = []  # (pallet, prev_status)
    touched_receipts: dict = {}
    for p in pallets:
        prev = p.status
        if prev == PalletStatus.IN_STOCK.value:
            # Counted in its row and its receipt: free both, like a ship-out.
            _release_row_capacity(db, p, float(p.cases or 0))
            if p.receipt_id:
                r = db.query(Receipt).filter(Receipt.id == p.receipt_id).with_for_update().first()
                if r is not None:
                    r.quantity = max(0.0, float(r.quantity or 0) - float(p.cases or 0))
                    touched_receipts[r.id] = r
        # PENDING: never in a row counter or a receipt — touch neither (§2.3).
        p.status = PalletStatus.SHIPPED.value
        p.transfer_id = transfer.id
        plc.record_event(
            db, p, PalletEventType.SHUTTLED, user=current_user,
            from_status=prev, to_status=PalletStatus.SHIPPED.value,
            reason=f"Moyel shuttle trailer {trailer_number}",
            ref_type="transfer", ref_id=transfer.id,
        )
        shipped.append((p, prev))

    for lic, lot, seq, product, existing in planned_missing:
        cases = product.default_cases_per_pallet or DEFAULT_CASES_PER_PALLET
        if existing is not None:
            p = existing  # a cancelled leftover holds the unique number
            prev = p.status
            p.lot_number, p.sequence, p.product_id = lot, seq, product.id
            p.cases = p.cases or cases
            p.is_deleted = False
        else:
            p = PalletLicence(
                id=f"pl-{uuid.uuid4().hex[:12]}", licence_number=lic,
                product_id=product.id, lot_number=lot, sequence=seq, cases=cases,
                is_partial=False, warehouse_id=wh_id,
                scanned_by=user_id, scanned_at=now,
            )
            db.add(p)
            prev = None
        p.status = PalletStatus.SHIPPED.value
        p.transfer_id = transfer.id
        p.storage_row_id = None
        p.storage_area_id = None
        if p.warehouse_id is None:
            p.warehouse_id = wh_id
        db.flush()
        plc.record_event(
            db, p, PalletEventType.CREATED_SHIPPED, user=current_user,
            from_status=prev, to_status=PalletStatus.SHIPPED.value,
            reason=f"Never scanned — loaded on Moyel shuttle trailer {trailer_number}",
            ref_type="transfer", ref_id=transfer.id,
        )
        shipped.append((p, prev or "never_scanned"))

    for r in touched_receipts.values():
        _rebuild_receipt_allocation_from_licences(db, r)
        if (r.quantity or 0) <= 0:
            r.status = ReceiptStatus.DEPLETED.value

    # 4. Lines (one per product + receipt) and the frozen document snapshot.
    line_groups: dict = {}
    for p, prev in shipped:
        key = (p.product_id, p.receipt_id if prev == PalletStatus.IN_STOCK.value else None)
        line_groups.setdefault(key, []).append((p, prev))
    seq_no = 0
    for (pid, rid), items in sorted(line_groups.items(), key=lambda kv: (products[kv[0][0]].name, kv[0][1] or "")):
        cases = float(sum(p.cases or 0 for p, _ in items))
        lots: dict = {}
        for p, _ in items:
            lots[p.lot_number or ""] = lots.get(p.lot_number or "", 0.0) + float(p.cases or 0)
        db.add(InventoryTransferLine(
            id=_new_id("tline"), transfer_id=transfer.id, product_id=pid, receipt_id=rid,
            cases_requested=cases, cases_picked=cases,
            pallet_licence_ids=[p.id for p, _ in items],
            lot_allocations=[
                {"lot_number": lot, "cases_requested": c, "cases_picked": c} for lot, c in sorted(lots.items())
            ],
            picks=[{
                "pallet_licence_id": p.id, "cases_consumed": float(p.cases or 0), "was_partial": False,
                "storage_row_id": None, "scanned_at": now.isoformat(), "scanned_by": user_id,
                "picked_via": "moyel_shuttle", "live_loaded": prev == PalletStatus.PENDING.value,
            } for p, prev in items],
            line_seq=seq_no,
        ))
        seq_no += 1

    transfer.quantity = float(sum(p.cases or 0 for p, _ in shipped))
    transfer.pallet_licence_ids = [p.id for p, _ in shipped]
    # The shuttle's B of L No lives on the printed document only. The
    # `bol_number` column is UNIQUE across all transfers (ship-out GSINs), so a
    # fixed placeholder there made every shuttle after the first fail with a
    # duplicate-key error. Leave the column NULL (NULLs never collide).
    transfer.bol_number = None
    transfer.document_snapshot = build_snapshot(
        db, transfer, [p for p, _ in shipped], products, dest,
        bol_number=shuttle_bol_number(db, transfer),
    )
    db.flush()
    return transfer


def build_snapshot(db: Session, transfer: InventoryTransfer, pallets: list, products: dict,
                   dest: ShipToLocation, bol_number: Optional[str] = None) -> dict:
    """Frozen BOL + packing-slip values. Same shape as a ship-out snapshot (so
    ShipOutDocuments and bol_pdf_service render it), plus `order_rows`: one
    BOL customer-order row per product+lot, "Lot: <lot>" as the order no."""
    by_line: dict = {}
    for p in pallets:
        key = (p.product_id, p.lot_number or "")
        e = by_line.setdefault(key, {"cases": 0.0, "pallets": 0})
        e["cases"] += float(p.cases or 0)
        e["pallets"] += 1
    keys = sorted(by_line, key=lambda k: (products[k[0]].name, k[1]))

    pallet_type = db.query(PalletType).filter(PalletType.is_default == True).first()  # noqa: E712
    pallet_weight = pallet_type.pallet_weight if pallet_type else _DEFAULT_PALLET_WEIGHT
    total_cases = sum(e["cases"] for e in by_line.values())
    pallet_count = len(pallets)
    product_weight = sum(
        e["cases"] * products[pid].package_size.case_weight for (pid, _lot), e in by_line.items()
    )

    order_rows = []
    for pid, lot in keys:
        prod, e = products[pid], by_line[(pid, lot)]
        order_rows.append({
            "order_no": f"Lot: {lot}" if lot else "",
            "qty": int(e["cases"]),
            "weight": round(e["cases"] * prod.package_size.case_weight, 1),
            "info": f"{prod.name} ({_item_code(prod)}) · {e['pallets']} PAL",
        })
    if len(order_rows) > MAX_ORDER_ROWS:
        # More lot lines than the form has rows: one summary row on the BOL,
        # per-lot detail on the packing slip that travels with it.
        order_rows = [{
            "order_no": "See packing slip",
            "qty": int(total_cases),
            "weight": round(product_weight, 1),
            "info": f"{len(keys)} lot lines · {pallet_count} PAL",
        }]

    slip_lines = [{
        "order_number": None, "po_number": None,
        "item": _item_code(products[pid]), "description": products[pid].name,
        "quantity": int(by_line[(pid, lot)]["cases"]), "uom": "CS", "lot_number": lot or None,
        "pallets": by_line[(pid, lot)]["pallets"],
    } for pid, lot in keys]

    tz = zone(warehouse_timezone(db, transfer.warehouse_id))
    ship_date = (transfer.time_out or datetime.now(timezone.utc)).astimezone(tz).date().isoformat()
    return {
        "kind": "moyel_shuttle",
        "bol_number": bol_number or transfer.bol_number,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ship_from": _SHIP_FROM, "bill_to": _BILL_TO,
        "ship_to": {
            "customer_name": dest.customer_name, "location_name": dest.location_name,
            "address_line1": dest.address_line1, "address_line2": dest.address_line2,
            "city": dest.city, "state": dest.state, "zip_code": dest.zip_code,
        },
        "order_number": None, "po_number": None,
        "carrier": transfer.carrier, "appointment_time": None,
        "ship_date": ship_date,
        "slip_lines": slip_lines,
        "order_rows": order_rows,
        "total_cases": int(total_cases),
        "pallet_count": pallet_count,
        "weight": {
            "product": round(product_weight, 1),
            "pallets": round(pallet_count * pallet_weight, 1),
            "total": round(product_weight + pallet_count * pallet_weight, 1),
        },
        "nmfc": _NMFC, "freight_class": _FREIGHT_CLASS, "freight_description": _FREIGHT_DESC,
        "driver_name": None, "driver_license": None,
        "truck_number": None, "truck_license": None,
        "trailer_number": transfer.trailer_number, "trailer_license": None,
        "seal_number": transfer.seal_number,
        "time_in": None,
        "time_out": transfer.time_out.isoformat() if transfer.time_out else None,
        "ship_short": False,
    }


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------

def shuttle_summary(db: Session, t: InventoryTransfer) -> dict:
    who = db.query(User).filter(User.id == t.requested_by).first() if t.requested_by else None
    snap = t.document_snapshot or {}
    return {
        "id": t.id,
        "trailer_number": t.trailer_number,
        "seal_number": t.seal_number,
        "destination": (t.ship_to_location.customer_name if t.ship_to_location else None),
        "shipped_at": t.time_out or t.approved_at or t.created_at,
        "pallets": len(t.pallet_licence_ids or []),
        "cases": float(t.quantity or 0),
        "created_by": (who.name or who.username) if who else None,
        "bol_number": snap.get("bol_number") or t.bol_number,
        "lines": snap.get("slip_lines") or [],
    }


def list_shuttles(db: Session, warehouse_id: Optional[str], limit: int = 100) -> list:
    q = db.query(InventoryTransfer).filter(InventoryTransfer.transfer_type == TRANSFER_TYPE_MOYEL_SHUTTLE)
    if warehouse_id:
        q = q.filter(InventoryTransfer.warehouse_id == warehouse_id)
    return [shuttle_summary(db, t) for t in q.order_by(InventoryTransfer.created_at.desc()).limit(limit).all()]


def get_shuttle(db: Session, transfer_id: str, warehouse_id: Optional[str]) -> InventoryTransfer:
    t = db.query(InventoryTransfer).filter(
        InventoryTransfer.id == transfer_id,
        InventoryTransfer.transfer_type == TRANSFER_TYPE_MOYEL_SHUTTLE,
    ).first()
    if t is None or (warehouse_id and t.warehouse_id and t.warehouse_id != warehouse_id):
        raise NotFoundError("Shuttle trailer")
    return t
