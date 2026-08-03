"""Container flow acceptance criteria — INGREDIENT-SERIALIZATION-SPEC.md §19,
exercised through `app.services.ingredient_intake_service`.

Companion file: `test_container_invariants.py` proves the criteria that hold at
the schema level with or without a service (unique constraints, the cache-vs-
ledger drift query, the "no module parses a serial" static scan). This file
proves the ones that only exist once something mints and scans:

  §4.2   serials are gapless, intake-global, and never re-issued
  §19.2  a scan with no row context is REJECTED — never placed by guess, and
         never quietly inherited from the drum scanned before it
  §18.2  R-1 an offline-queue replay returns the prior result and does not
         double-count; R-2 a move to a different row demands confirmation
  §19.6  row capacity is SOFT for ingredients — an over-capacity scan SUCCEEDS
         and returns a warning, where the finished-goods scanner hard-raises
         (`app/services/scanner_service.py:532-533`)
  §19.1  a container count is never reported in "cases"
  §19.3  one ledger event per mutation, and `container.status` /
         `storage_row_id` always equal the newest event's `to_*`
  §18.9  soft-deleted containers are invisible to every service read path

The service is called directly rather than over HTTP: the router and its mount
in `main.py` belong to another change in flight, and every rule above lives in
the service regardless of what is mounted in front of it.

Tests commit after each service call because the service deliberately does not
commit — the router owns the transaction boundary (see its module docstring), so
committing here is what the real caller does.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.constants import CATEGORY_INGREDIENT
from app.enums import ContainerEventType, ContainerStatus, ContainerType, IntakeStatus
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    CategoryGroup,
    Container,
    ContainerEvent,
    IntakeLot,
    Location,
    Product,
    StorageRow,
    SubLocation,
    User,
    Warehouse,
)
from app.schemas.ingredient import IngredientIntakeCreate, IntakeLotCreate
from app.services import ingredient_intake_service as svc
from app.utils.auth import get_password_hash

BBD = datetime(2027, 2, 15, tzinfo=timezone.utc)


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def plant(db_session):
    """One plant: two ingredient products (one barrel, one bag), three rows.

    `row-a12` and `row-b01` have pallet_capacity = 0, which is how ingredient
    rows are actually created — capacity is advisory (§8.1) and 0 means "no
    opinion", not "full". `row-a13` carries a real capacity of 2 so the soft-
    capacity path has something to be soft about.
    """
    db_session.add(Warehouse(id="wh-pp", name="Paw Paw", code="PP", type="plant",
                             timezone="America/New_York"))
    db_session.add(CategoryGroup(id="grp-sb", name="Sunberry"))
    db_session.add(Category(id="cat-ing", name="Purees", type=CATEGORY_INGREDIENT,
                            parent_id="grp-sb"))
    db_session.add(Product(id="prod-guava", name="Conventional Guava Puree",
                           category_id="cat-ing"))
    db_session.add(Product(id="prod-powder", name="Blueberry Powder",
                           category_id="cat-ing"))
    db_session.add(Location(id="loc-pp", name="Paw Paw", warehouse_id="wh-pp"))
    db_session.add(SubLocation(id="sub-barn", name="Blueberry Barn", location_id="loc-pp"))
    db_session.add(StorageRow(id="row-a12", name="A-12", sub_location_id="sub-barn",
                              barcode="PP-A-12", pallet_capacity=0))
    db_session.add(StorageRow(id="row-a13", name="A-13", sub_location_id="sub-barn",
                              barcode="PP-A-13", pallet_capacity=2))
    db_session.add(StorageRow(id="row-b01", name="B-01", sub_location_id="sub-barn",
                              barcode="PP-B-01", pallet_capacity=0))
    db_session.add(User(id="u-wh", username="whworker", name="WH Worker",
                        email="wh@sunberry.com",
                        hashed_password=get_password_hash("password123"),
                        role="warehouse", is_active=True, warehouse_id="wh-pp"))
    db_session.add(User(id="u-sup", username="supervisor1", name="Sue Supervisor",
                        email="sup@sunberry.com",
                        hashed_password=get_password_hash("password123"),
                        role="supervisor", is_active=True, warehouse_id="wh-pp"))
    db_session.commit()
    return {
        "worker": db_session.query(User).filter(User.id == "u-wh").first(),
        "supervisor": db_session.query(User).filter(User.id == "u-sup").first(),
    }


def _lot_line(**overrides):
    line = dict(
        product_id="prod-guava",
        container_type=ContainerType.BARREL.value,
        vendor_lot="389641",
        bbd=BBD,
        expected_count=3,
        net_weight_per_container=500.0,
        weight_unit="lbs",
    )
    line.update(overrides)
    return IntakeLotCreate(**line)


def _make_intake(db, plant, *, lots=None, expected_total=None):
    """One truck, created the way the router creates it."""
    intake = svc.create_intake(
        db,
        IngredientIntakeCreate(
            bol="BOL-77120",
            warehouse_id="wh-pp",
            lots=lots or [_lot_line(expected_count=expected_total or 3)],
        ),
        plant["worker"],
    )
    db.commit()
    return intake


@pytest.fixture
def intake(db_session, plant):
    """A three-barrel truck, recorded and open."""
    return _make_intake(db_session, plant, expected_total=3)


def _events(db, container):
    return (
        db.query(ContainerEvent)
        .filter(ContainerEvent.container_id == container.id)
        .order_by(ContainerEvent.seq)
        .all()
    )


def _event_types(db, container):
    return [e.event_type for e in _events(db, container)]


def _reload(db, container_id):
    return db.query(Container).filter(Container.id == container_id).first()


# ── §4.2 — serial minting ────────────────────────────────────────────────────

@pytest.mark.integration
def test_minting_numbers_containers_intake_globally_with_no_gaps(db_session, plant):
    """The sequence belongs to the INTAKE, not the lot line.

    Two materials on one truck share one contiguous 1..N range. Per-lot stacks
    come from `ORDER BY intake_lot_id, sequence` at print time, so a late top-up
    on the barrel lot cannot renumber stickers already applied to the bags.
    """
    intake = _make_intake(db_session, plant, lots=[
        _lot_line(expected_count=3),
        _lot_line(product_id="prod-powder", container_type=ContainerType.BAG.value,
                  vendor_lot="BP-2211", expected_count=2,
                  net_weight_per_container=25.0, weight_unit="kg"),
    ])
    barrels_lot, bags_lot = intake.lots[0], intake.lots[1]

    barrels = svc.mint_serials(db_session, intake, barrels_lot, 3, plant["worker"])
    db_session.commit()
    bags = svc.mint_serials(db_session, intake, bags_lot, 2, plant["worker"])
    db_session.commit()

    assert [c.sequence for c in barrels] == [1, 2, 3]
    assert [c.sequence for c in bags] == [4, 5], "the second lot must continue the range"
    assert intake.last_serial_seq == 5

    everything = barrels + bags
    assert len({c.serial for c in everything}) == 5, "serials must be unique"
    # B-YYMMDD-<intake ordinal>-NNN. The prefix is per container type, the
    # ordinal is the intake's, and the last segment is the sequence COLUMN
    # zero-padded — the label prints "17 of 80" off `sequence`, never off a
    # substring of the serial.
    ordinal = intake.intake_number.split("-")[-1]
    for container in everything:
        prefix, day, intake_ordinal, tail = container.serial.split("-")
        assert prefix == ("B" if container.container_type == ContainerType.BARREL.value else "G")
        assert len(day) == 6 and day.isdigit()
        assert intake_ordinal == ordinal
        assert tail == f"{container.sequence:03d}"

    # Denormalized lot data lands on the drum so the scan hot path needs no join.
    assert {c.vendor_lot for c in barrels} == {"389641"}
    assert {c.vendor_lot for c in bags} == {"BP-2211"}
    assert {c.qty_unit for c in bags} == {"kg"}


@pytest.mark.integration
def test_the_serial_counter_is_never_rewound_by_a_deleted_container(db_session, plant, intake):
    """MAX(sequence)+1 is the tempting implementation and it is wrong twice: it
    races two concurrent mints, and it silently RE-ISSUES a number as soon as the
    highest row stops being visible. A serial is never reused, so the counter has
    to be the locked `last_serial_seq` column.
    """
    first = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    burned_serial = first[2].serial

    first[2].is_deleted = True
    first[2].deleted_at = datetime.now(timezone.utc)
    db_session.commit()

    topped_up = svc.mint_serials(db_session, intake, intake.lots[0], 2, plant["worker"])
    db_session.commit()

    assert [c.sequence for c in topped_up] == [4, 5], (
        "sequence 3 was re-issued — the counter was derived from live rows"
    )
    assert burned_serial not in {c.serial for c in topped_up}
    assert intake.last_serial_seq == 5


@pytest.mark.integration
def test_a_second_writer_cannot_duplicate_a_minted_sequence(db_session, plant, intake):
    """UNIQUE(intake_id, sequence) is the backstop under the locked counter: if
    the lock is ever dropped, the loser gets an IntegrityError instead of a
    second drum labelled "3 of 80"."""
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    clash = minted[2]

    db_session.add(Container(
        id=f"cnt-{uuid.uuid4().hex[:12]}",
        serial=clash.serial + "-RACE",       # different serial, same slot
        sequence=clash.sequence,
        intake_id=clash.intake_id,
        intake_lot_id=clash.intake_lot_id,
        product_id=clash.product_id,
        container_type=clash.container_type,
    ))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


@pytest.mark.integration
def test_serials_can_only_be_minted_while_the_intake_is_open(db_session, plant, intake):
    """Submitted is still open — an over-receipt top-up happens while the
    approval is pending and must not be blocked. Approved is closed."""
    svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    svc.submit_intake(db_session, intake, plant["worker"])
    db_session.commit()

    late = svc.mint_serials(db_session, intake, intake.lots[0], 1, plant["worker"])
    db_session.commit()
    assert late[0].sequence == 4

    svc.approve_intake(db_session, intake, plant["supervisor"])
    db_session.commit()

    with pytest.raises(ValidationError):
        svc.mint_serials(db_session, intake, intake.lots[0], 1, plant["worker"])
    db_session.rollback()

    with pytest.raises(ValidationError):
        svc.mint_serials(db_session, intake, intake.lots[0], 0, plant["worker"])
    db_session.rollback()


@pytest.mark.integration
def test_a_reprint_reproduces_the_same_serials_and_the_corrected_lot_data(
    db_session, plant, intake
):
    """§4.2/§5: a label is a pointer to a row, not an identity of its own.

    I-8 — the BBD was keyed wrong and found after 80 stickers were applied. The
    correction fans out onto the containers; the reprint shows the corrected
    values under the SAME serials. Anything that derived meaning from the serial
    string would still be printing February.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    serials_before = [c.serial for c in minted]

    lot = db_session.query(IntakeLot).filter(IntakeLot.id == intake.lots[0].id).first()
    lot.vendor_lot = "389641-B"
    lot.bbd = BBD + timedelta(days=400)
    db_session.query(Container).filter(
        Container.intake_lot_id == lot.id,
        Container.is_deleted == False,  # noqa: E712 — SQL predicate, not a bool test
    ).update({"vendor_lot": lot.vendor_lot, "bbd": lot.bbd}, synchronize_session=False)
    db_session.commit()

    reprinted, boundaries = svc.label_sheet(db_session, intake, current_user=plant["worker"])
    db_session.commit()

    assert [c.serial for c in reprinted] == serials_before, "a reprint must not re-mint"
    assert {c.vendor_lot for c in reprinted} == {"389641-B"}
    assert {c.bbd for c in reprinted} == {lot.bbd}
    assert boundaries == [], "a single-lot intake has no stack divider"
    # Reprint is ungated but never silent: one `relabeled` event each.
    for container in reprinted:
        assert _event_types(db_session, container) == [
            ContainerEventType.PRINTED.value,
            ContainerEventType.RELABELED.value,
        ]
    assert svc.cache_drift(db_session)["drifted"] == 0


# ── §19.2 / §6.4 — a location is never guessed ───────────────────────────────

@pytest.mark.integration
def test_scanning_without_a_row_is_rejected_and_never_falls_back_to_the_last_row(
    db_session, plant, intake
):
    """The single most-repeated bug in this codebase: quantity spread across
    rows nobody selected.

    The finished-goods scanner deliberately DOES carry a last-known row forward
    (`scanner_service.py:433-443` returns `last_row_id` on session resume). This
    path must not. The second half of the test is the part that matters: after a
    successful scan into A-12 there is now an obvious row to guess, and a
    row-less scan must still be refused.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()

    with pytest.raises(ValidationError):
        svc.scan_container(db_session, intake, minted[0].serial, None, plant["worker"])
    db_session.rollback()

    result = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                                plant["worker"])
    db_session.commit()
    assert result["status"] == "ok"

    for missing_row in (None, ""):
        with pytest.raises(ValidationError):
            svc.scan_container(db_session, intake, minted[1].serial, missing_row,
                               plant["worker"])
        db_session.rollback()

    stranded = _reload(db_session, minted[1].id)
    assert stranded.storage_row_id is None, "a rejected scan must not place the drum"
    assert stranded.status == ContainerStatus.PRINTED_UNAPPLIED.value
    assert _event_types(db_session, stranded) == [ContainerEventType.PRINTED.value]

    # An unknown row is a 404, not a silent placement into some default.
    with pytest.raises(NotFoundError):
        svc.scan_container(db_session, intake, minted[1].serial, "row-does-not-exist",
                           plant["worker"])
    db_session.rollback()


# ── §18.2 R-1 / R-2 — replay and re-scan ─────────────────────────────────────

@pytest.mark.integration
def test_replaying_a_queued_scan_returns_the_prior_result_without_double_counting(
    db_session, plant, intake
):
    """R-1. The offline queue replays whatever it still holds when the radio
    comes back, including scans that already landed. The replay must return the
    original outcome — not a second receive, and not an error that makes the
    queue retry forever.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    key = "offline-queue-8f21"

    first = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                               plant["worker"], idempotency_key=key)
    db_session.commit()
    assert first["status"] == "ok"
    assert first["intake_scanned_count"] == 1
    assert first["row_scanned_count"] == 1

    replay = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                                plant["worker"], idempotency_key=key)
    db_session.commit()

    assert replay["status"] == "already_received"
    assert replay["intake_scanned_count"] == 1, "the replay double-counted the drum"
    assert replay["row_scanned_count"] == 1
    assert replay["container"].id == minted[0].id
    assert _event_types(db_session, minted[0]) == [
        ContainerEventType.PRINTED.value,
        ContainerEventType.RECEIVED.value,
    ], "a replay must not append a second receive to the ledger"
    assert db_session.query(ContainerEvent).filter(
        ContainerEvent.idempotency_key == key
    ).count() == 1

    # The replay is answered BEFORE any state validation. This is the half that
    # the "same drum, same row" no-op cannot cover for us: once the intake is
    # approved the drum is `in_stock`, which is NOT a receivable status, so a
    # service that recognised the replay only by (serial, row) would raise
    # ConflictError here. A radio that reconnects after the supervisor approved
    # would then retry that scan forever.
    svc.submit_intake(db_session, intake, plant["worker"])
    db_session.commit()
    svc.approve_intake(db_session, intake, plant["supervisor"])
    db_session.commit()
    assert _reload(db_session, minted[0].id).status == ContainerStatus.IN_STOCK.value

    late = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                              plant["worker"], idempotency_key=key)
    db_session.commit()
    assert late["status"] == "already_received", (
        "a queued scan replayed after approval must get its original answer"
    )
    assert late["intake_scanned_count"] == 1
    assert late["container"].id == minted[0].id
    # Still no extra ledger row, and the drum was not dragged back to `received`.
    assert _event_types(db_session, minted[0]) == [
        ContainerEventType.PRINTED.value,
        ContainerEventType.RECEIVED.value,
        ContainerEventType.APPROVED.value,
    ]
    assert _reload(db_session, minted[0].id).status == ContainerStatus.IN_STOCK.value
    assert db_session.query(ContainerEvent).filter(
        ContainerEvent.idempotency_key == key
    ).count() == 1
    assert svc.cache_drift(db_session)["drifted"] == 0


@pytest.mark.integration
def test_rescanning_the_same_drum_into_the_same_row_is_an_idempotent_no_op(
    db_session, plant, intake
):
    """R-1 without an idempotency key — the worker simply scanned twice. Same
    guarantee: no second event, no second count."""
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()

    svc.scan_container(db_session, intake, minted[0].serial, "row-a12", plant["worker"])
    db_session.commit()
    again = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                               plant["worker"])
    db_session.commit()

    assert again["status"] == "already_received"
    assert again["intake_scanned_count"] == 1
    assert _event_types(db_session, minted[0]) == [
        ContainerEventType.PRINTED.value,
        ContainerEventType.RECEIVED.value,
    ]


@pytest.mark.integration
def test_moving_a_drum_to_another_row_needs_confirmation_and_writes_one_moved_event(
    db_session, plant, intake
):
    """R-2. The finished-goods scanner re-homes a pallet silently
    (`scanner_service.py:537-546`); that is the behaviour this path deliberately
    does not copy. `needs_confirm` is a QUESTION — it must leave the database
    exactly as it found it.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    drum = minted[0]

    svc.scan_container(db_session, intake, drum.serial, "row-a12", plant["worker"])
    db_session.commit()

    asked = svc.scan_container(db_session, intake, drum.serial, "row-b01", plant["worker"])
    db_session.commit()
    assert asked["status"] == "needs_confirm"
    assert asked["warning"] == "already_in_other_row"
    assert _reload(db_session, drum.id).storage_row_id == "row-a12", (
        "an unconfirmed move must not move the drum"
    )
    assert len(_events(db_session, drum)) == 2, "a question is not a mutation"

    moved = svc.scan_container(db_session, intake, drum.serial, "row-b01",
                               plant["worker"], confirm_move=True)
    db_session.commit()

    assert moved["status"] == "moved"
    assert _reload(db_session, drum.id).storage_row_id == "row-b01"
    ledger = _events(db_session, drum)
    assert [e.event_type for e in ledger] == [
        ContainerEventType.PRINTED.value,
        ContainerEventType.RECEIVED.value,
        ContainerEventType.MOVED.value,
    ]
    move_event = ledger[-1]
    assert move_event.from_row_id == "row-a12"
    assert move_event.to_row_id == "row-b01"
    # A move is received -> received: the status check-and-set that would be
    # enough for other flows gives no mutual exclusion here, which is why the
    # container row is locked instead.
    assert move_event.from_status == move_event.to_status == ContainerStatus.RECEIVED.value
    assert svc.cache_drift(db_session)["drifted"] == 0


# ── §19.6 — row capacity is SOFT for ingredients ─────────────────────────────

@pytest.mark.integration
def test_an_over_capacity_ingredient_scan_succeeds_with_a_warning(db_session, plant):
    """The whole point of the ingredient path.

    `scanner_service.py:532-533` hard-raises when a finished-goods row is full,
    and `receipts.py` returns HTTP 400 in four more places. An 80-drum unload
    that 400s at drum 41 leaves a worker with a half-emptied trailer and no way
    to record the rest. Here the drum lands and the screen says so.
    """
    intake = _make_intake(db_session, plant, expected_total=4)
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 4, plant["worker"])
    db_session.commit()

    outcomes = []
    for drum in minted:                       # row-a13 has pallet_capacity = 2
        outcomes.append(svc.scan_container(db_session, intake, drum.serial, "row-a13",
                                           plant["worker"]))
        db_session.commit()

    assert [o["status"] for o in outcomes] == ["ok", "ok", "ok", "ok"], (
        "an over-capacity ingredient scan must never fail"
    )
    assert outcomes[0]["warning"] is None, "under capacity there is nothing to say"
    for over in outcomes[1:]:
        assert over["warning"] == "row_full"
        assert "capacity of 2" in over["warning_detail"]
    assert outcomes[-1]["row_scanned_count"] == 4

    # Every drum is genuinely on the rack, not merely acknowledged.
    placed = db_session.query(Container).filter(
        Container.storage_row_id == "row-a13",
        Container.status == ContainerStatus.RECEIVED.value,
        Container.is_deleted == False,  # noqa: E712 — SQL predicate, not a bool test
    ).count()
    assert placed == 4
    for drum in minted:
        assert _event_types(db_session, drum) == [
            ContainerEventType.PRINTED.value,
            ContainerEventType.RECEIVED.value,
        ]


@pytest.mark.integration
def test_a_zero_capacity_row_never_warns(db_session, plant, intake):
    """Ingredient rows are created with pallet_capacity = 0. That means "nobody
    has counted this barn", not "this barn is full" — warning on every single
    scan would train workers to ignore the warning that matters."""
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()

    for drum in minted:                       # row-a12 has pallet_capacity = 0
        result = svc.scan_container(db_session, intake, drum.serial, "row-a12",
                                    plant["worker"])
        db_session.commit()
        assert result["status"] == "ok"
        assert result["warning"] is None
        assert result["warning_detail"] is None


# ── §19.1 — "cases" is impossible for a container ────────────────────────────

@pytest.mark.integration
def test_a_container_count_is_never_reported_in_cases(db_session, plant):
    """The bug: an 80-barrel ingredient receipt rendered "80 cases", because
    `Receipt.unit` defaults to "cases" and nothing overrode it. Counts here are
    derived from `container_type`, so there is no default to leak.
    """
    assert svc.container_count_unit(ContainerType.BARREL.value, 1) == "barrel"
    assert svc.container_count_unit(ContainerType.BARREL.value, 80) == "barrels"
    assert svc.container_count_unit(ContainerType.BAG.value, 12) == "bags"
    # Unknown type degrades to "containers" — vague, but never wrong.
    assert svc.container_count_unit(None) == "containers"

    intake = _make_intake(db_session, plant, expected_total=3)
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    result = svc.scan_container(db_session, intake, minted[0].serial, "row-a12",
                                plant["worker"])
    db_session.commit()

    assert result["count_unit"] == "barrels"
    for field, value in result.items():
        if isinstance(value, str):
            assert "case" not in value.lower(), f"scan response field {field!r} says cases"

    # A truck carrying two materials cannot claim one unit, so it says the
    # honest generic — still not "cases".
    mixed = _make_intake(db_session, plant, lots=[
        _lot_line(expected_count=1),
        _lot_line(product_id="prod-powder", container_type=ContainerType.BAG.value,
                  vendor_lot="BP-2211", expected_count=1,
                  net_weight_per_container=25.0, weight_unit="kg"),
    ])
    bag = svc.mint_serials(db_session, mixed, mixed.lots[1], 1, plant["worker"])[0]
    db_session.commit()
    mixed_result = svc.scan_container(db_session, mixed, bag.serial, "row-a12",
                                      plant["worker"])
    db_session.commit()
    assert mixed_result["count_unit"] == "containers"


# ── §19.3 — one event per mutation, ledger agrees with the row ───────────────

@pytest.mark.integration
def test_receive_and_approve_write_one_event_each_and_leave_no_drift(db_session, plant, intake):
    """The reconciliation invariant end to end.

    `container.status` is authoritative state, not a projection of the ledger —
    which means the two are written independently and can disagree. They may not.
    Each event's `from_status` must be the previous event's `to_status`, and the
    container must equal the newest event's `to_*`.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    for drum in minted:
        svc.scan_container(db_session, intake, drum.serial, "row-a12", plant["worker"])
        db_session.commit()

    svc.submit_intake(db_session, intake, plant["worker"])
    db_session.commit()
    assert intake.received_count == 3

    svc.approve_intake(db_session, intake, plant["supervisor"])
    db_session.commit()
    assert intake.status == IntakeStatus.APPROVED.value

    for drum in minted:
        container = _reload(db_session, drum.id)
        ledger = _events(db_session, container)
        assert [e.event_type for e in ledger] == [
            ContainerEventType.PRINTED.value,
            ContainerEventType.RECEIVED.value,
            ContainerEventType.APPROVED.value,
        ], "each mutation writes exactly one event — no more, no fewer"

        assert ledger[0].from_status is None
        for previous, current in zip(ledger, ledger[1:]):
            assert current.from_status == previous.to_status, (
                "the ledger must be a continuous chain, not independent snapshots"
            )
        assert all(e.to_status for e in ledger), "to_status is never null"

        assert container.status == ContainerStatus.IN_STOCK.value
        assert container.status == ledger[-1].to_status
        assert container.storage_row_id == ledger[-1].to_row_id

    drift = svc.cache_drift(db_session)
    assert drift["checked"] == 3
    assert drift["drifted"] == 0, drift["rows"]


@pytest.mark.integration
def test_voiding_an_intake_writes_one_event_per_container_and_burns_the_serial(
    db_session, plant, intake
):
    """I-5/I-6: a duplicate or wrong-product intake. Serials are burned, never
    recycled — a later scan of that sticker is refused rather than quietly
    succeeding onto the wrong material."""
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    svc.scan_container(db_session, intake, minted[0].serial, "row-a12", plant["worker"])
    db_session.commit()

    svc.void_intake(db_session, intake, "duplicate of the 06:10 truck", plant["supervisor"])
    db_session.commit()

    scanned = _reload(db_session, minted[0].id)
    assert scanned.status == ContainerStatus.VOIDED.value
    ledger = _events(db_session, scanned)
    assert [e.event_type for e in ledger] == [
        ContainerEventType.PRINTED.value,
        ContainerEventType.RECEIVED.value,
        ContainerEventType.VOIDED.value,
    ]
    assert ledger[-1].from_status == ContainerStatus.RECEIVED.value
    assert ledger[-1].reason == "duplicate of the 06:10 truck"
    # The drum is voided, not teleported: the ledger still records where it is.
    assert ledger[-1].to_row_id == scanned.storage_row_id == "row-a12"
    assert svc.cache_drift(db_session)["drifted"] == 0

    with pytest.raises(ConflictError):
        svc.scan_container(db_session, intake, minted[0].serial, "row-a12", plant["worker"])
    db_session.rollback()


@pytest.mark.integration
@pytest.mark.xfail(
    strict=True,
    reason="cache_drift() does `if not entry: continue`, so a container with NO "
           "ledger row is counted in `checked` and then silently exempted. The "
           "reconciliation query in app/models/ingredient.py's ContainerEvent "
           "docstring LEFT JOINs and treats a missing join partner as drift "
           "(test_container_invariants.py proves that SQL catches it). Remove "
           "this marker when the service adopts the documented query.",
)
def test_a_container_with_no_ledger_history_is_reported_as_drift(db_session, plant, intake):
    """§19.3's unreconcilable case: a write path that created a drum and never
    wrote its `printed` event.

    Every container minted through `mint_serials` has at least one event, so an
    empty ledger can only mean a bug in a write path — precisely what the audit
    exists to surface. Reporting it as clean is the one answer that guarantees
    nobody ever looks.
    """
    svc.mint_serials(db_session, intake, intake.lots[0], 1, plant["worker"])
    db_session.commit()

    # A drum inserted without a ledger append, the way a buggy write path would.
    orphan = Container(
        id=f"cnt-{uuid.uuid4().hex[:12]}",
        serial="B-260803-9999-042",
        sequence=42,
        intake_id=intake.id,
        intake_lot_id=intake.lots[0].id,
        product_id="prod-guava",
        container_type=ContainerType.BARREL.value,
        status=ContainerStatus.IN_STOCK.value,
        storage_row_id="row-a12",
    )
    db_session.add(orphan)
    db_session.commit()

    drift = svc.cache_drift(db_session)
    assert drift["checked"] == 2
    assert orphan.id in {r["container_id"] for r in drift["rows"]}, (
        "a container whose status can never be reconciled was reported as clean"
    )


# ── §18.9 — soft-deleted containers are invisible ────────────────────────────

@pytest.mark.integration
def test_soft_deleted_containers_are_invisible_to_every_service_read_path(
    db_session, plant, intake
):
    """Nothing inherits a default-scoped query on these tables, so each read path
    carries its own `is_deleted == False` and each one can forget. Every reachable
    reader is checked here rather than trusting the one that happens to be
    convenient.
    """
    minted = svc.mint_serials(db_session, intake, intake.lots[0], 3, plant["worker"])
    db_session.commit()
    for drum in minted[:2]:
        svc.scan_container(db_session, intake, drum.serial, "row-a12", plant["worker"])
        db_session.commit()

    doomed = minted[1]
    doomed_serial = doomed.serial
    doomed.is_deleted = True
    doomed.deleted_at = datetime.now(timezone.utc)
    db_session.commit()

    # 1. the label sheet
    labels, _ = svc.label_sheet(db_session, intake)
    assert doomed_serial not in {c.serial for c in labels}
    assert len(labels) == 2

    # 2. the scan lookup — a deleted serial is unknown, not "already received"
    with pytest.raises(NotFoundError):
        svc.scan_container(db_session, intake, doomed_serial, "row-a12", plant["worker"])
    db_session.rollback()

    # 3. the drift audit
    assert svc.cache_drift(db_session)["checked"] == 2

    # 4. the received counter, and therefore the whole approval card
    svc.submit_intake(db_session, intake, plant["worker"])
    db_session.commit()
    assert intake.received_count == 1, "a deleted drum was still counted as received"

    # 5. the row occupancy behind the capacity warning
    still_there = svc.scan_container(db_session, intake, minted[2].serial, "row-a12",
                                     plant["worker"])
    db_session.commit()
    assert still_there["row_scanned_count"] == 2
