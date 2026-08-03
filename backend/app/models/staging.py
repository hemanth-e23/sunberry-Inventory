from sqlalchemy import Column, Integer, String, Boolean, DateTime, Date, Text, ForeignKey, Float
from sqlalchemy.orm import backref, relationship
from sqlalchemy.sql import func
from app.database import Base


class StagingRequest(Base):
    """
    A request from the Production system to stage materials for a batch.
    Created automatically when QA creates a batch in Production.
    """
    __tablename__ = "staging_requests"

    id = Column(String(50), primary_key=True)
    production_batch_uid = Column(String(500), nullable=False, index=True)
    product_name = Column(String(200), nullable=True)
    formula_name = Column(String(200), nullable=True)
    number_of_batches = Column(Integer, default=1)
    status = Column(String(20), default="pending")
    production_date = Column(Date, nullable=True)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True)

    items = relationship("StagingRequestItem", backref="request", cascade="all, delete-orphan")


class StagingRequestItem(Base):
    """One line-item inside a staging request (one ingredient needed)."""
    __tablename__ = "staging_request_items"

    id = Column(String(50), primary_key=True)
    request_id = Column(String(50), ForeignKey("staging_requests.id"), nullable=False, index=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=True)
    sid = Column(String(50), nullable=True)
    ingredient_name = Column(String(200), nullable=False)
    quantity_needed = Column(Float, nullable=False)
    quantity_fulfilled = Column(Float, default=0)
    unit = Column(String(20), nullable=True)
    status = Column(String(20), default="pending")
    # Legacy: a Text blob of StagingItem ids, for NON-serialized lines only.
    # Serialized ingredient lines record their pull in staging_line_containers
    # below and create no StagingItem rows at all — see that class's docstring.
    staging_item_ids = Column(Text, nullable=True)

    # Line-level claim, so three workers can split one request (barrels / dry
    # goods / packaging) without double-pulling. Claimed atomically:
    #   UPDATE ... SET claimed_by = :me WHERE id = :id AND claimed_by IS NULL
    # checking rowcount. There was no prior claim pattern in this codebase to
    # copy — the nearest analogue (scanner_service.py:199-211) is read-then-write
    # and would let both workers win.
    claimed_by = Column(String(50), ForeignKey("users.id"), nullable=True, index=True)
    claimed_at = Column(DateTime(timezone=True), nullable=True)

    product = relationship("Product")
    claimer = relationship("User", foreign_keys=[claimed_by])


class StagingLineContainer(Base):
    """One serialized container pulled against one staging line.

    Replaces the `staging_item_ids` Text blob for serialized ingredients: a
    comma-joined string cannot be joined, filtered, or counted, and it is how
    "which drum went to which batch" became unanswerable.

    Serialized lines deliberately create NO `StagingItem` rows. `StagingItem`
    feeds sync_production_usage, which writes an auto-approved adjustment and
    decrements receipt.quantity (staging_request_service.py:767, 904, 912-913).
    A serialized container is already decremented by its own consume event, so
    creating both would deduct the same material twice — see spec §19.8.
    """

    __tablename__ = "staging_line_containers"

    id = Column(String(50), primary_key=True)
    request_item_id = Column(
        String(50), ForeignKey("staging_request_items.id"), nullable=False, index=True
    )
    container_id = Column(String(50), ForeignKey("containers.id"), nullable=False, index=True)
    # Denormalized so the pull list still reads correctly if a container row is
    # ever archived, and so the line renders without a join.
    serial = Column(String(100), nullable=False, index=True)

    qty_pulled = Column(Float, nullable=True)
    qty_unit = Column(String(20), nullable=True)

    # 'staged' -> 'returned'. Returns require scanning a destination row, so the
    # rack that was freed at pull time is actually re-credited — the live path
    # today (staging_request_service.py:482-483) never re-credits it.
    status = Column(String(20), default="staged", nullable=False)
    returned_to_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    returned_at = Column(DateTime(timezone=True), nullable=True)
    returned_by = Column(String(50), ForeignKey("users.id"), nullable=True)

    # False when the worker pulled something the FEFO list did not suggest.
    # Allowed — the list is advisory — but recorded with a reason.
    off_list = Column(Boolean, nullable=False, default=False, server_default="false")
    off_list_reason = Column(Text, nullable=True)

    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    request_item = relationship(
        "StagingRequestItem",
        backref=backref("containers", cascade="all, delete-orphan"),
    )
    container = relationship("Container", backref="staging_lines")
    scanner = relationship("User", foreign_keys=[scanned_by])
    returner = relationship("User", foreign_keys=[returned_by])
    returned_row = relationship("StorageRow", foreign_keys=[returned_to_row_id])
