"""Dual-mode on-hand availability: legacy ``Receipt`` quantity + live ``Container``
quantity, for one product.

WHY THIS EXISTS (audit B4). ``POST /service/check-availability`` is the only
availability gate the Production app consults before it will let QA schedule a
batch (``sunberry-production/backend/routers/batches.py:1495``). It summed
``Receipt.quantity`` and knew nothing about containers. The moment the cutover
sweep converts a drum from "1/40th of a legacy receipt" to "one serialized
Container", the receipt quantity drops but nothing replaces it, so ``on_hand``
walks toward 0 while the drums sit physically in the barn and production reports
``all_sufficient: false``. That fires on the FIRST converted lot, so the
container-aware read has to land BEFORE any conversion tooling.

THE UNIT TRAP (audit B3). For a properly-entered ingredient receipt
``Receipt.quantity`` is WEIGHT, not a container count — see
``app/routers/receipts.py:110-113``, which sets
``quantity = container_count * weight_per_container`` and ``unit = weight_unit``
whenever the container fields are supplied. A 40 x 500 lb load is stored as
``quantity=20000, unit='lbs'``, with the count kept in its own column.
``Container.remaining_qty`` / ``net_weight`` are in that container's own
``qty_unit``. So the two sides are usually both weight and DO add — but when they
disagree the sum is meaningless (20000 lbs + 40 barrels is not a quantity), and
this module raises ``ValidationError`` rather than returning a corrupt number.
Empty / NULL units are treated as compatible with anything: legacy rows predate
the container fields and a great many carry no unit at all, and refusing to
answer for those would take down the gate this module exists to protect.

THREE NUMBERS, NOT ONE. The audit's closing note on B4 is that
``check-availability`` conflates three distinct quantities. They are named
separately here rather than guessed at per caller:

* ``available_to_stage`` — what production may actually consume. Approved-only
  and unheld: legacy receipt quantity net of QA holds, plus containers in
  ``in_stock`` / ``staged`` / ``opened`` that are not held. This is the number
  the availability gate wants.
* ``physically_present`` — what is in the building, hold or no hold, approved or
  not: adds back held material and containers still in ``received`` (scanned at
  the dock, intake not yet approved). Use this to answer "but I can SEE the
  drums" questions; never to authorize consumption.
* ``financial_on_hand`` — what is owned and on the books: held material counts
  (a QA hold does not un-own it) but ``received`` does not, because an
  unapproved intake has not been booked.

BEHAVIOUR PRESERVATION. ``legacy_qty`` reproduces
``app/routers/service.py:232-255`` exactly — approved receipts, ``quantity > 0``,
``hold = True`` with no ``held_quantity`` recorded means a full-lot hold (counts
0), otherwise subtract ``held_quantity``. Two deliberate non-changes:

* no ``Receipt.is_deleted == False`` filter, because the query being replaced
  did not have one. Adding it would silently change every existing number. It is
  arguably a bug; it is not this module's bug to fix.
* a legacy-only unit disagreement (two approved receipts for one product in
  different units) does NOT raise. That data exists today and the old query
  summed it regardless; raising would turn an old silent inaccuracy into a new
  outage. It is reported in ``sources['unit_conflict']`` instead. Only a conflict
  that would newly mix container quantity into legacy quantity raises — which is
  exactly the case that cannot occur until containers exist, so this module is
  bit-for-bit behaviour-preserving on a container-free database.

Containers carry no ``category_id`` (it lives on ``IntakeLot``), so this module
filters on ``product_id`` alone and never needs a category predicate. Every
container query carries its own ``is_deleted == False``: nothing in
``app/models/ingredient.py`` inherits a soft-delete-aware base, so an omitted
filter is a silent data leak rather than an error.
"""

from typing import Iterable, Optional

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.enums import ContainerStatus, ReceiptStatus
from app.exceptions import ValidationError
from app.models import Container, Receipt

# Containers that count as usable stock. `printed_unapplied` is a sticker with
# no drum behind it; `empty`/`shipped`/`disposed`/`damaged`/`returned_to_vendor`/
# `voided`/`missing` are gone. `received` is deliberately NOT here — see
# CONTAINER_PENDING_STATUSES.
CONTAINER_ACTIVE_STATUSES = (
    ContainerStatus.IN_STOCK.value,
    ContainerStatus.STAGED.value,
    ContainerStatus.OPENED.value,
)

# Scanned at the dock, intake not yet approved. Physically in the building, not
# yet releasable to production — the whole point of the approval gate.
CONTAINER_PENDING_STATUSES = (ContainerStatus.RECEIVED.value,)

# Everything the building is holding, in any usable or pending state.
CONTAINER_PHYSICAL_STATUSES = CONTAINER_ACTIVE_STATUSES + CONTAINER_PENDING_STATUSES


def _normalize_unit(unit: Optional[str]) -> Optional[str]:
    """Case/whitespace-insensitive unit key. ``None`` for absent/blank, which
    this module treats as compatible with every other unit."""
    if unit is None:
        return None
    cleaned = unit.strip().lower()
    return cleaned or None


def _legacy_by_unit(
    db: Session, product_id: str, warehouse_id: Optional[str] = None
) -> list:
    """Per-unit legacy sums. Grouping by unit does not change the totals — the
    group sums add back up to the ungrouped sum of
    ``app/routers/service.py:232-255`` — it only lets the caller see which units
    are actually in play.

    Returns ``[(unit, net_qty, gross_qty), ...]``.
    """
    net_expr = func.coalesce(
        func.sum(
            case(
                (
                    (Receipt.hold == True)  # noqa: E712
                    & (func.coalesce(Receipt.held_quantity, 0) <= 0),
                    0,
                ),
                else_=Receipt.quantity - func.coalesce(Receipt.held_quantity, 0),
            )
        ),
        0,
    )
    gross_expr = func.coalesce(func.sum(Receipt.quantity), 0)

    q = (
        db.query(Receipt.unit, net_expr, gross_expr)
        .filter(
            Receipt.product_id == product_id,
            Receipt.status == ReceiptStatus.APPROVED,
            Receipt.quantity > 0,
        )
        .group_by(Receipt.unit)
    )
    if warehouse_id:
        q = q.filter(Receipt.warehouse_id == warehouse_id)
    return [(u, float(net or 0), float(gross or 0)) for u, net, gross in q.all()]


def _containers_by_bucket(
    db: Session,
    product_id: str,
    warehouse_id: Optional[str] = None,
    statuses: Iterable[str] = CONTAINER_PHYSICAL_STATUSES,
) -> list:
    """Per ``(status, is_held, qty_unit)`` container sums and counts.

    A sealed drum may carry ``net_weight`` with ``remaining_qty`` still NULL —
    the column is documented as the live quantity for partials — so the quantity
    expression falls back through ``net_weight`` to 0 rather than dropping the
    drum on a NULL.

    Returns ``[(status, is_held, qty_unit, qty, count), ...]``.
    """
    qty_expr = func.coalesce(
        func.sum(func.coalesce(Container.remaining_qty, Container.net_weight, 0.0)),
        0.0,
    )
    q = (
        db.query(
            Container.status,
            Container.is_held,
            Container.qty_unit,
            qty_expr,
            func.count(Container.id),
        )
        .filter(
            Container.product_id == product_id,
            Container.is_deleted == False,  # noqa: E712
            Container.status.in_(tuple(statuses)),
        )
        .group_by(Container.status, Container.is_held, Container.qty_unit)
    )
    if warehouse_id:
        q = q.filter(Container.warehouse_id == warehouse_id)
    return [
        (status, bool(is_held), qty_unit, float(qty or 0.0), int(count or 0))
        for status, is_held, qty_unit, qty, count in q.all()
    ]


def container_qty_for_product(
    db: Session,
    product_id: str,
    warehouse_id: Optional[str] = None,
    *,
    include_pending: bool = False,
    include_held: bool = False,
) -> float:
    """Just the container contribution, as a bare float.

    For read sites whose legacy semantics differ from
    ``app/routers/service.py:232-255`` (different status set, no hold handling,
    no warehouse scope). Those callers must NOT be re-based onto
    ``on_hand_for_product``'s legacy side — that would silently change their
    existing numbers — so they add this on top of the sum they already compute.

    No unit assertion: a caller with its own legacy sum already has its own unit
    story, and this function has no view of it. Use ``on_hand_for_product`` when
    you want the units checked.
    """
    statuses = list(CONTAINER_ACTIVE_STATUSES)
    if include_pending:
        statuses += list(CONTAINER_PENDING_STATUSES)

    total = 0.0
    for _status, is_held, _unit, qty, _count in _containers_by_bucket(
        db, product_id, warehouse_id, statuses
    ):
        if is_held and not include_held:
            continue
        total += qty
    return total


def _resolve_unit(
    legacy_units: dict,
    container_units: dict,
    legacy_qty: float,
    container_qty: float,
) -> tuple:
    """Pick the unit for a combined total, or raise on a genuine conflict.

    ``legacy_units`` / ``container_units`` map normalized unit -> (display unit,
    quantity). Returns ``(display_unit_or_None, legacy_only_conflict_or_None)``.

    Raises ``ValidationError`` only when the conflict involves container
    quantity, i.e. only in a situation that cannot arise before containers
    exist. See the module docstring for why a legacy-only disagreement is
    reported rather than raised.
    """
    def _declared(pool: dict) -> dict:
        """Buckets that carry quantity AND name a unit. A blank/NULL unit is
        compatible with everything, so it never participates in a conflict."""
        return {
            key: value
            for key, value in pool.items()
            if key is not None and value[1] != 0
        }

    def _names(pool: dict) -> list:
        return sorted(value[0] for value in pool.values())

    declared_containers = _declared(container_units)
    declared_legacy = _declared(legacy_units)

    if len(declared_containers) > 1:
        raise ValidationError(
            "Container quantity for this product is recorded in more than one "
            f"unit ({', '.join(_names(declared_containers))}); availability "
            "cannot be summed until the units are reconciled."
        )

    legacy_conflict = _names(declared_legacy) if len(declared_legacy) > 1 else None

    if declared_containers and declared_legacy:
        if set(declared_containers) != set(declared_legacy) or len(declared_legacy) > 1:
            raise ValidationError(
                "Cannot add container quantity to legacy receipt quantity for "
                f"this product: receipts are in {', '.join(_names(declared_legacy))} "
                f"but containers are in {', '.join(_names(declared_containers))}. "
                "For ingredient receipts Receipt.quantity is total WEIGHT, not a "
                "container count — reconcile the units before trusting availability."
            )

    # Prefer whichever side actually carries quantity; containers first, since a
    # converted product's legacy side trends to zero.
    for pool, qty in ((declared_containers, container_qty), (declared_legacy, legacy_qty)):
        if pool and qty:
            return _names(pool)[0], legacy_conflict
    for pool in (declared_containers, declared_legacy, container_units, legacy_units):
        for display, _qty in pool.values():
            if display:
                return display, legacy_conflict
    return None, legacy_conflict


def on_hand_for_product(
    db: Session,
    product_id: str,
    warehouse_id: Optional[str] = None,
    *,
    include_pending: bool = False,
) -> dict:
    """Container-aware on-hand for one product.

    ``include_pending`` additionally counts containers in ``received`` — scanned
    at the dock but with the intake not yet approved. Off by default: the
    approval gate exists precisely so unapproved material cannot be consumed.

    Returns::

        {
          "product_id", "warehouse_id",
          "legacy_qty",          # app/routers/service.py:232-255, unchanged
          "container_qty",       # unheld containers (+ pending if requested)
          "total",               # legacy_qty + container_qty
          "unit",                # agreed unit, or None when nothing declares one
          "has_containers",      # any physical container row exists at all
          "container_count",     # containers behind container_qty
          "available_to_stage",  # approved + unheld  (the availability gate)
          "physically_present",  # everything in the building, held or pending
          "financial_on_hand",   # owned and booked: held yes, pending no
          "sources": {...},      # per-bucket breakdown + unit_conflict flag
        }

    Raises ``ValidationError`` when container units and legacy units genuinely
    disagree — see the module docstring's UNIT TRAP note.
    """
    legacy_rows = _legacy_by_unit(db, product_id, warehouse_id)
    legacy_net = sum(row[1] for row in legacy_rows)
    legacy_gross = sum(row[2] for row in legacy_rows)

    legacy_units: dict = {}
    for unit, net, _gross in legacy_rows:
        key = _normalize_unit(unit)
        display, running = legacy_units.get(key, (unit, 0.0))
        legacy_units[key] = (display or unit, running + net)

    container_rows = _containers_by_bucket(db, product_id, warehouse_id)

    active_unheld = active_held = pending_unheld = pending_held = 0.0
    count_active_unheld = count_pending_unheld = count_total = 0
    counted_units: dict = {}

    for status, is_held, qty_unit, qty, count in container_rows:
        count_total += count
        is_pending = status in CONTAINER_PENDING_STATUSES
        if is_pending:
            if is_held:
                pending_held += qty
            else:
                pending_unheld += qty
                count_pending_unheld += count
        else:
            if is_held:
                active_held += qty
            else:
                active_unheld += qty
                count_active_unheld += count

        # Only the buckets that feed `container_qty` participate in the unit
        # assertion — a held or pending drum in an odd unit must not take down
        # the gate for material it is not contributing to.
        if is_held or (is_pending and not include_pending):
            continue
        key = _normalize_unit(qty_unit)
        display, running = counted_units.get(key, (qty_unit, 0.0))
        counted_units[key] = (display or qty_unit, running + qty)

    container_qty = active_unheld + (pending_unheld if include_pending else 0.0)
    container_count = count_active_unheld + (
        count_pending_unheld if include_pending else 0
    )

    unit, legacy_conflict = _resolve_unit(
        legacy_units, counted_units, legacy_net, container_qty
    )

    container_active_all = active_unheld + active_held
    container_pending_all = pending_unheld + pending_held

    return {
        "product_id": product_id,
        "warehouse_id": warehouse_id,
        "legacy_qty": legacy_net,
        "container_qty": container_qty,
        "total": legacy_net + container_qty,
        "unit": unit,
        "has_containers": count_total > 0,
        "container_count": container_count,
        "available_to_stage": legacy_net + active_unheld,
        "physically_present": legacy_gross + container_active_all + container_pending_all,
        "financial_on_hand": legacy_gross + container_active_all,
        "sources": {
            "include_pending": include_pending,
            "legacy": {
                "net": legacy_net,
                "gross": legacy_gross,
                "held": legacy_gross - legacy_net,
                "units": sorted(
                    {display for display, _qty in legacy_units.values() if display}
                ),
            },
            "containers": {
                "active_unheld": active_unheld,
                "active_held": active_held,
                "pending_unheld": pending_unheld,
                "pending_held": pending_held,
                "count_total": count_total,
                "count_active_unheld": count_active_unheld,
                "count_pending_unheld": count_pending_unheld,
                "units": sorted(
                    {
                        display
                        for _s, _h, display, _q, _c in container_rows
                        if display
                    }
                ),
            },
            "unit_conflict": legacy_conflict,
        },
    }
