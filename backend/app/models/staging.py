from sqlalchemy import Column, Integer, String, Boolean, DateTime, Date, Text, ForeignKey, Float
from sqlalchemy.orm import relationship
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
    staging_item_ids = Column(Text, nullable=True)

    product = relationship("Product")
