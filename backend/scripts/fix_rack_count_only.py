"""Set ONE lot on ONE rack to a counted figure WITHOUT moving the books.

WHY THIS EXISTS

Before the fix to approval, approving a receipt that had already been scanned
on the gun put its drums on the rack a second time: the books said 13 drums of
M019116, the rack said 26 (production, 2026-10-02). The books were right and
the rack was wrong. A normal count now moves the books along with the rack —
the right thing for a real count, the wrong thing here, because it would drag
the correct books down too. This corrects the rack alone, with a recorded
reason, after somebody has counted what is physically there.

    python3.9 scripts/fix_rack_count_only.py --lot M019116 --rack "Reefer 557" --units 13
    python3.9 scripts/fix_rack_count_only.py --lot M019116 --rack "Reefer 557" --units 13 --write
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal  # noqa: E402
from app.models import LotPlacement, MaterialLot, StorageRow  # noqa: E402
from app.services import lot_placement_service as lps  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--lot", required=True, help="vendor lot, e.g. M019116")
    parser.add_argument("--rack", required=True, help="rack name, e.g. 'Reefer 557'")
    parser.add_argument("--units", required=True, type=int, help="sealed units physically there")
    parser.add_argument("--write", action="store_true", help="apply (default: report only)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        lots = db.query(MaterialLot).filter(
            MaterialLot.vendor_lot_number == args.lot, MaterialLot.is_deleted == False,  # noqa: E712
        ).all()
        rows = db.query(StorageRow).filter(StorageRow.name == args.rack, StorageRow.is_active.isnot(False)).all()
        if len(rows) != 1:
            print(f"Rack '{args.rack}': {len(rows)} active racks have that name — be specific.")
            return
        row = rows[0]
        matches = [
            (lot, p) for lot in lots
            for p in db.query(LotPlacement).filter(
                LotPlacement.material_lot_id == lot.id, LotPlacement.storage_row_id == row.id).all()
        ]
        if len(matches) != 1:
            print(f"Lot {args.lot} on {args.rack}: {len(matches)} placements found — nothing done.")
            return
        lot, placement = matches[0]
        before = int(placement.full_units or 0)
        print(f"{args.lot} on {args.rack}: rack says {before} {lot.unit_label}, set to {args.units} "
              f"({args.units - before:+d}). Books are NOT changed.")
        if not args.write:
            print("Report only — run with --write to apply.")
            return
        lps.set_count(
            db, lot, row.id,
            full_units=args.units,
            open_units=int(placement.open_units or 0),
            open_remaining_qty=float(placement.open_remaining_qty or 0),
            reason="Rack-only correction: drums double-booked when an already-scanned "
                   "receipt was approved (books were right). Physically counted.",
            ref_type="rack-correction",
        )
        db.commit()
        print("Written.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
