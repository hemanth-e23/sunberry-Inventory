"""Turn a request schema into constructor kwargs a model will actually accept.

`SomeModel(**payload.dict())` is the obvious way to build a row from a request
body, and it is a trap. A request schema usually inherits from the same base as
the RESPONSE schema, so the moment a display-only field is added there —
`live_pallets`, `live_cases`, a nested `rows` list — it starts arriving in the
constructor, which rejects it:

    TypeError: 'live_pallets' is an invalid keyword argument for StorageRow

That raises inside the route, becomes a 500 that loses its CORS headers on the
way out, and reaches the browser as a bare "Network Error". Creating a storage
row was impossible from the UI from 2026-06-01, and a storage area from
2026-03-05, before anyone traced it back to this.

The field is not the bug — several create schemas legitimately carry fields that
are not columns (`UserCreate.password` becomes `hashed_password`,
`ReceiptCreate.allocations` is written by the router afterwards). Passing them
to the model is the bug. Filtering here keeps the two concerns apart: a schema
may describe whatever the API needs, and the model still only sees its own
columns.
"""
from typing import Any, Dict


def schema_dict(payload: Any) -> Dict[str, Any]:
    """Payload as a plain dict, across pydantic versions.

    The codebase runs pydantic 2 but still calls the v1 `.dict()` alias in most
    places; both spellings appear in the routers.
    """
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    return payload.dict()


def model_kwargs(payload: Any, model: type, **overrides: Any) -> Dict[str, Any]:
    """Fields of `payload` that are real columns on `model`.

    Defaults are deliberately NOT excluded: the previous `.dict()` behaviour
    included them, and a create endpoint relies on that to write `hold=False`
    rather than leaving it NULL.

    `overrides` are applied last and are not filtered — they are the route's own
    values (a generated id, the acting user), not untrusted request input.
    """
    columns = {c.name for c in model.__table__.columns}
    data = {k: v for k, v in schema_dict(payload).items() if k in columns}
    data.update(overrides)
    return data
