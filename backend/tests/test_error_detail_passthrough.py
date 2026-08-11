"""Validation messages must reach the browser exactly as written.

Some of them are not prose — they are sentinels the frontend switches on.
`reconcile` answers SHORT_CONFIRM_REQUIRED so the UI can raise a "this order is
short, are you sure?" dialog instead of an error, and the check is an equality
test on the detail string.

This broke in production without a code change. `ValidationError` subclasses
starlette's `HTTPException`; starlette 0.41 added a `__str__` of
`f"{status_code}: {detail}"`, so routes doing `detail=str(e)` began sending
"400: SHORT_CONFIRM_REQUIRED". The frontend's equality check stopped matching,
the dialog never opened, and a short shipment could not be finalized at all —
the raw sentinel was shown to the operator as an error toast.

requirements.txt pinned fastapi but not starlette, so a container rebuild
changed the behaviour of code nobody had touched.
"""
import re
from pathlib import Path

import pytest

from app.exceptions import ValidationError, ConflictError, NotFoundError

ROUTERS = Path(__file__).resolve().parent.parent / "app" / "routers"


def test_validation_error_detail_is_the_bare_message():
    e = ValidationError("SHORT_CONFIRM_REQUIRED")
    assert e.detail == "SHORT_CONFIRM_REQUIRED"
    assert e.status_code == 400


@pytest.mark.parametrize("exc,expected", [
    (ValidationError("SHORT_CONFIRM_REQUIRED"), "SHORT_CONFIRM_REQUIRED"),
    (ConflictError("Already reconciled"), "Already reconciled"),
    (NotFoundError("Transfer"), "Transfer not found"),
])
def test_detail_carries_no_status_prefix(exc, expected):
    """`.detail` is stable across starlette versions; `str()` is not."""
    assert exc.detail == expected
    assert not re.match(r"^\d{3}: ", str(exc.detail))


def test_no_router_uses_str_of_an_http_exception():
    """`detail=str(e)` is the exact shape that shipped "400: ..." to the browser.

    Every ValidationError/ConflictError already IS an HTTPException carrying the
    right status and a clean detail, so routes should re-raise with `e.detail`.
    """
    offenders = []
    for path in ROUTERS.glob("*.py"):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            if "detail=str(e)" in line:
                offenders.append(f"{path.name}:{i}")
    assert not offenders, (
        "these routes would prefix the status onto the message under "
        f"starlette >= 0.41: {offenders}"
    )
