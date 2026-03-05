from sqlalchemy import Column, String, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Notification(Base):
    """
    In-app notifications for users/warehouses.
    e.g. inter-warehouse transfer initiated, approval needed, stock alerts.
    """
    __tablename__ = "notifications"

    id = Column(String(50), primary_key=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    user_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    type = Column(String(50), nullable=False)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    reference_id = Column(String(50), nullable=True)
    reference_type = Column(String(50), nullable=True)
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    warehouse = relationship("Warehouse", backref="notifications")
    user = relationship("User", backref="notifications")
