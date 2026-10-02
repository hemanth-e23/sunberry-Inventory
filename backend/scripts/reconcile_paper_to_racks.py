"""Bring each lot's books (receipt paper) into line with its racks, once.

WHY THIS EXISTS

Until 2026-10-02 a physical count changed only the RACK. The receipts' paper —
what Lot Trace, the Activity Ledger and the Snapshot read — kept the old
figure (C-0901: racks 2,970 lb, books 3,025). And a lot entered by a count or
at cutover with no delivery had no receipt at all, so the Transfer and
Adjustment forms, By Location and Lot Trace never showed it (B-FOUND), while
the Activity Ledger counted it. Counts made since then keep both in step;
this script repairs what was recorded before.

WHAT IT DOES, per lot-tracked lot with placements

  * no receipt at all  -> creates one "found in a count" receipt for what is
                          on the racks (exactly what a count now does)
  * books != racks + what is out in staging (beyond 0.5 lb)
                       -> moves the paper by the difference and records an
                          approved stock correction saying why

Lots on QA hold are reported, not touched.

    python3.9 scripts/reconcile_paper_to_racks.py            # report only
    python3.9 scripts/reconcile_paper_to_racks.py --write    # apply
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal  # noqa: E402
from app.enums import ReceiptStatus  # noqa: E402
from app.models import LotPlacement, MaterialLot, Receipt  # noqa: E402
from app.services import lot_placement_service as lps  # noqa: E402
from app.services.lot_cutover_service import sync_paper_to_count  # noqa: E402
from app.services.transfer_service import lot_scoped_availability  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--write", action="store_true", help="apply (default: report only)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        lot_ids = [lid for (lid,) in db.query(LotPlacement.material_lot_id).distinct().all()]
        fixes = 0
        for lot_id in lot_ids:
            lot = db.query(MaterialLot).filter(MaterialLot.id == lot_id).first()
            if lot is None or lot.is_deleted:
                continue
            placements = lps.placements_for_lot(db, lot.id)
            if not placements:
                continue
            racks = round(sum(lps.derived_weight(lot, p) for p in placements), 3)
            label = lot.vendor_lot_number or lot.lot_code
            receipts = db.query(Receipt).filter(
                Receipt.material_lot_id == lot.id, Receipt.is_deleted == False,  # noqa: E712
            ).all()
            if lot.is_held:
                print(f"skip   {label}: on QA hold")
                continue
            if not receipts:
                print(f"found  {label}: {racks:,.2f} lb on racks, no receipt — create one")
                fixes += 1
                if args.write:
                    sync_paper_to_count(
                        db, lot, 0.0, racks, storage_row_id=placements[0].storage_row_id,
                        user_id=None, warehouse_id=lot.warehouse_id,
                        reason="One-time repair: lot entered by count before receipts were created",
                    )
                continue
            anchor = next(
                (r for r in receipts if r.status in (ReceiptStatus.APPROVED, ReceiptStatus.DEPLETED)),
                None,
            )
            if anchor is None:
                continue
            pool = lot_scoped_availability(db, anchor)
            books_on_racks = round(float(pool["total"]) - float(pool.get("staged") or 0), 3)
            diff = round(racks - books_on_racks, 3)
            if abs(diff) <= 0.5:
                continue
            print(f"books  {label}: books {books_on_racks:,.2f} vs racks {racks:,.2f} lb ({diff:+,.2f})")
            fixes += 1
            if args.write:
                sync_paper_to_count(
                    db, lot, books_on_racks, racks, storage_row_id=placements[0].storage_row_id,
                    user_id=None, warehouse_id=lot.warehouse_id,
                    reason="One-time repair: a count made before counts updated the books",
                )
        print(f"{len(lot_ids)} lots checked, {fixes} to repair.")
        if args.write:
            db.commit()
            print("Written.")
        else:
            db.rollback()
            print("Report only — run with --write to apply.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
