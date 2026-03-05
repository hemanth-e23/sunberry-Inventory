from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey, Float, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class CategoryGroup(Base):
    __tablename__ = "category_groups"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Category(Base):
    __tablename__ = "categories"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    type = Column(String(20), nullable=False)
    parent_id = Column(String(50), ForeignKey("category_groups.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parent = relationship("CategoryGroup", backref="categories")


class Vendor(Base):
    __tablename__ = "vendors"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    contact_person = Column(String(100))
    email = Column(String(100))
    phone = Column(String(20))
    address = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Product(Base):
    __tablename__ = "products"

    id = Column(String(50), primary_key=True)
    name = Column(String(200), nullable=False)
    short_code = Column(String(20), unique=True, nullable=True, index=True)
    fcc_code = Column(String(50))
    sid = Column(String(50))
    brix = Column(Float)
    category_id = Column(String(50), ForeignKey("categories.id"))
    vendor_id = Column(String(50), ForeignKey("vendors.id"))
    description = Column(Text)
    default_cases_per_pallet = Column(Integer)
    expire_years = Column(Integer)
    quantity_uom = Column(String(20))
    inventory_tracked = Column(Boolean, default=True)
    gal_per_case = Column(Float, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    category = relationship("Category", backref="products")
    vendor = relationship("Vendor", backref="products")


class WarehouseCategoryAccess(Base):
    __tablename__ = "warehouse_category_access"

    id = Column(Integer, primary_key=True, autoincrement=True)
    warehouse_id = Column(String(50), ForeignKey("warehouses.id"), nullable=False)
    category_group_id = Column(String(50), ForeignKey("category_groups.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("warehouse_id", "category_group_id", name="uq_wh_catgroup"),
    )

    warehouse = relationship("Warehouse", backref="category_access")
    category_group = relationship("CategoryGroup", backref="warehouse_access")
