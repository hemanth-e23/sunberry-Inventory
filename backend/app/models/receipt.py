from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey, Float, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Receipt(Base):
    __tablename__ = "receipts"

    id = Column(String(50), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    lot_number = Column(String(100))
    quantity = Column(Float, nullable=False)
    unit = Column(String(20), default="cases")
    container_count = Column(Float, nullable=True)
    container_unit = Column(String(30), nullable=True)
    weight_per_container = Column(Float, nullable=True)
    weight_unit = Column(String(10), nullable=True)
    production_date = Column(DateTime(timezone=True))
    expiration_date = Column(DateTime(timezone=True))
    receipt_date = Column(DateTime(timezone=True), server_default=func.now())
    cases_per_pallet = Column(Integer)
    full_pallets = Column(Integer)
    partial_cases = Column(Integer, default=0)
    loose_cases = Column(Integer, default=0)
    quantity_produced = Column(Float)
    shift_id = Column(String(50), ForeignKey("production_shifts.id"))
    line_id = Column(String(50), ForeignKey("production_lines.id"))
    status = Column(String(20), default="recorded")
    bol = Column(String(100))
    purchase_order = Column(String(100))
    vendor_id = Column(String(50), ForeignKey("vendors.id"))
    location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    pallets = Column(Float, nullable=True)
    hold = Column(Boolean, default=False)
    held_quantity = Column(Float, default=0)
    hold_location = Column(String(100), nullable=True)
    allocation = Column(JSON)
    raw_material_row_allocations = Column(JSON, nullable=True)
    note = Column(Text)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    is_deleted = Column(Boolean, default=False, nullable=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by_id = Column(String(50), ForeignKey("users.id"), nullable=True)

    warehouse = relationship("Warehouse", backref="receipts")
    product = relationship("Product", backref="receipts")
    category = relationship("Category", backref="receipts")
    shift = relationship("ProductionShift", backref="receipts")
    line = relationship("ProductionLine", backref="receipts")
    vendor = relationship("Vendor", backref="receipts")
    location = relationship("Location", backref="receipts")
    sub_location = relationship("SubLocation", backref="receipts")
    storage_row = relationship("StorageRow", backref="receipts")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_receipts")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_receipts")


class ReceiptAllocation(Base):
    __tablename__ = "receipt_allocations"

    id = Column(Integer, primary_key=True, index=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    storage_area_id = Column(String(50), ForeignKey("storage_areas.id"))
    pallet_quantity = Column(Float, nullable=False)
    cases_quantity = Column(Float, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    receipt = relationship("Receipt", backref="allocations")
    storage_area = relationship("StorageArea", backref="allocations")
