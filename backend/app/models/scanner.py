from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class ForkliftRequest(Base):
    """Forklift scan session - pallets scanned by forklift person before approval"""
    __tablename__ = "forklift_requests"

    id = Column(String(50), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    lot_number = Column(String(100))
    production_date = Column(DateTime(timezone=True))
    expiration_date = Column(DateTime(timezone=True))
    shift_id = Column(String(50), ForeignKey("production_shifts.id"), nullable=True)
    line_id = Column(String(50), ForeignKey("production_lines.id"), nullable=True)
    cases_per_pallet = Column(Integer)
    total_full_pallets = Column(Integer, default=0)
    total_partial_pallets = Column(Integer, default=0)
    total_cases = Column(Float, default=0)
    status = Column(String(20), default="scanning")
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    scanned_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    product = relationship("Product", backref="forklift_requests")
    shift = relationship("ProductionShift", backref="forklift_requests")
    line = relationship("ProductionLine", backref="forklift_requests")
    receipt = relationship("Receipt", backref="forklift_requests", foreign_keys=[receipt_id])
    scanner = relationship("User", foreign_keys=[scanned_by], backref="scanned_forklift_requests")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_forklift_requests")


class PalletLicence(Base):
    """Individual pallet tracking with unique licence number"""
    __tablename__ = "pallet_licences"

    id = Column(String(50), primary_key=True)
    licence_number = Column(String(100), unique=True, index=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    forklift_request_id = Column(String(50), ForeignKey("forklift_requests.id"), nullable=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    lot_number = Column(String(100))
    storage_area_id = Column(String(50), ForeignKey("storage_areas.id"), nullable=True)
    storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    cases = Column(Integer)
    is_partial = Column(Boolean, default=False)
    is_held = Column(Boolean, default=False, nullable=False, server_default="false")
    sequence = Column(Integer)
    status = Column(String(20), default="pending")
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"), nullable=True)
    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), nullable=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    receipt = relationship("Receipt", backref="pallet_licences")
    forklift_request = relationship("ForkliftRequest", backref="pallet_licences")
    product = relationship("Product", backref="pallet_licences")
    storage_area = relationship("StorageArea", backref="pallet_licences")
    storage_row = relationship("StorageRow", backref="pallet_licences")
    transfer = relationship("InventoryTransfer", backref="pallet_licences")
    scanner = relationship("User", foreign_keys=[scanned_by], backref="scanned_pallet_licences")


class TransferScanEvent(Base):
    """Log each pallet scan during ship-out picking for progress and exception reporting."""
    __tablename__ = "transfer_scan_events"

    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"), nullable=False)
    licence_number = Column(String(100), nullable=False)
    licence_id = Column(String(50), ForeignKey("pallet_licences.id"), nullable=True)
    on_list = Column(Boolean, nullable=False)
    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), server_default=func.now())

    transfer = relationship("InventoryTransfer", backref="scan_events")
    scanner = relationship("User", foreign_keys=[scanned_by], backref="transfer_scan_events")
