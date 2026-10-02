"""Re-run the rack projection for every lot-tracked lot.

WHY THIS EXISTS

`raw_material_row_allocations` (the rack picture the forms and By Location read)
and the row counters are a PROJECTION of the placement ledger, rewritten only
when a lot changes. On 2026-10-01 rack pounds started following each delivery
of a lot (502 lb/drum truck vs 474 lb/drum truck) and the projection gained a
per-rack `weightPerUnit`. A lot nobody has touched since still carries the old
picture: QA-D2's nine 474s kept reading 4,518 lb while the live figure was
4,266. Run once after deploying that change.

WHAT IT DOES

Calls `project_lot` for every lot that has placements. Recompute-from-source,
so running it twice is the same as running it once; it changes no counts, only
the stored picture and row counters derived from them.

    python3.9 scripts/reproject_lots.py            # report what would change
    python3.9 scripts/reproject_lots.py --write    # apply
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal  # noqa: E402
from app.models import LotPlacement, MaterialLot, Receipt  # noqa: E402
from app.services import lot_placement_service as lps  # noqa: E402


def _picture(db, lot_id):
    out = {}
    for r in db.query(Receipt).filter(Receipt.material_lot_id == lot_id).all():
        for a in r.raw_material_row_allocations or []:
            out[(r.id, a.get("rowId"))] = (round(float(a.get("cases") or 0), 2), a.get("weightPerUnit"))
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--write", action="store_true", help="apply (default: report only)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        lot_ids = [lid for (lid,) in db.query(LotPlacement.material_lot_id).distinct().all()]
        changed = 0
        for lot_id in lot_ids:
            lot = db.query(MaterialLot).filter(MaterialLot.id == lot_id).first()
            if lot is None:
                continue
            before = _picture(db, lot_id)
            lps.project_lot(db, lot)
            db.flush()
            after = _picture(db, lot_id)
            if before != after:
                changed += 1
                lbs_before = sum(v[0] for v in before.values())
                lbs_after = sum(v[0] for v in after.values())
                print(f"{lot.lot_code}: rack lbs {lbs_before:,.2f} -> {lbs_after:,.2f}")
        print(f"{len(lot_ids)} lots checked, {changed} with a changed picture.")
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
