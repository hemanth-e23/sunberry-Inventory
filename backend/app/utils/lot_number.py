"""Lot number generator + parser.

Mirror of frontend `generateLotNumber` in
`frontend/src/components/receipt/useReceiptForm.js:176-185`.

Format: MP{DDD}{YY}L{N}
  DDD = day-of-year, zero-padded to 3 digits
  YY  = last two digits of the year
  N   = production line number (digits extracted from line name)

Both `DDD` and `YY` are computed in the plant's local timezone, not UTC,
so the lot number reflects the plant's calendar day.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo


_LINE_DIGIT_RE = re.compile(r"\d+")
_LOT_RE = re.compile(r"^MP(\d{3})(\d{2})L(\d+)$", re.IGNORECASE)


def extract_line_number(line_name_or_number: str) -> Optional[str]:
    """Pull digits from a line name. 'Line 1' -> '1'; '12' -> '12'; '' -> None."""
    if not line_name_or_number:
        return None
    match = _LINE_DIGIT_RE.search(str(line_name_or_number))
    return match.group(0) if match else None


def generate_lot_number(production_date_local: date, line_name_or_number: str) -> str:
    """Build a lot number from a plant-local date + line.

    Raises ValueError if line has no digits.
    """
    line_num = extract_line_number(line_name_or_number)
    if line_num is None:
        raise ValueError(f"Line name must contain a digit: {line_name_or_number!r}")
    day_of_year = production_date_local.timetuple().tm_yday
    yy = production_date_local.year % 100
    return f"MP{day_of_year:03d}{yy:02d}L{line_num}"


def lot_for_today(plant_timezone: str, line_name_or_number: str) -> str:
    """Convenience: lot number for today in the plant's local timezone."""
    tz = ZoneInfo(plant_timezone or "UTC")
    today_local = datetime.now(tz).date()
    return generate_lot_number(today_local, line_name_or_number)


def parse_lot_number(lot_number: str) -> Optional[dict]:
    """Parse a lot number back into its components, or None on mismatch."""
    if not lot_number:
        return None
    match = _LOT_RE.match(lot_number.strip())
    if not match:
        return None
    return {
        "day_of_year": int(match.group(1)),
        "year_2digit": int(match.group(2)),
        "line_number": match.group(3),
    }


def plant_local_date(plant_timezone: str, dt: datetime) -> date:
    """Convert any tz-aware datetime to a date in plant local time."""
    tz = ZoneInfo(plant_timezone or "UTC")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz).date()
