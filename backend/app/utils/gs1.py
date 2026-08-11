"""GS1 identifier helpers — the Bill of Lading number.

The BOL number is a GSIN (Global Shipment Identification Number), not a running
count. 17 digits:

    0850039525    003614    7
    └────┬───┘    └──┬─┘    │
     GS1 company   6-digit  mod-10 check digit
     prefix        serial

The check digit is arithmetic over the other sixteen, which makes the number
self-validating: anyone who receives it — a carrier keying it in, a customer's
receiving system — can recompute the last digit and know the number arrived
intact, without a lookup against us.

This reproduces the numbering Sunberry's legacy system issued (its T-SQL built
the same string and called udfGetGSINCheckDigit), verified against five real
production BOLs from 2026-08-07. That continuity matters: thousands of BOLs are
already in circulation in this format, and a shipment identifier is not
something you can recall once it is printed.
"""
from app.constants import BOL_GSIN_PREFIX, BOL_SERIAL_DIGITS
from app.exceptions import ValidationError


def gs1_check_digit(payload: str) -> str:
    """Standard GS1 mod-10 check digit for a string of digits.

    Weight the digits alternately 3 and 1 working from the RIGHT — so the digit
    immediately left of the check digit always gets 3 regardless of length —
    sum, and take the amount needed to reach the next multiple of ten. The same
    algorithm behind GTIN, SSCC, GLN and GSIN; only the payload length differs.

    Catches every single-digit error and ~89% of adjacent transpositions. The
    ones it misses are pairs differing by exactly 5 (0<->5, 1<->6, ...), where
    the weight difference of 2 makes the sum change by 10, which is invisible
    mod 10. That is inherent to the standard, not to this implementation.
    """
    if not payload or not payload.isdigit():
        raise ValueError(f"GS1 check digit needs a digit string, got {payload!r}")
    total = sum(
        int(ch) * (3 if i % 2 == 0 else 1)
        for i, ch in enumerate(reversed(payload))
    )
    return str((10 - total % 10) % 10)


def build_bol_number(serial: int) -> str:
    """Build the 17-digit GSIN for a BOL from a shipment serial.

    `serial` comes from `bol_number_seq`. It is zero-padded to six digits, which
    caps the series at 999,999 shipments — the same ceiling the legacy system
    had, except there a serial past six digits made REPLICATE() return NULL and
    silently produced a NULL BOL number. Here it raises: a loud failure at
    document generation beats a malformed shipment identifier on paperwork that
    has already left the yard.
    """
    if serial < 0:
        raise ValidationError(f"BOL serial must not be negative: {serial}")
    if serial >= 10 ** BOL_SERIAL_DIGITS:
        raise ValidationError(
            f"BOL serial {serial} needs more than {BOL_SERIAL_DIGITS} digits — "
            f"the GSIN series is exhausted and a new GS1 prefix is required."
        )
    body = f"{BOL_GSIN_PREFIX}{serial:0{BOL_SERIAL_DIGITS}d}"
    return body + gs1_check_digit(body)
