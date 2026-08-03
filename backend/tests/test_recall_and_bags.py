"""Recall trace over containers (§19.9) and bag deferred serialization (§10).

The recall tests matter more than they look. `build_lot_trace` used to match
Receipt.lot_number only and return `{"receipts": []}` on no match — so asking it
about a serialized lot produced a blank that reads as CLEAN. On a recall that is
the worst available failure mode: it is not a missing feature, it is a confident
wrong answer.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.enums import ContainerStatus
from app.models import (
    Category,
    Container,
    Location,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.schemas.ingredient import IngredientIntakeCreate, IntakeLotCreate
from app.services import container_service as cs
from app.services import ingredient_intake_service as svc
from app.services.report_builders import build_lot_trace

LOT = "389641"


@pytest.fixture
def env(db_session):
    db_session.add(Warehouse(id="wh-rb", name="Paw Paw", code="PRB", type="plant",
                             timezone="America/New_York"))
    db_session.add(Location(id="loc-rb", name="Barn", warehouse_id="wh-rb"))
    db_session.add(SubLocation(id="sub-rb", name="Cooler", location_id="loc-rb"))
    db_session.add(StorageRow(id="row-rb", name="A-1", sub_location_id="sub-rb"))
    db_session.add(StorageRow(id="row-stg", name="STAGING", sub_location_id="sub-rb"))
    db_session.add(Category(id="cat-rb", name="Ingredients", type="ingredient"))
    db_session.add(Product(id="prod-rb", name="Guava Puree", sid="GUAP", category_id="cat-rb"))
    db_session.add(Vendor(id="ven-rb", name="SunOpta"))
    db_session.add(User(id="user-rb", username="rb-sup", name="Sam",
                        email="rb@example.com", hashed_password="x",
                        role="supervisor", warehouse_id="wh-rb"))
    db_session.commit()
    return db_session.query(User).filter(User.id == "user-rb").first()


def _intake(db, user, *, container_type="barrel", count=2, lot=LOT):
    payload = IngredientIntakeCreate(
        vendor_id="ven-rb", warehouse_id="wh-rb",
        lots=[IntakeLotCreate(
            product_id="prod-rb", container_type=container_type, vendor_lot=lot,
            bbd=datetime.now(timezone.utc) + timedelta(days=200),
            expected_count=count, net_weight_per_container=500, weight_unit="lbs",
        )],
    )
    intake = svc.create_intake(db, payload, user)
    db.commit()
    containers = svc.mint_serials(db, intake, intake.lots[0], count, user)
    db.commit()
    return intake, containers


def _receive_and_approve(db, intake, containers, user):
    for c in containers:
        svc.scan_container(db, intake, c.serial, "row-rb", user)
    db.commit()
    svc.submit_intake(db, intake, user)
    db.commit()
    # A supervisor who did not submit it — self-approval is blocked.
    approver = User(id="user-rb2", username="rb-sup2", name="Ann",
                    email="rb2@example.com", hashed_password="x",
                    role="supervisor", warehouse_id="wh-rb")
    db.add(approver)
    db.commit()
    svc.approve_intake(db, intake, approver)
    db.commit()


# ─── recall trace (§19.9) ─────────────────────────────────────────────────────

class TestRecallTrace:
    def test_serialized_lot_is_found_and_reports_coverage(self, db_session, env):
        intake, containers = _intake(db_session, env)
        _receive_and_approve(db_session, intake, containers, env)

        trace = build_lot_trace(db_session, LOT)

        assert len(trace["containers"]) == 2, "serialized drums must appear in a recall"
        assert trace["coverage"]["serialized_containers_found"] == 2
        assert "serialized_containers" in trace["coverage"]["sources_searched"]

    def test_consumed_drum_names_its_batch(self, db_session, env):
        """The whole point of serializing: vendor lot -> batch."""
        intake, containers = _intake(db_session, env)
        _receive_and_approve(db_session, intake, containers, env)
        cs.consume_container(db_session, containers[0].serial, env,
                             batch_uid="BATCH-2026-08-03-A",
                             bypass_reason="direct pull for test")
        db_session.commit()

        trace = build_lot_trace(db_session, LOT)
        by_serial = {c["serial"]: c for c in trace["containers"]}
        assert by_serial[containers[0].serial]["consumed_by_batch_uid"] == "BATCH-2026-08-03-A"
        assert by_serial[containers[1].serial]["consumed_by_batch_uid"] is None

    def test_timeline_is_present_and_ordered(self, db_session, env):
        intake, containers = _intake(db_session, env)
        _receive_and_approve(db_session, intake, containers, env)

        trace = build_lot_trace(db_session, LOT)
        timeline = trace["containers"][0]["timeline"]
        assert [e["event"] for e in timeline][:2] == ["printed", "received"]
        assert timeline[-1]["to_status"] == ContainerStatus.IN_STOCK.value

    def test_empty_result_states_what_was_searched(self, db_session, env):
        """An empty trace must read as 'searched and found nothing', never as
        'unsupported' — the distinction is the whole finding."""
        trace = build_lot_trace(db_session, "NO-SUCH-LOT")

        assert trace["receipts"] == []
        assert trace["containers"] == []
        assert trace["coverage"]["sources_searched"] == [
            "legacy_receipts", "serialized_containers",
        ]

    def test_half_converted_lot_is_flagged_partial(self, db_session, env):
        """A lot mid-cutover has drums on BOTH sides. Returning only one half
        without saying so is how a recall misses material."""
        db_session.add(Receipt(
            id="rcpt-rb", product_id="prod-rb", category_id="cat-rb",
            lot_number=LOT, quantity=1000, unit="lbs", container_count=2,
            weight_per_container=500, weight_unit="lbs",
            warehouse_id="wh-rb", vendor_id="ven-rb", status="approved",
        ))
        db_session.commit()
        intake, containers = _intake(db_session, env)
        _receive_and_approve(db_session, intake, containers, env)

        trace = build_lot_trace(db_session, LOT)
        assert trace["coverage"]["legacy_receipts_found"] == 1
        assert trace["coverage"]["serialized_containers_found"] == 2
        assert trace["coverage"]["partial"] is True

    def test_lot_correction_cannot_hide_a_drum(self, db_session, env):
        """Matches the lot line as well as the container's denormalized copy, so
        a correction that has not fanned out yet still finds the drum."""
        intake, containers = _intake(db_session, env)
        _receive_and_approve(db_session, intake, containers, env)

        # Simulate a fan-out that only half-applied.
        intake.lots[0].vendor_lot = "CORRECTED-LOT"
        db_session.commit()

        assert len(build_lot_trace(db_session, LOT)["containers"]) == 2
        assert len(build_lot_trace(db_session, "CORRECTED-LOT")["containers"]) == 2


# ─── bags: deferred serialization (§10) ───────────────────────────────────────

class TestBagActivation:
    def test_place_lot_locates_stack_without_serializing(self, db_session, env):
        intake, bags = _intake(db_session, env, container_type="bag", count=5)

        result = cs.place_bag_lot(db_session, intake.lots[0].id, "row-rb", env)
        db_session.commit()

        assert result["placed"] == 5
        assert result["count_unit"] == "bags"
        for bag in bags:
            db_session.refresh(bag)
            # Located, but still not individually identifiable.
            assert bag.storage_row_id == "row-rb"
            assert bag.status == ContainerStatus.PRINTED_UNAPPLIED.value

    def test_activation_is_a_one_row_conversion(self, db_session, env):
        """`unapplied + activated = received` holds by construction, because a
        single row moves between two statuses."""
        intake, bags = _intake(db_session, env, container_type="bag", count=5)
        cs.place_bag_lot(db_session, intake.lots[0].id, "row-rb", env)
        db_session.commit()

        before = cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"][0]
        assert (before["unapplied"], before["activated"]) == (5, 0)

        cs.activate_bag(db_session, bags[0].serial, env, storage_row_id="row-stg")
        db_session.commit()

        after = cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"][0]
        assert (after["unapplied"], after["activated"]) == (4, 1)
        assert after["minted"] == before["minted"] == 5

    def test_activation_is_idempotent(self, db_session, env):
        intake, bags = _intake(db_session, env, container_type="bag", count=2)
        cs.activate_bag(db_session, bags[0].serial, env, idempotency_key="bag-k1")
        db_session.commit()
        again = cs.activate_bag(db_session, bags[0].serial, env, idempotency_key="bag-k1")
        db_session.commit()

        assert again["status"] == "already_activated"
        assert cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"][0]["activated"] == 1

    def test_activation_never_blocked_when_books_say_empty(self, db_session, env):
        """§18.4 S-9. More physical bags than the system believes is a real,
        recurring drift; a worker holding a real bag in front of a real batch
        must not be stopped by it."""
        intake, bags = _intake(db_session, env, container_type="bag", count=2)
        for bag in bags:
            cs.activate_bag(db_session, bag.serial, env)
        db_session.commit()

        row = cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"][0]
        assert row["unapplied"] == 0

        # A surprise bag turns up: mint one more and activate it. No exception.
        extra = svc.mint_serials(db_session, intake, intake.lots[0], 1, env)[0]
        db_session.commit()
        result = cs.activate_bag(db_session, extra.serial, env)
        db_session.commit()

        assert result["status"] == "ok"
        after = cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"][0]
        assert after["activated"] == 3
        # Surfaced rather than suppressed.
        assert after["variance_vs_expected"] == 1

    def test_bag_counts_never_say_cases(self, db_session, env):
        """§19.1 — the word must be impossible for a serialized ingredient."""
        intake, _ = _intake(db_session, env, container_type="bag", count=3)
        rows = cs.bag_reconciliation(db_session, intake_id=intake.id)["rows"]
        assert rows[0]["count_unit"] == "bags"
        assert "case" not in rows[0]["count_unit"]
