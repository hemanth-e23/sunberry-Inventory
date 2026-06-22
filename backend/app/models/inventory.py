from sqlalchemy import Column, Integer, String, Boolean, DateTime, Date, Text, ForeignKey, Float, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class InventoryTransfer(Base):
    __tablename__ = "inventory_transfers"

    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    from_location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    from_sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    to_location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    to_sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    quantity = Column(Float, nullable=False)
    unit = Column(String(20), default="cases")
    reason = Column(Text)
    transfer_type = Column(String(50), default="warehouse-transfer")
    order_number = Column(String(100), nullable=True)
    source_breakdown = Column(JSON, nullable=True)
    destination_breakdown = Column(JSON, nullable=True)
    pallet_licence_ids = Column(JSON, nullable=True)
    status = Column(String(20), default="pending")
    requested_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    forklift_submitted_at = Column(DateTime(timezone=True), nullable=True)
    forklift_notes = Column(Text, nullable=True)
    skipped_pallet_ids = Column(JSON, nullable=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    voided_at = Column(DateTime(timezone=True), nullable=True)
    voided_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    voided_reason = Column(Text, nullable=True)

    receipt = relationship("Receipt", backref="transfers")
    from_location = relationship("Location", foreign_keys=[from_location_id], backref="transfers_from")
    from_sub_location = relationship("SubLocation", foreign_keys=[from_sub_location_id], backref="transfers_from")
    to_location = relationship("Location", foreign_keys=[to_location_id], backref="transfers_to")
    to_sub_location = relationship("SubLocation", foreign_keys=[to_sub_location_id], backref="transfers_to")
    requester = relationship("User", foreign_keys=[requested_by], backref="requested_transfers")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_transfers")
    voider = relationship("User", foreign_keys=[voided_by], backref="voided_transfers")
    warehouse = relationship("Warehouse", backref="inventory_transfers")
    lines = relationship(
        "InventoryTransferLine",
        back_populates="transfer",
        cascade="all, delete-orphan",
        order_by="InventoryTransferLine.line_seq",
    )
    swaps = relationship(
        "TransferPalletSwap",
        back_populates="transfer",
        cascade="all, delete-orphan",
        order_by="TransferPalletSwap.swapped_at",
    )


class InventoryTransferLine(Base):
    """A single product/receipt line within a multi-product ship-out order."""
    __tablename__ = "inventory_transfer_lines"

    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False, index=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=False, index=True)
    cases_requested = Column(Float, nullable=False)
    cases_picked = Column(Float, nullable=False, default=0)
    pallet_licence_ids = Column(JSON, nullable=True)
    # Lot-level intent: [{lot_number, cases_requested, cases_picked}]
    lot_allocations = Column(JSON, nullable=True)
    # Actual scanned pulls: [{pallet_licence_id, cases_consumed, was_partial,
    # scanned_at, scanned_by}]. Source of truth for what shipped.
    picks = Column(JSON, nullable=True)
    # Audit of escape-hatch swaps: [{from_lot, to_lot, reason, at, by}]
    lot_swap_history = Column(JSON, nullable=True)
    line_seq = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    transfer = relationship("InventoryTransfer", back_populates="lines")
    product = relationship("Product")
    receipt = relationship("Receipt")


class ShipOutLotReservation(Base):
    """Soft capacity lock per (product_id, lot_number) for an open ship-out line.

    Prevents two concurrent ship-out plans from over-committing the same lot.
    Sum of `cases_reserved` for active rows (released_at IS NULL) on a
    (product_id, lot_number) must stay ≤ that lot's available cases.
    Released when the line is fully picked, voided, or swapped via the
    escape hatch.
    """
    __tablename__ = "ship_out_lot_reservations"

    id = Column(String(50), primary_key=True)
    transfer_line_id = Column(
        String(50),
        ForeignKey("inventory_transfer_lines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False)
    # Phase D: reservations pool at the PRODUCT level — NULL means "not pinned to
    # a lot" (the lot is chosen live at scan time). Legacy rows may still carry a
    # specific lot; the product-level sums ignore lot_number either way.
    lot_number = Column(String(100), nullable=True)
    cases_reserved = Column(Float, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    released_at = Column(DateTime(timezone=True), nullable=True)

    transfer_line = relationship("InventoryTransferLine", backref="lot_reservations")
    product = relationship("Product")


class TransferPalletSwap(Base):
    """Records a pallet swap on a ship-out (forklift on-the-fly swap or warehouse edit)."""
    __tablename__ = "transfer_pallet_swaps"

    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id", ondelete="CASCADE"), nullable=False, index=True)
    transfer_line_id = Column(String(50), ForeignKey("inventory_transfer_lines.id", ondelete="CASCADE"), nullable=True, index=True)
    removed_pallet_id = Column(String(50), ForeignKey("pallet_licences.id"), nullable=True)
    added_pallet_id = Column(String(50), ForeignKey("pallet_licences.id"), nullable=True)
    swapped_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    swapped_at = Column(DateTime(timezone=True), server_default=func.now())
    reason = Column(Text, nullable=True)
    source = Column(String(20), nullable=False, default="forklift")  # 'forklift' | 'warehouse_edit'

    transfer = relationship("InventoryTransfer", back_populates="swaps")
    line = relationship("InventoryTransferLine")
    removed_pallet = relationship("PalletLicence", foreign_keys=[removed_pallet_id])
    added_pallet = relationship("PalletLicence", foreign_keys=[added_pallet_id])
    swapper = relationship("User", foreign_keys=[swapped_by])


class InventoryAdjustment(Base):
    __tablename__ = "inventory_adjustments"

    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=True)
    adjustment_type = Column(String(50), nullable=False)
    quantity = Column(Float, nullable=False)
    # Unit of `quantity`, copied from the receipt at create time so historical
    # adjustments stay interpretable even if the receipt's unit later changes.
    unit = Column(String(20), nullable=True)
    reason = Column(Text, nullable=False)
    recipient = Column(String(200), nullable=True)
    source_breakdown = Column(JSON, nullable=True)
    pallet_licence_ids = Column(JSON, nullable=True)
    status = Column(String(20), default="pending")
    original_quantity = Column(Float, nullable=True)
    new_quantity = Column(Float, nullable=True)
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    receipt = relationship("Receipt", backref="adjustments")
    category = relationship("Category", backref="adjustments")
    product = relationship("Product", backref="adjustments")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_adjustments")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_adjustments")
    warehouse = relationship("Warehouse", backref="inventory_adjustments")


class InventoryHoldAction(Base):
    __tablename__ = "inventory_hold_actions"

    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    action = Column(String(20), nullable=False)
    reason = Column(Text, nullable=False)
    hold_items = Column(JSON, nullable=True)
    total_quantity = Column(Float, nullable=True)
    pallet_licence_ids = Column(JSON, nullable=True)
    status = Column(String(20), default="pending")
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    receipt = relationship("Receipt", backref="hold_actions")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_hold_actions")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_hold_actions")
    warehouse = relationship("Warehouse", backref="hold_actions")


class CycleCount(Base):
    __tablename__ = "cycle_counts"

    id = Column(String(50), primary_key=True)
    location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    count_date = Column(Date, nullable=False)
    items = Column(JSON, nullable=False)
    summary = Column(JSON, nullable=False)
    performed_by = Column(String(100), nullable=False)
    performed_by_id = Column(String(50), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)

    location = relationship("Location", backref="cycle_counts")
    category = relationship("Category", backref="cycle_counts")
    performer = relationship("User", foreign_keys=[performed_by_id], backref="performed_cycle_counts")
    warehouse = relationship("Warehouse", backref="cycle_counts")


class StagingItem(Base):
    __tablename__ = "staging_items"

    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"))
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    product_id = Column(String(50), ForeignKey("products.id"))
    quantity_staged = Column(Float, nullable=False)
    quantity_used = Column(Float, default=0)
    quantity_returned = Column(Float, default=0)
    pallets_staged = Column(Float, nullable=True)
    pallets_used = Column(Float, default=0)
    pallets_returned = Column(Float, default=0)
    original_storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    staging_storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    status = Column(String(20), default="staged")
    staging_batch_id = Column(String(50), nullable=True)
    staged_at = Column(DateTime(timezone=True), server_default=func.now())
    used_at = Column(DateTime(timezone=True), nullable=True)
    returned_at = Column(DateTime(timezone=True), nullable=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)

    transfer = relationship("InventoryTransfer", backref="staging_items")
    receipt = relationship("Receipt", backref="staging_items")
    product = relationship("Product", backref="staging_items")
    original_storage_row = relationship("StorageRow", foreign_keys=[original_storage_row_id], backref="staging_items_from")
    staging_storage_row = relationship("StorageRow", foreign_keys=[staging_storage_row_id], backref="staging_items_at")
    warehouse = relationship("Warehouse", backref="staging_items")
