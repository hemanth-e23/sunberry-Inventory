"""Storage-row lookup, scan resolution, and barcode minting for the ingredient
receiving flow — INGREDIENT-SERIALIZATION-SPEC.md §8.3, audit B9.

Why this module exists at all, given `GET /scanner/storage-rows` already lists
rows: that endpoint is unusable for ingredients on three counts, all recorded in
IMPL-COMMENT 4.

1. It filters `pallet_capacity > 0` (`scanner_service.py:1453-1455`). Ingredient
   rows are created with capacity 0 on purpose — §8.1 makes capacity advisory,
   never a gate — so every ingredient / quarantine / staging row is invisible to
   it until an admin invents a number. This module NEVER filters on capacity.
2. It resolves the location label through `storage_area_id` only
   (`scanner_service.py:1478`), which is NULL for ingredient rows: those hang off
   `sub_location_id` instead (`frontend/src/utils/rowSources.js:18-22`). Every row
   here gets its path derived through whichever parent is populated, mirroring
   `findRowInfo`'s two-tree lookup on the server side.
3. There is no resolve step at all — the FG scanner fuzzy-matches row names in a
   client-side array (`ScannerReceiptFlow.jsx:321-332`), stripping an `FG-`
   prefix and comparing uppercased names. `storage_rows.name` carries no
   uniqueness constraint, so two barns each holding an "A-12" silently bind the
   drum to whichever one the array hit first. §18.2 R-3 blocks every drum scan
   until row resolution succeeds, so a silently-wrong row is a silently-wrong
   traceability record for the whole truck.

`resolve_row` therefore has exactly one ordering, and it is not negotiable:

    1. `storage_rows.barcode` — unique, so at most one row can match.
    2. EXACT `storage_rows.name`, scoped to the caller's warehouse.
    3. Two or more name matches -> a disambiguation ValidationError naming the
       candidates. NEVER a silent pick, never a prefix/substring match.

Warehouse scoping runs through the location, not the row: `StorageRow` has no
`warehouse_id`. Rows whose location has a NULL `warehouse_id` are NOT scope-
excluded — that mirrors `require_approval_access` (`utils/auth.py:76`), which
treats unset warehouse as drift rather than as "belongs to someone else". A row
of unknown warehouse that collides on name surfaces as a disambiguation error,
which is the correct outcome.
"""

import re
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.enums import ContainerStatus
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.models import Container, StorageArea, StorageRow, SubLocation

# Container states that mean "this drum is physically sitting in that rack right
# now". PRINTED_UNAPPLIED has no drum yet; EMPTY/SHIPPED/DISPOSED/RETURNED/VOIDED
# have left. DAMAGED counts — damaged drums live in a quarantine row and someone
# has to walk past them.
_OCCUPYING_CONTAINER_STATUSES = (
    ContainerStatus.RECEIVED.value,
    ContainerStatus.IN_STOCK.value,
    ContainerStatus.STAGED.value,
    ContainerStatus.OPENED.value,
    ContainerStatus.DAMAGED.value,
)

# Barcode minting must reproduce alembic u6v7w8x9y0z1's backfill EXACTLY, or a
# row created after that migration gets a differently-shaped code than the rack
# next to it. The SQL is:
#   LEFT(loc_name, 3) -> UPPER -> strip [^A-Z0-9]        (location prefix)
#   UPPER(row_name)   -> strip [^A-Z0-9-]                (row segment)
#   LEFT(prefix || '-' || row, 34), collisions get '-<n>' starting at 2.
# Note the truncate-to-3 happens BEFORE the strip, so a location named "A-1 Barn"
# yields "A1", not "A1B". Preserved deliberately.
_LOC_PREFIX_LEN = 3
_CODE_MAX_LEN = 34
_NON_LOC_CHARS = re.compile(r"[^A-Z0-9]")
_NON_ROW_CHARS = re.compile(r"[^A-Z0-9-]")


def _location_prefix(location_name: Optional[str]) -> str:
    return _NON_LOC_CHARS.sub("", (location_name or "").upper()[:_LOC_PREFIX_LEN])


def _row_segment(row_name: Optional[str]) -> str:
    return _NON_ROW_CHARS.sub("", (row_name or "").upper())


def _base_code(location_name: Optional[str], row_name: Optional[str]) -> Optional[str]:
    """`{LOC3}-{NAME}`, or None when either half is unusable.

    The migration skips these rows too: "BLU-" is not a label anyone can act on,
    and every unnamed row in a barn would generate the same one.
    """
    prefix = _location_prefix(location_name)
    segment = _row_segment(row_name)
    if not prefix or not segment:
        return None
    return f"{prefix}-{segment}"[:_CODE_MAX_LEN]


def _rows_query(db: Session):
    """Base query with every parent needed to derive a location path eagerly
    loaded. Both parent chains are loaded because a row may use either."""
    return (
        db.query(StorageRow)
        .options(
            joinedload(StorageRow.sub_location).joinedload(SubLocation.location),
            joinedload(StorageRow.storage_area).joinedload(StorageArea.location),
            joinedload(StorageRow.storage_area)
            .joinedload(StorageArea.sub_location)
            .joinedload(SubLocation.location),
        )
    )


def _parents(row: StorageRow):
    """(location, sub_location, storage_area) for a row, using whichever parent
    chain is populated. Server-side twin of `findRowInfo`."""
    area = row.storage_area
    sub = row.sub_location or (area.sub_location if area is not None else None)
    location = None
    if sub is not None:
        location = sub.location
    if location is None and area is not None:
        location = area.location
    return location, sub, area


def _row_payload(row: StorageRow, container_count: int = 0) -> dict:
    location, sub, area = _parents(row)
    parts = [p.name for p in (location, sub, area) if p is not None and p.name]
    return {
        "id": row.id,
        "name": row.name,
        "barcode": row.barcode,
        "location_id": location.id if location is not None else None,
        "location_name": location.name if location is not None else None,
        "sub_location_id": sub.id if sub is not None else None,
        "sub_location_name": sub.name if sub is not None else None,
        "storage_area_id": area.id if area is not None else None,
        "storage_area_name": area.name if area is not None else None,
        "warehouse_id": location.warehouse_id if location is not None else None,
        # Pre-joined path so the label sheet and the scanner banner render the
        # same string without either re-implementing the two-tree walk.
        "path": " / ".join(parts),
        # Advisory only — §8.1 and the row-capacity-is-a-soft-hint rule. Present
        # so the UI can show "12 / 20" without any caller treating it as a gate.
        "pallet_capacity": row.pallet_capacity or 0,
        "occupied_pallets": row.occupied_pallets or 0,
        "container_count": container_count,
        "is_partial_pallet_location": bool(row.is_partial_pallet_location),
        "hold": bool(row.hold),
        "is_active": row.is_active is not False,
    }


def _container_counts(db: Session, row_ids: List[str]) -> dict:
    """Drums currently in each row. `containers` inherits nothing, so the
    `is_deleted` filter is spelled out here — an omitted one is a silent leak."""
    if not row_ids:
        return {}
    rows = (
        db.query(Container.storage_row_id, func.count(Container.id))
        .filter(
            Container.is_deleted == False,  # noqa: E712 — SQL, not Python truthiness
            Container.storage_row_id.in_(row_ids),
            Container.status.in_(_OCCUPYING_CONTAINER_STATUSES),
        )
        .group_by(Container.storage_row_id)
        .all()
    )
    return {row_id: count for row_id, count in rows}


def _effective_warehouse(current_user, warehouse_id: Optional[str]) -> Optional[str]:
    """The warehouse a request is scoped to.

    A plant user's own warehouse always wins — an explicit `warehouse_id` param
    can narrow a corporate view but can never widen or redirect a plant one.
    """
    from app.utils.auth import warehouse_filter

    scoped = warehouse_filter(current_user)
    return scoped if scoped else warehouse_id


def _in_warehouse(row: StorageRow, warehouse_id: Optional[str]) -> bool:
    if not warehouse_id:
        return True
    location, _sub, _area = _parents(row)
    row_wh = location.warehouse_id if location is not None else None
    # NULL warehouse = drift, not another warehouse's row. See module docstring.
    return row_wh is None or row_wh == warehouse_id


def list_rows(
    db: Session,
    current_user,
    q: Optional[str] = None,
    location_id: Optional[str] = None,
    warehouse_id: Optional[str] = None,
) -> List[dict]:
    """Rows available for labelling / manual selection.

    No capacity filter: an ingredient row legitimately has `pallet_capacity = 0`
    and must still be listed (audit B9b).
    """
    query = _rows_query(db)
    # `is_active` is a Python-side default, so rows inserted by raw SQL can carry
    # NULL. `== True` would silently drop them; only an explicit False hides a row.
    query = query.filter(StorageRow.is_active.isnot(False))

    if q:
        needle = f"%{q.strip()}%"
        query = query.filter(
            StorageRow.name.ilike(needle) | StorageRow.barcode.ilike(needle)
        )

    rows = query.order_by(StorageRow.name).all()

    # Location and warehouse live two joins up through EITHER parent chain, so
    # they are applied in Python against the already-eager-loaded parents rather
    # than as a pair of outer-joined OR'd predicates. Row counts here are in the
    # hundreds; this is not a hot path.
    effective_wh = _effective_warehouse(current_user, warehouse_id)
    selected = []
    for row in rows:
        if not _in_warehouse(row, effective_wh):
            continue
        if location_id:
            location, _sub, _area = _parents(row)
            if location is None or location.id != location_id:
                continue
        selected.append(row)

    counts = _container_counts(db, [r.id for r in selected])
    return [_row_payload(r, counts.get(r.id, 0)) for r in selected]


def resolve_row(db: Session, current_user, code: Optional[str]) -> dict:
    """Resolve one scanned code to exactly one row. See module docstring for the
    ordering guarantee."""
    cleaned = (code or "").strip()
    if not cleaned:
        raise ValidationError("Scan a row barcode — no code was received.")

    upper = cleaned.upper()

    # ── 1. Barcode. Unique index, so this can match at most one row. Both the
    #       raw and the uppercased form are tried in one indexed IN lookup.
    candidates = {cleaned, upper}
    match = (
        _rows_query(db)
        .filter(StorageRow.barcode.in_(candidates))
        .first()
    )
    if match is not None:
        if match.is_active is False:
            raise ValidationError(
                f"Row {match.name} is deactivated — pick an active row."
            )
        counts = _container_counts(db, [match.id])
        payload = _row_payload(match, counts.get(match.id, 0))
        payload["resolved_by"] = "barcode"
        return payload

    # ── 2. Exact name, scoped to the caller's warehouse. Exact means exact:
    #       no FG- prefix stripping, no substring, no Levenshtein.
    effective_wh = _effective_warehouse(current_user, None)
    name_matches = [
        row
        for row in _rows_query(db)
        .filter(
            StorageRow.is_active.isnot(False),
            func.upper(StorageRow.name) == upper,
        )
        .all()
        if _in_warehouse(row, effective_wh)
    ]

    if len(name_matches) == 1:
        row = name_matches[0]
        counts = _container_counts(db, [row.id])
        payload = _row_payload(row, counts.get(row.id, 0))
        payload["resolved_by"] = "name"
        return payload

    # ── 3. Ambiguous. Refuse rather than guess — this is the exact defect the
    #       barcode column was added to kill.
    if len(name_matches) > 1:
        listed = ", ".join(sorted(_row_payload(r)["path"] or r.name for r in name_matches))
        raise ValidationError(
            f"\"{cleaned}\" matches {len(name_matches)} rows ({listed}). "
            "Scan the row's barcode label instead so the right rack is recorded."
        )

    raise NotFoundError("Storage row", cleaned)


def assign_barcodes(
    db: Session,
    current_user,
    row_ids: Optional[List[str]] = None,
    location_id: Optional[str] = None,
) -> dict:
    """Mint `{LOC3}-{NAME}` barcodes for rows that have none.

    An existing barcode is NEVER re-minted: a label already stuck to a rack has
    to keep resolving. Rows created after alembic u6v7w8x9y0z1 are the reason
    this exists at all.
    """
    query = _rows_query(db).filter(
        StorageRow.is_active.isnot(False),
        StorageRow.barcode.is_(None),
    )
    if row_ids:
        query = query.filter(StorageRow.id.in_(row_ids))

    effective_wh = _effective_warehouse(current_user, None)
    targets = []
    for row in query.order_by(StorageRow.id).all():
        if not _in_warehouse(row, effective_wh):
            continue
        if location_id:
            location, _sub, _area = _parents(row)
            if location is None or location.id != location_id:
                continue
        targets.append(row)

    # Every code already in use, so an ordinal suffix is picked against the whole
    # table and not just this batch.
    taken = {
        code
        for (code,) in db.query(StorageRow.barcode)
        .filter(StorageRow.barcode.isnot(None))
        .all()
        if code
    }

    assigned, skipped = [], []
    for row in targets:
        location, _sub, _area = _parents(row)
        base = _base_code(location.name if location is not None else None, row.name)
        if base is None:
            skipped.append({
                "id": row.id,
                "name": row.name,
                "reason": "Row or location name has no usable letters or digits",
            })
            continue

        code = base
        ordinal = 1
        while code in taken:
            ordinal += 1
            code = f"{base}-{ordinal}"
        taken.add(code)

        row.barcode = code
        assigned.append(_row_payload(row))

    if assigned:
        try:
            db.commit()
        except IntegrityError:
            # Two admins minting at once. The unique index caught it; say so
            # instead of surfacing a 500.
            db.rollback()
            raise ConflictError(
                "Another user assigned row barcodes at the same time. "
                "Reload the list and try again."
            )

    return {
        "assigned": assigned,
        "skipped": skipped,
        "assigned_count": len(assigned),
        "skipped_count": len(skipped),
    }
