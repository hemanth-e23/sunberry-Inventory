"""Dual-mode availability helper — app/services/availability.py (audit B4/B3).

The gate these tests guard: ``POST /service/check-availability`` is the only
availability check the Production app makes before letting QA schedule a batch.
If it stops seeing converted drums, nobody can schedule anything. So the two
properties that matter are (a) a container-free database gets byte-identical
numbers to the query that was there before, and (b) once containers exist their
quantity is added rather than a weight being added to a barrel count.
"""
import itertools
import uuid

import pytest

from app.enums import ContainerStatus, ReceiptStatus
from app.exceptions import ValidationError
from app.models import (
    Category,
    CategoryGroup,
    Container,
    IngredientIntake,
    IntakeLot,
    Product,
    Receipt,
    Warehouse,
)
from app.services.availability import (
    container_qty_for_product,
    on_hand_for_product,
)

PRODUCT_ID = "prod-ingredient-1"
OTHER_PRODUCT_ID = "prod-ingredient-2"
WH_A = "wh-avail-a"
WH_B = "wh-avail-b"
INTAKE_ID = "intake-avail-1"
LOT_ID = "intake-lot-avail-1"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def avail_seed(db_session):
    """Two warehouses, an ingredient category, two products, and one intake +
    lot line for containers to hang off (both FKs are NOT NULL)."""
    db_session.add_all([
        Warehouse(id=WH_A, name="Plant A", code="PA", type="owned", is_active=True),
        Warehouse(id=WH_B, name="Plant B", code="PB", type="owned", is_active=True),
    ])
    db_session.add(CategoryGroup(id="grp-avail", name="Sunberry"))
    db_session.add(Category(id="cat-ingredient", name="Ingredients", type="ingredient"))
    db_session.add_all([
        Product(id=PRODUCT_ID, name="Guava Puree", category_id="cat-ingredient"),
        Product(id=OTHER_PRODUCT_ID, name="Mango Puree", category_id="cat-ingredient"),
    ])
    db_session.commit()

    db_session.add(IngredientIntake(id=INTAKE_ID, intake_number="ING-260803-0001", warehouse_id=WH_A))
    db_session.commit()
    db_session.add(IntakeLot(
        id=LOT_ID,
        intake_id=INTAKE_ID,
        product_id=PRODUCT_ID,
        category_id="cat-ingredient",
        container_type="barrel",
        vendor_lot="VL-1",
    ))
    db_session.commit()
    return {"warehouse_id": WH_A, "product_id": PRODUCT_ID}


def make_receipt(db, **kwargs):
    """An approved ingredient receipt. Mirrors app/routers/receipts.py:110-113:
    quantity is total WEIGHT and unit is the weight unit."""
    defaults = dict(
        id=f"rcpt-{uuid.uuid4().hex[:8]}",
        product_id=PRODUCT_ID,
        category_id="cat-ingredient",
        warehouse_id=WH_A,
        quantity=20000.0,
        unit="lbs",
        container_count=40,
        container_unit="barrel",
        weight_per_container=500.0,
        weight_unit="lbs",
        status=ReceiptStatus.APPROVED,
        hold=False,
        held_quantity=0,
    )
    defaults.update(kwargs)
    receipt = Receipt(**defaults)
    db.add(receipt)
    db.commit()
    return receipt


_seq_counter = itertools.count(1)


def make_container(db, **kwargs):
    """One serialized drum. remaining_qty is in the container's own qty_unit.

    `sequence` auto-increments: containers carry UNIQUE(intake_id, sequence),
    so a fixed sequence made every second drum on the same intake a duplicate
    key. Callers that care about ordering still pass an explicit sequence.
    """
    suffix = uuid.uuid4().hex[:8]
    defaults = dict(
        id=f"cont-{suffix}",
        serial=f"SN-{suffix}",
        sequence=next(_seq_counter),
        intake_id=INTAKE_ID,
        intake_lot_id=LOT_ID,
        product_id=PRODUCT_ID,
        warehouse_id=WH_A,
        container_type="barrel",
        status=ContainerStatus.IN_STOCK.value,
        remaining_qty=500.0,
        net_weight=500.0,
        qty_unit="lbs",
        is_held=False,
        is_deleted=False,
    )
    defaults.update(kwargs)
    container = Container(**defaults)
    db.add(container)
    db.commit()
    return container


# ---------------------------------------------------------------------------
# Legacy-only — must be bit-for-bit the pre-existing service.py:232-255 result
# ---------------------------------------------------------------------------

class TestLegacyOnly:
    def test_empty_product_is_zero_not_none(self, db_session, avail_seed):
        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["total"] == 0
        assert result["legacy_qty"] == 0
        assert result["container_qty"] == 0
        assert result["has_containers"] is False
        assert result["unit"] is None

    def test_sums_approved_receipts_only(self, db_session, avail_seed):
        make_receipt(db_session, quantity=20000.0)
        make_receipt(db_session, quantity=5000.0, status=ReceiptStatus.RECORDED)
        make_receipt(db_session, quantity=5000.0, status=ReceiptStatus.DEPLETED)

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["legacy_qty"] == 20000.0
        assert result["total"] == 20000.0
        assert result["unit"] == "lbs"

    def test_zero_and_negative_quantity_receipts_excluded(self, db_session, avail_seed):
        make_receipt(db_session, quantity=20000.0)
        make_receipt(db_session, quantity=0.0)
        make_receipt(db_session, quantity=-100.0)

        assert on_hand_for_product(db_session, PRODUCT_ID)["legacy_qty"] == 20000.0

    def test_partial_hold_subtracts_held_quantity(self, db_session, avail_seed):
        make_receipt(db_session, quantity=20000.0, hold=True, held_quantity=5000.0)

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["legacy_qty"] == 15000.0
        # Held material is still in the barn and still owned.
        assert result["physically_present"] == 20000.0
        assert result["financial_on_hand"] == 20000.0

    def test_full_lot_hold_counts_zero(self, db_session, avail_seed):
        """hold=True with no held_quantity recorded is a whole-lot hold."""
        make_receipt(db_session, quantity=20000.0, hold=True, held_quantity=0)
        make_receipt(db_session, quantity=20000.0, hold=True, held_quantity=None)

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["legacy_qty"] == 0.0
        assert result["physically_present"] == 40000.0

    def test_warehouse_scope(self, db_session, avail_seed):
        make_receipt(db_session, quantity=20000.0, warehouse_id=WH_A)
        make_receipt(db_session, quantity=7000.0, warehouse_id=WH_B)

        assert on_hand_for_product(db_session, PRODUCT_ID)["legacy_qty"] == 27000.0
        assert on_hand_for_product(db_session, PRODUCT_ID, WH_A)["legacy_qty"] == 20000.0
        assert on_hand_for_product(db_session, PRODUCT_ID, WH_B)["legacy_qty"] == 7000.0

    def test_other_products_not_counted(self, db_session, avail_seed):
        make_receipt(db_session, quantity=20000.0)
        make_receipt(db_session, quantity=999.0, product_id=OTHER_PRODUCT_ID)

        assert on_hand_for_product(db_session, PRODUCT_ID)["legacy_qty"] == 20000.0

    def test_mixed_legacy_units_do_not_raise(self, db_session, avail_seed):
        """Pre-existing data really does mix units; the query being replaced
        summed it regardless. Report it, do not turn it into a 400."""
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_receipt(db_session, quantity=50.0, unit="kg")

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["total"] == 20050.0
        assert result["sources"]["unit_conflict"] == ["kg", "lbs"]


# ---------------------------------------------------------------------------
# Container-only — the post-cutover steady state
# ---------------------------------------------------------------------------

class TestContainerOnly:
    def test_active_statuses_counted(self, db_session, avail_seed):
        for status in (
            ContainerStatus.IN_STOCK.value,
            ContainerStatus.STAGED.value,
            ContainerStatus.OPENED.value,
        ):
            make_container(db_session, status=status, remaining_qty=500.0)

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["container_qty"] == 1500.0
        assert result["container_count"] == 3
        assert result["total"] == 1500.0
        assert result["unit"] == "lbs"
        assert result["has_containers"] is True

    def test_non_stock_statuses_excluded(self, db_session, avail_seed):
        for status in (
            ContainerStatus.PRINTED_UNAPPLIED.value,
            ContainerStatus.EMPTY.value,
            ContainerStatus.SHIPPED.value,
            ContainerStatus.DAMAGED.value,
            ContainerStatus.DISPOSED.value,
            ContainerStatus.RETURNED_TO_VENDOR.value,
            ContainerStatus.VOIDED.value,
            ContainerStatus.MISSING.value,
        ):
            make_container(db_session, status=status, remaining_qty=500.0)

        result = on_hand_for_product(db_session, PRODUCT_ID, include_pending=True)
        assert result["container_qty"] == 0.0
        assert result["physically_present"] == 0.0
        assert result["has_containers"] is False

    def test_partial_drum_uses_remaining_not_net(self, db_session, avail_seed):
        make_container(
            db_session,
            status=ContainerStatus.OPENED.value,
            remaining_qty=120.0,
            net_weight=500.0,
        )
        assert on_hand_for_product(db_session, PRODUCT_ID)["container_qty"] == 120.0

    def test_null_remaining_falls_back_to_net_weight(self, db_session, avail_seed):
        """A sealed drum may never have had remaining_qty written; it must not
        drop out of availability on a NULL."""
        make_container(db_session, remaining_qty=None, net_weight=500.0)
        assert on_hand_for_product(db_session, PRODUCT_ID)["container_qty"] == 500.0

    def test_warehouse_scope(self, db_session, avail_seed):
        make_container(db_session, warehouse_id=WH_A, remaining_qty=500.0)
        make_container(db_session, warehouse_id=WH_B, remaining_qty=300.0)

        assert on_hand_for_product(db_session, PRODUCT_ID)["container_qty"] == 800.0
        assert on_hand_for_product(db_session, PRODUCT_ID, WH_A)["container_qty"] == 500.0
        assert on_hand_for_product(db_session, PRODUCT_ID, WH_B)["container_qty"] == 300.0

    def test_other_products_not_counted(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(db_session, product_id=OTHER_PRODUCT_ID, remaining_qty=999.0)

        assert on_hand_for_product(db_session, PRODUCT_ID)["container_qty"] == 500.0


class TestHeldContainersExcluded:
    def test_held_container_not_available(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(db_session, remaining_qty=500.0, is_held=True, hold_reason="QA")

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["container_qty"] == 500.0
        assert result["container_count"] == 1
        assert result["available_to_stage"] == 500.0
        # Still in the barn, still owned.
        assert result["physically_present"] == 1000.0
        assert result["financial_on_hand"] == 1000.0
        assert result["sources"]["containers"]["active_held"] == 500.0

    def test_held_included_on_request_via_bare_helper(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(db_session, remaining_qty=500.0, is_held=True)

        assert container_qty_for_product(db_session, PRODUCT_ID) == 500.0
        assert container_qty_for_product(db_session, PRODUCT_ID, include_held=True) == 1000.0


class TestSoftDeletedExcluded:
    def test_soft_deleted_container_excluded(self, db_session, avail_seed):
        """Nothing in models/ingredient.py inherits a soft-delete-aware base, so
        an omitted is_deleted filter is a silent data leak."""
        make_container(db_session, remaining_qty=500.0)
        make_container(db_session, remaining_qty=500.0, is_deleted=True)

        result = on_hand_for_product(db_session, PRODUCT_ID, include_pending=True)
        assert result["container_qty"] == 500.0
        assert result["container_count"] == 1
        assert result["physically_present"] == 500.0
        assert result["sources"]["containers"]["count_total"] == 1


class TestPendingContainers:
    def test_received_excluded_by_default(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(
            db_session, status=ContainerStatus.RECEIVED.value, remaining_qty=500.0
        )

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["container_qty"] == 500.0
        assert result["available_to_stage"] == 500.0
        # Physically in the building even though the intake is not approved...
        assert result["physically_present"] == 1000.0
        # ...but not on the books yet.
        assert result["financial_on_hand"] == 500.0

    def test_received_included_when_requested(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(
            db_session, status=ContainerStatus.RECEIVED.value, remaining_qty=500.0
        )

        result = on_hand_for_product(db_session, PRODUCT_ID, include_pending=True)
        assert result["container_qty"] == 1000.0
        assert result["container_count"] == 2
        assert result["total"] == 1000.0
        # available_to_stage never includes pending, whatever the flag says.
        assert result["available_to_stage"] == 500.0

    def test_bare_helper_honours_include_pending(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0)
        make_container(
            db_session, status=ContainerStatus.RECEIVED.value, remaining_qty=500.0
        )

        assert container_qty_for_product(db_session, PRODUCT_ID) == 500.0
        assert container_qty_for_product(
            db_session, PRODUCT_ID, include_pending=True
        ) == 1000.0


# ---------------------------------------------------------------------------
# Mixed — the cutover window, where both modes are live at once
# ---------------------------------------------------------------------------

class TestMixedMode:
    def test_partial_conversion_keeps_the_total_flat(self, db_session, avail_seed):
        """The whole point of B4. A 40 x 500 lb receipt is quantity=20000 lbs.
        Convert 10 drums: the receipt drops by 10 x 500 lb and 10 containers
        appear. Availability must not move."""
        receipt = make_receipt(db_session, quantity=20000.0, unit="lbs")
        before = on_hand_for_product(db_session, PRODUCT_ID)["total"]

        receipt.quantity = 15000.0
        receipt.container_count = 30
        db_session.commit()
        for i in range(10):
            make_container(db_session, sequence=i + 1, remaining_qty=500.0)

        after = on_hand_for_product(db_session, PRODUCT_ID)
        assert before == 20000.0
        assert after["total"] == 20000.0
        assert after["legacy_qty"] == 15000.0
        assert after["container_qty"] == 5000.0
        assert after["container_count"] == 10
        assert after["unit"] == "lbs"

    def test_unitless_legacy_receipt_is_compatible(self, db_session, avail_seed):
        """A great many legacy rows predate the container fields and carry no
        unit at all. Blank is compatible, not a conflict.

        The NULL has to be written after the insert: Receipt.unit carries
        `default="cases"` (models/receipt.py:15), and SQLAlchemy applies a column
        default whenever the value is None at flush time — so `unit=None` here
        would silently become 'cases', and 'cases' vs 'lbs' MUST raise. Rows with
        a genuinely NULL unit predate that default and are what this covers.
        """
        receipt = make_receipt(db_session, quantity=1000.0)
        receipt.unit = None
        db_session.query(Receipt).filter(Receipt.id == receipt.id).update(
            {"unit": None}, synchronize_session=False
        )
        db_session.commit()
        make_container(db_session, remaining_qty=500.0, qty_unit="lbs")

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["total"] == 1500.0
        assert result["unit"] == "lbs"
        assert result["sources"]["unit_conflict"] is None

    def test_unitless_container_is_compatible(self, db_session, avail_seed):
        make_receipt(db_session, quantity=1000.0, unit="lbs")
        make_container(db_session, remaining_qty=500.0, qty_unit=None)

        result = on_hand_for_product(db_session, PRODUCT_ID)
        assert result["total"] == 1500.0
        assert result["unit"] == "lbs"

    def test_unit_comparison_ignores_case_and_padding(self, db_session, avail_seed):
        make_receipt(db_session, quantity=1000.0, unit="LBS")
        make_container(db_session, remaining_qty=500.0, qty_unit=" lbs ")

        assert on_hand_for_product(db_session, PRODUCT_ID)["total"] == 1500.0


# ---------------------------------------------------------------------------
# The unit trap (audit B3)
# ---------------------------------------------------------------------------

class TestUnitConflictRaises:
    def test_weight_plus_container_count_raises(self, db_session, avail_seed):
        """20000 lbs + 40 barrels is not a quantity. Refuse rather than return
        a corrupt number that reads as plausible."""
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_container(db_session, remaining_qty=40.0, qty_unit="barrel")

        with pytest.raises(ValidationError) as excinfo:
            on_hand_for_product(db_session, PRODUCT_ID)
        assert "lbs" in str(excinfo.value.detail)
        assert "barrel" in str(excinfo.value.detail)

    def test_containers_in_two_units_raise(self, db_session, avail_seed):
        make_container(db_session, remaining_qty=500.0, qty_unit="lbs")
        make_container(db_session, remaining_qty=200.0, qty_unit="kg")

        with pytest.raises(ValidationError):
            on_hand_for_product(db_session, PRODUCT_ID)

    def test_held_container_in_an_odd_unit_does_not_break_the_gate(
        self, db_session, avail_seed
    ):
        """A held drum contributes nothing, so its unit must not take down
        availability for the material that IS available."""
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_container(db_session, remaining_qty=500.0, qty_unit="lbs")
        make_container(db_session, remaining_qty=40.0, qty_unit="barrel", is_held=True)

        assert on_hand_for_product(db_session, PRODUCT_ID)["total"] == 20500.0

    def test_pending_container_in_an_odd_unit_only_raises_when_included(
        self, db_session, avail_seed
    ):
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_container(
            db_session,
            status=ContainerStatus.RECEIVED.value,
            remaining_qty=40.0,
            qty_unit="barrel",
        )

        assert on_hand_for_product(db_session, PRODUCT_ID)["total"] == 20000.0
        with pytest.raises(ValidationError):
            on_hand_for_product(db_session, PRODUCT_ID, include_pending=True)

    def test_zero_quantity_container_in_an_odd_unit_does_not_raise(
        self, db_session, avail_seed
    ):
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_container(db_session, remaining_qty=0.0, net_weight=0.0, qty_unit="barrel")

        assert on_hand_for_product(db_session, PRODUCT_ID)["total"] == 20000.0

    def test_mixed_legacy_units_raise_once_containers_join(self, db_session, avail_seed):
        """Legacy-only disagreement is tolerated for backwards compatibility,
        but the moment a container has to be added to it there is no defensible
        answer."""
        make_receipt(db_session, quantity=20000.0, unit="lbs")
        make_receipt(db_session, quantity=50.0, unit="kg")
        make_container(db_session, remaining_qty=500.0, qty_unit="lbs")

        with pytest.raises(ValidationError):
            on_hand_for_product(db_session, PRODUCT_ID)


# ---------------------------------------------------------------------------
# The wired endpoint
# ---------------------------------------------------------------------------

class TestCheckAvailabilityEndpoint:
    """POST /api/service/check-availability — the gate itself."""

    def _post(self, client, payload):
        from app.config import settings
        return client.post(
            "/api/service/check-availability",
            json=payload,
            headers={"X-Api-Key": settings.SERVICE_API_KEY or ""},
        )

    def test_containers_keep_the_batch_schedulable(self, db_session, client, avail_seed):
        db_session.query(Product).filter(Product.id == PRODUCT_ID).update({"sid": "SID-GUAVA"})
        db_session.commit()
        # Fully converted: no legacy quantity left at all.
        for i in range(4):
            make_container(db_session, sequence=i + 1, remaining_qty=500.0)

        response = self._post(client, {
            "items": [{"sid": "SID-GUAVA", "quantity_needed": 1500, "unit": "lbs"}]
        })
        assert response.status_code == 200
        body = response.json()
        assert body["all_sufficient"] is True
        item = body["items"][0]
        assert item["on_hand"] == 2000.0
        assert item["legacy_qty"] == 0.0
        assert item["container_qty"] == 2000.0
        assert item["container_count"] == 4

    def test_legacy_only_response_unchanged(self, db_session, client, avail_seed):
        db_session.query(Product).filter(Product.id == PRODUCT_ID).update({"sid": "SID-GUAVA"})
        db_session.commit()
        make_receipt(db_session, quantity=20000.0, hold=True, held_quantity=5000.0)

        response = self._post(client, {
            "items": [{"sid": "SID-GUAVA", "quantity_needed": 15000, "unit": "lbs"}]
        })
        assert response.status_code == 200
        item = response.json()["items"][0]
        assert item["on_hand"] == 15000.0
        assert item["sufficient"] is True
        assert item["short"] == 0
        assert item["container_qty"] == 0.0
