"""
Container data-model invariants — INGREDIENT-SERIALIZATION-SPEC.md §19
acceptance criteria that hold with or WITHOUT the Phase 1 service.

Everything in this file runs today. The flow-level criteria that need
`app.services.ingredient_intake_service` (minting, scanning, idempotency,
soft row capacity) live in `test_containers.py` and skip until it exists.

What is proved here:

  §19.1  a container never reports "cases"    — no unit column on containers /
         intake_lots defaults to it, the way `Receipt.unit` does
         (`app/models/receipt.py:15`, the actual source of the bug)
  §4.2   no code parses a serial for meaning  — a static scan of every module
         that touches a serial, plus a row whose serial DISAGREES with its
         columns to prove reads come from the row
  §19.3  cache-vs-ledger reconciliation       — `container.status` /
         `storage_row_id` must equal the latest `container_events` row; the
         drift query the audit endpoint will run is exercised directly
  §18.9  soft-deleted containers never leak   — a static scan of every read
         path, plus proof that soft-deleting does not free a serial

The static scans are deliberate: without a service there is no runtime read
path to reach, and a filter omitted on these tables is "a silent data leak, not
an error" (`app/models/ingredient.py` module docstring). They fail loudly the
moment a query lands without its guard, which is the only time they matter.
"""
import ast
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.constants import CATEGORY_INGREDIENT
from app.enums import ContainerEventType, ContainerStatus, ContainerType, IntakeStatus
from app.models import (
    Category,
    CategoryGroup,
    Container,
    ContainerEvent,
    IngredientIntake,
    IntakeLot,
    Location,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    User,
    Warehouse,
)
from app.utils.auth import get_password_hash

APP_DIR = Path(__file__).resolve().parents[1] / "app"

# The reconciliation query from `app/models/ingredient.py`'s ContainerEvent
# docstring, widened to also catch row drift (§19.3 names `storage_rows.occupied_*`
# and FG pallet `warehouse_id` in the same breath as status). This is the query
# `GET /ingredient-containers/audit/cache-drift` is specified to run; when that
# endpoint lands, point these tests at it instead of re-declaring the SQL.
CACHE_DRIFT_SQL = text(
    """
    WITH latest AS (
        SELECT DISTINCT ON (container_id) container_id, to_status, to_row_id
        FROM container_events
        ORDER BY container_id, seq DESC
    )
    SELECT c.id AS container_id,
           c.status AS cached_status,
           l.to_status AS ledger_status,
           c.storage_row_id AS cached_row,
           l.to_row_id AS ledger_row
    FROM containers c
    LEFT JOIN latest l ON l.container_id = c.id
    WHERE c.is_deleted = false
      AND (l.container_id IS NULL
           OR l.to_status IS DISTINCT FROM c.status
           OR l.to_row_id IS DISTINCT FROM c.storage_row_id)
    """
)


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def world(db_session):
    """One warehouse, one ingredient product, one row, one open intake + lot."""
    db_session.add(Warehouse(id="wh-pp", name="Paw Paw", code="PP", type="plant"))
    db_session.add(CategoryGroup(id="grp-sb", name="Sunberry"))
    db_session.add(Category(id="cat-ing", name="Purees", type=CATEGORY_INGREDIENT,
                            parent_id="grp-sb"))
    db_session.add(Product(id="prod-guava", name="Conventional Guava Puree",
                           category_id="cat-ing"))
    db_session.add(Location(id="loc-pp", name="Paw Paw"))
    db_session.add(SubLocation(id="sub-barn", name="Blueberry Barn", location_id="loc-pp"))
    db_session.add(StorageRow(id="row-a12", name="A-12", sub_location_id="sub-barn",
                              barcode="PP-A-12", pallet_capacity=0))
    db_session.add(StorageRow(id="row-a13", name="A-13", sub_location_id="sub-barn",
                              barcode="PP-A-13", pallet_capacity=0))
    db_session.add(User(id="u-wh", username="whworker", name="WH Worker",
                        email="wh@sunberry.com", hashed_password=get_password_hash("password123"),
                        role="warehouse", is_active=True, warehouse_id="wh-pp"))
    db_session.add(IngredientIntake(
        id="ing-1", intake_number="ING-260803-0042", warehouse_id="wh-pp",
        status=IntakeStatus.RECORDED.value, expected_count=80, received_count=0,
        last_serial_seq=0,
    ))
    db_session.add(IntakeLot(
        id="ilot-1", intake_id="ing-1", product_id="prod-guava", category_id="cat-ing",
        container_type=ContainerType.BARREL.value, vendor_lot="389641",
        bbd=datetime(2027, 2, 15, tzinfo=timezone.utc), expected_count=80,
        net_weight_per_container=500.0, weight_unit="lbs",
    ))
    db_session.commit()
    return {
        "intake_id": "ing-1",
        "lot_id": "ilot-1",
        "product_id": "prod-guava",
        "warehouse_id": "wh-pp",
        "row_id": "row-a12",
        "other_row_id": "row-a13",
        "user_id": "u-wh",
    }


def _container(db, world, *, serial, sequence, **overrides):
    kwargs = dict(
        id=f"cnt-{uuid.uuid4().hex[:12]}",
        serial=serial,
        sequence=sequence,
        intake_id=world["intake_id"],
        intake_lot_id=world["lot_id"],
        product_id=world["product_id"],
        warehouse_id=world["warehouse_id"],
        container_type=ContainerType.BARREL.value,
        status=ContainerStatus.PRINTED_UNAPPLIED.value,
        vendor_lot="389641",
        bbd=datetime(2027, 2, 15, tzinfo=timezone.utc),
        net_weight=500.0,
        remaining_qty=500.0,
        qty_unit="lbs",
    )
    kwargs.update(overrides)
    container = Container(**kwargs)
    db.add(container)
    return container


def _event(db, container, *, event_type, from_status, to_status,
           from_row_id=None, to_row_id=None):
    evt = ContainerEvent(
        id=f"cevt-{uuid.uuid4().hex[:12]}",
        container_id=container.id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        from_row_id=from_row_id,
        to_row_id=to_row_id,
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(evt)
    return evt


def _receive_and_approve(db, container, row_id):
    """Write the ledger a correctly-implemented service would write."""
    _event(db, container, event_type=ContainerEventType.PRINTED.value,
           from_status=None, to_status=ContainerStatus.PRINTED_UNAPPLIED.value)
    _event(db, container, event_type=ContainerEventType.RECEIVED.value,
           from_status=ContainerStatus.PRINTED_UNAPPLIED.value,
           to_status=ContainerStatus.RECEIVED.value, to_row_id=row_id)
    _event(db, container, event_type=ContainerEventType.APPROVED.value,
           from_status=ContainerStatus.RECEIVED.value,
           to_status=ContainerStatus.IN_STOCK.value,
           from_row_id=row_id, to_row_id=row_id)
    container.status = ContainerStatus.IN_STOCK.value
    container.storage_row_id = row_id
    db.commit()


# ── §4.2 / §19.2 — a serial is an opaque pointer ─────────────────────────────

@pytest.mark.integration
def test_unique_intake_sequence_constraint_is_enforced_by_the_database(world, db_session):
    """UNIQUE(intake_id, sequence) — the label prints "17 of 80" off `sequence`,
    so two drums may not claim seq 17 even with different serials."""
    _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()

    _container(db_session, world, serial="B-260803-0042-017-DUP", sequence=17)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


@pytest.mark.integration
def test_serial_is_globally_unique(world, db_session):
    """A serial is never reused or reassigned — across intakes, not just within one."""
    _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()

    db_session.add(IngredientIntake(
        id="ing-2", intake_number="ING-260804-0043", warehouse_id="wh-pp",
        status=IntakeStatus.RECORDED.value, last_serial_seq=0,
    ))
    db_session.commit()
    _container(db_session, world, serial="B-260803-0042-017", sequence=1, intake_id="ing-2")
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


@pytest.mark.integration
def test_soft_deleting_a_container_does_not_free_its_serial(world, db_session):
    """"Never reused" outlives soft delete — otherwise a voided drum's serial
    could be minted onto a second physical barrel and the recall trace forks."""
    original = _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()

    original.is_deleted = True
    original.deleted_at = datetime.now(timezone.utc)
    db_session.commit()

    _container(db_session, world, serial="B-260803-0042-017", sequence=99)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


@pytest.mark.integration
def test_every_attribute_comes_from_the_row_not_the_serial(world, db_session):
    """§4.2: "no code ever parses a serial". Two halves of the same proof.

    1. A lot correction (I-8: BBD/lot typo found after printing) fans out onto
       the container. The serial string is untouched and every attribute reads
       the corrected value — labels self-correct at lookup, never by reprint.
    2. The serial's trailing segment is set to disagree with `sequence` on
       purpose. Anything deriving "17 of 80" from the string instead of the
       column reads 999 here.
    """
    container = _container(
        db_session, world,
        serial="B-260803-0042-999",  # deliberately NOT the sequence below
        sequence=17,
        vendor_lot="389641",
        bbd=datetime(2027, 2, 15, tzinfo=timezone.utc),
    )
    db_session.commit()
    serial_before = container.serial

    lot = db_session.query(IntakeLot).filter(IntakeLot.id == world["lot_id"]).first()
    lot.vendor_lot = "CORRECTED-7788"
    lot.bbd = datetime(2028, 6, 1, tzinfo=timezone.utc)
    db_session.query(Container).filter(
        Container.intake_lot_id == lot.id,
        Container.is_deleted == False,  # noqa: E712 — SQL predicate, not a bool test
    ).update({"vendor_lot": lot.vendor_lot, "bbd": lot.bbd}, synchronize_session=False)
    db_session.commit()
    db_session.expire_all()

    container = db_session.query(Container).filter(Container.sequence == 17).first()
    assert container.serial == serial_before, "a lot correction must never rewrite a serial"
    assert container.vendor_lot == "CORRECTED-7788"
    assert container.bbd.year == 2028
    # The row, not the string, is the sequence.
    assert container.sequence == 17
    assert container.serial.rsplit("-", 1)[-1] == "999"


@pytest.mark.integration
def test_no_module_parses_a_serial_for_meaning(db_session):
    """Static guard for §4.2. Splitting/slicing/regexing a value named `serial`
    is how the meaning-from-the-string bug gets reintroduced.

    Deliberately NOT flagged: parsing the label *payload*
    (`SB1|<serial>|<vendor_lot>|<bbd>`) has a versioned envelope and is allowed
    (IMPL-COMMENT 7); only the serial itself is opaque.
    """
    scanned, violations = _scan_for_serial_parsing()
    assert scanned, "the serial-parsing guard scanned no files — it has gone blind"
    assert not violations, (
        "a serial must be an opaque pointer to a DB row (SPEC §4.2); read the "
        "column instead:\n  " + "\n  ".join(violations)
    )


# ── §18.9 — soft-deleted rows never leak ─────────────────────────────────────

@pytest.mark.integration
def test_every_container_read_path_filters_soft_deletes(db_session):
    """`app/models/ingredient.py`: "EVERY read of these tables must carry its own
    `is_deleted == False`; an omitted filter is a silent data leak, not an error."

    Nothing inherits a default-scoped query, so this is the only mechanism that
    can enforce it. Granularity is the enclosing function: a function that
    queries containers and never mentions `is_deleted` anywhere is the leak.

    Scoped to `Container` on purpose. `IngredientIntake` carries the same soft
    delete and the same hazard, but its read paths are the intake service's to
    own; widening this tuple is the right follow-up once they settle.
    """
    scanned, violations = _scan_for_unfiltered_reads(("Container",))
    assert scanned, "the soft-delete guard scanned no files — it has gone blind"
    assert not violations, (
        "these queries can return soft-deleted rows; add `.filter(Model.is_deleted "
        "== False)`:\n  " + "\n  ".join(violations)
    )


@pytest.mark.integration
def test_soft_deleted_containers_are_excluded_from_the_drift_audit(world, db_session):
    """A voided drum must not show up as drift forever. The audit read path is a
    read path like any other."""
    dead = _container(db_session, world, serial="B-260803-0042-001", sequence=1)
    db_session.commit()
    # No events at all: maximum drift signal, so exclusion is unambiguous.
    assert _drift_ids(db_session) == {dead.id}

    dead.is_deleted = True
    dead.deleted_at = datetime.now(timezone.utc)
    db_session.commit()

    assert _drift_ids(db_session) == set()


# ── §19.3 — cache vs. ledger reconciliation ──────────────────────────────────

@pytest.mark.integration
def test_drift_query_is_clean_for_a_correctly_written_ledger(world, db_session):
    """print -> receive -> approve, written the way the service must write it:
    `status` and `storage_row_id` equal the newest event's `to_*`."""
    container = _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()
    _receive_and_approve(db_session, container, world["row_id"])

    assert _drift_ids(db_session) == set()


@pytest.mark.integration
def test_drift_query_catches_a_status_cache_that_outran_the_ledger(world, db_session):
    """The failure mode IMPL-COMMENT 1 accepts as the cost of an authoritative
    `status` column: a mutation that forgets its ledger append."""
    container = _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()
    _receive_and_approve(db_session, container, world["row_id"])

    container.status = ContainerStatus.STAGED.value  # no event written
    db_session.commit()

    drift = _drift_rows(db_session)
    assert [r.container_id for r in drift] == [container.id]
    assert drift[0].cached_status == ContainerStatus.STAGED.value
    assert drift[0].ledger_status == ContainerStatus.IN_STOCK.value


@pytest.mark.integration
def test_drift_query_catches_a_move_that_never_reached_the_ledger(world, db_session):
    """§6.4's bug class in its container form: the drum's location changed and
    nothing recorded where it went."""
    container = _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()
    _receive_and_approve(db_session, container, world["row_id"])

    container.storage_row_id = world["other_row_id"]  # moved, no `moved` event
    db_session.commit()

    drift = _drift_rows(db_session)
    assert [r.container_id for r in drift] == [container.id]
    assert drift[0].cached_row == world["other_row_id"]
    assert drift[0].ledger_row == world["row_id"]


@pytest.mark.integration
def test_a_container_with_no_ledger_history_is_drift(world, db_session):
    """Minting writes `printed`. A container with an empty ledger was created by
    something that skipped the ledger, so it can never be reconciled."""
    orphan = _container(db_session, world, serial="B-260803-0042-002", sequence=2)
    db_session.commit()

    assert orphan.id in _drift_ids(db_session)


@pytest.mark.integration
def test_ledger_is_totally_ordered_independent_of_wall_clock(world, db_session):
    """`occurred_at` is wall-clock; two events in the same millisecond have no
    replay order. `seq` is what DISTINCT ON orders by, so it must be assigned
    and strictly increasing even when timestamps tie."""
    container = _container(db_session, world, serial="B-260803-0042-017", sequence=17)
    db_session.commit()
    same_instant = datetime.now(timezone.utc)

    first = _event(db_session, container, event_type=ContainerEventType.PRINTED.value,
                   from_status=None, to_status=ContainerStatus.PRINTED_UNAPPLIED.value)
    first.occurred_at = same_instant
    db_session.commit()
    second = _event(db_session, container, event_type=ContainerEventType.RECEIVED.value,
                    from_status=ContainerStatus.PRINTED_UNAPPLIED.value,
                    to_status=ContainerStatus.RECEIVED.value, to_row_id=world["row_id"])
    second.occurred_at = same_instant
    db_session.commit()

    assert first.seq is not None and second.seq is not None
    assert second.seq > first.seq
    assert first.occurred_at == second.occurred_at

    container.status = ContainerStatus.RECEIVED.value
    container.storage_row_id = world["row_id"]
    db_session.commit()
    assert _drift_ids(db_session) == set(), "DISTINCT ON must resolve the tie via seq"


@pytest.mark.integration
def test_the_ledger_has_no_soft_delete():
    """"An immutable ledger with a delete flag is a contradiction" — if someone
    adds one, the drift query silently stops seeing history."""
    for column in ("is_deleted", "deleted_at", "deleted_by_id"):
        assert column not in ContainerEvent.__table__.columns, (
            f"container_events.{column} makes the audit trail mutable"
        )


# ── §19.1 — "cases" is impossible for a container ────────────────────────────

@pytest.mark.integration
def test_no_container_column_defaults_to_cases():
    """The §19.1 bug is a *default* leaking, not a bad write: `Receipt.unit`
    defaults to "cases" (`app/models/receipt.py:15`) and an 80-barrel receipt
    renders "80 cases". Containers carry `container_type` and `qty_unit` and
    must never acquire a defaulted unit column of their own."""
    # Sanity: assert the bug we are guarding against still looks the way we think.
    assert Receipt.__table__.c.unit.default.arg == "cases"

    for table in (Container.__table__, IntakeLot.__table__):
        assert "unit" not in table.columns, (
            f"{table.name}.unit would re-open §19.1 — units derive from "
            "container_type / the lot's weight_unit, never from a column default"
        )
        for column in table.columns:
            default = getattr(column.default, "arg", None)
            server_default = getattr(getattr(column, "server_default", None), "arg", None)
            assert default != "cases", f"{table.name}.{column.name} defaults to 'cases'"
            assert str(server_default) != "cases", (
                f"{table.name}.{column.name} server-defaults to 'cases'"
            )


@pytest.mark.integration
def test_container_type_is_required_so_a_unit_can_always_be_derived(world, db_session):
    """"The word "cases" must be impossible for a serialized-ingredient row" only
    holds if every container can name its own unit. A NULL container_type would
    force a fallback, and the fallback in this repo is "cases"."""
    assert Container.__table__.c.container_type.nullable is False
    assert IntakeLot.__table__.c.container_type.nullable is False

    orphan = Container(
        id=f"cnt-{uuid.uuid4().hex[:12]}", serial="B-260803-0042-003", sequence=3,
        intake_id=world["intake_id"], intake_lot_id=world["lot_id"],
        product_id=world["product_id"], container_type=None,
    )
    db_session.add(orphan)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


@pytest.mark.integration
def test_container_type_values_are_the_enum_and_nothing_else(world, db_session):
    """Guards the derivation itself: the unit label switches on container_type,
    so a third spelling silently falls through to whatever the UI defaults to."""
    assert {t.value for t in ContainerType} == {"barrel", "bag"}
    barrel = _container(db_session, world, serial="B-260803-0042-004", sequence=4,
                        container_type=ContainerType.BARREL.value)
    bag = _container(db_session, world, serial="G-260803-0042-005", sequence=5,
                     container_type=ContainerType.BAG.value)
    db_session.commit()
    assert {barrel.container_type, bag.container_type} == {t.value for t in ContainerType}
    assert "case" not in barrel.container_type and "case" not in bag.container_type


# ── drift-query helpers ──────────────────────────────────────────────────────

def _drift_rows(db):
    return db.execute(CACHE_DRIFT_SQL).fetchall()


def _drift_ids(db):
    return {row.container_id for row in _drift_rows(db)}


# ── static-scan helpers ──────────────────────────────────────────────────────

def _python_sources():
    """Every module under app/, so a container query cannot hide by living in a
    file whose name does not say "container"."""
    return sorted(p for p in APP_DIR.rglob("*.py") if "__pycache__" not in p.parts)


def _parents(tree):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _enclosing_function(node, parents):
    current = parents.get(node)
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current
        current = parents.get(current)
    return None


def _is_serial_name(node):
    """True for a value that IS a serial — `serial`, `c.serial`, `prior_serial`.
    Plural names (`serials`) are collections and index/slice legitimately."""
    if isinstance(node, ast.Name):
        name = node.id
    elif isinstance(node, ast.Attribute):
        name = node.attr
    else:
        return False
    return name == "serial" or name.endswith("_serial")


def _scan_for_serial_parsing():
    scanned, violations = [], []
    for path in _python_sources():
        source = path.read_text()
        if "serial" not in source:
            continue
        scanned.append(path)
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            where = f"{path.relative_to(APP_DIR.parent)}:{getattr(node, 'lineno', '?')}"
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if "parse" in node.name and "serial" in node.name:
                    violations.append(f"{where} defines {node.name}()")
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if (node.func.attr in ("split", "rsplit", "partition", "rpartition")
                        and _is_serial_name(node.func.value)):
                    violations.append(f"{where} splits a serial")
                if node.func.attr in ("match", "search", "fullmatch", "findall"):
                    if any(_is_serial_name(arg) for arg in node.args):
                        violations.append(f"{where} regexes a serial")
            elif isinstance(node, ast.Subscript) and _is_serial_name(node.value):
                violations.append(f"{where} slices a serial")
    return scanned, violations


def _scan_for_unfiltered_reads(model_names):
    """Flag `db.query(Model)` whose enclosing function never mentions
    `is_deleted`. Function-level granularity keeps query-builder style
    (`q = db.query(X)` then conditional `.filter()`) from false-positiving,
    while still catching the case that actually leaks: no filter anywhere.
    """
    scanned, violations = [], []
    wanted = set(model_names)
    for path in _python_sources():
        source = path.read_text()
        if not any(f"query({name})" in source for name in wanted):
            continue
        scanned.append(path)
        tree = ast.parse(source, filename=str(path))
        parents = _parents(tree)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "query"):
                continue
            queried = [a.id for a in node.args if isinstance(a, ast.Name) and a.id in wanted]
            if not queried:
                continue
            scope = _enclosing_function(node, parents) or tree
            guarded = any(
                isinstance(inner, ast.Attribute) and inner.attr == "is_deleted"
                for inner in ast.walk(scope)
            )
            if not guarded:
                where = f"{path.relative_to(APP_DIR.parent)}:{node.lineno}"
                scope_name = getattr(scope, "name", "<module>")
                violations.append(
                    f"{where} {scope_name}() queries {'/'.join(queried)} unfiltered"
                )
    return scanned, violations
