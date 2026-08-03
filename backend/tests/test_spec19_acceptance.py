"""§19 acceptance criteria — the past bug classes this design must kill.

Each of these has already burned production at least once. The spec's rule is
that the implementation is not done until each is STRUCTURALLY impossible for
serialized ingredients, so these are not ordinary unit tests: each one asserts
that a whole class of mistake can no longer be made.

Criteria 4 and 5 live in sunberry-production and are explicitly skipped, not
silently omitted — a green suite must not imply coverage it does not have.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.enums import ContainerStatus, DEDUCTION_TYPES, AdjustmentType
from app.exceptions import ConflictError, ValidationError
from app.models import (
    Category,
    Container,
    ContainerEvent,
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
from app.services import ingredient_cutover_service as cut
from app.services import ingredient_intake_service as svc
from app.services.report_builders import build_lot_trace


@pytest.fixture
def env(db_session):
    db_session.add(Warehouse(id="wh19", name="Paw Paw", code="P19", type="plant",
                             timezone="America/New_York"))
    db_session.add(Location(id="loc19", name="Barn", warehouse_id="wh19"))
    db_session.add(SubLocation(id="sub19", name="Cooler", location_id="loc19"))
    # capacity 2 so the soft-gate test has something to exceed
    db_session.add(StorageRow(id="row19", name="A-1", sub_location_id="sub19",
                              pallet_capacity=2, occupied_cases=0))
    db_session.add(StorageRow(id="row19b", name="A-2", sub_location_id="sub19"))
    db_session.add(Category(id="cat19", name="Ingredients", type="ingredient"))
    db_session.add(Product(id="prod19", name="Guava Puree", sid="GUAP", category_id="cat19"))
    db_session.add(Vendor(id="ven19", name="SunOpta"))
    db_session.add_all([
        User(id="u19a", username="w19", name="Worker", email="w19@x.com",
             hashed_password="x", role="warehouse", warehouse_id="wh19"),
        User(id="u19b", username="s19", name="Super", email="s19@x.com",
             hashed_password="x", role="supervisor", warehouse_id="wh19"),
    ])
    db_session.commit()
    return (db_session.query(User).filter(User.id == "u19a").first(),
            db_session.query(User).filter(User.id == "u19b").first())


def _intake(db, user, count=4, ctype="barrel"):
    payload = IngredientIntakeCreate(
        vendor_id="ven19", warehouse_id="wh19",
        lots=[IntakeLotCreate(product_id="prod19", container_type=ctype,
                              vendor_lot="L19",
                              bbd=datetime.now(timezone.utc) + timedelta(days=200),
                              expected_count=count,
                              net_weight_per_container=500, weight_unit="lbs")],
    )
    intake = svc.create_intake(db, payload, user)
    db.commit()
    containers = svc.mint_serials(db, intake, intake.lots[0], count, user)
    db.commit()
    return intake, containers


# ── §19.1 "cases" for non-case units ─────────────────────────────────────────

def test_19_1_a_serialized_ingredient_never_reports_cases(db_session, env):
    worker, _ = env
    intake, containers = _intake(db_session, worker)

    assert svc.container_count_unit("barrel", 80) == "barrels"
    assert svc.container_count_unit("bag", 40) == "bags"
    assert svc._intake_count_unit(intake) == "barrels"

    result = svc.scan_container(db_session, intake, containers[0].serial, "row19", worker)
    db_session.commit()
    assert result["count_unit"] == "barrels"
    assert "case" not in result["count_unit"]


# ── §19.2 quantity deducted from rows the user never selected ────────────────

def test_19_2_a_scan_without_a_row_is_refused_not_guessed(db_session, env):
    worker, _ = env
    intake, containers = _intake(db_session, worker)

    with pytest.raises(ValidationError):
        svc.scan_container(db_session, intake, containers[0].serial, "", worker)


def test_19_2_b_a_move_without_a_destination_is_refused(db_session, env):
    worker, sup = env
    intake, containers = _intake(db_session, worker)
    svc.scan_container(db_session, intake, containers[0].serial, "row19", worker)
    db_session.commit()

    with pytest.raises(ValidationError):
        cs.move_container(db_session, containers[0].serial, "", worker)


def test_19_2_c_conversion_touches_only_the_scanned_row(db_session, env):
    """The cutover frees rack space with an EXPLICIT pallets_by_row for the row
    the sweeper scanned — never deduct_rm_total, which prorates across every
    allocation entry."""
    _, sup = env
    receipt = Receipt(
        id="r19", product_id="prod19", category_id="cat19", lot_number="L19",
        quantity=1000, unit="lbs", container_count=2,
        weight_per_container=500, weight_unit="lbs",
        warehouse_id="wh19", vendor_id="ven19", status="approved",
        storage_row_id="row19",
        # The STORED shape, verified against production data: entries are keyed
        # by "rowId" holding the real StorageRow.id, with the quantity in
        # "cases". (The `{id: "row-X", quantity}` form is the REQUEST breakdown,
        # a different shape that parse_breakdown converts.)
        raw_material_row_allocations=[
            {"rowId": "row19", "cases": 500, "pallets": 1},
            {"rowId": "row19b", "cases": 500, "pallets": 1},
        ],
    )
    db_session.add(receipt)
    db_session.commit()

    cut.convert_one(db_session, receipt, "row19", sup)
    db_session.commit()

    allocs = {a["rowId"]: a for a in (receipt.raw_material_row_allocations or [])}
    # row19 is emptied by the 500 lb drum and pruned entirely by deduct_rm_rows.
    assert "row19" not in allocs or allocs["row19"]["cases"] == 0
    assert allocs["row19b"]["cases"] == 500, "an unnamed row must NOT be touched"


# ── §19.3 denormalized location/count drift ──────────────────────────────────

def test_19_3_cache_and_ledger_agree_after_every_flow(db_session, env):
    worker, sup = env
    intake, containers = _intake(db_session, worker)

    for c in containers:
        svc.scan_container(db_session, intake, c.serial, "row19", worker)
    db_session.commit()
    svc.submit_intake(db_session, intake, worker)
    db_session.commit()
    svc.approve_intake(db_session, intake, sup)
    db_session.commit()

    cs.move_container(db_session, containers[0].serial, "row19b", worker)
    cs.set_hold(db_session, containers[1].serial, True, worker, reason="QA")
    cs.mark_damaged(db_session, containers[2].serial, worker, reason="leak",
                    quarantine_row_id="row19b")
    cs.consume_container(db_session, containers[3].serial, worker,
                         batch_uid="B19", bypass_reason="direct")
    db_session.commit()

    drift = svc.cache_drift(db_session)
    assert drift["drifted"] == 0, drift["rows"]
    assert drift["checked"] == 4


def test_19_3_b_every_mutation_writes_exactly_one_event(db_session, env):
    worker, _ = env
    intake, containers = _intake(db_session, worker)
    serial = containers[0].serial

    def events_for():
        return (db_session.query(ContainerEvent)
                .join(Container, ContainerEvent.container_id == Container.id)
                .filter(Container.serial == serial).count())

    assert events_for() == 1                      # printed
    svc.scan_container(db_session, intake, serial, "row19", worker)
    db_session.commit()
    assert events_for() == 2                      # + received
    cs.move_container(db_session, serial, "row19b", worker)
    db_session.commit()
    assert events_for() == 3                      # + moved


# ── §19.6 stuck flows from hard quantity gates ───────────────────────────────

def test_19_6_a_over_capacity_scan_succeeds_with_a_warning(db_session, env):
    """The finished-goods path RAISES here (scanner_service.py:532-533). An
    80-drum unload that 400s mid-truck is the failure this criterion exists for."""
    worker, _ = env
    intake, containers = _intake(db_session, worker)

    results = []
    for c in containers:                       # 4 drums into a capacity-2 row
        results.append(svc.scan_container(db_session, intake, c.serial, "row19", worker))
    db_session.commit()

    assert all(r["status"] == "ok" for r in results), "no scan may be rejected"
    assert results[-1]["warning"] == "row_full"
    assert results[-1]["container"] is not None, "a warning still returns the drum"


def test_19_6_b_over_pull_and_over_draw_are_recorded_not_blocked(db_session, env):
    worker, sup = env
    intake, containers = _intake(db_session, worker, count=1)
    svc.scan_container(db_session, intake, containers[0].serial, "row19", worker)
    db_session.commit()
    svc.submit_intake(db_session, intake, worker)
    db_session.commit()
    svc.approve_intake(db_session, intake, sup)
    db_session.commit()

    # Draw 600 from a 500 lb drum: allowed, clamped, compensated.
    result = cs.consume_container(db_session, containers[0].serial, worker,
                                  batch_uid="B19", qty_used=600,
                                  fully_consumed=False, bypass_reason="direct")
    db_session.commit()
    assert result["over_drawn"] == 100
    assert result["remaining_qty"] == 0
    compensating = (db_session.query(ContainerEvent)
                    .filter(ContainerEvent.reason_code == "over_draw").all())
    assert len(compensating) == 1, "the clamp must leave a compensating entry"
    assert compensating[0].qty_delta == -100


# ── §19.7 unit mixing in dual-mode arithmetic ────────────────────────────────

def test_19_7_conversion_moves_weight_not_one(db_session, env):
    """The spec said 'legacy qty -1'. For ingredients quantity is WEIGHT, so a
    40 x 500lb load would have kept 19,960 lbs of phantom stock."""
    _, sup = env
    receipt = Receipt(
        id="r19b", product_id="prod19", category_id="cat19", lot_number="L19",
        quantity=20000, unit="lbs", container_count=40,
        weight_per_container=500, weight_unit="lbs",
        warehouse_id="wh19", vendor_id="ven19", status="approved",
        storage_row_id="row19",
        raw_material_row_allocations=[{"id": "row19", "quantity": 20000, "pallets": 40}],
    )
    db_session.add(receipt)
    db_session.commit()

    cut.convert_one(db_session, receipt, "row19", sup)
    db_session.commit()

    assert receipt.quantity == 19500, "must move by net weight, not by 1"
    assert receipt.container_count == 39, "and the count must move too"


def test_19_7_b_reconciliation_preserves_the_total(db_session, env):
    _, sup = env
    receipt = Receipt(
        id="r19c", product_id="prod19", category_id="cat19", lot_number="L19C",
        quantity=1500, unit="lbs", container_count=3,
        weight_per_container=500, weight_unit="lbs",
        warehouse_id="wh19", vendor_id="ven19", status="approved",
        storage_row_id="row19",
        raw_material_row_allocations=[{"id": "row19", "quantity": 1500, "pallets": 3}],
    )
    db_session.add(receipt)
    db_session.commit()

    for _ in range(3):
        cut.convert_one(db_session, receipt, "row19", sup)
        db_session.commit()

    row = [r for r in cut.reconciliation(db_session)["rows"]
           if r["receipt_id"] == "r19c"][0]
    assert row["combined"] == 1500, "nothing is created or destroyed by a conversion"
    assert row["legacy_remaining"] == 0
    assert row["serialized_remaining"] == 1500


def test_19_7_c_conversion_type_cannot_double_deduct(db_session, env):
    """It is created already-APPROVED and is deliberately NOT a deduction type,
    so approve_adjustment can never apply it a second time."""
    assert AdjustmentType.SERIALIZATION_CONVERSION.value not in DEDUCTION_TYPES


# ── §19.8 double-decrement of serialized consumption ─────────────────────────

def test_19_8_serialized_staging_creates_no_staging_item_rows(db_session, env):
    """StagingItem feeds sync_production_usage, which writes its own adjustment
    and decrements receipt.quantity. A serialized container is already
    decremented by its consume event, so both would deduct the same material."""
    from app.models import StagingItem, StagingLineContainer, StagingRequest, StagingRequestItem
    from app.services import container_staging_service as css

    worker, sup = env
    intake, containers = _intake(db_session, worker, count=1)
    svc.scan_container(db_session, intake, containers[0].serial, "row19", worker)
    db_session.commit()
    svc.submit_intake(db_session, intake, worker)
    db_session.commit()
    svc.approve_intake(db_session, intake, sup)
    db_session.commit()

    db_session.add(StagingRequest(id="sr19", production_batch_uid="B19", status="pending"))
    db_session.add(StagingRequestItem(id="sri19", request_id="sr19", product_id="prod19",
                                      ingredient_name="Guava", quantity_needed=500,
                                      unit="lbs"))
    db_session.commit()

    before = db_session.query(StagingItem).count()
    css.stage_container(db_session, "sri19", containers[0].serial, worker,
                        staging_row_id="row19b")
    db_session.commit()

    assert db_session.query(StagingItem).count() == before, "no legacy StagingItem row"
    assert db_session.query(StagingLineContainer).count() == 1, "recorded in the child table"


# ── §19.9 recall trace that fails silently ───────────────────────────────────

def test_19_9_recall_over_serialized_lot_states_its_coverage(db_session, env):
    worker, sup = env
    intake, containers = _intake(db_session, worker, count=1)
    svc.scan_container(db_session, intake, containers[0].serial, "row19", worker)
    db_session.commit()
    svc.submit_intake(db_session, intake, worker)
    db_session.commit()
    svc.approve_intake(db_session, intake, sup)
    db_session.commit()

    trace = build_lot_trace(db_session, "L19")
    assert trace["containers"], "a serialized lot must not return blank"
    assert trace["coverage"]["sources_searched"] == [
        "legacy_receipts", "serialized_containers",
    ]


# ── §19.4 / §19.5 — sunberry-production, deferred ────────────────────────────

@pytest.mark.skip(reason=(
    "§19.4 (BatchScan.lot_barcode is free text with no FK) lives in "
    "sunberry-production, which the owner scoped out of this session. Cannot be "
    "asserted from this repo. The inventory half — GET /service/containers/{serial} "
    "returning usable/blocked_reasons — exists and is covered elsewhere."
))
def test_19_4_consumption_scan_cannot_reference_a_nonexistent_serial():
    pass


@pytest.mark.skip(reason=(
    "§19.5 (retire the ADMIN_SKIPPED magic string) is a one-line change in "
    "sunberry-production/backend/routers/batches.py:1042 with no readers "
    "anywhere. Deferred with the rest of Phase 4."
))
def test_19_5_admin_skipped_sentinel_is_gone():
    pass
