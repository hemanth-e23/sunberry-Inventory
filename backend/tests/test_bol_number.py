"""The BOL number is a GSIN, and the check digit is not decorative.

A wrong check digit makes the number invalid to every GS1-aware system that
receives it, and a wrong SERIAL silently identifies a different shipment. Both
land on a signed bill of lading, so both are pinned here — most importantly
against real production numbers, so this tests the actual format Sunberry
issues rather than my reading of the spec.
"""
import pytest

from app.constants import BOL_GSIN_PREFIX, BOL_SERIAL_DIGITS
from app.utils.gs1 import build_bol_number, gs1_check_digit
from app.exceptions import ValidationError


# Real BOLs printed by the legacy system on 2026-08-07. If the algorithm ever
# stops reproducing these exactly, the numbering has diverged from the series
# already in customers' and carriers' hands.
REAL_BOLS = [
    "08500395250035669",
    "08500395250036000",
    "08500395250036024",
    "08500395250036147",
    "08500395250036154",
]


@pytest.mark.parametrize("bol", REAL_BOLS)
def test_reproduces_real_production_bols(bol):
    serial = int(bol[len(BOL_GSIN_PREFIX):len(BOL_GSIN_PREFIX) + BOL_SERIAL_DIGITS])
    assert build_bol_number(serial) == bol


def test_check_digit_matches_a_known_gs1_value():
    """Independent of Sunberry's prefix: a published GTIN-13 check digit."""
    assert gs1_check_digit("978030640615") == "7"


def test_shape_is_a_17_digit_gsin():
    n = build_bol_number(6000)
    assert len(n) == 17 and n.isdigit()
    assert n.startswith(BOL_GSIN_PREFIX)
    assert n[:-1] + gs1_check_digit(n[:-1]) == n


def test_serial_is_zero_padded_to_six():
    assert build_bol_number(1)[10:16] == "000001"
    assert build_bol_number(999999)[10:16] == "999999"


def test_check_digit_catches_a_single_digit_typo():
    good = build_bol_number(3614)
    typo = good[:12] + ("8" if good[12] != "8" else "7") + good[13:]
    assert gs1_check_digit(typo[:-1]) != typo[-1]


def test_series_is_exhausted_loudly_not_silently():
    """The legacy T-SQL emitted a NULL BOL number past six digits. Raise instead."""
    with pytest.raises(ValidationError):
        build_bol_number(1_000_000)


def test_negative_serial_rejected():
    with pytest.raises(ValidationError):
        build_bol_number(-1)


def test_generation_uses_the_gsin_builder(monkeypatch):
    """Guards the wiring: ship_out_service must format the sequence value as a
    GSIN, not as the old bare counter ("003")."""
    from app.services import ship_out_service
    assert ship_out_service.build_bol_number is build_bol_number
    assert build_bol_number(6000) == "08500395250060005"
