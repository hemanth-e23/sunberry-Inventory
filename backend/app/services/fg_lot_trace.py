"""Finished-goods lot trace built from pallets (FG-PALLET-LIFECYCLE-SPEC §5).

The receipt-based trace (report_builders.build_lot_trace) cannot see pallets
that never sat on a receipt — live-loaded and Moyel-shuttle pallets — nor the
MISSING status. For an FG lot every pallet already says what became of it, so
the summary is built from the pallets and balances by construction:

    Produced − Shipped (orders) − Moyel shuttle − Adjusted − Missing
             − Pending review = In stock (by row)
    Not produced is listed separately and not counted.

`books` puts the receipts' own on-hand next to the pallets' in-stock figure,
which is where drift shows up.
"""
from collections import defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.constants import TRANSFER_TYPE_MOYEL_SHUTTLE
from app.enums import AdjustmentStatus, AdjustmentType, PalletEventType, PalletStatus, ReceiptStatus
from app.models import (
    InventoryAdjustment, InventoryTransfer, InventoryTransferLine, PalletEvent, PalletLicence,
    Product, Receipt, StorageRow, TransferScanEvent, User,
)

LINE_KEYS = ("shipped", "shuttle", "adjusted", "missing", "pending", "in_stock")


def _bucket():
    return {"pallets": 0, "cases": 0.0, "items": []}


def build_fg_pallet_trace(db: Session, lot_number: str, warehouse_id: Optional[str] = None) -> list:
    q = db.query(PalletLicence).filter(
        PalletLicence.lot_number.ilike(f"%{lot_number}%"),
    )
    if warehouse_id:
        q = q.filter(PalletLicence.warehouse_id == warehouse_id)
    pallets = q.order_by(PalletLicence.lot_number, PalletLicence.sequence).all()
    if not pallets:
        return []

    ids = [p.id for p in pallets]
    users = {u.id: (u.name or u.username) for u in db.query(User).all()}
    rows = {
        r.id: r.name for r in db.query(StorageRow).filter(
            StorageRow.id.in_({p.storage_row_id for p in pallets if p.storage_row_id})
        ).all()
    }
    products = {
        p.id: p for p in db.query(Product).filter(Product.id.in_({p.product_id for p in pallets})).all()
    }

    # Transfers each pallet touched: its own transfer_id (full pulls, shuttle)
    # plus any order it was scanned onto (partial pulls leave transfer_id NULL).
    scan_rows = db.query(TransferScanEvent.transfer_id, TransferScanEvent.licence_id).filter(
        TransferScanEvent.licence_id.in_(ids), TransferScanEvent.on_list == True,  # noqa: E712
    ).all()
    transfer_ids = {p.transfer_id for p in pallets if p.transfer_id} | {t for t, _ in scan_rows}
    transfers = {
        t.id: t for t in db.query(InventoryTransfer).filter(InventoryTransfer.id.in_(transfer_ids)).all()
    } if transfer_ids else {}
    # Cases actually pulled per pallet, from v2 picks.
    picked = defaultdict(list)  # pallet_id -> [(transfer, cases, at, by)]
    if transfer_ids:
        for ln in db.query(InventoryTransferLine).filter(InventoryTransferLine.transfer_id.in_(transfer_ids)).all():
            t = transfers.get(ln.transfer_id)
            if t is None or t.transfer_type == TRANSFER_TYPE_MOYEL_SHUTTLE:
                continue
            for pk in (ln.picks or []):
                pid = pk.get("pallet_licence_id")
                if pid in ids:
                    picked[pid].append((t, float(pk.get("cases_consumed") or 0), pk.get("scanned_at"), pk.get("scanned_by")))

    # Approved adjustments touching these pallets.
    adjs_by_pallet = defaultdict(list)
    for a in db.query(InventoryAdjustment).filter(
        InventoryAdjustment.status == AdjustmentStatus.APPROVED.value,
        InventoryAdjustment.product_id.in_(list(products)),
        InventoryAdjustment.pallet_licence_ids.isnot(None),
    ).all():
        for pid in (a.pallet_licence_ids or []):
            if pid in ids:
                adjs_by_pallet[pid].append(a)

    events = defaultdict(list)
    for e in db.query(PalletEvent).filter(PalletEvent.pallet_licence_id.in_(ids)).order_by(PalletEvent.created_at).all():
        events[e.pallet_licence_id].append(e)

    def last_ev(pid, etype):
        evs = [e for e in events.get(pid, []) if e.event_type == etype]
        return evs[-1] if evs else None

    groups: dict = {}
    for p in pallets:
        key = (p.product_id, p.lot_number or "")
        g = groups.get(key)
        if g is None:
            prod = products.get(p.product_id)
            g = groups[key] = {
                "product_id": p.product_id,
                "product_name": prod.name if prod else p.product_id,
                "product_code": (prod.fcc_code or prod.short_code) if prod else None,
                "lot_number": p.lot_number,
                "produced": {"pallets": 0, "cases": 0.0},
                **{k: _bucket() for k in LINE_KEYS},
                "not_produced": _bucket(),
                "in_stock_by_row": {},
                "found_history": [],
            }
        base = {
            "licence_number": p.licence_number, "sequence": p.sequence,
            "cases": p.cases, "status": p.status,
        }
        st = p.status
        if st == PalletStatus.NOT_PRODUCED.value:
            ev = last_ev(p.id, PalletEventType.NOT_PRODUCED.value)
            g["not_produced"]["pallets"] += 1
            g["not_produced"]["items"].append({
                **base, "reason_code": ev.reason_code if ev else None,
                "reason": ev.reason if ev else None,
                "by": users.get(ev.user_id) if ev else users.get(p.scanned_by),
                "at": ev.created_at if ev else p.scanned_at,
            })
            continue

        case_adjs = [a for a in adjs_by_pallet.get(p.id, []) if a.adjustment_type == AdjustmentType.CASE_ADJUSTMENT.value]
        whole_adjs = [a for a in adjs_by_pallet.get(p.id, []) if a.adjustment_type != AdjustmentType.CASE_ADJUSTMENT.value]
        case_adj_removed = sum(float(a.quantity or 0) for a in case_adjs)  # + removed, − added back

        if st == PalletStatus.CANCELLED.value and not whole_adjs and not case_adjs:
            # A rejected or removed scan — never produced into stock.
            continue

        picks = picked.get(p.id, [])
        pick_cases = sum(c for _t, c, _at, _by in picks)
        current = float(p.cases or 0)
        is_shuttle = bool(p.transfer_id and transfers.get(p.transfer_id)
                          and transfers[p.transfer_id].transfer_type == TRANSFER_TYPE_MOYEL_SHUTTLE)

        # Cases this pallet carried when produced.
        if st == PalletStatus.SHIPPED.value and not is_shuttle and picks:
            produced_cases = pick_cases + case_adj_removed
        else:
            produced_cases = current + pick_cases + case_adj_removed
        g["produced"]["pallets"] += 1
        g["produced"]["cases"] += produced_cases

        # Partial pulls from a pallet that is still here (or went elsewhere later).
        for t, c, at, by in picks:
            if st == PalletStatus.SHIPPED.value and not is_shuttle:
                continue  # counted with the pallet below
            b = g["shipped"]
            b["cases"] += c
            b["items"].append({**base, "cases": c, "partial": True, "order_number": t.order_number,
                               "transfer_id": t.id, "at": at, "by": users.get(by)})
        if case_adjs:
            b = g["adjusted"]
            b["cases"] += case_adj_removed
            for a in case_adjs:
                d = ((a.source_breakdown or [{}])[0] or {})
                b["items"].append({**base, "cases": -float(a.quantity or 0), "case_adjustment": True,
                                   "reason_code": d.get("reason_code"), "reason": a.reason,
                                   "by": users.get(a.approved_by), "at": a.approved_at})

        if st == PalletStatus.SHIPPED.value:
            t = transfers.get(p.transfer_id)
            if is_shuttle:
                b = g["shuttle"]
                b["pallets"] += 1
                b["cases"] += current
                b["items"].append({**base, "trailer_number": t.trailer_number, "transfer_id": t.id,
                                   "at": t.time_out or t.approved_at, "by": users.get(t.requested_by)})
            else:
                b = g["shipped"]
                b["pallets"] += 1
                cases = pick_cases if picks else current
                b["cases"] += cases
                when = picks[-1][2] if picks else (t.time_out or t.approved_at if t else None)
                who = users.get(picks[-1][3]) if picks else None
                b["items"].append({**base, "cases": cases, "order_number": t.order_number if t else None,
                                   "customer": t.ship_to_location.customer_name if (t and t.ship_to_location) else None,
                                   "transfer_id": t.id if t else None,
                                   "live_loaded": any(e.event_type == PalletEventType.LIVE_LOADED.value for e in events.get(p.id, [])),
                                   "at": when, "by": who})
        elif st == PalletStatus.MISSING.value:
            ev = last_ev(p.id, PalletEventType.MISSING.value)
            b = g["missing"]
            b["pallets"] += 1
            b["cases"] += current
            b["items"].append({**base, "row_name": rows.get(p.storage_row_id),
                               "reason": ev.reason if ev else None,
                               "by": users.get(ev.user_id) if ev else None,
                               "at": ev.created_at if ev else None})
        elif st in (PalletStatus.CANCELLED.value, PalletStatus.EMPTIED.value):
            b = g["adjusted"]
            b["pallets"] += 1
            if whole_adjs:
                b["cases"] += current
                a = whole_adjs[-1]
                b["items"].append({**base, "adjustment_type": a.adjustment_type, "reason": a.reason,
                                   "by": users.get(a.approved_by), "at": a.approved_at})
            # A pallet case-adjusted down to 0 is closed: its cases are in the
            # case-adjustment rows above; it only adds the pallet here.
        elif st in (PalletStatus.PENDING.value, PalletStatus.MISSING_STICKER.value):
            b = g["pending"]
            b["pallets"] += 1
            b["cases"] += current
            b["items"].append({**base, "row_name": rows.get(p.storage_row_id),
                               "forklift_request_id": p.forklift_request_id,
                               "by": users.get(p.scanned_by), "at": p.scanned_at})
        else:  # in_stock (and legacy reserved/placed/transferred)
            b = g["in_stock"]
            b["pallets"] += 1
            b["cases"] += current
            row_name = rows.get(p.storage_row_id) or "Floor"
            b["items"].append({**base, "row_name": row_name, "is_held": bool(p.is_held),
                               "by": users.get(p.scanned_by), "at": p.scanned_at})
            r = g["in_stock_by_row"].setdefault(row_name, {"row_name": row_name, "pallets": 0, "cases": 0.0})
            r["pallets"] += 1
            r["cases"] += current

        for e in events.get(p.id, []):
            if e.event_type in (PalletEventType.MISSING.value, PalletEventType.FOUND.value,
                                PalletEventType.NOT_PRODUCED_SCANNED.value, PalletEventType.REVIVED.value):
                g["found_history"].append({
                    "licence_number": p.licence_number, "event_type": e.event_type,
                    "reason": e.reason, "by": users.get(e.user_id), "at": e.created_at,
                })

    out = []
    for (pid, lot), g in sorted(groups.items(), key=lambda kv: (kv[1]["product_name"] or "", kv[0][1])):
        if g["produced"]["pallets"] == 0 and g["not_produced"]["pallets"] == 0:
            continue
        expected_pallets = g["produced"]["pallets"] - sum(
            g[k]["pallets"] for k in ("shipped", "shuttle", "adjusted", "missing", "pending")
        )
        expected_cases = g["produced"]["cases"] - sum(
            g[k]["cases"] for k in ("shipped", "shuttle", "adjusted", "missing", "pending")
        )
        diff_pallets = g["in_stock"]["pallets"] - expected_pallets
        diff_cases = round(g["in_stock"]["cases"] - expected_cases, 2)
        rq = db.query(Receipt).filter(
            Receipt.product_id == pid, Receipt.lot_number == lot, Receipt.is_deleted == False,  # noqa: E712
            Receipt.status.in_((ReceiptStatus.APPROVED.value, ReceiptStatus.DEPLETED.value)),
        )
        if warehouse_id:
            rq = rq.filter(Receipt.warehouse_id == warehouse_id)
        receipts = rq.all()
        books_on_hand = round(sum(float(r.quantity or 0) for r in receipts), 2)
        for k in ("produced",) + LINE_KEYS + ("not_produced",):
            g[k]["cases"] = round(g[k]["cases"], 2)
        g["in_stock_by_row"] = sorted(g["in_stock_by_row"].values(), key=lambda r: r["row_name"])
        g["found_history"].sort(key=lambda e: (e["at"] is None, e["at"]))
        g["balanced"] = diff_pallets == 0 and abs(diff_cases) < 0.01
        g["difference"] = {"pallets": diff_pallets, "cases": diff_cases}
        g["books"] = {
            "receipt_on_hand": books_on_hand,
            "receipt_produced": round(sum(float(r.quantity_produced or 0) for r in receipts), 2),
            "receipts": len(receipts),
            "on_hand_difference": round(g["in_stock"]["cases"] - books_on_hand, 2),
        }
        out.append(g)
    return out
