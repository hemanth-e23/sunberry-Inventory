"""Lot-level identity and unit-count placement for raw material.

Replaces the per-drum serialization model. The unit of identity is the LOT, not
the individual drum or bag:

    lot = product + vendor + vendor's lot number + BBD

Every drum or bag of a lot wears an IDENTICAL sticker carrying one QR. Items
within a lot are fungible, because they physically are — and that fungibility is
the point. Per-drum serials were tried and rejected: at month end a physical
count that disagrees by one drum forces the question "which serial do I remove?",
which has no answer when the drums are interchangeable. It also cannot survive a
third-party warehouse (they will not apply our stickers) or material redirected
between plants (a serial minted at Plant A is meaningless at Plant B).

THE COUNTING RULE, which drives every design decision below:

    Whole units are counted. Pounds are DERIVED.

Never the reverse. Different vendors ship different weights per drum, so pounds
are not a countable quantity at all — a counter in a cold room can count drums
and cannot count pounds. Today the system stores only weight
(`Receipt.quantity`) and derives drums as `quantity / weight_per_container`,
which produces answers like "98.82 drums" that nobody can act on. `lot_placements`
below is the live integer count that fixes it.
"""

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
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


class MaterialLot(Base):
    """One real-world lot. The thing a sticker identifies.

    A lot spans MANY receipts — the same vendor lot arrives on several trucks
    over months — so this cannot live on Receipt. Receipts point here.
    """

    __tablename__ = "material_lots"

    id = Column(String(50), primary_key=True)

    # THE QR PAYLOAD, and the only thing the QR carries. Short, opaque, minted
    # once, never reused. Human-readable product / vendor / lot / BBD are printed
    # as text on the sticker; the machine-readable half stays an immutable
    # pointer, so nothing on a printed label can ever go stale.
    lot_code = Column(String(30), unique=True, index=True, nullable=False)

    # Normalized natural key: {product_id}|{vendor_id}|{NORM(vendor_lot)}|{bbd_original date}.
    # A UNIQUE index on the four columns would NOT work — vendor_id and bbd are
    # nullable and Postgres treats NULLs as distinct, so the constraint would
    # silently fail to constrain. Normalization is deliberately conservative
    # (trim, collapse internal whitespace, upper) because over-normalizing merges
    # two genuinely different lots, and since every drum of a lot wears an
    # identical sticker, a wrong merge is a traceability failure a recall cannot
    # untangle afterwards.
    lot_key = Column(String(255), unique=True, index=True, nullable=False)

    product_id = Column(String(50), ForeignKey("products.id"), nullable=False, index=True)
    vendor_id = Column(String(50), ForeignKey("vendors.id"), nullable=True, index=True)
    vendor_lot_number = Column(String(100), nullable=True)
    # An unreadable drum marking is recorded as unknown and QA-flagged rather
    # than guessed at. Each such lot stays separate — never merged into one
    # giant "unknown" bucket.
    lot_unknown = Column(Boolean, nullable=False, default=False, server_default="false")

    # THE BBD SPLIT IS LOAD-BEARING.
    # `bbd_original` is part of lot_key and never changes. An approved shelf-life
    # extension moves `bbd_current` only, so the key stays stable and every
    # sticker already applied to a drum in the barn remains valid. If BBD were
    # part of the live key, one extension would invalidate the whole pile and
    # force a re-label of material that is sitting in a freezer.
    # FEFO ordering and the past-BBD block read `bbd_current`.
    bbd_original = Column(DateTime(timezone=True), nullable=True, index=True)
    bbd_current = Column(DateTime(timezone=True), nullable=True, index=True)

    # 'drum' | 'bag' | 'tote' | 'pail' … — what one counted unit IS.
    unit_label = Column(String(20), nullable=False, default="unit", server_default="unit")
    # THE single source for deriving pounds. Held once per lot so correcting a
    # mistyped 500-vs-550 fixes every derived weight in one UPDATE.
    weight_per_unit = Column(Float, nullable=True)
    weight_unit = Column(String(10), nullable=True)
    brix = Column(Float, nullable=True)

    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True, index=True)
    status = Column(String(20), nullable=False, default="active", server_default="active")

    # Set when a backfill or intake could not resolve the lot confidently — a
    # multi-receipt merge, or two receipts disagreeing on weight_per_unit.
    # NO STICKER MAY BE PRINTED for a lot with needs_review set: an identical
    # sticker applied to the wrong material is unrecoverable.
    needs_review = Column(Boolean, nullable=False, default=False, server_default="false")
    review_reason = Column(Text, nullable=True)

    first_received_at = Column(DateTime(timezone=True), nullable=True)
    last_received_at = Column(DateTime(timezone=True), nullable=True)
    label_printed_at = Column(DateTime(timezone=True), nullable=True)

    # Raw material and ingredients are held at LOT level (finished goods are held
    # per pallet). Holding the lot blocks staging and production for every unit
    # of it, wherever they sit.
    is_held = Column(Boolean, nullable=False, default=False, server_default="false")
    hold_reason = Column(Text, nullable=True)
    held_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    held_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    product = relationship("Product", backref="material_lots")
    vendor = relationship("Vendor", backref="material_lots")
    warehouse = relationship("Warehouse", backref="material_lots")
    holder = relationship("User", foreign_keys=[held_by])


class MaterialLotBbdExtension(Base):
    """A vendor extending a lot's shelf life, with its approval trail.

    A table rather than a pair of columns because a lot can be extended more than
    once, and each extension needs its own reason, document reference and
    approver. Approving one writes the new date to `MaterialLot.bbd_current`.

    Because the printed sticker and its QR both carry the ORIGINAL date, an
    approved extension is the one case where stickers must be reprinted and
    reapplied for that lot.
    """

    __tablename__ = "material_lot_bbd_extensions"

    id = Column(String(50), primary_key=True)
    material_lot_id = Column(
        String(50), ForeignKey("material_lots.id"), nullable=False, index=True
    )

    previous_bbd = Column(DateTime(timezone=True), nullable=True)
    new_bbd = Column(DateTime(timezone=True), nullable=False)
    reason = Column(Text, nullable=False)
    # COA / retest certificate reference — the evidence an auditor asks for.
    supporting_doc_ref = Column(String(200), nullable=True)

    requested_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    requested_at = Column(DateTime(timezone=True), server_default=func.now())
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(20), nullable=False, default="pending", server_default="pending")

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    material_lot = relationship(
        "MaterialLot",
        backref=backref("bbd_extensions", order_by="MaterialLotBbdExtension.requested_at"),
    )
    requester = relationship("User", foreign_keys=[requested_by])
    approver = relationship("User", foreign_keys=[approved_by])


class LotPlacement(Base):
    """How many units of a lot are in a row. The number a person counts.

    GRAIN IS (lot, row) — deliberately not (receipt, row). Per-receipt grain would
    recreate "which receipt's drums did the forklift just move?", which is the
    serial question wearing a different hat. The same lot arriving on five trucks
    is one pile on the rack, and that is how it is counted.

    WRITTEN BY EXACTLY ONE MODULE: `services/lot_placement_service.py`. Every
    mutation takes SELECT ... FOR UPDATE on the placement row, appends one
    `LotPlacementEvent`, and re-projects the legacy allocation JSON — all in the
    same transaction.
    """

    __tablename__ = "lot_placements"

    id = Column(String(50), primary_key=True)
    material_lot_id = Column(
        String(50), ForeignKey("material_lots.id"), nullable=False, index=True
    )
    storage_row_id = Column(
        String(50), ForeignKey("storage_rows.id"), nullable=False, index=True
    )
    # Denormalized from the lot so "what is in this room" is a single-table
    # group-by, mirroring how live_products is built for finished goods.
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False, index=True)
    # Denormalized because StorageRow has NO warehouse_id — warehouse lives four
    # levels up on Location, so every scoped query would otherwise need the join.
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True, index=True)

    # THE counted number: sealed, whole, untouched units.
    full_units = Column(Integer, nullable=False, default=0, server_default="0")
    # A COUNT of opened units, not a boolean — two rooms can each hold a partial
    # of the same lot, and a staging return can create another.
    open_units = Column(Integer, nullable=False, default=0, server_default="0")
    # The SUM of what remains across those open units. Deliberately not tracked
    # per drum: attributing remaining weight to one specific drum is exactly the
    # per-item identity this model exists to avoid.
    open_remaining_qty = Column(Float, nullable=False, default=0, server_default="0")

    last_counted_at = Column(DateTime(timezone=True), nullable=True)
    last_counted_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    last_movement_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        # Not cosmetic. Without it two concurrent put-aways create two rows for
        # the same (lot, row) and the count silently becomes a SUM that answers
        # the question twice.
        UniqueConstraint("material_lot_id", "storage_row_id", name="uq_lot_placement_lot_row"),
        CheckConstraint("full_units >= 0", name="ck_lot_placement_full_units_nonneg"),
        CheckConstraint("open_units >= 0", name="ck_lot_placement_open_units_nonneg"),
        CheckConstraint("open_remaining_qty >= 0", name="ck_lot_placement_open_qty_nonneg"),
        # No open units means no remaining quantity hiding in them.
        CheckConstraint(
            "open_units > 0 OR open_remaining_qty = 0",
            name="ck_lot_placement_open_qty_requires_unit",
        ),
    )

    # NOTE: no soft-delete columns, and that is deliberate. A depleted placement
    # stays at 0/0 so "this lot was in Cooler 2 last month" survives — the exact
    # inverse of row_allocation.deduct_rm_rows, which prunes entries at zero and
    # destroys that history. Reads filter on full_units + open_units > 0.

    material_lot = relationship("MaterialLot", backref="placements")
    storage_row = relationship("StorageRow", backref="lot_placements")
    product = relationship("Product", backref="lot_placements")
    counter = relationship("User", foreign_keys=[last_counted_by])


class LotPlacementEvent(Base):
    """Append-only ledger of every change to a placement.

    One event per AFFECTED PLACEMENT, so a row-to-row move writes two rows
    sharing a ref — one negative at the source, one positive at the destination.

    Reconciliation is then a plain aggregate:

        SUM(full_units_delta) GROUP BY (material_lot_id, storage_row_id)
            == lot_placements.full_units

    `seq` exists because `occurred_at` is wall-clock and two events in the same
    millisecond have no defined replay order.
    """

    __tablename__ = "lot_placement_events"

    id = Column(String(50), primary_key=True)
    seq = Column(
        BigInteger,
        Sequence("lot_placement_events_seq_seq"),
        nullable=False, unique=True, index=True,
    )

    material_lot_id = Column(
        String(50), ForeignKey("material_lots.id"), nullable=False, index=True
    )
    storage_row_id = Column(
        String(50), ForeignKey("storage_rows.id"), nullable=False, index=True
    )
    # The other end of a move. Null for receipts, counts and consumption.
    counterpart_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)

    event_type = Column(String(30), nullable=False, index=True)

    # Signed. A move is -n at the source and +n at the destination.
    full_units_delta = Column(Integer, nullable=False, default=0, server_default="0")
    open_units_delta = Column(Integer, nullable=False, default=0, server_default="0")
    qty_delta = Column(Float, nullable=False, default=0, server_default="0")

    actor_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    ref_type = Column(String(30), nullable=True)   # receipt | transfer | adjustment | staging_line | count
    ref_id = Column(String(50), nullable=True)

    reason = Column(Text, nullable=True)
    reason_code = Column(String(30), nullable=True)

    occurred_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True,
    )
    # Offline scan replay: the gun mints this, so a queued scan that syncs twice
    # is deduped server-side instead of counting a drum twice.
    idempotency_key = Column(String(64), unique=True, index=True, nullable=True)

    # No soft delete: an immutable ledger with a delete flag is a contradiction.

    material_lot = relationship("MaterialLot", backref="placement_events")
    actor = relationship("User", foreign_keys=[actor_id])
