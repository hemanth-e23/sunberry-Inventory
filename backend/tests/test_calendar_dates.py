"""A CALENDAR DAY IS NOT A MOMENT.

This trap has appeared four times in this codebase — in the label payload, on
the wire, in the day navigator, and worst of all inside the lot key, where a
day's drift split one material into two lots. The rule now lives in one module
and this file guards it directly, so the fifth appearance fails a test rather
than a recall.
"""
from datetime import date, datetime, timedelta, timezone

from app.utils.calendar_dates import calendar_day, calendar_day_compact

CHICAGO = timezone(timedelta(hours=-5))
KOLKATA = timezone(timedelta(hours=5, minutes=30))


class TestCalendarDay:
    def test_utc_midnight_is_that_day(self):
        assert calendar_day(datetime(2027, 6, 1, tzinfo=timezone.utc)) == "2027-06-01"

    def test_the_same_instant_west_of_utc_is_still_that_day(self):
        """What Postgres hands back on this machine. `.date()` here gives May 31
        and that is the bug: the same moment, the previous day."""
        as_db = datetime(2027, 5, 31, 19, tzinfo=CHICAGO)
        assert as_db == datetime(2027, 6, 1, tzinfo=timezone.utc)
        assert calendar_day(as_db) == "2027-06-01"

    def test_and_east_of_utc(self):
        """The mirror case, which drifts the other way."""
        assert calendar_day(datetime(2027, 6, 1, 5, 30, tzinfo=KOLKATA)) == "2027-06-01"

    def test_a_naive_datetime_is_read_as_utc(self):
        assert calendar_day(datetime(2027, 6, 1)) == "2027-06-01"

    def test_a_plain_date_passes_through(self):
        assert calendar_day(date(2027, 6, 1)) == "2027-06-01"

    def test_a_string_is_read_lexically(self):
        """No parsing, no timezone maths — the leading ten characters ARE the
        day, which is the whole reason calendar fields are stored that way."""
        assert calendar_day("2027-06-01") == "2027-06-01"
        assert calendar_day("2027-06-01T00:00:00Z") == "2027-06-01"

    def test_none_stays_none(self):
        assert calendar_day(None) is None

    def test_year_and_month_boundaries_do_not_drift(self):
        """Where an off-by-one day is also off-by-one month or year."""
        assert calendar_day(datetime(2027, 1, 1, tzinfo=timezone.utc)) == "2027-01-01"
        # 19:00 CST is exactly midnight UTC — the New Year rolls over there.
        assert calendar_day(datetime(2026, 12, 31, 19, tzinfo=CHICAGO)) == "2027-01-01"
        # An hour earlier is still the old year, and must stay that way.
        assert calendar_day(datetime(2026, 12, 31, 18, tzinfo=CHICAGO)) == "2026-12-31"
        assert calendar_day(datetime(2027, 3, 1, tzinfo=timezone.utc)) == "2027-03-01"

    def test_a_leap_day_survives(self):
        assert calendar_day(datetime(2028, 2, 29, tzinfo=timezone.utc)) == "2028-02-29"


class TestCompact:
    def test_it_is_the_same_day_without_dashes(self):
        """The form the lot code and the QR payload use."""
        assert calendar_day_compact(datetime(2027, 6, 1, tzinfo=timezone.utc)) == "20270601"
        assert calendar_day_compact(datetime(2027, 5, 31, 19, tzinfo=CHICAGO)) == "20270601"

    def test_empty_rather_than_none(self):
        """It is joined into a string, so an empty segment is what the caller
        wants rather than the word "None" in a printed code."""
        assert calendar_day_compact(None) == ""
