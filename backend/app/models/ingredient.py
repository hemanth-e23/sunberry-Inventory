"""Ingredient container serialization — see INGREDIENT-SERIALIZATION-SPEC.md.

Four tables: an intake (one truck), its vendor-lot lines, one row per physical
barrel/bag, and an append-only event ledger.

Design notes that are NOT obvious from the column lists, each of which was a
deliberate decision recorded in the spec's IMPL-COMMENTs:

* `Container.status` is AUTHORITATIVE STATE, not a cache recomputed from
  `container_events` (IMPL-COMMENT 1). The ledger is an audit trail written in
  the same transaction, serialized by `SELECT ... FOR UPDATE` on the container
  row (IMPL-COMMENT 2) — a check-and-set on `status` gives no mutual exclusion
  for the two most common mutations, because neither changes status: a move is
  in_stock -> in_stock, and a bag weigh-out is opened -> opened.

* There is deliberately NO `idempotency_key` on `Container` (IMPL-COMMENT 8.3).
  A PalletLicence is created by the scan it dedupes, so one key protects it; a
  container is created at print time and then receives many independent scans
  (receive, move, stage, hold, consume), each replayable by the offline queue.
  One unique column can protect exactly one of them. The key lives on
  `ContainerEvent`, per event, where it actually works.

* `Container` stores `storage_row_id` ONLY — no location_id / storage_area_id
  (IMPL-COMMENT 4). StorageRow hangs off EITHER `storage_area_id` (finished
  goods) OR `sub_location_id` (raw/ingredient), so a denormalized area id would
  be NULL for every drum. The location path is derived server-side.

* `product_id` / `category_id` / `container_type` live on `IntakeLot`, not on
  `IngredientIntake` (IMPL-COMMENT 8.1): an intake is one truck under one BOL,
  and a truck can carry two materials. Putting product on the intake would have
  forced two intakes to share one BOL.

* `vendor_lot` and `bbd` are denormalized onto `Container` from its lot line.
  They are on the scan hot path (FEFO ordering, the past-BBD block, the 2D
  payload, lot-wide holds) and a two-hop join per scan is not worth it. They are
  lot-line-derived, NOT ledger-derived: a lot correction fans out an UPDATE.

Nothing is inherited from a base class — `app.database.Base` is a bare
declarative_base() with no mixins, so every column is spelled out. Consequently
EVERY read of these tables must carry its own `is_deleted == False`; an omitted
filter is a silent data leak, not an error. `ContainerEvent` has no soft delete
by design: an immutable ledger with a delete flag is a contradiction.
"""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Sequence,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import backref, relationship
from sqlalchemy.sql import func

from app.database import Base
from app.enums import ContainerStatus, IntakeSource, IntakeStatus


class IngredientIntake(Base):
    """One truck / delivery. Replaces the manual ingredient receipt form.

    Deliberately creates NO legacy `Receipt` (IMPL-COMMENT 13): dual-mode
    availability sums legacy receipt weight + live container quantity, so a
    shadow Receipt would be double-counted. Legacy receipts remain read-only
    history; new intakes contribute containers and nothing else.
    """

    __tablename__ = "ingredient_intakes"

    id = Column(String(50), primary_key=True)
    intake_number = Column(String(30), unique=True, index=True)

    vendor_id = Column(String(50), ForeignKey("vendors.id"), nullable=True)
    bol = Column(String(100))
    purchase_order = Column(String(100))
    receipt_date = Column(DateTime(timezone=True), server_default=func.now())
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True, index=True)

    status = Column(String(24), default=IntakeStatus.RECORDED.value, index=True)
    # 'legacy_sweep' intakes come from the cutover floor sweep, where the real
    # received date is unknown. We record that honestly rather than fabricating
    # one; FEFO sorts on BBD so the received date is not needed.
    source = Column(
        String(20), nullable=False,
        default=IntakeSource.TRUCK.value, server_default=IntakeSource.TRUCK.value,
    )

    expected_count = Column(Integer, default=0)
    received_count = Column(Integer, default=0)
    short_count = Column(Integer, default=0)
    short_reason = Column(Text)
    # Distinguishes "82 arrived against an expected 80" (allowed, flagged for
    # approval) from a plain miscount.
    over_received = Column(Boolean, nullable=False, default=False, server_default="false")
    over_reason = Column(Text)
    damaged_count = Column(Integer, default=0)

    # Serial sequence counter for this intake. Minted under SELECT ... FOR UPDATE
    # so concurrent mints (over-receipt top-ups, reprints, a second device) cannot
    # double-allocate. MAX(sequence)+1 would race and surface to a worker as an
    # IntegrityError. Precedent: routers/palletizer.py:189-196.
    last_serial_seq = Column(Integer, nullable=False, default=0, server_default="0")

    submitted_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    submitted_at = Column(DateTime(timezone=True), nullable=True)
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)

    rejected_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    rejected_at = Column(DateTime(timezone=True), nullable=True)
    rejection_reason = Column(Text)
    # Rejection REQUIRES a disposition so scanned drums never silently vanish:
    # 'fix_and_resubmit' (containers stay, data corrected) or 'return_to_vendor'
    # (containers -> returned_to_vendor). See spec §18.2 R-9.
    rejection_disposition = Column(String(24), nullable=True)

    voided_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    voided_at = Column(DateTime(timezone=True), nullable=True)
    void_reason = Column(Text)

    notes = Column(Text)

    # ── Incoming order (2026-08, Phase 2) ────────────────────────────────────
    # This table is REUSED as the corporate incoming order. It already had
    # everything an order needs — a vendor, a BOL, a PO, multi-product lot lines
    # with expected counts, a short count with a reason, and an approval trail —
    # so rebuilding it would have produced a second table with the same columns
    # and a second set of bugs.
    #
    # `warehouse_id` above IS the destination: corporate creates one order per
    # destination site, which is how "500 drums to the Chicago 3PL, 300 to
    # Florida, 200 to our plant" is expressed. Three orders, not one order with
    # three destinations — because each is received, shorted and closed
    # independently, and a shared header would couple them.
    #
    # `status` carries IncomingOrderStatus for these rows and IntakeStatus for
    # rows created by the old per-drum flow. The two vocabularies do not
    # overlap, so old rows keep reading correctly.
    is_incoming_order = Column(
        Boolean, nullable=False, default=False, server_default="false", index=True
    )
    # Where the material is coming FROM when it is not a vendor delivery — a 3PL
    # or another plant. Free text: third parties are not in our warehouse table
    # and inventing rows for them would be master data nobody maintains.
    origin_name = Column(String(120), nullable=True)
    # Set when corporate transfers stock between sites, so the source is a real
    # warehouse we can decrement rather than a name.
    origin_warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    expected_date = Column(DateTime(timezone=True), nullable=True, index=True)
    released_at = Column(DateTime(timezone=True), nullable=True)
    released_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    closed_at = Column(DateTime(timezone=True), nullable=True)
    closed_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    close_reason = Column(Text)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id], backref="ingredient_intakes")
    origin_warehouse = relationship("Warehouse", foreign_keys=[origin_warehouse_id])
    vendor = relationship("Vendor", backref="ingredient_intakes")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_intakes")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_intakes")


class IntakeLot(Base):
    """One vendor-lot line on the truck.

    The vendor lot is an ATTRIBUTE, never a key — vendors reuse and repeat lot
    numbers. The same vendor lot arriving on two trucks is two intakes with two
    disjoint serial ranges, both searchable under the shared lot.
    """

    __tablename__ = "intake_lots"

    id = Column(String(50), primary_key=True)
    intake_id = Column(String(50), ForeignKey("ingredient_intakes.id"), nullable=False, index=True)

    product_id = Column(String(50), ForeignKey("products.id"), nullable=False, index=True)
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    container_type = Column(String(10), nullable=False)

    vendor_lot = Column(String(100), index=True)
    # Cutover: an unreadable drum label gets lot_unknown=True, is QA-flagged and
    # used first, rather than having a lot number invented for it.
    lot_unknown = Column(Boolean, nullable=False, default=False, server_default="false")
    bbd = Column(DateTime(timezone=True), nullable=True, index=True)

    expected_count = Column(Integer, default=0)
    brix = Column(Float, nullable=True)
    net_weight_per_container = Column(Float, nullable=True)
    weight_unit = Column(String(20), nullable=True)

    # ── Incoming order line (2026-08, Phase 2) ───────────────────────────────
    # Resolved when the plant starts receiving this line, NOT when corporate
    # writes the order. Corporate types a vendor lot from paperwork; the lot only
    # becomes real identity once material is physically here, and resolving early
    # would mint lots for trucks that never arrive.
    material_lot_id = Column(
        String(50), ForeignKey("material_lots.id"), nullable=True, index=True
    )
    # The receipt this line was received onto — the receiving session. One per
    # line, created on "start receiving".
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True, index=True)
    vendor_id = Column(String(50), ForeignKey("vendors.id"), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    intake = relationship(
        "IngredientIntake",
        backref=backref("lots", order_by="IntakeLot.created_at", cascade="all, delete-orphan"),
    )
    product = relationship("Product", backref="intake_lots")
    category = relationship("Category", backref="intake_lots")
    material_lot = relationship("MaterialLot", backref="intake_lines")
    vendor = relationship("Vendor", backref="intake_lots")


class Container(Base):
    """One physical barrel or bag. Serial is never reused or reassigned."""

    __tablename__ = "containers"

    id = Column(String(50), primary_key=True)
    serial = Column(String(100), unique=True, index=True, nullable=False)
    # The label prints "17 of 80" and no code may parse a serial, so the
    # sequence has to be a real column.
    sequence = Column(Integer, nullable=False)

    intake_id = Column(String(50), ForeignKey("ingredient_intakes.id"), nullable=False, index=True)
    intake_lot_id = Column(String(50), ForeignKey("intake_lots.id"), nullable=False, index=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False, index=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True, index=True)

    container_type = Column(String(10), nullable=False)
    status = Column(String(24), default=ContainerStatus.PRINTED_UNAPPLIED.value, index=True)

    # Live quantity for partials. For a sealed drum this equals net_weight.
    remaining_qty = Column(Float, nullable=True)
    net_weight = Column(Float, nullable=True)
    qty_unit = Column(String(20), nullable=True)

    # Denormalized from the lot line — see module docstring.
    vendor_lot = Column(String(100), nullable=True, index=True)
    bbd = Column(DateTime(timezone=True), nullable=True, index=True)

    # Location is a single row reference; the path is derived. See docstring.
    storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True, index=True)

    # Emergent grouping: drums that travelled together on the forks. Advisory
    # only — the member list is always shown and always uncheckable.
    pallet_group_id = Column(String(50), nullable=True, index=True)

    is_held = Column(Boolean, default=False, nullable=False, server_default="false")
    hold_reason = Column(Text)
    held_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    held_at = Column(DateTime(timezone=True), nullable=True)

    staged_for_request_id = Column(String(50), nullable=True, index=True)
    consumed_by_batch_uid = Column(String(100), nullable=True, index=True)
    opened_at = Column(DateTime(timezone=True), nullable=True)

    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    __table_args__ = (
        UniqueConstraint("intake_id", "sequence", name="uq_container_intake_sequence"),
    )

    # Ordered by sequence so the approval card and the reprint stack always show
    # drums in the order they were minted, not Postgres storage order.
    intake = relationship(
        "IngredientIntake",
        backref=backref("containers", order_by="Container.sequence"),
    )
    intake_lot = relationship(
        "IntakeLot",
        backref=backref("containers", order_by="Container.sequence"),
    )
    product = relationship("Product", backref="containers")
    warehouse = relationship("Warehouse", backref="containers")
    storage_row = relationship("StorageRow", backref="containers")
    scanner = relationship("User", foreign_keys=[scanned_by], backref="scanned_containers")
    holder = relationship("User", foreign_keys=[held_by], backref="held_containers")


class ContainerEvent(Base):
    """Append-only audit trail. One row per state change, written in the same
    transaction as the change itself.

    `seq` exists because `occurred_at` is wall-clock and two events in the same
    millisecond have no defined replay order. The cache-vs-ledger reconciliation
    view depends on a total order:

        SELECT DISTINCT ON (container_id) container_id, to_status, to_row_id
        FROM container_events ORDER BY container_id, seq DESC
    """

    __tablename__ = "container_events"

    id = Column(String(50), primary_key=True)
    seq = Column(
        BigInteger,
        Sequence("container_events_seq_seq"),
        nullable=False, unique=True, index=True,
    )

    container_id = Column(String(50), ForeignKey("containers.id"), nullable=False, index=True)
    event_type = Column(String(30), nullable=False, index=True)

    # Recorded on every event so the ledger can be reconciled against the
    # container row without re-deriving business rules.
    from_status = Column(String(24), nullable=True)
    to_status = Column(String(24), nullable=False)

    from_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    to_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)

    # Signed. A clamped over-weigh-out writes a compensating `adjusted` event
    # carrying the clamp, so SUM(qty_delta) stays reconcilable with
    # remaining_qty instead of drifting permanently.
    qty_delta = Column(Float, nullable=True)

    actor_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    ref_type = Column(String(30), nullable=True)
    ref_id = Column(String(50), nullable=True)

    reason = Column(Text)
    reason_code = Column(String(30), nullable=True)

    # False when a production scan had to fall back to the printed label because
    # the lookup API was unreachable. Such events are quarantined and reconciled
    # on reconnect — we degrade verification, never recording.
    verified = Column(Boolean, nullable=False, default=True, server_default="true")

    occurred_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True,
    )
    idempotency_key = Column(String(64), unique=True, index=True, nullable=True)

    container = relationship(
        "Container",
        backref=backref("events", order_by="ContainerEvent.seq"),
    )
    actor = relationship("User", foreign_keys=[actor_id], backref="container_events")
