from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Location(Base):
    __tablename__ = "locations"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    warehouse = relationship("Warehouse", backref="locations")


class SubLocation(Base):
    __tablename__ = "sub_locations"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    location_id = Column(String(50), ForeignKey("locations.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    location = relationship("Location", backref="sub_locations")


class StorageArea(Base):
    __tablename__ = "storage_areas"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    location_id = Column(String(50), ForeignKey("locations.id"))
    sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    allow_floor_storage = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    location = relationship("Location", backref="storage_areas")
    sub_location = relationship("SubLocation", backref="storage_areas")


class StorageRow(Base):
    __tablename__ = "storage_rows"

    id = Column(String(50), primary_key=True)
    storage_area_id = Column(String(50), ForeignKey("storage_areas.id"), nullable=True)
    sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    name = Column(String(100), nullable=False)
    template = Column(String(20))
    pallet_capacity = Column(Integer, default=0)
    default_cases_per_pallet = Column(Integer, default=0)
    occupied_pallets = Column(Float, default=0)
    occupied_cases = Column(Float, default=0)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=True)
    hold = Column(Boolean, default=False)
    notes = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    storage_area = relationship("StorageArea", backref="rows")
    sub_location = relationship("SubLocation", backref="rows")
    product = relationship("Product", backref="storage_rows")


class ProductionShift(Base):
    __tablename__ = "production_shifts"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    start_time = Column(String(10))
    end_time = Column(String(10))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ProductionLine(Base):
    __tablename__ = "production_lines"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
