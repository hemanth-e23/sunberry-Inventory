"""
One-time backfill: strip stray prefix garbage from historical pallet
licence numbers and the lot_number column.

Why
---
Pallets were created with licence numbers like `PMP14026L1-GVN128C-001`,
`QMP13926L1-GVN1280-073`, etc. — stray characters that landed in the scan
input before the scanner gun fired. The system stored those verbatim, so
the same physical lot now appears as multiple "lots" in the DB.

The new scan path (scanner_service.normalize_scanned_licence) prevents this
going forward. This script cleans up the historical drift.

What it does
------------
For each PalletLicence row whose lot_number starts with any character(s)
followed by 'MP{digits}{digits}L{digits}' (the real format), it:
  1. Computes the corrected lot_number (everything from MP... onward)
  2. Computes the corrected licence_number (replace the bad prefix in place)
  3. Rewrites pallet_licences.lot_number, pallet_licences.licence_number
  4. Rewrites receipts.lot_number if any receipt references the bad lot

Conflict handling
-----------------
If correcting would create a duplicate licence_number (because a real
MP-prefixed licence with that sequence already exists), the row is LEFT
ALONE and reported at the end so a human can resolve it manually.

Receipts: if the corrected lot_number already exists on another receipt
for the same product, the receipt is LEFT ALONE and reported.

Safety
------
- Supports --dry-run (no writes)
- Idempotent — second run is a no-op
- Atomic per-row: failures don't poison later rows

Run:
  cd backend
  python3.9 scripts/normalize_pmp_lots.py --dry-run
  python3.9 scripts/normalize_pmp_lots.py
"""

from __future__ import annotations

import re
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models import PalletLicence, Receipt


# Matches the real lot pattern anywhere in a string. We rewrite by chopping
# any chars before the first occurrence of this pattern.
LOT_RE = re.compile(r"MP\d{3}\d{2}L\d+", re.IGNORECASE)


def first_lot_match(s: str) -> tuple[int, str] | None:
    """Return (index, matched_substring) of the first MP... pattern in s.
    None if no match."""
    if not s:
        return None
    m = LOT_RE.search(s)
    if not m:
        return None
    return (m.start(), m.group(0))


def normalize_str(s: str) -> str:
    """Strip any chars before the first MP... pattern. Returns input unchanged
    if no match or if pattern already at position 0."""
    if not s:
        return s
    m = first_lot_match(s)
    if not m or m[0] == 0:
        return s
    return s[m[0]:]


def run(dry_run: bool = False) -> dict:
    db = SessionLocal()
    stats = {
        "pallet_considered": 0,
        "pallet_rewritten": 0,
        "pallet_conflicts": 0,
        "receipt_considered": 0,
        "receipt_rewritten": 0,
        "receipt_conflicts": 0,
        "errors": 0,
    }
    pallet_conflict_log: list = []
    receipt_conflict_log: list = []

    try:
        # ── PalletLicence pass ────────────────────────────────────────────────
        pls = (
            db.query(PalletLicence)
            .filter(PalletLicence.lot_number.isnot(None))
            .all()
        )
        for pl in pls:
            stats["pallet_considered"] += 1
            current_lot = pl.lot_number or ""
            current_lic = pl.licence_number or ""
            fixed_lot = normalize_str(current_lot)
            fixed_lic = normalize_str(current_lic)
            if fixed_lot == current_lot and fixed_lic == current_lic:
                continue

            # Conflict check: any OTHER pallet already has fixed_lic?
            conflict = (
                db.query(PalletLicence)
                .filter(
                    PalletLicence.licence_number == fixed_lic,
                    PalletLicence.id != pl.id,
                )
                .first()
            )
            if conflict:
                stats["pallet_conflicts"] += 1
                pallet_conflict_log.append({
                    "id": pl.id,
                    "from_licence": current_lic,
                    "to_licence": fixed_lic,
                    "conflicting_existing_id": conflict.id,
                })
                continue

            try:
                pl.lot_number = fixed_lot
                pl.licence_number = fixed_lic
                stats["pallet_rewritten"] += 1
                if dry_run:
                    db.rollback()
                else:
                    db.commit()
            except Exception as e:
                stats["errors"] += 1
                print(f"  ERROR pallet {pl.id}: {e}")
                db.rollback()

        # ── Receipt pass ──────────────────────────────────────────────────────
        receipts = (
            db.query(Receipt)
            .filter(Receipt.lot_number.isnot(None))
            .all()
        )
        for r in receipts:
            stats["receipt_considered"] += 1
            current = r.lot_number or ""
            fixed = normalize_str(current)
            if fixed == current:
                continue

            # Conflict check: another receipt with same product + fixed lot?
            conflict = (
                db.query(Receipt)
                .filter(
                    Receipt.lot_number == fixed,
                    Receipt.product_id == r.product_id,
                    Receipt.id != r.id,
                )
                .first()
            )
            if conflict:
                stats["receipt_conflicts"] += 1
                receipt_conflict_log.append({
                    "id": r.id,
                    "from_lot": current,
                    "to_lot": fixed,
                    "conflicting_existing_id": conflict.id,
                })
                continue

            try:
                r.lot_number = fixed
                stats["receipt_rewritten"] += 1
                if dry_run:
                    db.rollback()
                else:
                    db.commit()
            except Exception as e:
                stats["errors"] += 1
                print(f"  ERROR receipt {r.id}: {e}")
                db.rollback()

        return {"stats": stats, "pallet_conflicts": pallet_conflict_log, "receipt_conflicts": receipt_conflict_log}
    finally:
        db.close()


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    print(f"{'DRY RUN — no writes.' if dry else 'LIVE — committing changes.'}\n")
    result = run(dry_run=dry)
    stats = result["stats"]
    print("Summary:")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    if result["pallet_conflicts"]:
        print("\nPallet licence conflicts (left untouched, resolve manually):")
        for c in result["pallet_conflicts"]:
            print(f"  - id={c['id']}  '{c['from_licence']}' -> '{c['to_licence']}' "
                  f"(blocked by id={c['conflicting_existing_id']})")
    if result["receipt_conflicts"]:
        print("\nReceipt lot conflicts (left untouched, resolve manually):")
        for c in result["receipt_conflicts"]:
            print(f"  - id={c['id']}  '{c['from_lot']}' -> '{c['to_lot']}' "
                  f"(blocked by id={c['conflicting_existing_id']})")
