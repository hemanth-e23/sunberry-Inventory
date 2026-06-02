from datetime import time
from sqlalchemy import Column, String, Boolean, DateTime, ForeignKey, Text, Time
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Warehouse(Base):
    __tablename__ = "warehouses"

    id = Column(String(50), primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    code = Column(String(20), unique=True, nullable=False, index=True)
    type = Column(String(20), nullable=False)
    address = Column(Text, nullable=True)
    contact_person = Column(String(100), nullable=True)
    email = Column(String(100), nullable=True)
    phone = Column(String(20), nullable=True)
    timezone = Column(String(50), default="America/New_York")
    # 24h production-day window. Operating hours are ~05:30 AM through 03:00 AM
    # next day; using a 24h window starting at 05:30 catches stragglers without
    # a dead-zone gap. If start == end, the window is a full 24h block.
    production_day_start = Column(Time, nullable=False, server_default="05:30", default=time(5, 30))
    production_day_end = Column(Time, nullable=False, server_default="05:30", default=time(5, 30))
    is_active = Column(Boolean, default=True)
    allow_product_creation = Column(Boolean, default=False, nullable=False, server_default="false")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class User(Base):
    __tablename__ = "users"

    id = Column(String(50), primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(100), nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False)
    badge_id = Column(String(50), unique=True, nullable=True, index=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    warehouse = relationship("Warehouse", backref="users")
