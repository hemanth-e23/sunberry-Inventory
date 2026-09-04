"""Rebuild StorageRow.occupied_* from what is actually on the racks.

WHY THIS EXISTS

`occupied_pallets` and `occupied_cases` are a cache. For years the receipt-create
path incremented them and nothing decremented them, so they only ever climbed:

    ROW 1    501 occupied against a capacity of 22
    ROW 9     80 against 22
    AA121     17 against 15

That was not merely cosmetic. The create endpoint used to raise HTTP 400 when a
row was over capacity, and the receipt form hid such rows entirely, so a drifted
row became permanently unusable — and the only thing that could have corrected
the number was the very entry being refused. Both gates are now soft, but the
numbers themselves still need one honest rebuild.

WHAT IT COMPUTES

Two sources of truth, and neither is the cache:

  * finished goods  -> pallet_licences that are in_stock
  * raw / packaging -> lot_placements

A row holding neither goes to zero, which is the point: a row nothing is on
should read empty.

WHEN TO RUN IT

After clearing raw material data and before re-entering it, so the racks start
from a true zero. Safe to run again at any time — it recomputes from source
rather than applying a delta, so running it twice is the same as running it once.

    python3.9 scripts/recompute_row_occupancy.py            # report only
    python3.9 scripts/recompute_row_occupancy.py --write    # apply

Add `--skip-rows-holding-fg` to leave rows with finished-goods pallets on them
untouched. Worth knowing before you do: the FG cache has drifted the same way
(AD101 reads 24 pallets with no licence on it at all), so the narrow run fixes
the raw material racks and leaves that for a separate decision.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal  # noqa: E402
from app.enums import PalletStatus  # noqa: E402
from app.models import LotPlacement, MaterialLot, PalletLicence, StorageRow  # noqa: E402
from app.services import lot_placement_service as lps  # noqa: E402


def compute(db):
    """`{row_id: (pallets, cases)}` — what every row should read."""
    totals = {row.id: [0.0, 0.0] for row in db.query(StorageRow).all()}

    # Finished goods: one licence per physical pallet.
    for licence in (
        db.query(PalletLicence)
        .filter(
            PalletLicence.status == PalletStatus.IN_STOCK,
            PalletLicence.storage_row_id.isnot(None),
        )
        .all()
    ):
        entry = totals.get(licence.storage_row_id)
        if entry is None:
            continue
        entry[0] += 1
        entry[1] += float(licence.cases or 0)

    # Raw material / packaging: placements, with weight derived from the count.
    lots = {lot.id: lot for lot in db.query(MaterialLot).all()}
    for placement in db.query(LotPlacement).all():
        entry = totals.get(placement.storage_row_id)
        lot = lots.get(placement.material_lot_id)
        if entry is None or lot is None:
            continue
        units = int(placement.full_units or 0) + int(placement.open_units or 0)
        # Borrow the projection's own footprint rule rather than restating it.
        # It is the count for drums and ceil(units / units_per_pallet) for bags,
        # and this script must not hold a second opinion: it presents itself as
        # a rebuild from truth, so any disagreement with `_project_rows` would
        # be written to the racks as a correction and stay there.
        entry[0] += lps._pallet_footprint(lot, units)
        entry[1] += lps.derived_weight(lot, placement)

    return {rid: (round(p, 3), round(c, 3)) for rid, (p, c) in totals.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="apply the changes")
    parser.add_argument(
        "--skip-rows-holding-fg",
        action="store_true",
        help=(
            "Leave alone any row that currently has finished-goods pallets on "
            "it. Rows whose FG has all shipped are still corrected — nothing is "
            "on them, so reading zero is the true answer."
        ),
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        wanted = compute(db)
        rows = {row.id: row for row in db.query(StorageRow).all()}

        # The FG denorm has drifted too — AD101 reads 24 pallets with no licence
        # on it at all — but correcting that is a separate decision about
        # separate stock, so it is opt-in rather than bundled in.
        fg_rows = {
            licence.storage_row_id
            for licence in db.query(PalletLicence)
            .filter(PalletLicence.status == PalletStatus.IN_STOCK)
            .all()
        }

        changed = []
        for row_id, (pallets, cases) in wanted.items():
            row = rows[row_id]
            if args.skip_rows_holding_fg and row_id in fg_rows:
                continue
            if (
                abs(float(row.occupied_pallets or 0) - pallets) > 0.001
                or abs(float(row.occupied_cases or 0) - cases) > 0.001
            ):
                changed.append((row, pallets, cases))

        if not changed:
            print("Every row already agrees with what is on it. Nothing to do.")
            return

        print(f"{len(changed)} row(s) disagree with the racks:\n")
        for row, pallets, cases in sorted(changed, key=lambda c: -float(c[0].occupied_pallets or 0)):
            print(
                f"  {row.name:<12} pallets {float(row.occupied_pallets or 0):>8.0f} -> {pallets:<8.0f}"
                f"  cases {float(row.occupied_cases or 0):>10.1f} -> {cases:<10.1f}"
            )

        if not args.write:
            print("\nReport only. Re-run with --write to apply.")
            return

        for row, pallets, cases in changed:
            row.occupied_pallets = pallets
            row.occupied_cases = cases
            if pallets <= 0:
                # A row holding nothing belongs to no product.
                row.product_id = None
        db.commit()
        print(f"\nWrote {len(changed)} row(s).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
