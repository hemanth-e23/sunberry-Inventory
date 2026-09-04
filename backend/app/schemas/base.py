from datetime import date, datetime, timezone
from typing import Annotated, Optional

from pydantic import BaseModel, BeforeValidator, PlainSerializer

from app.utils.calendar_dates import calendar_day


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


# THE canonical rule lives in app/utils/calendar_dates — see that module for why
# this keeps going wrong and what it costs when it does.
_serialize_calendar_date = calendar_day


# A calendar field on a RESPONSE: always `YYYY-MM-DD`, never an offset instant.
CalendarDateOut = Annotated[
    Optional[datetime],
    PlainSerializer(_serialize_calendar_date, return_type=Optional[str]),
]
