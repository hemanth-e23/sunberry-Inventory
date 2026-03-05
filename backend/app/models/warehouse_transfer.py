from sqlalchemy import Column, String, DateTime, Text, ForeignKey, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class InterWarehouseTransfer(Base):
    """
    A transfer of inventory between two warehouses (physical truck shipment).
    Flow: initiated → confirmed_by_sender → in_transit → received → completed
    Corporate initiates; sender warehouse ships; receiver warehouse confirms receipt.
    """
    __tablename__ = "inter_warehouse_transfers"

    id = Column(String(50), primary_key=True)
    from_warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=False)
    to_warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=False)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False)
    lot_number = Column(String(100), nullable=True)
    quantity = Column(Float, nullable=False)
    unit = Column(String(20), default="cases")
    status = Column(String(30), default="initiated")
    source_receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    destination_receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    reference_number = Column(String(100), nullable=True)
    expected_arrival_date = Column(DateTime(timezone=True), nullable=True)
    actual_arrival_date = Column(DateTime(timezone=True), nullable=True)
    notes = Column(Text, nullable=True)
    dispute_reason = Column(Text, nullable=True)
    initiated_by = Column(String(50), ForeignKey("users.id"), nullable=False)
    confirmed_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    received_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    initiated_at = Column(DateTime(timezone=True), server_default=func.now())
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    shipped_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    from_warehouse = relationship("Warehouse", foreign_keys=[from_warehouse_id], backref="outgoing_transfers")
    to_warehouse = relationship("Warehouse", foreign_keys=[to_warehouse_id], backref="incoming_transfers")
    product = relationship("Product", backref="inter_warehouse_transfers")
    source_receipt = relationship("Receipt", foreign_keys=[source_receipt_id], backref="inter_warehouse_transfer_source")
    destination_receipt = relationship("Receipt", foreign_keys=[destination_receipt_id], backref="inter_warehouse_transfer_destination")
    initiator = relationship("User", foreign_keys=[initiated_by], backref="initiated_inter_transfers")
    confirmer = relationship("User", foreign_keys=[confirmed_by], backref="confirmed_inter_transfers")
    receiver = relationship("User", foreign_keys=[received_by], backref="received_inter_transfers")
