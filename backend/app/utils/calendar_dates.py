"""A CALENDAR DAY IS NOT A MOMENT. One rule, one place.

A best-by date is the same day in every timezone. It is printed on a drum, it is
part of a lot's identity, and it is what a recall is traced by. It is not an
instant, and it must never go through a timezone conversion.

THIS KEEPS GOING WRONG, so it lives here now rather than in four places:

  * `labelPayload.js` reads a BBD lexically off the leading `YYYY-MM-DD`, and
    has warned about the trap since the per-drum work.
  * The API was serializing calendar fields as offset instants, so JSON carried
    `2027-05-31T19:00:00-05:00` and every lexical reader took May 31.
  * The day navigator rendered a `YYYY-MM-DD` key through the timezone-aware
    formatter and showed "Today · 8/20" while its own date input said 8/21.
  * And worst, `build_lot_key` took `.date()` straight off a datetime loaded
    from Postgres. A BBD is stored as midnight UTC but comes back in the SESSION
    timezone — America/Chicago here — so 2027-06-01 read as 2027-05-31.

That last one was not a display bug. The day is part of the lot key, and the two
entry paths sourced it differently:

    walk-in / incoming order -> loaded from the DB   -> 2027-05-31
    opening balance          -> parsed from the form -> 2027-06-01

Two keys for one lot, so a second delivery would not match the first: two lots,
two sticker designs, split stock, and nothing afterwards to show the pile on the
rack had ever been one thing.

THE RULE: normalise to UTC, THEN take the day. Everything that stores a calendar
field writes midnight UTC (see schemas/base.py), so the UTC day is always the
day somebody typed.
"""

from datetime import date, datetime, timezone
from typing import Optional


def calendar_day(value) -> Optional[str]:
    """`YYYY-MM-DD` for a calendar field, or None.

    A naive datetime is read as UTC, which is what everything reaching here
    means by one — the stores all write midnight UTC.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return aware.astimezone(timezone.utc).date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    return text[:10] if len(text) >= 10 else None


def calendar_day_compact(value) -> str:
    """`YYYYMMDD` — the form the lot code and the label payload use."""
    day = calendar_day(value)
    return day.replace("-", "") if day else ""
