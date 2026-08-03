"""Cutover: converting legacy ingredient receipts into serialized containers.

Phase 6 of INGREDIENT-SERIALIZATION-SPEC.md (§15). Does NOT commit; the router
owns the transaction boundary.

THE ARITHMETIC IS THE WHOLE POINT OF THIS MODULE, and the spec had it wrong.
§15.3 says a conversion is "legacy receipt qty −1 ⟷ container +1". For a
properly-entered ingredient receipt that is a UNIT ERROR: `Receipt.quantity`
holds total WEIGHT, not a container count. routers/receipts.py:110-113 sets

    quantity = container_count * weight_per_container
    unit     = weight_unit

so a 40 × 500 lb load is `quantity=20000, unit='lbs'` with the count in the
separate `container_count` column. Deducting 1 per drum would leave 19,960 lbs
of phantom stock after converting all forty. A conversion therefore moves BOTH
numbers:

    receipt.quantity       -= container.net_weight     (in the receipt's unit)
    receipt.container_count -= 1

and asserts `legacy + serialized == pre-conversion` INSIDE the transaction —
not only in a reconciliation view read later, by which time the truck is gone.

IT ALSO DOES NOT GO THROUGH approve_adjustment. Adjustment types are a
hardcoded frozenset (adjustment_service.py, now enums.DEDUCTION_TYPES), so a new
type produces an APPROVED adjustment that looks right in every UI while leaving
`receipt.quantity` untouched — the whole lot double-counted with an audit trail
claiming it was handled. And routing through that service inherits
`_apply_row_breakdown`'s auto-spread, which §6.4 bans. Instead this module does
its own decrement, frees the row with an EXPLICIT `pallets_by_row`, and writes
an already-APPROVED adjustment purely so KPIs and reports stay continuous.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import (
    AdjustmentStatus,
    AdjustmentType,
    ContainerEventType,
    ContainerStatus,
    IntakeSource,
    IntakeStatus,
)
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.models import (
    Container,
    IngredientIntake,
    IntakeLot,
    InventoryAdjustment,
    Receipt,
    StorageRow,
)
from app.services.ingredient_intake_service import (
    _active_containers,
    _mint_id,
    _plant_timezone,
    _record_event,
    container_count_unit,
)
from app.services.row_allocation import deduct_rm_rows
from app.utils.category_rules import is_ingredient

# Tolerance for the in-transaction invariant. Weights are floats and the receipt
# rounds to 3 dp on write (receipts.py:112), so an exact equality check would
# fail on arithmetic noise rather than on real drift.
_EPSILON = 0.01


def _sweep_intake(db: Session, receipt: Receipt, current_user) -> IngredientIntake:
    """Find or create the legacy-sweep intake that owns this receipt's drums.

    One intake per legacy receipt, marked `legacy_sweep`, so converted drums
    still hang off something with a number and a history. The received date is
    the RECEIPT's date, not today's — and where the receipt has none it stays
    null rather than being invented (§15.4: unknown history is honest).
    """
    existing = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.source == IntakeSource.LEGACY_SWEEP.value,
            IngredientIntake.bol == f"legacy:{receipt.id}",
            IngredientIntake.is_deleted == False,  # noqa: E712
        )
        .first()
    )
    if existing:
        return existing

    plant_tz = _plant_timezone(db, receipt.warehouse_id)
    from app.services.ingredient_intake_service import _next_intake_number

    intake = IngredientIntake(
        id=_mint_id("ing"),
        intake_number=_next_intake_number(db, plant_tz),
        vendor_id=receipt.vendor_id,
        # Traceable back to the receipt it came from without inventing a BOL.
        bol=f"legacy:{receipt.id}",
        purchase_order=receipt.purchase_order,
        receipt_date=receipt.receipt_date,
        warehouse_id=receipt.warehouse_id,
        status=IntakeStatus.APPROVED.value,
        source=IntakeSource.LEGACY_SWEEP.value,
        notes=f"Floor sweep conversion of legacy receipt {receipt.id}",
        expected_count=int(receipt.container_count or 0),
        received_count=0,
        submitted_by=str(current_user.id),
        approved_by=str(current_user.id),
        approved_at=datetime.now(timezone.utc),
        last_serial_seq=0,
    )
    db.add(intake)
    db.flush()

    lot = IntakeLot(
        id=_mint_id("ilot"),
        intake_id=intake.id,
        product_id=receipt.product_id,
        category_id=receipt.category_id,
        container_type="barrel",
        vendor_lot=receipt.lot_number,
        # An unreadable drum label is recorded as unknown and QA-flagged, not
        # guessed at.
        lot_unknown=not bool(receipt.lot_number),
        bbd=receipt.expiration_date,
        expected_count=int(receipt.container_count or 0),
        net_weight_per_container=receipt.weight_per_container,
        weight_unit=receipt.weight_unit or receipt.unit,
    )
    db.add(lot)
    db.flush()
    return intake


def sweep_eligibility(db: Session, receipt: Receipt) -> dict:
    """Whether this receipt can be swept, and why not if it cannot."""
    reasons = []
    if not is_ingredient(db, receipt):
        reasons.append("Not an ingredient receipt")
    if receipt.is_deleted:
        reasons.append("Receipt is deleted")
    if (receipt.quantity or 0) <= 0:
        reasons.append("Receipt has no remaining quantity")
    if not receipt.weight_per_container:
        # Without a per-container weight there is no defensible number to
        # decrement per drum, and guessing one is how phantom stock appears.
        reasons.append("Receipt has no weight_per_container — cannot convert safely")

    held_qty = float(receipt.held_quantity or 0)
    qty = float(receipt.quantity or 0)
    if held_qty > 0 and held_qty < qty:
        # §21 Q5. A partial hold has no correct per-drum answer: `hold` is a
        # flag but `held_quantity` is the real hold, and nothing records WHICH
        # drums are held. Excluding these removes the whole ambiguity class for
        # a rare case; they get swept once the hold clears.
        reasons.append(
            f"Lot is PARTIALLY held ({held_qty:g} of {qty:g}) — clear or complete the hold first"
        )

    return {
        "eligible": not reasons,
        "reasons": reasons,
        "fully_held": held_qty >= qty > 0,
        "remaining_qty": qty,
        "container_count": receipt.container_count,
        "weight_per_container": receipt.weight_per_container,
        "unit": receipt.unit,
    }


def convert_one(
    db: Session,
    receipt: Receipt,
    storage_row_id: str,
    current_user,
    *,
    lot_number_override: Optional[str] = None,
    bbd_override: Optional[datetime] = None,
    damaged: bool = False,
    opened_remaining: Optional[float] = None,
) -> dict:
    """Convert ONE physical drum off a legacy receipt into a serialized container.

    Idempotent per (receipt, row, sequence) only in the sense that re-running it
    creates the NEXT drum — a sweeper who scans the same drum twice is caught by
    the serial already existing on that drum, not by this function (§18.8 C-2).

    One transaction: decrement the receipt, free the row explicitly, create the
    container, write the KPI-continuity adjustment, assert the invariant.
    """
    check = sweep_eligibility(db, receipt)
    if not check["eligible"]:
        raise ValidationError("; ".join(check["reasons"]))

    row = (
        db.query(StorageRow)
        .filter(StorageRow.id == storage_row_id, StorageRow.is_active == True)  # noqa: E712
        .first()
    )
    if not row:
        raise NotFoundError("Storage row", storage_row_id)

    net = float(receipt.weight_per_container or 0)
    if net <= 0:
        raise ValidationError("weight_per_container must be positive to convert")

    qty_before = float(receipt.quantity or 0)
    count_before = receipt.container_count

    intake = _sweep_intake(db, receipt, current_user)
    lot = intake.lots[0]
    if lot_number_override:
        lot.vendor_lot = lot_number_override
        lot.lot_unknown = False
    if bbd_override:
        lot.bbd = bbd_override

    # Mint one serial on the sweep intake, under the same locked counter the
    # normal receiving path uses.
    from app.services.ingredient_intake_service import mint_serials

    container = mint_serials(db, intake, lot, 1, current_user)[0]

    remaining = float(opened_remaining) if opened_remaining is not None else net
    if remaining > net:
        raise ValidationError("Remaining quantity cannot exceed the container's net weight")

    container.storage_row_id = row.id
    container.warehouse_id = receipt.warehouse_id
    container.remaining_qty = remaining
    container.net_weight = net
    container.qty_unit = receipt.weight_unit or receipt.unit
    container.vendor_lot = lot.vendor_lot
    container.bbd = lot.bbd
    container.opened_at = datetime.now(timezone.utc) if remaining < net else None
    container.scanned_by = str(current_user.id)
    container.scanned_at = datetime.now(timezone.utc)

    if damaged:
        container.status = ContainerStatus.DAMAGED.value
    elif remaining < net:
        container.status = ContainerStatus.OPENED.value
    else:
        container.status = ContainerStatus.IN_STOCK.value

    # C-4: a FULLY held lot passes its hold to every drum. A partial hold never
    # reaches here — sweep_eligibility rejects it above.
    if check["fully_held"]:
        container.is_held = True
        container.hold_reason = "Inherited from legacy lot hold at conversion"
        container.held_by = str(current_user.id)
        container.held_at = datetime.now(timezone.utc)

    _record_event(
        db, container, ContainerEventType.RECEIVED.value,
        from_status=ContainerStatus.PRINTED_UNAPPLIED.value,
        to_status=container.status,
        actor_id=str(current_user.id),
        to_row_id=row.id,
        qty_delta=remaining,
        ref_type="legacy_receipt", ref_id=receipt.id,
        reason="Floor sweep conversion",
    )

    # ── the legacy side ──────────────────────────────────────────────────────
    # BOTH numbers move. See the module docstring: quantity is weight.
    taken = remaining
    receipt.quantity = max(0.0, qty_before - taken)
    if receipt.container_count is not None:
        receipt.container_count = max(0, int(receipt.container_count) - 1)

    # Free the rack EXPLICITLY for the row the sweeper scanned. Never
    # deduct_rm_total, which prorates across every allocation entry — that is
    # the auto-spread §6.4 bans and §19.2 tests for.
    deduct_rm_rows(
        db, receipt,
        {row.id: taken},
        pallets_by_row={row.id: 0},
        update_rows=True,
    )

    # KPI/report continuity only — this adjustment does NOT perform the
    # decrement (that happened above) and is created already APPROVED so it can
    # never be routed through approve_adjustment and double-applied.
    db.add(InventoryAdjustment(
        id=_mint_id("adj"),
        receipt_id=receipt.id,
        product_id=receipt.product_id,
        adjustment_type=AdjustmentType.SERIALIZATION_CONVERSION.value,
        quantity=taken,
        unit=receipt.unit,
        original_quantity=qty_before,
        new_quantity=max(0.0, qty_before - taken),
        reason=f"Serialized as {container.serial}",
        status=AdjustmentStatus.APPROVED.value,
        submitted_by=str(current_user.id),
        approved_by=str(current_user.id),
        approved_at=datetime.now(timezone.utc),
        warehouse_id=receipt.warehouse_id,
    ))

    intake.received_count = (intake.received_count or 0) + 1
    db.flush()

    # ── the invariant, asserted HERE and not in a report read next week ───────
    # Nothing is created or destroyed by a conversion: weight moves from the
    # legacy receipt into a container. So the combined total must be unchanged,
    # which reduces to "the receipt went down by exactly what the drum holds".
    # Raising rolls the whole thing back — better an operator retries one drum
    # than that a silent 1-vs-500 unit error compounds across eighty of them.
    after = float(receipt.quantity or 0)
    actually_deducted = qty_before - after
    if abs(actually_deducted - taken) > _EPSILON:
        raise ConflictError(
            "Conversion does not balance: the drum holds "
            f"{taken:g} {receipt.unit or ''} but the receipt moved by "
            f"{actually_deducted:g} ({qty_before:g} -> {after:g})"
        )

    return {
        "container": container,
        "serial": container.serial,
        "intake_number": intake.intake_number,
        "receipt_quantity_before": qty_before,
        "receipt_quantity_after": after,
        "receipt_container_count_before": count_before,
        "receipt_container_count_after": receipt.container_count,
        "taken": taken,
        "unit": receipt.unit,
        "count_unit": container_count_unit(container.container_type, 1),
    }


def _serialized_weight_for_receipt(db: Session, receipt: Receipt) -> float:
    """Total live weight sitting in containers converted off this receipt."""
    intake = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.bol == f"legacy:{receipt.id}",
            IngredientIntake.is_deleted == False,  # noqa: E712
        )
        .first()
    )
    if not intake:
        return 0.0
    total = (
        db.query(func.coalesce(func.sum(Container.remaining_qty), 0))
        .filter(
            Container.intake_id == intake.id,
            Container.is_deleted == False,  # noqa: E712
            Container.status.in_(
                (
                    ContainerStatus.IN_STOCK.value,
                    ContainerStatus.STAGED.value,
                    ContainerStatus.OPENED.value,
                    ContainerStatus.DAMAGED.value,
                )
            ),
        )
        .scalar()
    )
    return float(total or 0)


def reconciliation(db: Session, warehouse_id: Optional[str] = None) -> dict:
    """Per-lot: legacy remaining + serialized == expected.

    Drift is reported, never auto-healed (§18.8 C-3). A discrepancy means a
    write path is wrong or someone moved material without scanning, and silently
    correcting it is how the previous denormalization bugs stayed invisible for
    so long.
    """
    intakes = (
        db.query(IngredientIntake)
        .filter(
            IngredientIntake.source == IntakeSource.LEGACY_SWEEP.value,
            IngredientIntake.is_deleted == False,  # noqa: E712
        )
    )
    if warehouse_id:
        intakes = intakes.filter(IngredientIntake.warehouse_id == warehouse_id)

    rows = []
    for intake in intakes.all():
        if not (intake.bol or "").startswith("legacy:"):
            continue
        receipt_id = intake.bol.split("legacy:", 1)[1]
        receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
        if not receipt:
            continue

        serialized = _serialized_weight_for_receipt(db, receipt)
        legacy = float(receipt.quantity or 0)
        converted = (
            _active_containers(db, intake_id=intake.id).count()
        )
        rows.append({
            "receipt_id": receipt.id,
            "intake_number": intake.intake_number,
            "lot_number": receipt.lot_number,
            "legacy_remaining": legacy,
            "serialized_remaining": serialized,
            "combined": legacy + serialized,
            "converted_containers": converted,
            "unit": receipt.unit,
            "count_unit": container_count_unit("barrel", converted),
        })

    return {"rows": rows, "total": len(rows)}
