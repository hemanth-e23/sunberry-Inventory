"""Serialized-container staging: line claims, FEFO, pulls and returns.

Phase 3 of INGREDIENT-SERIALIZATION-SPEC.md (§11). Does NOT commit; the router
owns the transaction boundary.

This module deliberately diverges from the existing RM staging path in four
ways. Each divergence is a bug being closed, not a preference:

1. IT NEVER CALLS `_stage_free_rack`. That helper (staging_service.py:36-63)
   frees rack occupancy by spreading a quantity proportionally across every
   allocation row — the auto-spread §6.4 bans. Container staging moves specific
   drums off specific rows, so there is nothing to apportion.

2. RETURNS REQUIRE A DESTINATION ROW SCAN. The path the UI uses today
   (staging_request_service.py:482-483) sets receipt.location_id and never
   touches rows, so occupancy freed at pull time is never re-credited — every
   staging round permanently under-counts the rack. Here a return is not
   complete until a row is scanned.

3. IT CREATES NO `StagingItem` ROWS. StagingItem feeds sync_production_usage,
   which writes an auto-approved adjustment and decrements receipt.quantity.
   A serialized container is decremented by its own consume event, so creating
   both would deduct the same material twice (§19.8).

4. FEFO IS ADVISORY. Off-list pulls are allowed with a reason, over-pull is
   allowed and recorded. Same philosophy as ship-out soft totals: the physical
   world wins, and a gate that stops a running batch over a bookkeeping number
   costs more than the number is worth.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from app.enums import ContainerEventType, ContainerStatus
from app.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.models import (
    Container,
    StagingLineContainer,
    StagingRequest,
    StagingRequestItem,
    StorageRow,
)
from app.services.ingredient_intake_service import (
    _active_containers,
    _lock_container,
    _record_event,
    container_count_unit,
)

# A drum may be pulled to staging from these states only.
_STAGEABLE = (
    ContainerStatus.IN_STOCK.value,
    ContainerStatus.OPENED.value,
)


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _get_line(db: Session, item_id: str) -> StagingRequestItem:
    line = db.query(StagingRequestItem).filter(StagingRequestItem.id == item_id).first()
    if not line:
        raise NotFoundError("Staging line", item_id)
    return line


# ─── claims (§11.2, §18.4 S-1) ────────────────────────────────────────────────

def claim_line(db: Session, item_id: str, current_user) -> StagingRequestItem:
    """Claim a staging line for this worker.

    Atomic: a conditional UPDATE with a rowcount check, not read-then-write.
    There was no claim pattern in this codebase to copy — the nearest analogue
    (scanner_service.py:199-211) reads then writes, which lets two workers both
    observe "unclaimed" and both proceed. The loser here gets a clear message
    naming who holds it.
    """
    result = db.execute(
        update(StagingRequestItem)
        .where(
            StagingRequestItem.id == item_id,
            StagingRequestItem.claimed_by.is_(None),
        )
        .values(claimed_by=str(current_user.id), claimed_at=datetime.now(timezone.utc))
    )

    line = _get_line(db, item_id)
    if result.rowcount == 0:
        if line.claimed_by == str(current_user.id):
            return line  # idempotent re-claim by the same person
        holder = line.claimer.name if line.claimer else line.claimed_by
        raise ConflictError(f"Already claimed by {holder}")
    db.flush()
    return line


def unclaim_line(db: Session, item_id: str, current_user, *, force: bool = False) -> StagingRequestItem:
    """Release a claim.

    Scans already made keep their attribution — releasing a claim does not undo
    work (§18.4 S-2). `force` is for a supervisor reassigning an absent worker's
    line.
    """
    line = _get_line(db, item_id)
    if line.claimed_by and line.claimed_by != str(current_user.id) and not force:
        holder = line.claimer.name if line.claimer else line.claimed_by
        raise ForbiddenError(f"This line is claimed by {holder}")
    line.claimed_by = None
    line.claimed_at = None
    db.flush()
    return line


# ─── FEFO suggestions (§11.4) ─────────────────────────────────────────────────

def fefo_suggestions(
    db: Session,
    product_id: str,
    *,
    warehouse_id: Optional[str] = None,
    limit: int = 50,
) -> List[Container]:
    """Advisory pull list, first-expiry-first-out.

    Ordered by BBD rather than received date, deliberately: legacy drums swept
    in during cutover have an unknown received date (§15.4 refuses to fabricate
    one) but always have a BBD, so BBD is the only key that sorts the whole
    population. NULL BBD sorts last rather than first — an unknown date is not
    an urgent one.

    OPENED containers come FIRST, ahead of BBD order: a part-used drum should be
    finished before a sealed one is broken into (§18.4 S-8), and use-it-up beats
    FEFO when both apply.
    """
    q = (
        _active_containers(db, product_id=product_id)
        .filter(
            Container.status.in_(_STAGEABLE),
            Container.is_held == False,  # noqa: E712
        )
    )
    if warehouse_id:
        q = q.filter(Container.warehouse_id == warehouse_id)

    return (
        q.order_by(
            (Container.status != ContainerStatus.OPENED.value),
            Container.bbd.asc().nullslast(),
            Container.serial,
        )
        .limit(limit)
        .all()
    )


# ─── pulling (§11.3, §11.5) ───────────────────────────────────────────────────

def stage_container(
    db: Session,
    item_id: str,
    serial: str,
    current_user,
    *,
    staging_row_id: Optional[str] = None,
    off_list_reason: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Pull one drum against one staging line.

    Every scan records who and when, so "who staged it" falls out of the events
    rather than needing a form field (§11.3).

    Blocks only what corrupts data: a held drum (checked at EVERY scan, so a
    hold placed mid-pull takes effect immediately — §18.4 S-3), the wrong
    product, or a drum that is not in stock. Over-pull is allowed and recorded.
    """
    line = _get_line(db, item_id)

    if idempotency_key:
        prior = (
            db.query(StagingLineContainer)
            .join(Container, StagingLineContainer.container_id == Container.id)
            .filter(
                StagingLineContainer.request_item_id == item_id,
                Container.serial == serial,
                StagingLineContainer.status == "staged",
            )
            .first()
        )
        if prior:
            return _line_payload(db, line, status="already_staged",
                                 message=f"{serial} is already on this line")

    container = _active_containers(db).filter(Container.serial == serial).first()
    if not container:
        raise NotFoundError("Container", serial)

    locked = _lock_container(db, container.id)
    if not locked:
        raise NotFoundError("Container", serial)

    # Re-checked on every scan, not just when the pull list was built.
    if locked.is_held:
        raise ConflictError(
            f"{serial} is on hold{': ' + locked.hold_reason if locked.hold_reason else ''}"
        )
    if line.product_id and locked.product_id != line.product_id:
        raise ValidationError(
            f"{serial} is not the product this line needs"
        )
    if locked.status not in _STAGEABLE:
        raise ConflictError(f"{serial} is {locked.status} and cannot be staged")

    previous_status = locked.status
    previous_row = locked.storage_row_id

    # Staging MOVES the drum to a staging row, which frees the rack — the same
    # intent as the RM path, but by moving a specific drum rather than
    # apportioning a quantity across rows.
    if staging_row_id:
        row = (
            db.query(StorageRow)
            .filter(StorageRow.id == staging_row_id, StorageRow.is_active == True)  # noqa: E712
            .first()
        )
        if not row:
            raise NotFoundError("Storage row", staging_row_id)
        locked.storage_row_id = row.id

    locked.status = ContainerStatus.STAGED.value
    locked.staged_for_request_id = line.request_id
    locked.scanned_by = str(current_user.id)
    locked.scanned_at = datetime.now(timezone.utc)

    _record_event(
        db, locked, ContainerEventType.STAGED.value,
        from_status=previous_status, to_status=ContainerStatus.STAGED.value,
        actor_id=str(current_user.id),
        from_row_id=previous_row, to_row_id=locked.storage_row_id,
        ref_type="staging_line", ref_id=line.id,
        reason=off_list_reason,
        idempotency_key=idempotency_key,
    )

    db.add(StagingLineContainer(
        id=_mint_id("slc"),
        request_item_id=line.id,
        container_id=locked.id,
        serial=locked.serial,
        qty_pulled=locked.remaining_qty,
        qty_unit=locked.qty_unit,
        status="staged",
        off_list=bool(off_list_reason),
        off_list_reason=off_list_reason,
        scanned_by=str(current_user.id),
        scanned_at=datetime.now(timezone.utc),
    ))

    # Flush BEFORE recomputing: _recompute_line derives the line total by
    # querying the child rows, and a pending-but-unflushed insert is invisible
    # to that query — which silently leaves every line one pull behind.
    db.flush()
    _recompute_line(db, line)
    db.flush()
    return _line_payload(db, line, status="ok", message=f"{serial} staged")


def return_container(
    db: Session,
    item_id: str,
    serial: str,
    to_row_id: str,
    current_user,
    *,
    reason: Optional[str] = None,
) -> dict:
    """Return a staged drum to stock. The destination row scan is REQUIRED.

    This is the bug being closed: the live return path never re-credits the rack
    the pull freed, so occupancy drifts down forever. Without a scanned
    destination there is no row to credit, so there is no return.
    """
    if not to_row_id:
        raise ValidationError("Scan the row you are putting it back into")

    line = _get_line(db, item_id)
    row = (
        db.query(StorageRow)
        .filter(StorageRow.id == to_row_id, StorageRow.is_active == True)  # noqa: E712
        .first()
    )
    if not row:
        raise NotFoundError("Storage row", to_row_id)

    entry = (
        db.query(StagingLineContainer)
        .filter(
            StagingLineContainer.request_item_id == item_id,
            StagingLineContainer.serial == serial,
            StagingLineContainer.status == "staged",
        )
        .first()
    )
    if not entry:
        raise NotFoundError("Staged container on this line", serial)

    locked = _lock_container(db, entry.container_id)
    if not locked:
        raise NotFoundError("Container", serial)

    previous_status = locked.status
    previous_row = locked.storage_row_id

    # An opened drum returns as opened, not as a sealed one.
    locked.status = (
        ContainerStatus.OPENED.value
        if locked.opened_at is not None
        else ContainerStatus.IN_STOCK.value
    )
    locked.storage_row_id = row.id
    locked.staged_for_request_id = None
    locked.scanned_by = str(current_user.id)
    locked.scanned_at = datetime.now(timezone.utc)

    _record_event(
        db, locked, ContainerEventType.STAGING_RETURNED.value,
        from_status=previous_status, to_status=locked.status,
        actor_id=str(current_user.id),
        from_row_id=previous_row, to_row_id=row.id,
        ref_type="staging_line", ref_id=line.id,
        reason=reason,
    )

    entry.status = "returned"
    entry.returned_to_row_id = row.id
    entry.returned_at = datetime.now(timezone.utc)
    entry.returned_by = str(current_user.id)

    # Same reason as in stage_container: the status change above must be
    # visible to the recompute query, or the returned drum still counts.
    db.flush()
    _recompute_line(db, line)
    db.flush()
    return _line_payload(db, line, status="ok", message=f"{serial} returned to {row.name}")


# ─── line state ───────────────────────────────────────────────────────────────

def _recompute_line(db: Session, line: StagingRequestItem) -> None:
    """Recompute fulfilled quantity from the containers actually on the line.

    Derived from the child rows on every change rather than incremented, so a
    return cannot leave the line's total drifting above reality.
    """
    rows = (
        db.query(StagingLineContainer)
        .filter(
            StagingLineContainer.request_item_id == line.id,
            StagingLineContainer.status == "staged",
        )
        .all()
    )
    line.quantity_fulfilled = sum((r.qty_pulled or 0) for r in rows)

    needed = line.quantity_needed or 0
    if not rows:
        line.status = "pending"
    elif needed and line.quantity_fulfilled >= needed:
        # Over-pull lands here too — allowed and recorded, never blocked.
        line.status = "fulfilled"
    else:
        line.status = "partially_fulfilled"


def _line_payload(db: Session, line: StagingRequestItem, *, status: str, message: str) -> dict:
    rows = (
        db.query(StagingLineContainer)
        .filter(
            StagingLineContainer.request_item_id == line.id,
            StagingLineContainer.status == "staged",
        )
        .all()
    )
    ctype = None
    if rows:
        first = (
            db.query(Container)
            .filter(
                Container.id == rows[0].container_id,
                Container.is_deleted == False,  # noqa: E712
            )
            .first()
        )
        ctype = first.container_type if first else None

    needed = line.quantity_needed or 0
    pulled = line.quantity_fulfilled or 0
    return {
        "status": status,
        "message": message,
        "line_id": line.id,
        "line_status": line.status,
        "quantity_needed": needed,
        "quantity_fulfilled": pulled,
        # Product-level remaining, floored at zero — never a negative that a UI
        # would render as a stuck counter.
        "remaining": max(0.0, needed - pulled),
        "over_pulled": max(0.0, pulled - needed) if needed else 0.0,
        "container_count": len(rows),
        "count_unit": container_count_unit(ctype, len(rows)),
        "serials": [r.serial for r in rows],
        "claimed_by": line.claimed_by,
    }


def line_detail(db: Session, item_id: str) -> dict:
    line = _get_line(db, item_id)
    return _line_payload(db, line, status="ok", message="")
