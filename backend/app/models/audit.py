import uuid
from sqlalchemy import Column, String, DateTime, JSON, ForeignKey
from sqlalchemy.sql import func
from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String(50), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(50), ForeignKey("users.id"), nullable=True)
    action = Column(String(100), nullable=False)      # e.g. "approve_receipt"
    resource_type = Column(String(50), nullable=True)  # e.g. "receipt"
    resource_id = Column(String(50), nullable=True)
    details = Column(JSON, nullable=True)              # {"before": {...}, "after": {...}}
    created_at = Column(DateTime(timezone=True), server_default=func.now())
