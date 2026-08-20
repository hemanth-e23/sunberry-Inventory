from datetime import date, datetime, timezone
from typing import Annotated, Optional

from pydantic import BaseModel, BeforeValidator, PlainSerializer


class BaseSchema(BaseModel):
    class Config:
        from_attributes = True


def _coerce_calendar_date(value):
    """Accept a bare `YYYY-MM-DD` where a datetime is declared.

    `<input type="date">` posts exactly that, and Pydantic 2.5 rejects it for a
    `datetime` field — "invalid datetime separator, expected `T`, `t`, `_` or
    space" — which is a 422 the person filling the form cannot act on.

    MIDNIGHT UTC, deliberately. These fields are CALENDAR DAYS, not instants: a
    best-by date is the same day in every timezone, and the sticker prints it as
    text. Storing midnight UTC keeps the leading `YYYY-MM-DD` of the stored value
    equal to what was typed, which is what `labelPayload.toCalendarKey` and
    `formatCalendarDate` read — lexically, with no timezone maths — so the date
    on a drum matches the date in the database.

    The matching rule on the READ side is that a calendar date must never go
    through `dateUtils.formatDate`. That helper is timezone-aware and correct for
    instants, but on midnight UTC in an America/New_York warehouse it renders the
    PREVIOUS DAY — printing a best-by one day early on a food-safety label.
    """
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            try:
                day = date.fromisoformat(text)
            except ValueError:
                return value       # let pydantic report it properly
            return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return value


# A datetime field that also accepts a bare calendar date from a date input.
CalendarDateTime = Annotated[Optional[datetime], BeforeValidator(_coerce_calendar_date)]


def _serialize_calendar_date(value):
    """Emit a calendar field as `YYYY-MM-DD`, normalized to UTC first.

    Storing midnight UTC is only half the job. Postgres returns a timestamptz in
    the SESSION timezone, and this database runs America/Chicago — so a BBD
    stored as `2027-02-15 00:00:00+00` comes back as `2027-02-14T18:00:00-06:00`
    and serializes to JSON that way. Every lexical reader then takes the leading
    ten characters and gets FEBRUARY 14: a best-by one day early, printed on the
    sticker and encoded into its QR.

    Converting to UTC before taking `.date()` recovers the day that was typed,
    whatever timezone the connection happens to be in.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return aware.astimezone(timezone.utc).date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


# A calendar field on a RESPONSE: always `YYYY-MM-DD`, never an offset instant.
CalendarDateOut = Annotated[
    Optional[datetime],
    PlainSerializer(_serialize_calendar_date, return_type=Optional[str]),
]
