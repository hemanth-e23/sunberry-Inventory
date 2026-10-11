"""Kiosk pallet numbering for the active line production (FG-PALLET-LIFECYCLE-SPEC §3.2).

The numbering used to restart at #1 whenever a row was created: switching a
line A → B → A on the same day reprinted A's #1, and the midnight rollover
overwrote the row in place so the previous lot's last printed number was lost.
Now a new row starts after the highest number this lot+product already used —
on earlier rows for the line (printed) or on real pallets (scanned) — and the
day rollover keeps the old row and opens a new one.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo

from app.models import ActiveLineProduction, PalletLicence
from app.utils.lot_number import lot_for_today, plant_local_date


def starting_seq(
    db: Session, line_id: str, lot_number: str, product_id: str,
    exclude_id: Optional[str] = None,
) -> int:
    """Last number already used for this lot+product: max of what the line
    printed on earlier rows and what was actually scanned/created as pallets.
    A lot number is one line on one day, so lot+product+line is "today"."""
    q = db.query(func.max(ActiveLineProduction.last_printed_seq)).filter(
        ActiveLineProduction.line_id == line_id,
        ActiveLineProduction.lot_number == lot_number,
        ActiveLineProduction.product_id == product_id,
    )
    if exclude_id:
        q = q.filter(ActiveLineProduction.id != exclude_id)
    printed = q.scalar() or 0
    scanned = db.query(func.max(PalletLicence.sequence)).filter(
        PalletLicence.lot_number == lot_number,
        PalletLicence.product_id == product_id,
    ).scalar() or 0
    return max(int(printed), int(scanned))


def new_active_row(
    db: Session, line_id: str, product_id: str, lot_number: str, set_by_user_id: str,
) -> ActiveLineProduction:
    row = ActiveLineProduction(
        id=f"alp-{uuid.uuid4().hex[:12]}",
        line_id=line_id,
        product_id=product_id,
        lot_number=lot_number,
        last_printed_seq=starting_seq(db, line_id, lot_number, product_id),
        set_at=datetime.now(timezone.utc),
        set_by_user_id=set_by_user_id,
        is_active=True,
    )
    db.add(row)
    return row


def ensure_today(db: Session, active: ActiveLineProduction, plant_tz: str) -> ActiveLineProduction:
    """Lazy day-rollover. If the active row is from an earlier plant-local day,
    retire it (keeping its lot and last printed number for the record) and
    return a NEW active row for today's lot with the same product. Caller
    commits. Returns the row that is active after the call."""
    if not active or not active.is_active:
        return active
    set_at_date = plant_local_date(plant_tz, active.set_at)
    today_local = datetime.now(ZoneInfo(plant_tz or "UTC")).date()
    if set_at_date >= today_local:
        return active
    line_name = active.line.name if active.line else ""
    lot = lot_for_today(plant_tz, line_name)
    active.is_active = False
    db.flush()  # one active row per line (partial unique index)
    return new_active_row(db, active.line_id, active.product_id, lot, active.set_by_user_id)
