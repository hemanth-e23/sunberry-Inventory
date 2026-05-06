from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class ActiveLineProduction(Base):
    """Currently-active production declared by supervisor for a given line.

    One row per (line, day, product). Replaced (is_active=false) when
    supervisor changes product or at plant-local midnight (lazy reset on read).
    """
    __tablename__ = "active_line_production"

    id = Column(String(50), primary_key=True)
    line_id = Column(String(50), ForeignKey("production_lines.id"), nullable=False, index=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=False)
    lot_number = Column(String(100), nullable=False)
    last_printed_seq = Column(Integer, nullable=False, default=0, server_default="0")
    set_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    set_by_user_id = Column(String(50), ForeignKey("users.id"), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    line = relationship("ProductionLine", backref="active_productions")
    product = relationship("Product", backref="active_productions")
    set_by = relationship("User", foreign_keys=[set_by_user_id], backref="active_productions_set")

    __table_args__ = (
        Index(
            "uq_active_line_production_one_active",
            "line_id",
            unique=True,
            postgresql_where=(is_active == True),  # noqa: E712
        ),
    )
