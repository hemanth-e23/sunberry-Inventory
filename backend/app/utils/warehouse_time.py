"""A warehouse's LOCAL day — the counterpart of calendar_dates.

calendar_dates covers CALENDAR fields (a best-by is the typed day everywhere).
This covers INSTANTS seen through a warehouse's clock: "what happened on
10/1" at a plant in America/New_York means 04:00Z 10/1 .. 03:59:59Z 10/2, not
the UTC day. Treating it as the UTC day is how a truck received at 8:13 PM
Eastern dropped out of that day's reports (browser test 2026-10-01, F3).
"""

from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

# Warehouse.timezone's column default — the fallback whenever a warehouse
# (or the viewer's warehouse) can't be determined.
DEFAULT_WAREHOUSE_TIMEZONE = "America/New_York"


def zone(tz_name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name or DEFAULT_WAREHOUSE_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_WAREHOUSE_TIMEZONE)


def warehouse_timezone(db: Session, warehouse_id: Optional[str]) -> Optional[str]:
    """The warehouse's configured timezone name, or None if unknown."""
    if not warehouse_id:
        return None
    from app.models import Warehouse

    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    return wh.timezone if wh and wh.timezone else None


def as_aware_utc(value: datetime) -> datetime:
    """A naive datetime is read as UTC (what every writer here means by one)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
