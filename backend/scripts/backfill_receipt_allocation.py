"""
One-time backfill: rebuild receipt.allocation JSON from the live pallet table.

Why this exists
---------------
receipt.allocation is a cached JSON snapshot of "where the pallets are sitting"
for each lot. Historically, ship-out approvals decremented receipt.quantity and
freed storage_row occupancy, but never refreshed receipt.allocation. The cached
JSON kept saying "8 pallets at AJ151" long after those 8 pallets had shipped.

The new multi-product ship-out path rebuilds allocation correctly going forward
(transfer_service.py _approve_multi_line_ship_out). This script cleans up the
drift that accumulated under the old single-receipt path.

What it does
------------
For every Receipt with at least one pallet_licence row, it calls the existing
helper transfer_service._rebuild_receipt_allocation_from_licences(), which
groups IN_STOCK pallets by storage_row and rewrites receipt.allocation.

Safety
------
- Read-only against pallet_licences and storage_rows
- Only writes receipt.allocation (one JSON column)
- Idempotent — running twice produces the same result
- Receipts with zero pallet_licences (e.g. RM/PKG or bulk-imported FG) are
  skipped so we don't accidentally blank a valid allocation built another way.

Run once:
  cd backend
  python3.9 scripts/backfill_receipt_allocation.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import func
from app.database import SessionLocal
from app.models import Receipt, PalletLicence
from app.services.transfer_service import _rebuild_receipt_allocation_from_licences


def backfill(dry_run: bool = False) -> dict:
    db = SessionLocal()
    stats = {"considered": 0, "updated": 0, "skipped_no_pallets": 0, "errors": 0}
    try:
        # Only consider receipts that have at least one pallet_licence row.
        # Receipts with no licences are either non-pallet (RM/PKG) or bulk-imported
        # FG — their allocation came from another source and we shouldn't blank it.
        receipt_ids_with_pallets = [
            rid for (rid,) in db.query(PalletLicence.receipt_id)
            .filter(PalletLicence.receipt_id.isnot(None))
            .distinct()
            .all()
        ]

        receipts = (
            db.query(Receipt)
            .filter(Receipt.id.in_(receipt_ids_with_pallets))
            .all()
        ) if receipt_ids_with_pallets else []

        print(f"Found {len(receipts)} receipts with pallet_licences.")

        for r in receipts:
            stats["considered"] += 1
            try:
                before = r.allocation
                _rebuild_receipt_allocation_from_licences(db, r)
                if r.allocation != before:
                    stats["updated"] += 1
                if dry_run:
                    db.rollback()
                else:
                    db.commit()
            except Exception as e:
                stats["errors"] += 1
                print(f"  ERROR on receipt {r.id}: {e}")
                db.rollback()

        # Optional: show count of receipts skipped (no pallets)
        total_receipts = db.query(func.count(Receipt.id)).scalar() or 0
        stats["skipped_no_pallets"] = total_receipts - stats["considered"]
        return stats
    finally:
        db.close()


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    print(f"{'DRY RUN — no writes.' if dry else 'LIVE — committing changes.'}")
    result = backfill(dry_run=dry)
    print()
    print("Backfill summary:")
    for k, v in result.items():
        print(f"  {k}: {v}")
