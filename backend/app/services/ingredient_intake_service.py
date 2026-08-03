"""Ingredient intake, serial minting, and scan-to-location receiving.

See INGREDIENT-SERIALIZATION-SPEC.md §4, §5, §7, §8.

COMMIT OWNERSHIP: this module does NOT commit. Callers (the router) own the
transaction boundary. The repo is inconsistent about this — staging_service
never commits while staging_request_service commits internally — so it is
stated explicitly here rather than left to be inferred.

Three rules in this module are load-bearing, each one a past production bug:

1. NO LOCATION GUESSING (§6.4, §19.2). A scan without an explicit row is
   rejected. There is deliberately no "last known row" fallback, even though
   the finished-goods scanner has one (scanner_service.py:433-443 returns
   last_row_id on session resume). Quantity spread across rows nobody selected
   is the single most-repeated bug in this codebase.

2. CAPACITY IS SOFT (§8.1, §19.6). Over-capacity returns a warning ALONGSIDE a
   successful scan; it never raises. The finished-goods path hard-raises
   (scanner_service.py:532-533) and receipts.py returns HTTP 400 in four more
   places. An 80-drum unload that 400s halfway through is the stuck-flow
   failure this design exists to prevent.

3. STATE AND LEDGER MOVE TOGETHER. Every mutation takes SELECT ... FOR UPDATE on
   the container row and writes exactly one ContainerEvent in the same
   transaction (IMPL-COMMENT 1/2). A check-and-set on `status` is not enough:
   a move is in_stock -> in_stock and a weigh-out is opened -> opened, so both
   racers would match the expected status and the last writer would win.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import func, text
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo

from app.constants import APPROVAL_ROLES, ROLE_WAREHOUSE
from app.enums import (
    ContainerEventType,
    ContainerStatus,
    ContainerType,
    IntakeSource,
    IntakeStatus,
)
from app.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.models import (
    Container,
    ContainerEvent,
    IngredientIntake,
    IntakeLot,
    Product,
    StorageRow,
    Vendor,
    Warehouse,
)
from app.utils.auth import require_approval_access, warehouse_filter
from app.utils.lot_number import plant_local_date

# Serials are minted per container type. The prefix is human courtesy on the
# drum; no code may parse it back out (§4.2).
_TYPE_PREFIX = {
    ContainerType.BARREL.value: "B",
    ContainerType.BAG.value: "G",
}

# Statuses from which a container may still be received onto a rack.
_RECEIVABLE = (
    ContainerStatus.PRINTED_UNAPPLIED.value,
    ContainerStatus.RECEIVED.value,
)

# An intake accepts edits and scans only while it is still open.
_OPEN_STATUSES = (IntakeStatus.RECORDED.value, IntakeStatus.SUBMITTED.value)


# ─── ids ──────────────────────────────────────────────────────────────────────

def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ─── helpers ──────────────────────────────────────────────────────────────────

def _plant_timezone(db: Session, warehouse_id: Optional[str]) -> str:
    if not warehouse_id:
        return "UTC"
    wh = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    return (wh.timezone if wh and wh.timezone else "UTC")


def container_count_unit(container_type: Optional[str], count: int = 2) -> str:
    """Display unit for a container count. Never "cases" (§6.3, §19.1).

    The unit is derived from the container type, never from a column default —
    that default is exactly how an 80-barrel receipt came to render as
    "80 cases".
    """
    plural = "" if count == 1 else "s"
    if container_type == ContainerType.BARREL.value:
        return f"barrel{plural}"
    if container_type == ContainerType.BAG.value:
        return f"bag{plural}"
    return f"container{plural}"


def _intake_count_unit(intake: IngredientIntake) -> str:
    """One unit for the whole intake when its lots agree; generic when mixed."""
    types = {lot.container_type for lot in (intake.lots or [])}
    if len(types) == 1:
        return container_count_unit(next(iter(types)))
    return "containers"


def _active_containers(db: Session, **filters):
    """Base container query. EVERY read must exclude soft-deleted rows — these
    tables inherit nothing, so there is no global default doing it for us."""
    q = db.query(Container).filter(Container.is_deleted == False)  # noqa: E712
    for key, value in filters.items():
        q = q.filter(getattr(Container, key) == value)
    return q


def _record_event(
    db: Session,
    container: Container,
    event_type: str,
    *,
    from_status: Optional[str],
    to_status: str,
    actor_id: Optional[str] = None,
    from_row_id: Optional[str] = None,
    to_row_id: Optional[str] = None,
    qty_delta: Optional[float] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    reason: Optional[str] = None,
    reason_code: Optional[str] = None,
    verified: bool = True,
    idempotency_key: Optional[str] = None,
) -> ContainerEvent:
    """Append one ledger row. Always called in the same transaction as the state
    change it describes — see module docstring rule 3.

    `to_row_id` means "where the container is AFTER this event", not "where it
    was moved to". Events that change status without moving anything (approve,
    void, relabel) therefore inherit the container's current row rather than
    recording NULL. Recording NULL there makes the latest ledger row disagree
    with the container for every drum that was ever approved, which the
    cache-drift audit correctly — but uselessly — reports as drift.
    """
    event = ContainerEvent(
        id=_mint_id("cevt"),
        container_id=container.id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        from_row_id=from_row_id,
        to_row_id=to_row_id if to_row_id is not None else container.storage_row_id,
        qty_delta=qty_delta,
        actor_id=actor_id,
        ref_type=ref_type,
        ref_id=ref_id,
        reason=reason,
        reason_code=reason_code,
        verified=verified,
        occurred_at=datetime.now(timezone.utc),
        idempotency_key=idempotency_key,
    )
    db.add(event)
    return event


def _lock_container(db: Session, container_id: str) -> Optional[Container]:
    """SELECT ... FOR UPDATE one container.

    Copies the repo idiom from routers/transfers.py:181-192
    (_lock_pallets_for_update). This — not a status check-and-set — is the
    serialization point for container mutations.
    """
    return (
        db.query(Container)
        .filter(Container.id == container_id, Container.is_deleted == False)  # noqa: E712
        .with_for_update()
        .first()
    )


# ─── intake creation ──────────────────────────────────────────────────────────

def _next_intake_number(db: Session, plant_tz: str) -> str:
    """ING-{plant-local YYMMDD}-{NNNN}.

    The ordinal comes from a Postgres sequence and is globally monotonic, NOT
    per-day: a per-day counter would need a reset, and §18.9 forbids counter
    resets outright. The date segment is plant-local (a truck received at 8pm ET
    on Aug 3 must read 260803, not 260804) — a deliberate exception to the
    otherwise-UTC rule, matching the palletizer's lot numbering.
    """
    # IF NOT EXISTS so a fresh test database still works: conftest builds the
    # schema with create_all and never runs migrations, so the sequence the
    # migration creates is absent there.
    db.execute(text("CREATE SEQUENCE IF NOT EXISTS ingredient_intake_seq"))
    seq = db.execute(text("SELECT nextval('ingredient_intake_seq')")).scalar()
    day = plant_local_date(plant_tz, datetime.now(timezone.utc)).strftime("%y%m%d")
    return f"ING-{day}-{int(seq):04d}"


def create_intake(db: Session, data, current_user) -> IngredientIntake:
    """Create an intake and its vendor-lot lines.

    Deliberately creates NO legacy Receipt (IMPL-COMMENT 13). Dual-mode
    availability sums legacy receipt weight plus live container quantity, so a
    shadow Receipt for a serialized intake would be counted twice.
    """
    warehouse_id = data.warehouse_id or warehouse_filter(current_user)
    plant_tz = _plant_timezone(db, warehouse_id)

    if data.source not in (IntakeSource.TRUCK.value, IntakeSource.LEGACY_SWEEP.value):
        raise ValidationError(f"Unknown intake source '{data.source}'")

    if not data.lots:
        raise ValidationError("An intake needs at least one lot line")

    intake = IngredientIntake(
        id=_mint_id("ing"),
        intake_number=_next_intake_number(db, plant_tz),
        vendor_id=data.vendor_id,
        bol=data.bol,
        purchase_order=data.purchase_order,
        receipt_date=data.receipt_date or datetime.now(timezone.utc),
        warehouse_id=warehouse_id,
        status=IntakeStatus.RECORDED.value,
        source=data.source,
        notes=data.notes,
        expected_count=0,
        received_count=0,
        submitted_by=str(current_user.id),
        last_serial_seq=0,
    )
    db.add(intake)
    db.flush()

    total_expected = 0
    for line in data.lots:
        lot = _build_lot(db, intake, line)
        db.add(lot)
        total_expected += lot.expected_count or 0

    intake.expected_count = total_expected
    db.flush()
    return intake


def _build_lot(db: Session, intake: IngredientIntake, line) -> IntakeLot:
    if line.container_type not in (ContainerType.BARREL.value, ContainerType.BAG.value):
        raise ValidationError(
            f"Unknown container type '{line.container_type}' — expected barrel or bag"
        )

    product = db.query(Product).filter(Product.id == line.product_id).first()
    if not product:
        raise NotFoundError("Product", line.product_id)

    # The 2D label payload is pipe-delimited (SB1|serial|lot|bbd). Rejecting the
    # delimiter at entry is simpler and safer than escaping it at print time,
    # and a vendor lot containing '|' has never been seen in practice.
    if line.vendor_lot and "|" in line.vendor_lot:
        raise ValidationError("Vendor lot cannot contain the '|' character")

    return IntakeLot(
        id=_mint_id("ilot"),
        intake_id=intake.id,
        product_id=line.product_id,
        category_id=line.category_id or product.category_id,
        container_type=line.container_type,
        vendor_lot=line.vendor_lot,
        lot_unknown=bool(line.lot_unknown),
        bbd=line.bbd,
        expected_count=line.expected_count or 0,
        brix=line.brix,
        net_weight_per_container=line.net_weight_per_container,
        weight_unit=line.weight_unit,
    )


# ─── serial minting ───────────────────────────────────────────────────────────

def mint_serials(
    db: Session, intake: IngredientIntake, lot: IntakeLot, count: int, current_user
) -> List[Container]:
    """Mint `count` serials on `lot`, returning the new containers.

    The counter lives on the intake and is taken under SELECT ... FOR UPDATE, so
    two devices minting at once cannot double-allocate. The obvious alternative,
    MAX(sequence)+1, races — and it races precisely during over-receipt top-ups
    and reprints, which is when a worker is standing at the dock waiting. The
    losing mint would surface as an IntegrityError. Precedent for the locked
    counter: routers/palletizer.py:189-196.

    The sequence is INTAKE-GLOBAL, not per-lot: §4.2 defines the last segment as
    "sequence within intake", and per-lot stacks are produced by ordering on
    (intake_lot_id, sequence) at print time. That keeps late top-ups on one lot
    from renumbering another lot's already-applied stickers.
    """
    if count <= 0:
        raise ValidationError("Mint count must be positive")
    # A legacy-sweep intake is exempt: it is not a truck that closes, it is a
    # long-lived home for drums converted off one legacy receipt, one at a time,
    # over days or weeks. It is created already-approved so converted drums go
    # straight to stock without a second gate, which would otherwise make it
    # permanently unmintable.
    if (
        intake.source != IntakeSource.LEGACY_SWEEP.value
        and intake.status not in _OPEN_STATUSES
    ):
        raise ValidationError(
            f"Intake {intake.intake_number} is {intake.status}; serials can only be minted while it is open"
        )
    if lot.intake_id != intake.id:
        raise ValidationError("Lot line does not belong to this intake")

    locked = (
        db.query(IngredientIntake)
        .filter(IngredientIntake.id == intake.id)
        .with_for_update()
        .first()
    )
    if not locked:
        raise NotFoundError("Intake", intake.id)

    plant_tz = _plant_timezone(db, locked.warehouse_id)
    day = plant_local_date(plant_tz, locked.receipt_date or datetime.now(timezone.utc))
    day_str = day.strftime("%y%m%d")
    # The intake ordinal is the uniqueness-bearing segment; fall back to a slice
    # of the id only if an intake somehow has no number.
    ordinal = (locked.intake_number or locked.id).split("-")[-1]
    prefix = _TYPE_PREFIX.get(lot.container_type, "C")

    created: List[Container] = []
    start = int(locked.last_serial_seq or 0)
    for offset in range(1, count + 1):
        seq = start + offset
        container = Container(
            id=_mint_id("cnt"),
            serial=f"{prefix}-{day_str}-{ordinal}-{seq:03d}",
            sequence=seq,
            intake_id=locked.id,
            intake_lot_id=lot.id,
            product_id=lot.product_id,
            warehouse_id=locked.warehouse_id,
            container_type=lot.container_type,
            status=ContainerStatus.PRINTED_UNAPPLIED.value,
            net_weight=lot.net_weight_per_container,
            remaining_qty=lot.net_weight_per_container,
            qty_unit=lot.weight_unit,
            vendor_lot=lot.vendor_lot,
            bbd=lot.bbd,
        )
        db.add(container)
        db.flush()
        _record_event(
            db, container, ContainerEventType.PRINTED.value,
            from_status=None,
            to_status=ContainerStatus.PRINTED_UNAPPLIED.value,
            actor_id=str(current_user.id),
            ref_type="intake", ref_id=locked.id,
        )
        created.append(container)

    locked.last_serial_seq = start + count
    db.flush()
    return created


# ─── labels ───────────────────────────────────────────────────────────────────

def label_sheet(
    db: Session,
    intake: IngredientIntake,
    *,
    scope: str = "intake",
    lot_id: Optional[str] = None,
    serials: Optional[List[str]] = None,
    current_user=None,
) -> Tuple[List[Container], List[int]]:
    """Containers for a reprint, in per-lot stack order, plus lot boundaries.

    Reprint is deliberately ungated (§5): a worker blocked from reprinting
    invents workarounds, which is worse than a reprint. Every reprint writes a
    `relabeled` event instead, so excessive reprinting is visible after the fact.
    Reprints always reproduce the SAME serials — a label is a pointer to a row,
    not a new identity.
    """
    q = _active_containers(db, intake_id=intake.id)

    if scope == "lot":
        if not lot_id:
            raise ValidationError("scope=lot requires a lot_id")
        q = q.filter(Container.intake_lot_id == lot_id)
    elif scope == "selection":
        if not serials:
            raise ValidationError("scope=selection requires serials")
        q = q.filter(Container.serial.in_(serials))
    elif scope != "intake":
        raise ValidationError(f"Unknown label scope '{scope}'")

    # Per-lot stacks with a divider at each boundary — matching how the stickers
    # are physically applied.
    containers = q.order_by(Container.intake_lot_id, Container.sequence).all()

    if scope == "selection" and serials:
        found = {c.serial for c in containers}
        missing = [s for s in serials if s not in found]
        if missing:
            raise NotFoundError("Container", ", ".join(missing[:5]))

    boundaries: List[int] = []
    last_lot = None
    for index, container in enumerate(containers):
        if last_lot is not None and container.intake_lot_id != last_lot:
            boundaries.append(index)
        last_lot = container.intake_lot_id

    if current_user is not None:
        for container in containers:
            _record_event(
                db, container, ContainerEventType.RELABELED.value,
                from_status=container.status, to_status=container.status,
                actor_id=str(current_user.id),
                ref_type="label_scope", ref_id=scope,
            )
        db.flush()

    return containers, boundaries


# ─── receiving scan ───────────────────────────────────────────────────────────

def _row_capacity_warning(db: Session, row: StorageRow) -> Optional[Tuple[str, str]]:
    """Advisory only. Returns (code, detail) or None — NEVER raises.

    Ingredient rows are created with pallet_capacity = 0, which means "no
    opinion" rather than "full", so a zero-capacity row never warns.
    """
    capacity = int(row.pallet_capacity or 0)
    if capacity <= 0:
        return None
    occupied = (
        db.query(func.count(Container.id))
        .filter(
            Container.storage_row_id == row.id,
            Container.is_deleted == False,  # noqa: E712
            Container.status.in_(
                (
                    ContainerStatus.RECEIVED.value,
                    ContainerStatus.IN_STOCK.value,
                    ContainerStatus.OPENED.value,
                )
            ),
        )
        .scalar()
        or 0
    )
    if occupied >= capacity:
        return ("row_full", f"{row.name} is at its capacity of {capacity}")
    return None


def scan_container(
    db: Session,
    intake: IngredientIntake,
    serial: str,
    storage_row_id: str,
    current_user,
    *,
    idempotency_key: Optional[str] = None,
    confirm_move: bool = False,
) -> dict:
    """Receive one drum onto one row. See §8.3 and the R-1..R-5 edge cases.

    Returns a dict shaped like ContainerScanResponse. Never raises for a full
    row; does raise for an unknown serial, a missing row, a cross-intake serial,
    or a container that has already left the receiving stage.
    """
    # Idempotent replay FIRST, before any validation — a queued scan that
    # already succeeded must return its original result even if the intake has
    # since been submitted. Mirrors scanner_service.py:484-511.
    if idempotency_key:
        prior = (
            db.query(ContainerEvent)
            .filter(ContainerEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            container = _active_containers(db, id=prior.container_id).first()
            return _scan_payload(
                db, intake, container,
                status="already_received",
                message="Already recorded (idempotent replay).",
            )

    if not storage_row_id:
        # §6.4 / §19.2. No fallback to a last-known row, by design.
        raise ValidationError("Scan a row first — a drum is never placed by guess")

    row = (
        db.query(StorageRow)
        .filter(StorageRow.id == storage_row_id, StorageRow.is_active == True)  # noqa: E712
        .first()
    )
    if not row:
        raise NotFoundError("Storage row", storage_row_id)

    container = _active_containers(db).filter(Container.serial == serial).first()
    if not container:
        raise NotFoundError("Container", serial)

    # R-9: a serial always belongs to its own intake, regardless of which
    # session scanned it. Warn and refuse rather than silently re-homing it.
    if container.intake_id != intake.id:
        raise ValidationError(
            f"{serial} belongs to another intake and cannot be received onto this one"
        )

    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)

    if locked.status not in _RECEIVABLE:
        raise ConflictError(
            f"{serial} is {locked.status} and can no longer be received"
        )

    previous_status = locked.status
    previous_row = locked.storage_row_id

    # R-1: same drum, same row -> idempotent no-op with a friendly message.
    if previous_status == ContainerStatus.RECEIVED.value and previous_row == row.id:
        return _scan_payload(
            db, intake, locked,
            status="already_received",
            message=f"Already received @ {row.name}",
        )

    # R-2: same drum, DIFFERENT row -> explicit confirmation, never silent.
    # (The finished-goods scanner moves silently here; that is the behaviour we
    # are deliberately not copying — scanner_service.py:537-546.)
    if (
        previous_status == ContainerStatus.RECEIVED.value
        and previous_row
        and previous_row != row.id
        and not confirm_move
    ):
        prior_row = db.query(StorageRow).filter(StorageRow.id == previous_row).first()
        return _scan_payload(
            db, intake, locked,
            status="needs_confirm",
            message=f"Already in {prior_row.name if prior_row else previous_row} — move to {row.name}?",
            warning="already_in_other_row",
        )

    moved = previous_status == ContainerStatus.RECEIVED.value and previous_row != row.id

    locked.status = ContainerStatus.RECEIVED.value
    locked.storage_row_id = row.id
    locked.scanned_by = str(current_user.id)
    locked.scanned_at = datetime.now(timezone.utc)
    if locked.warehouse_id is None:
        locked.warehouse_id = intake.warehouse_id

    _record_event(
        db, locked,
        ContainerEventType.MOVED.value if moved else ContainerEventType.RECEIVED.value,
        from_status=previous_status,
        to_status=ContainerStatus.RECEIVED.value,
        actor_id=str(current_user.id),
        from_row_id=previous_row,
        to_row_id=row.id,
        ref_type="intake", ref_id=intake.id,
        idempotency_key=idempotency_key,
    )

    _refresh_received_count(db, intake)
    db.flush()

    warning = _row_capacity_warning(db, row)
    return _scan_payload(
        db, intake, locked,
        status="moved" if moved else "ok",
        message=f"{'Moved to' if moved else 'Received @'} {row.name}",
        warning=warning[0] if warning else None,
        warning_detail=warning[1] if warning else None,
    )


def _refresh_received_count(db: Session, intake: IngredientIntake) -> int:
    count = (
        db.query(func.count(Container.id))
        .filter(
            Container.intake_id == intake.id,
            Container.is_deleted == False,  # noqa: E712
            Container.status != ContainerStatus.PRINTED_UNAPPLIED.value,
            Container.status != ContainerStatus.VOIDED.value,
        )
        .scalar()
        or 0
    )
    intake.received_count = count
    # I-3: more drums arrived than the paperwork said. Allowed and flagged, not
    # blocked — the truck is already unloaded either way.
    if intake.expected_count and count > intake.expected_count:
        intake.over_received = True
    return count


def _scan_payload(
    db: Session,
    intake: IngredientIntake,
    container: Optional[Container],
    *,
    status: str,
    message: str,
    warning: Optional[str] = None,
    warning_detail: Optional[str] = None,
) -> dict:
    row_count = 0
    if container is not None and container.storage_row_id:
        row_count = (
            db.query(func.count(Container.id))
            .filter(
                Container.intake_id == intake.id,
                Container.storage_row_id == container.storage_row_id,
                Container.is_deleted == False,  # noqa: E712
                Container.status != ContainerStatus.PRINTED_UNAPPLIED.value,
            )
            .scalar()
            or 0
        )
    intake_count = (
        db.query(func.count(Container.id))
        .filter(
            Container.intake_id == intake.id,
            Container.is_deleted == False,  # noqa: E712
            Container.status != ContainerStatus.PRINTED_UNAPPLIED.value,
            Container.status != ContainerStatus.VOIDED.value,
        )
        .scalar()
        or 0
    )
    return {
        "status": status,
        "message": message,
        "container": container,
        "row_scanned_count": row_count,
        "intake_scanned_count": intake_count,
        "intake_expected_count": intake.expected_count or 0,
        "count_unit": _intake_count_unit(intake),
        "warning": warning,
        "warning_detail": warning_detail,
    }


# ─── lifecycle ────────────────────────────────────────────────────────────────

def close_short(db: Session, intake: IngredientIntake, reason: str, current_user) -> IngredientIntake:
    """Record that fewer drums arrived than the paperwork claimed.

    Unapplied serials are LEFT unapplied rather than burned (I-2): drums found
    in the trailer corner the next day scan normally and the short count
    corrects itself. Received-short never destroys identity.
    """
    if not reason or not reason.strip():
        raise ValidationError("A short receipt needs a reason")
    received = _refresh_received_count(db, intake)
    intake.short_count = max(0, (intake.expected_count or 0) - received)
    intake.short_reason = reason.strip()
    db.flush()
    return intake


def submit_intake(db: Session, intake: IngredientIntake, current_user) -> IngredientIntake:
    if intake.status != IntakeStatus.RECORDED.value:
        raise ValidationError(f"Intake is {intake.status} and cannot be submitted")
    _refresh_received_count(db, intake)
    intake.status = IntakeStatus.SUBMITTED.value
    intake.submitted_at = datetime.now(timezone.utc)
    intake.submitted_by = str(current_user.id)
    db.flush()
    return intake


def approve_intake(db: Session, intake: IngredientIntake, current_user) -> IngredientIntake:
    """One gate, not two (IMPL-COMMENT 13).

    Approving the intake puts its containers in stock directly. No legacy
    Receipt is created, so there is no second approval behind this one — the
    same shape as approve_forklift_request, where the session gate replaces the
    receipt gate (scanner_service.py:1067).
    """
    if intake.status != IntakeStatus.SUBMITTED.value:
        raise ValidationError(f"Intake is {intake.status} and cannot be approved")

    # Role + warehouse scope. Deliberately NOT supervisor-only: the gate this
    # mirrors admits warehouse users too and blocks self-approval per action
    # (scanner_service.py:214-221, :939-943). Supervisor-only here would be
    # stricter than every sibling flow.
    require_approval_access(current_user, intake)
    if current_user.role == ROLE_WAREHOUSE and intake.submitted_by == str(current_user.id):
        raise ForbiddenError("You cannot approve an intake you submitted")

    containers = (
        _active_containers(db, intake_id=intake.id)
        .filter(Container.status == ContainerStatus.RECEIVED.value)
        .all()
    )
    for container in containers:
        locked = _lock_container(db, container.id)
        if not locked or locked.status != ContainerStatus.RECEIVED.value:
            continue
        previous = locked.status
        locked.status = ContainerStatus.IN_STOCK.value
        _record_event(
            db, locked, ContainerEventType.APPROVED.value,
            from_status=previous,
            to_status=ContainerStatus.IN_STOCK.value,
            actor_id=str(current_user.id),
            ref_type="intake", ref_id=intake.id,
        )

    intake.status = IntakeStatus.APPROVED.value
    intake.approved_by = str(current_user.id)
    intake.approved_at = datetime.now(timezone.utc)
    db.flush()
    return intake


def reject_intake(
    db: Session, intake: IngredientIntake, reason: str, disposition: str, current_user
) -> IngredientIntake:
    """Reject with a REQUIRED disposition (§18.2 R-9).

    Scanned drums must never silently vanish. Either the data gets fixed and the
    intake comes back, or the material physically goes back to the vendor — and
    the containers follow whichever was chosen.
    """
    if intake.status != IntakeStatus.SUBMITTED.value:
        raise ValidationError(f"Intake is {intake.status} and cannot be rejected")
    require_approval_access(current_user, intake)
    if not reason or not reason.strip():
        raise ValidationError("A rejection needs a reason")
    if disposition not in ("fix_and_resubmit", "return_to_vendor"):
        raise ValidationError(
            "A rejection needs a disposition: fix_and_resubmit or return_to_vendor"
        )

    if disposition == "return_to_vendor":
        for container in _active_containers(db, intake_id=intake.id).all():
            locked = _lock_container(db, container.id)
            if not locked:
                continue
            previous = locked.status
            locked.status = ContainerStatus.RETURNED_TO_VENDOR.value
            _record_event(
                db, locked, ContainerEventType.RETURNED_TO_VENDOR.value,
                from_status=previous,
                to_status=ContainerStatus.RETURNED_TO_VENDOR.value,
                actor_id=str(current_user.id),
                reason=reason.strip(),
                ref_type="intake", ref_id=intake.id,
            )
        intake.status = IntakeStatus.REJECTED.value
    else:
        # Containers stay exactly as they are; the intake reopens for correction.
        intake.status = IntakeStatus.RECORDED.value

    intake.rejected_by_id = str(current_user.id)
    intake.rejected_at = datetime.now(timezone.utc)
    intake.rejection_reason = reason.strip()
    intake.rejection_disposition = disposition
    db.flush()
    return intake


def void_intake(db: Session, intake: IngredientIntake, reason: str, current_user) -> IngredientIntake:
    """Void a duplicate or wrong-product intake (I-5, I-6, I-10).

    Serials are BURNED, never reused: every container goes to `voided`, and a
    later scan of that sticker is rejected rather than quietly succeeding. A
    zero-scan intake is free to void; one with scans requires an approval role
    and a reason.
    """
    if intake.status in (IntakeStatus.VOIDED.value,):
        raise ValidationError("Intake is already voided")
    if not reason or not reason.strip():
        raise ValidationError("Voiding an intake needs a reason")

    scanned = (
        _active_containers(db, intake_id=intake.id)
        .filter(Container.status != ContainerStatus.PRINTED_UNAPPLIED.value)
        .count()
    )
    if scanned and current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError(
            "This intake already has scanned drums — a supervisor must void it"
        )

    for container in _active_containers(db, intake_id=intake.id).all():
        locked = _lock_container(db, container.id)
        if not locked:
            continue
        previous = locked.status
        locked.status = ContainerStatus.VOIDED.value
        _record_event(
            db, locked, ContainerEventType.VOIDED.value,
            from_status=previous,
            to_status=ContainerStatus.VOIDED.value,
            actor_id=str(current_user.id),
            reason=reason.strip(),
            ref_type="intake", ref_id=intake.id,
        )

    intake.status = IntakeStatus.VOIDED.value
    intake.voided_by_id = str(current_user.id)
    intake.voided_at = datetime.now(timezone.utc)
    intake.void_reason = reason.strip()
    db.flush()
    return intake


# ─── cache vs ledger reconciliation (§6.1 / §19.3) ────────────────────────────

def cache_drift(db: Session, limit: int = 500) -> dict:
    """Compare each container's stored state against its own latest event.

    This is a reconciliation between two independently-written records, not a
    recompute — the container row is authoritative (IMPL-COMMENT 1). A non-empty
    result means a bug in a write path, not routine drift, so nothing here
    auto-heals.
    """
    latest = text(
        """
        SELECT DISTINCT ON (ce.container_id)
               ce.container_id, ce.to_status, ce.to_row_id, ce.seq
        FROM container_events ce
        ORDER BY ce.container_id, ce.seq DESC
        """
    )
    ledger = {
        r[0]: {"status": r[1], "row_id": r[2], "seq": r[3]}
        for r in db.execute(latest).fetchall()
    }

    rows = []
    checked = 0
    for container in _active_containers(db).all():
        checked += 1
        entry = ledger.get(container.id)
        if not entry:
            continue
        # A `moved` event leaves status unchanged, and a relabel leaves both
        # unchanged, so only a genuine disagreement counts.
        if (
            entry["status"] == container.status
            and entry["row_id"] == container.storage_row_id
        ):
            continue
        rows.append(
            {
                "container_id": container.id,
                "serial": container.serial,
                "cached_status": container.status,
                "ledger_status": entry["status"],
                "cached_row_id": container.storage_row_id,
                "ledger_row_id": entry["row_id"],
                "last_event_seq": entry["seq"],
            }
        )

    truncated = len(rows) > limit
    return {
        "checked": checked,
        "drifted": len(rows),
        "rows": rows[:limit],
        "truncated": truncated,
    }
