"""Guard against reintroducing event-loop-blocking endpoints.

Every route handler in this app runs synchronous SQLAlchemy. FastAPI executes
an `async def` handler directly on the event loop, so a blocking database call
inside one freezes the entire worker — every other request in the process, not
just its own. Declared as `def`, the same handler runs on the threadpool and
blocks only itself.

That distinction is one keyword, invisible in review, and it is what turned a
client-side request loop into two full outages. Measured on this app with a 6s
blocking call: `async def` made an unrelated /api/health take 5.010s; `def`
kept it at 0.009s with three such calls running concurrently.

So the rule is enforced here rather than left to reviewer memory: an endpoint
may be `async def` only if it actually awaits something.
"""
import ast
import os

import pytest

ROUTERS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "routers")

# Handlers that genuinely await and must stay async. Listed explicitly so that
# adding to this set is a deliberate decision rather than an oversight.
KNOWN_ASYNC = {
    ("inventory.py", "get_bol_report"),          # awaits an external HTTP client
    ("service.py", "sync_production_usage"),     # awaits a service coroutine
    ("service.py", "get_close_out_data"),        # awaits a service coroutine
}


def _is_route_decorator(dec):
    func = dec.func if isinstance(dec, ast.Call) else dec
    return (
        isinstance(func, ast.Attribute)
        and func.attr in {"get", "post", "put", "patch", "delete", "head", "options"}
        and isinstance(func.value, ast.Name)
        and func.value.id in {"router", "app"}
    )


def _awaits_something(node):
    """True if this function's OWN body awaits. Nested coroutines don't count:
    they keep working regardless of how the outer handler is declared."""
    for child in ast.iter_child_nodes(node):
        for sub in ast.walk(child):
            if isinstance(sub, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            if isinstance(sub, (ast.Await, ast.AsyncWith, ast.AsyncFor)):
                return True
    return False


def _iter_endpoints():
    for entry in sorted(os.listdir(ROUTERS_DIR)):
        if not entry.endswith(".py"):
            continue
        path = os.path.join(ROUTERS_DIR, entry)
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), path)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not any(_is_route_decorator(d) for d in node.decorator_list):
                continue
            yield entry, node


def test_no_async_endpoint_without_await():
    """An `async def` endpoint that never awaits blocks the event loop."""
    offenders = [
        f"{entry}::{node.name} (line {node.lineno})"
        for entry, node in _iter_endpoints()
        if isinstance(node, ast.AsyncFunctionDef)
        and not _awaits_something(node)
        and (entry, node.name) not in KNOWN_ASYNC
    ]
    assert not offenders, (
        "These endpoints are declared `async def` but never await, so their "
        "synchronous database work runs on the event loop and blocks every "
        "other request in the worker. Drop the `async` keyword:\n  "
        + "\n  ".join(offenders)
    )


def test_known_async_endpoints_still_await():
    """If one of the allowed handlers stops awaiting, it should leave the list.

    Keeps the allowlist honest — a stale entry would silently re-permit a
    blocking handler.
    """
    stale = [
        f"{entry}::{node.name}"
        for entry, node in _iter_endpoints()
        if (entry, node.name) in KNOWN_ASYNC
        and isinstance(node, ast.AsyncFunctionDef)
        and not _awaits_something(node)
    ]
    assert not stale, (
        "These are exempted as genuinely async but no longer await anything. "
        "Convert them to `def` and remove them from KNOWN_ASYNC:\n  "
        + "\n  ".join(stale)
    )


@pytest.mark.parametrize("entry,name", sorted(KNOWN_ASYNC))
def test_known_async_allowlist_entries_exist(entry, name):
    """A renamed or deleted handler must not leave a dead exemption behind."""
    found = {(e, n.name) for e, n in _iter_endpoints()}
    assert (entry, name) in found, (
        f"KNOWN_ASYNC lists {entry}::{name}, which no longer exists. "
        "Remove the stale entry."
    )
