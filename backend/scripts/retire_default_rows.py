"""Retire leftover "default rows" in rooms that have real racks.

WHY THIS EXISTS

Typing a room ("Stored as: Drums") creates a hidden row named after the room so
a one-space room (a reefer, a cage) can still be scanned into. Since
2026-10-01 that row is retired automatically when the room gets real racks —
but rooms set up before then still carry it, and By Location lists it as an
empty rack (QA Drum Room, QA Quarantine in the browser test).

WHAT IT DOES

Deactivates rows that are attached directly to a room (no storage area), are
named exactly like the room, sit in a room that has other active rows, and
hold nothing. A default row with stock on it is left alone.

    python3.9 scripts/retire_default_rows.py            # report only
    python3.9 scripts/retire_default_rows.py --write    # apply
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import func  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.models import LotPlacement, SubLocation  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--write", action="store_true", help="apply (default: report only)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        retired = 0
        for sub in db.query(SubLocation).all():
            rows = [r for r in (sub.rows or []) if r.is_active]
            name = (sub.name or "").strip().lower()
            defaults = [
                r for r in rows
                if r.storage_area_id is None and (r.name or "").strip().lower() == name
            ]
            if not defaults or len(defaults) == len(rows):
                continue
            for row in defaults:
                held = db.query(
                    func.coalesce(func.sum(LotPlacement.full_units + LotPlacement.open_units), 0)
                ).filter(LotPlacement.storage_row_id == row.id).scalar()
                if held:
                    print(f"keep   {sub.name} / {row.name} — holds {held} units")
                    continue
                print(f"retire {sub.name} / {row.name} ({row.id})")
                row.is_active = False
                retired += 1
        print(f"{retired} default row(s) to retire.")
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
