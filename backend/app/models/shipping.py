"""Shipping master data for the scheduled ship-out flow.

- PackageSize: 16/32/64/128 oz — carries the case weight used on the BOL. Weight is
  a property of the SIZE, not the flavor, so it's set once per size and every product
  of that size inherits it (SPEC §7.1). Products FK to a size via package_size_id.
- PalletType: the pallet company/type printed on the packing slip pallet line and
  used for BOL pallet weight (SPEC §5.10). Seeded via SQL; no admin UI.
- ShipToLocation: self-populating customer ship-to addresses (SPEC §7.2). No managed
  master — rows are created on first use and offered as type-ahead suggestions.
- Carrier: self-populating carrier names (SPEC §7.2), same pattern.
"""
from sqlalchemy import Column, String, Boolean, DateTime, Float, Text, Integer
from sqlalchemy.sql import func
from app.database import Base


class PackageSize(Base):
    __tablename__ = "package_sizes"

    id = Column(String(50), primary_key=True)
    label = Column(String(50), nullable=False, unique=True)   # e.g. "64 oz", "1 Gallon (128 oz)"
    # Case (shipping unit, UOM=CS) weight in pounds — the ONE place weight is set.
    case_weight = Column(Float, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, default=True, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PalletType(Base):
    __tablename__ = "pallet_types"

    id = Column(String(50), primary_key=True)
    code = Column(String(30), nullable=False, unique=True)   # e.g. "PECO"
    name = Column(String(100), nullable=False)               # e.g. "PECO Pallet"
    # Item code + description printed on the packing slip pallet line
    # (e.g. SPECOSUN / "PECO PALLET SUNBERRY").
    item_code = Column(String(50), nullable=True)
    description = Column(String(200), nullable=True)
    pallet_weight = Column(Float, nullable=False, default=60.0)  # lb each
    is_default = Column(Boolean, default=False, nullable=False, server_default="false")
    is_active = Column(Boolean, default=True, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ShipToLocation(Base):
    __tablename__ = "ship_to_locations"

    id = Column(String(50), primary_key=True)
    customer_name = Column(String(100), nullable=False, index=True)  # e.g. "COSTCO"
    # Display label / consignee line, e.g. "COSTCO FREDERICK DRY".
    location_name = Column(String(200), nullable=False)
    address_line1 = Column(String(200), nullable=True)
    address_line2 = Column(String(200), nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(20), nullable=True)
    zip_code = Column(String(20), nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Carrier(Base):
    __tablename__ = "carriers"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False, unique=True, index=True)  # e.g. "IIK"
    is_active = Column(Boolean, default=True, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
