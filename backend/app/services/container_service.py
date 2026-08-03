"""Container moves, holds, damage and disposal (SPEC §8.1, §9, §13, §14, §18.3, §18.6).

Phase 2 of INGREDIENT-SERIALIZATION-SPEC.md. Same transaction discipline as
ingredient_intake_service: this module does NOT commit, and every mutation takes
SELECT ... FOR UPDATE on the container row and writes exactly one ContainerEvent
in the same transaction.

Policy decisions worth stating, because each contradicts something a reader
might reasonably assume:

* A MOVE IS ATOMIC BY CONSTRUCTION. The floor procedure is "scan drum, scan
  destination row", but nothing is written until both are known — this endpoint
  takes them together. So an abandoned move (drum scanned, destination never
  scanned) is a genuine no-op and the drum stays put (§18.3 M-1). There is no
  half-move state to clean up.

* MOVES ARE ALLOWED IN STATES THAT BLOCK USE. A pending-approval drum can move
  (M-2) and a HELD drum can move (M-3) — a hold blocks *use*, not *relocation*,
  and quarantining held material is precisely a move. Blocking relocation would
  mean the system's location data stops matching the building, which is worse
  than the thing the block was protecting.

* HOLDS TAKE EFFECT IMMEDIATELY, with no approval step — unlike the legacy
  lot-level InventoryHoldAction, which is approval-gated (hold_service.py:120-130).
  Stated explicitly because otherwise a dual-mode lot ends up half-held-instantly
  and half-held-pending, which is the worst of both.

* THE LOT-WIDE HOLD IS SCOPED TO (product, vendor, vendor_lot) — NOT to the lot
  number alone. §4.1 is explicit that a vendor lot is an attribute and not a key
  because vendors reuse numbers; a bare lot match would let one tap hold — or
  RELEASE — unrelated material.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES
from app.enums import ContainerEventType, ContainerStatus, ContainerType, DisposalReason
from app.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.models import Container, ContainerEvent, IngredientIntake, IntakeLot, StorageRow
from app.services.ingredient_intake_service import (
    _active_containers,
    _lock_container,
    _record_event,
    _row_capacity_warning,
    container_count_unit,
)

# Statuses whose drums are physically in the building and can therefore be moved.
_MOVABLE = (
    ContainerStatus.RECEIVED.value,
    ContainerStatus.IN_STOCK.value,
    ContainerStatus.STAGED.value,
    ContainerStatus.OPENED.value,
    ContainerStatus.DAMAGED.value,
)

# Statuses that mean the drum has left inventory. Holding one is pointless and
# usually indicates the operator has the wrong serial.
_TERMINAL = (
    ContainerStatus.EMPTY.value,
    ContainerStatus.SHIPPED.value,
    ContainerStatus.DISPOSED.value,
    ContainerStatus.RETURNED_TO_VENDOR.value,
    ContainerStatus.VOIDED.value,
)


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _get_by_serial(db: Session, serial: str) -> Container:
    container = _active_containers(db).filter(Container.serial == serial).first()
    if not container:
        raise NotFoundError("Container", serial)
    return container


def _get_row(db: Session, row_id: str) -> StorageRow:
    row = (
        db.query(StorageRow)
        .filter(StorageRow.id == row_id, StorageRow.is_active == True)  # noqa: E712
        .first()
    )
    if not row:
        raise NotFoundError("Storage row", row_id)
    return row


# ─── moves (§8.1, §18.3) ──────────────────────────────────────────────────────

def move_container(
    db: Session,
    serial: str,
    to_row_id: str,
    current_user,
    *,
    reason: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Move one drum to one row. One event per drum.

    Returns a payload shaped like the receiving scan so the gun can render both
    with the same component. A full destination row produces a WARNING on an
    otherwise successful move — never a rejection (§8.1).
    """
    if idempotency_key:
        prior = (
            db.query(ContainerEvent)
            .filter(ContainerEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            container = _active_containers(db, id=prior.container_id).first()
            return _move_payload(db, container, status="already_moved",
                                 message="Already recorded (idempotent replay).")

    if not to_row_id:
        # Same rule as receiving: a destination is never guessed (§6.4/§19.2).
        raise ValidationError("Scan a destination row — a drum is never moved by guess")

    row = _get_row(db, to_row_id)
    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)

    if locked.status in _TERMINAL:
        raise ConflictError(f"{serial} is {locked.status} and is no longer in the building")
    if locked.status not in _MOVABLE:
        raise ConflictError(f"{serial} is {locked.status} and cannot be moved")

    if locked.storage_row_id == row.id:
        return _move_payload(db, locked, status="already_there",
                             message=f"{serial} is already in {row.name}")

    previous_row = locked.storage_row_id
    locked.storage_row_id = row.id
    locked.scanned_by = str(current_user.id)
    locked.scanned_at = datetime.now(timezone.utc)

    _record_event(
        db, locked, ContainerEventType.MOVED.value,
        # A move does not change status — which is exactly why a status
        # check-and-set could not serialize it, and why the row lock above is
        # the real concurrency control here.
        from_status=locked.status, to_status=locked.status,
        actor_id=str(current_user.id),
        from_row_id=previous_row, to_row_id=row.id,
        reason=reason,
        idempotency_key=idempotency_key,
    )
    db.flush()

    warning = _row_capacity_warning(db, row)
    notices = []
    if locked.is_held:
        # M-3. Allowed and logged — a hold blocks use, not relocation.
        notices.append("This drum is on hold; the hold still applies after the move.")
    if locked.status == ContainerStatus.RECEIVED.value:
        # M-2. Location must track reality even before approval.
        notices.append("This drum is still pending intake approval.")

    return _move_payload(
        db, locked, status="ok", message=f"Moved to {row.name}",
        warning=warning[0] if warning else None,
        warning_detail=warning[1] if warning else None,
        notices=notices,
    )


def move_group(
    db: Session, serials: List[str], to_row_id: str, current_user, **kwargs
) -> dict:
    """Move several drums that travelled together on the forks (§9).

    Every member is moved individually and independently — the group is a
    convenience for the operator, never an authority. Callers show the member
    list with each member uncheckable, so what arrives here is already "what is
    actually on the forks".
    """
    if not serials:
        raise ValidationError("No containers selected")

    results = []
    group_id = _mint_id("grp")
    for serial in serials:
        result = move_container(db, serial, to_row_id, current_user, **kwargs)
        results.append(result)

    # Remember the association so the NEXT move can suggest these together.
    for serial in serials:
        container = _active_containers(db).filter(Container.serial == serial).first()
        if container:
            container.pallet_group_id = group_id
    db.flush()

    return {
        "moved": len(results),
        "group_id": group_id,
        "results": results,
    }


def _move_payload(
    db: Session, container: Optional[Container], *, status: str, message: str,
    warning: Optional[str] = None, warning_detail: Optional[str] = None,
    notices: Optional[List[str]] = None,
) -> dict:
    row_count = 0
    if container is not None and container.storage_row_id:
        row_count = (
            db.query(func.count(Container.id))
            .filter(
                Container.storage_row_id == container.storage_row_id,
                Container.is_deleted == False,  # noqa: E712
                Container.status.in_(_MOVABLE),
            ).scalar() or 0
        )
    return {
        "status": status,
        "message": message,
        "container": container,
        "row_count": row_count,
        "count_unit": container_count_unit(
            container.container_type if container else None, row_count
        ),
        "warning": warning,
        "warning_detail": warning_detail,
        "notices": notices or [],
    }


# ─── holds (§14, §18.6) ───────────────────────────────────────────────────────

def set_hold(
    db: Session, serial: str, held: bool, current_user, *, reason: Optional[str] = None
) -> Container:
    """Place or release a hold on ONE container. Immediate, no approval step.

    Allowed on pending-approval containers too (§18.6 H-3): a hold is
    independent of approval state, and QA should never have to wait for a
    receiving approval to stop material.
    """
    if held and not (reason or "").strip():
        raise ValidationError("A hold needs a reason")

    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)
    if locked.status in _TERMINAL:
        raise ConflictError(
            f"{serial} is {locked.status}; holding it would have no effect"
        )
    if locked.is_held == held:
        return locked

    locked.is_held = held
    locked.hold_reason = reason.strip() if (held and reason) else None
    locked.held_by = str(current_user.id) if held else None
    locked.held_at = datetime.now(timezone.utc) if held else None

    _record_event(
        db, locked,
        ContainerEventType.HELD.value if held else ContainerEventType.RELEASED.value,
        from_status=locked.status, to_status=locked.status,
        actor_id=str(current_user.id), reason=reason,
    )
    db.flush()
    return locked


def find_lot_containers(
    db: Session,
    *,
    vendor_lot: str,
    product_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    intake_id: Optional[str] = None,
) -> List[Container]:
    """All containers matching a lot, scoped so a reused lot number cannot
    sweep in unrelated material (§4.1 — the lot is an attribute, not a key).

    Matches BOTH the container's denormalized vendor_lot and its lot line's,
    so a lot correction mid-flight cannot hide drums from a recall.
    """
    if not vendor_lot:
        raise ValidationError("A lot number is required")

    q = (
        db.query(Container)
        .join(IntakeLot, Container.intake_lot_id == IntakeLot.id)
        .join(IngredientIntake, Container.intake_id == IngredientIntake.id)
        .filter(Container.is_deleted == False)  # noqa: E712
        .filter(
            (Container.vendor_lot == vendor_lot) | (IntakeLot.vendor_lot == vendor_lot)
        )
    )
    if product_id:
        q = q.filter(Container.product_id == product_id)
    if vendor_id:
        q = q.filter(IngredientIntake.vendor_id == vendor_id)
    if intake_id:
        q = q.filter(Container.intake_id == intake_id)
    return q.order_by(Container.intake_id, Container.sequence).all()


def lot_hold_preview(db: Session, **scope) -> dict:
    """What a lot-wide hold WOULD affect, before anyone taps confirm.

    The already-consumed and already-shipped lists are not a footnote: per
    §18.6 H-1 that list IS the recall trace. A drum consumed into a batch cannot
    be held, but knowing WHICH batch it went into is the entire point of
    serializing in the first place.
    """
    containers = find_lot_containers(db, **scope)
    holdable, consumed, shipped, already_held = [], [], [], []
    for c in containers:
        if c.status == ContainerStatus.EMPTY.value:
            consumed.append(c)
        elif c.status == ContainerStatus.SHIPPED.value:
            shipped.append(c)
        elif c.status in _TERMINAL:
            continue
        elif c.is_held:
            already_held.append(c)
        else:
            holdable.append(c)

    by_intake = {}
    for c in containers:
        by_intake.setdefault(c.intake_id, []).append(c)

    return {
        "total": len(containers),
        "holdable": holdable,
        "already_held": already_held,
        "consumed": consumed,
        "shipped": shipped,
        "intake_ids": sorted(by_intake.keys()),
    }


def bulk_set_hold(
    db: Session,
    serials: List[str],
    held: bool,
    current_user,
    *,
    reason: Optional[str] = None,
) -> dict:
    """Apply a hold/release to an explicit list of serials.

    Deliberately takes SERIALS, not a lot filter: the UI resolves the lot to a
    concrete list, shows it with per-container checkboxes (§18.6 H-2 requires
    partial release anyway), and sends back exactly what the human agreed to.
    A server-side "hold everything matching this string" has no confirmation
    step and cannot express a partial.
    """
    if not serials:
        raise ValidationError("No containers selected")

    changed, skipped = [], []
    for serial in serials:
        try:
            container = set_hold(db, serial, held, current_user, reason=reason)
            changed.append(container.serial)
        except (ConflictError, NotFoundError) as exc:
            skipped.append({"serial": serial, "reason": getattr(exc, "detail", str(exc))})
    return {"changed": changed, "skipped": skipped, "held": held}


# ─── damage, disposal, exits (§13, §18.3 R-8) ─────────────────────────────────

def mark_damaged(
    db: Session,
    serial: str,
    current_user,
    *,
    reason: str,
    quarantine_row_id: Optional[str] = None,
) -> Container:
    """Flag a drum damaged, optionally moving it to quarantine in the same step.

    Available at ANY time, not just during receiving — a leak discovered the day
    after the truck left is the normal case (§18.2 R-8).
    """
    if not (reason or "").strip():
        raise ValidationError("Damage needs a reason")

    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)
    if locked.status in _TERMINAL:
        raise ConflictError(f"{serial} is {locked.status} and cannot be marked damaged")

    previous_status = locked.status
    previous_row = locked.storage_row_id
    locked.status = ContainerStatus.DAMAGED.value

    if quarantine_row_id:
        row = _get_row(db, quarantine_row_id)
        locked.storage_row_id = row.id

    _record_event(
        db, locked, ContainerEventType.DAMAGED.value,
        from_status=previous_status, to_status=ContainerStatus.DAMAGED.value,
        actor_id=str(current_user.id),
        from_row_id=previous_row,
        to_row_id=locked.storage_row_id,
        reason=reason.strip(),
    )
    db.flush()
    return locked


def dispose(
    db: Session,
    serial: str,
    current_user,
    *,
    reason_code: str,
    reason: Optional[str] = None,
) -> Container:
    """Destroy/dump a container. Supervisor-only, reason code required.

    This is the one place §13's "supervisor" is literal: disposal is the only
    exit with no physical counterparty to reconcile against, so it is the only
    one where a wrong tap is unrecoverable and invisible.
    """
    if current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError("Only supervisors and above can dispose of material")

    valid = {r.value for r in DisposalReason}
    if reason_code not in valid:
        raise ValidationError(
            f"Unknown disposal reason '{reason_code}' — expected one of {sorted(valid)}"
        )

    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)
    if locked.status in _TERMINAL:
        raise ConflictError(f"{serial} is already {locked.status}")

    previous = locked.status
    locked.status = ContainerStatus.DISPOSED.value
    locked.remaining_qty = 0

    _record_event(
        db, locked, ContainerEventType.DISPOSED.value,
        from_status=previous, to_status=ContainerStatus.DISPOSED.value,
        actor_id=str(current_user.id),
        reason=(reason or "").strip() or None,
        reason_code=reason_code,
        qty_delta=-(container.remaining_qty or 0),
    )
    db.flush()
    return locked


def mark_missing(db: Session, serial: str, current_user, *, reason: str) -> Container:
    """Flag a drum that could not be found where the system says it is (§18.4 S-4).

    Not a disposal: the drum probably exists somewhere. It leaves the available
    pool and joins the cycle-count walk list, and any later scan of it restores
    it to stock naturally.
    """
    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)
    if locked.status in _TERMINAL:
        raise ConflictError(f"{serial} is {locked.status}")

    previous = locked.status
    locked.status = ContainerStatus.MISSING.value
    _record_event(
        db, locked, ContainerEventType.COUNTED.value,
        from_status=previous, to_status=ContainerStatus.MISSING.value,
        actor_id=str(current_user.id), reason=(reason or "").strip() or None,
    )
    db.flush()
    return locked


# ─── bags: deferred serialization (§10) ───────────────────────────────────────
#
# Bags differ from barrels in WHEN the sticker goes on. All serials are printed
# at receiving, but the stack rides on the pallet unapplied: nobody labels 200
# citric-acid bags on a dock. The bags exist as a lot quantity in a row — today's
# accuracy level — until a worker pulls one for staging, peels a sticker, sticks
# it on, and scans it. That scan is the ACTIVATION, and from then on the bag is
# individually tracked.
#
# The unserialized stack's location is carried on the `printed_unapplied`
# containers themselves. That needs no extra table and no lot-level quantity
# column to drift out of sync: the count of unapplied rows IS the lot quantity,
# so the §10.3 invariant `unapplied + activated = received` holds by
# construction rather than by reconciliation.


def place_bag_lot(
    db: Session,
    intake_lot_id: str,
    storage_row_id: str,
    current_user,
    *,
    count: Optional[int] = None,
) -> dict:
    """Record where an unserialized bag stack physically sits.

    Lot-level, not per-bag: this is the receiving step for bags, and its whole
    point is that no one scans 200 individual bags at the dock.
    """
    row = _get_row(db, storage_row_id)
    q = (
        _active_containers(db, intake_lot_id=intake_lot_id)
        .filter(Container.status == ContainerStatus.PRINTED_UNAPPLIED.value)
        .order_by(Container.sequence)
    )
    pending = q.all() if count is None else q.limit(count).all()
    if not pending:
        raise ValidationError("No unapplied bags remain on this lot line")

    for container in pending:
        container.storage_row_id = row.id
        # Status deliberately unchanged: the sticker is still not on the bag, so
        # the bag is not individually identifiable yet. Only its stack's
        # location is known.
        _record_event(
            db, container, ContainerEventType.MOVED.value,
            from_status=container.status, to_status=container.status,
            actor_id=str(current_user.id),
            to_row_id=row.id,
            reason="Unserialized bag stack placed",
        )
    db.flush()
    return {
        "placed": len(pending),
        "storage_row_id": row.id,
        "storage_row_name": row.name,
        "count_unit": container_count_unit(pending[0].container_type, len(pending)),
    }


def activate_bag(
    db: Session,
    serial: str,
    current_user,
    *,
    storage_row_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Apply a sticker to a bag and bring it under individual tracking.

    The conversion is atomic by construction: one row moves from
    `printed_unapplied` to `in_stock`, so the lot quantity (count of unapplied)
    falls by exactly one as the serialized count rises by one. There is no
    second number to keep in step and therefore nothing to drift.

    §18.4 S-9 — activation is NEVER blocked because the books say the lot is
    empty. If more physical bags exist than the system believes, physical
    reality wins: the activation succeeds and the discrepancy is surfaced by
    `bag_reconciliation` instead. Blocking here would strand a worker holding a
    real bag in front of a real batch.
    """
    if idempotency_key:
        prior = (
            db.query(ContainerEvent)
            .filter(ContainerEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            container = _active_containers(db, id=prior.container_id).first()
            return {
                "status": "already_activated",
                "message": "Already recorded (idempotent replay).",
                "container": container,
            }

    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)

    if locked.status != ContainerStatus.PRINTED_UNAPPLIED.value:
        # Already activated — not an error worth stopping a worker over.
        return {
            "status": "already_activated",
            "message": f"{serial} is already tracked ({locked.status})",
            "container": locked,
        }

    if storage_row_id:
        locked.storage_row_id = _get_row(db, storage_row_id).id

    locked.status = ContainerStatus.IN_STOCK.value
    locked.scanned_by = str(current_user.id)
    locked.scanned_at = datetime.now(timezone.utc)

    _record_event(
        db, locked, ContainerEventType.RECEIVED.value,
        from_status=ContainerStatus.PRINTED_UNAPPLIED.value,
        to_status=ContainerStatus.IN_STOCK.value,
        actor_id=str(current_user.id),
        to_row_id=locked.storage_row_id,
        qty_delta=locked.remaining_qty,
        reason="Bag activated at staging (deferred serialization)",
        idempotency_key=idempotency_key,
    )
    db.flush()
    return {
        "status": "ok",
        "message": f"{serial} activated",
        "container": locked,
    }


def bag_reconciliation(
    db: Session, *, intake_id: Optional[str] = None, warehouse_id: Optional[str] = None
) -> dict:
    """§10.3's invariant, per lot line: unapplied + activated == minted.

    Because activation moves a single row between two statuses this can only
    fail if something outside the activation path created or deleted containers.
    Surfacing it costs one query and it is the only place a lost or duplicated
    sticker stack would show up.
    """
    q = (
        db.query(
            Container.intake_lot_id,
            Container.status,
            func.count(Container.id),
            Container.container_type,
        )
        .filter(
            Container.is_deleted == False,  # noqa: E712
            Container.container_type == ContainerType.BAG.value,
        )
    )
    if intake_id:
        q = q.filter(Container.intake_id == intake_id)
    if warehouse_id:
        q = q.filter(Container.warehouse_id == warehouse_id)
    q = q.group_by(Container.intake_lot_id, Container.status, Container.container_type)

    by_lot = {}
    for lot_id, status, n, ctype in q.all():
        entry = by_lot.setdefault(lot_id, {"unapplied": 0, "activated": 0, "type": ctype})
        if status == ContainerStatus.PRINTED_UNAPPLIED.value:
            entry["unapplied"] += n
        else:
            entry["activated"] += n

    rows = []
    for lot_id, entry in by_lot.items():
        lot = db.query(IntakeLot).filter(IntakeLot.id == lot_id).first()
        minted = entry["unapplied"] + entry["activated"]
        expected = int(lot.expected_count or 0) if lot else 0
        rows.append({
            "intake_lot_id": lot_id,
            "vendor_lot": lot.vendor_lot if lot else None,
            "unapplied": entry["unapplied"],
            "activated": entry["activated"],
            "minted": minted,
            "expected_count": expected,
            # Non-zero means the printed stack and the expected count disagree —
            # usually a short/over receipt that was never dispositioned.
            "variance_vs_expected": minted - expected if expected else 0,
            "count_unit": container_count_unit(entry["type"], minted),
        })

    rows.sort(key=lambda r: abs(r["variance_vs_expected"]), reverse=True)
    return {"rows": rows, "total": len(rows)}


# ─── consumption (§12.2.5, §10.5, §18.5) ──────────────────────────────────────

# States a drum can be consumed from. `staged` is the normal path; `in_stock`
# is the staging-bypass case (§18.4 S-11) — allowed with a reason and flagged
# for review, because a batch that is physically running must not be blocked by
# a paperwork step someone skipped.
_CONSUMABLE = (
    ContainerStatus.STAGED.value,
    ContainerStatus.IN_STOCK.value,
    ContainerStatus.OPENED.value,
)


def consume_container(
    db: Session,
    serial: str,
    current_user,
    *,
    batch_uid: str,
    qty_used: Optional[float] = None,
    fully_consumed: bool = True,
    bypass_reason: Optional[str] = None,
    verified: bool = True,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Consume a container into a batch.

    Whole-drum is one tap (`fully_consumed=True`). A partial enters the quantity
    used and the drum stays `opened` with a live `remaining_qty` — the normal
    state for bags, the exception for barrels.

    THE CONCURRENCY POINT IS THE ROW LOCK, not a status check-and-set: a bag
    weigh-out is opened -> opened, so both racers would match any expected
    status and the second write would silently overwrite the first
    (§18.5 P-1 and the reason IMPL-COMMENT 2 replaced CAS).

    §18.5 P-3: a weigh-out larger than `remaining_qty` is ALLOWED — the scale is
    the truth and a running batch is never blocked on a bookkeeping number. The
    remainder clamps at zero AND writes a compensating `adjusted` event carrying
    the clamped amount, so SUM(qty_delta) stays reconcilable against
    remaining_qty instead of drifting apart permanently on the flow the spec
    calls normal.
    """
    if not batch_uid:
        raise ValidationError("A consumption needs a batch reference")

    if idempotency_key:
        prior = (
            db.query(ContainerEvent)
            .filter(ContainerEvent.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            container = _active_containers(db, id=prior.container_id).first()
            return {
                "status": "already_consumed",
                "message": "Already recorded (idempotent replay).",
                "container": container,
                "qty_consumed": abs(prior.qty_delta or 0),
                "remaining_qty": container.remaining_qty if container else None,
                "over_drawn": 0.0,
            }

    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)

    # Poka-yoke checks (§12.2.4). Each has its own message: "blocked" without a
    # reason is what makes a worker call the office.
    if locked.is_held:
        raise ConflictError(
            f"{serial} is on hold{': ' + locked.hold_reason if locked.hold_reason else ''}"
        )
    if locked.status == ContainerStatus.EMPTY.value:
        raise ConflictError(f"{serial} is already empty")
    if locked.status in _TERMINAL:
        raise ConflictError(f"{serial} is {locked.status} and cannot be consumed")
    if locked.status not in _CONSUMABLE:
        raise ConflictError(f"{serial} is {locked.status} and cannot be consumed")
    if locked.bbd is not None and locked.bbd < datetime.now(timezone.utc):
        raise ConflictError(f"{serial} is past its best-before date")

    if locked.status == ContainerStatus.IN_STOCK.value and not bypass_reason:
        # S-11: valid material, but it never went through staging. Allowed with
        # a reason, recorded as a bypass for review — not silently accepted.
        raise ValidationError(
            f"{serial} was never staged for this batch — a reason is required to use it"
        )

    previous_status = locked.status
    available = locked.remaining_qty if locked.remaining_qty is not None else locked.net_weight
    available = float(available or 0)

    if fully_consumed:
        taken = available
        over_drawn = 0.0
        locked.remaining_qty = 0
        locked.status = ContainerStatus.EMPTY.value
    else:
        if qty_used is None or qty_used <= 0:
            raise ValidationError("A partial consumption needs the quantity used")
        taken = float(qty_used)
        over_drawn = max(0.0, taken - available)
        locked.remaining_qty = max(0.0, available - taken)
        if locked.opened_at is None:
            locked.opened_at = datetime.now(timezone.utc)
        locked.status = (
            ContainerStatus.EMPTY.value
            if locked.remaining_qty <= 0
            else ContainerStatus.OPENED.value
        )

    locked.consumed_by_batch_uid = batch_uid
    locked.staged_for_request_id = None

    _record_event(
        db, locked, ContainerEventType.CONSUMED.value,
        from_status=previous_status, to_status=locked.status,
        actor_id=str(current_user.id),
        qty_delta=-(taken - over_drawn),
        ref_type="batch", ref_id=batch_uid,
        reason=bypass_reason,
        verified=verified,
        idempotency_key=idempotency_key,
    )

    if over_drawn > 0:
        # The compensating entry. Without it the ledger claims more was taken
        # than the drum ever held, and the variance is invisible.
        _record_event(
            db, locked, ContainerEventType.ADJUSTED.value,
            from_status=locked.status, to_status=locked.status,
            actor_id=str(current_user.id),
            qty_delta=-over_drawn,
            ref_type="batch", ref_id=batch_uid,
            reason=f"Weigh-out exceeded recorded remaining by {over_drawn:g}",
            reason_code="over_draw",
        )

    db.flush()
    return {
        "status": "ok",
        "message": f"{serial} consumed into {batch_uid}",
        "container": locked,
        "qty_consumed": taken,
        "remaining_qty": locked.remaining_qty,
        # Surfaced so the caller can show it, and so it lands on the variance
        # report rather than being buried in the ledger.
        "over_drawn": over_drawn,
    }


def open_container(db: Session, serial: str, current_user) -> Container:
    """Mark a drum/bag opened without consuming from it yet."""
    container = _get_by_serial(db, serial)
    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)
    if locked.status not in (ContainerStatus.IN_STOCK.value, ContainerStatus.STAGED.value):
        raise ConflictError(f"{serial} is {locked.status} and cannot be opened")

    previous = locked.status
    locked.status = ContainerStatus.OPENED.value
    locked.opened_at = datetime.now(timezone.utc)
    _record_event(
        db, locked, ContainerEventType.OPENED.value,
        from_status=previous, to_status=ContainerStatus.OPENED.value,
        actor_id=str(current_user.id),
    )
    db.flush()
    return locked


def variance_report(
    db: Session, *, product_id: Optional[str] = None, warehouse_id: Optional[str] = None
) -> dict:
    """Per-container weigh-out variance (§10.5).

    Compares what the ledger says was drawn from each container against its
    stated net weight. On expensive powders this is the shrink detector; it is
    also where every over-draw from P-3 surfaces.
    """
    q = (
        db.query(
            Container,
            func.coalesce(func.sum(ContainerEvent.qty_delta), 0).label("drawn"),
        )
        .outerjoin(
            ContainerEvent,
            (ContainerEvent.container_id == Container.id)
            & (ContainerEvent.event_type.in_(
                (ContainerEventType.CONSUMED.value, ContainerEventType.ADJUSTED.value)
            )),
        )
        .filter(
            Container.is_deleted == False,  # noqa: E712
            Container.status.in_(
                (ContainerStatus.EMPTY.value, ContainerStatus.OPENED.value)
            ),
        )
        .group_by(Container.id)
    )
    if product_id:
        q = q.filter(Container.product_id == product_id)
    if warehouse_id:
        q = q.filter(Container.warehouse_id == warehouse_id)

    rows = []
    for container, drawn in q.all():
        net = float(container.net_weight or 0)
        used = abs(float(drawn or 0))
        if not net:
            continue
        variance = used - net
        rows.append({
            "serial": container.serial,
            "product_id": container.product_id,
            "vendor_lot": container.vendor_lot,
            "net_weight": net,
            "total_drawn": used,
            "remaining_qty": container.remaining_qty,
            "variance": variance,
            "variance_pct": round(variance / net * 100, 2) if net else None,
            "status": container.status,
            "qty_unit": container.qty_unit,
        })

    rows.sort(key=lambda r: abs(r["variance"]), reverse=True)
    return {"rows": rows, "total": len(rows)}


# ─── row drift report (§8.1) ──────────────────────────────────────────────────

def row_capacity_drift(db: Session, warehouse_id: Optional[str] = None) -> dict:
    """Rows holding more drums than their stated capacity.

    A row that the system believes is full but which is not physically full
    means someone moved drums without scanning. This is the weekly walk-list —
    the deliberate counterpart to capacity being a soft prompt rather than a
    block: we accept the over-fill at the point of work and surface it here
    instead of stopping a forklift mid-unload.
    """
    counts = (
        db.query(
            Container.storage_row_id,
            func.count(Container.id).label("n"),
            Container.container_type,
        )
        .filter(
            Container.is_deleted == False,  # noqa: E712
            Container.storage_row_id.isnot(None),
            Container.status.in_(_MOVABLE),
        )
    )
    if warehouse_id:
        counts = counts.filter(Container.warehouse_id == warehouse_id)
    counts = counts.group_by(Container.storage_row_id, Container.container_type).all()

    rows = []
    for row_id, n, ctype in counts:
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        if not row:
            continue
        capacity = int(row.pallet_capacity or 0)
        # capacity 0 means "no opinion", not "full" — ingredient rows are
        # created that way deliberately.
        if capacity <= 0 or n <= capacity:
            continue
        rows.append({
            "storage_row_id": row_id,
            "storage_row_name": row.name,
            "capacity": capacity,
            "occupied": n,
            "over_by": n - capacity,
            "count_unit": container_count_unit(ctype, n),
        })

    rows.sort(key=lambda r: r["over_by"], reverse=True)
    return {"rows": rows, "total": len(rows)}
