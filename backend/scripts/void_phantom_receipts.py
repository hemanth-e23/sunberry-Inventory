"""Void receipts whose drums never reached a rack (phantom / duplicate entries).

WHY THIS EXISTS

Production (2026-10-02): for ITCSVTMC/25F25/32, 167 Z and 800/26 the receipts
dated 9/10 match the racks exactly, while receipts dated 9/8–9/9 never put a
single drum on a rack — the same deliveries entered twice (the September
phantom-receipt pattern). Their pounds inflate the books (Lot Trace, Activity
Ledger, Snapshot): ITCSVTMC/25F25/32 read 180,808 lb with 84,336 on the racks.

WHAT IT DOES, per receipt id you name

Refuses a receipt that ever put anything on a rack (any placement event that
names it), or that has staging or transfers against it — those are real.
Otherwise: quantity -> 0, status -> depleted, a note saying why, and an
approved stock correction for the pounds removed so every report shows it.

    python3.9 scripts/void_phantom_receipts.py --receipt rcpt-6e498007d336
    python3.9 scripts/void_phantom_receipts.py --receipt rcpt-6e498007d336 --write
"""

import argparse
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal  # noqa: E402
from app.enums import AdjustmentStatus, ReceiptStatus  # noqa: E402
from app.models import (  # noqa: E402
    InventoryAdjustment, InventoryTransfer, LotPlacementEvent, MaterialLot, Receipt, StagingItem,
)
from app.services import lot_placement_service as lps  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--receipt", action="append", required=True, help="receipt id (repeatable)")
    parser.add_argument("--write", action="store_true", help="apply (default: report only)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        to_void = []
        for rid in args.receipt:
            r = db.query(Receipt).filter(Receipt.id == rid).first()
            if r is None:
                print(f"refuse {rid}: not found")
                continue
            placed = db.query(LotPlacementEvent.id).filter(LotPlacementEvent.ref_id == rid).count()
            staged = db.query(StagingItem.id).filter(StagingItem.receipt_id == rid).count()
            moved = db.query(InventoryTransfer.id).filter(InventoryTransfer.receipt_id == rid).count()
            if placed or staged or moved:
                print(f"refuse {rid} ({r.lot_number}): it is real — {placed} rack events, "
                      f"{staged} staging items, {moved} transfers")
                continue
            if r.status not in (ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED) or float(r.quantity or 0) <= 0:
                print(f"skip   {rid} ({r.lot_number}): status {r.status}, quantity {r.quantity}")
                continue
            print(f"void   {rid} ({r.lot_number}, {r.receipt_date:%Y-%m-%d}): "
                  f"{float(r.quantity):,.2f} {r.unit or 'lbs'}, {r.container_count} containers")
            to_void.append(r)
        if not args.write:
            print("Report only — run with --write to apply.")
            return
        now = datetime.now(timezone.utc)
        for r in to_void:
            qty = float(r.quantity or 0)
            db.add(InventoryAdjustment(
                id=f"adj-void-{uuid.uuid4().hex[:10]}",
                receipt_id=r.id,
                product_id=r.product_id,
                warehouse_id=r.warehouse_id,
                adjustment_type="stock-correction",
                quantity=qty,
                reason="Voided duplicate receipt: its drums never reached a rack "
                       "(same delivery entered twice). Checked against a physical count.",
                status=AdjustmentStatus.APPROVED,
                approved_at=now,
                original_quantity=qty,
                new_quantity=0.0,
            ))
            r.quantity = 0.0
            r.status = ReceiptStatus.DEPLETED
            r.note = ((r.note or "") + "\n[Voided 2026-10: duplicate receipt, never on a rack]").strip()
            if r.material_lot_id:
                lot = db.query(MaterialLot).filter(MaterialLot.id == r.material_lot_id).first()
                if lot is not None:
                    db.flush()
                    lps.project_lot(db, lot)
        db.commit()
        print(f"Written: {len(to_void)} receipt(s) voided.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
