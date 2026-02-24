from sqlalchemy import Column, Integer, String, Boolean, DateTime, Date, Text, ForeignKey, Float, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base

class User(Base):
    __tablename__ = "users"
    
    id = Column(String(50), primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(100), nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False)  # admin, supervisor, warehouse, forklift
    badge_id = Column(String(50), unique=True, nullable=True, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

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
    type = Column(String(20), nullable=False)  # raw, packaging, finished
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
    quantity_uom = Column(String(20))  # Unit of measure: cases, bags, etc.
    inventory_tracked = Column(Boolean, default=True)  # False for items like water/sugar that don't need staging
    gal_per_case = Column(Float, nullable=True)  # For finished goods: gallons per case (e.g. 4 for 4x1gal bottles)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    category = relationship("Category", backref="products")
    vendor = relationship("Vendor", backref="products")

class Location(Base):
    __tablename__ = "locations"
    
    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

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
    template = Column(String(20))  # e.g., "3x5", "3x8", "4x6"
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
    start_time = Column(String(10))  # HH:MM format
    end_time = Column(String(10))    # HH:MM format
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class ProductionLine(Base):
    __tablename__ = "production_lines"
    
    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Receipt(Base):
    __tablename__ = "receipts"
    
    id = Column(String(50), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    lot_number = Column(String(100))
    quantity = Column(Float, nullable=False)          # Primary quantity used for staging/availability (total weight when weight info provided)
    unit = Column(String(20), default="cases")          # Unit for quantity (lbs, kg, cases, etc.)
    container_count = Column(Float, nullable=True)      # How many containers (barrels, bags, etc.)
    container_unit = Column(String(30), nullable=True)  # Container type: barrels, bags, cases, etc.
    weight_per_container = Column(Float, nullable=True)  # Weight of each container (e.g. 500 lbs per barrel)
    weight_unit = Column(String(10), nullable=True)      # Weight unit: lbs, kg, g, oz, etc.
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
    status = Column(String(20), default="recorded")  # recorded, reviewed, approved, rejected, sent-back
    bol = Column(String(100))
    purchase_order = Column(String(100))
    vendor_id = Column(String(50), ForeignKey("vendors.id"))
    location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    pallets = Column(Float, nullable=True)  # Pallet count for raw materials/packaging row occupancy
    hold = Column(Boolean, default=False)
    held_quantity = Column(Float, default=0) # Quantity currently on hold for this receipt
    hold_location = Column(String(100), nullable=True)  # Name of location/row on hold (e.g., "AC")
    allocation = Column(JSON)  # Store allocation plan as JSON (finished goods)
    raw_material_row_allocations = Column(JSON, nullable=True)  # Store multi-row pallet allocations for raw/packaging
    note = Column(Text)
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
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


class ForkliftRequest(Base):
    """Forklift scan session - pallets scanned by forklift person before approval"""
    __tablename__ = "forklift_requests"

    id = Column(String(50), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    lot_number = Column(String(100))
    production_date = Column(DateTime(timezone=True))
    expiration_date = Column(DateTime(timezone=True))
    shift_id = Column(String(50), ForeignKey("production_shifts.id"), nullable=True)
    line_id = Column(String(50), ForeignKey("production_lines.id"), nullable=True)
    cases_per_pallet = Column(Integer)
    total_full_pallets = Column(Integer, default=0)
    total_partial_pallets = Column(Integer, default=0)
    total_cases = Column(Float, default=0)
    status = Column(String(20), default="scanning")  # scanning, submitted, approved, rejected
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    scanned_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    product = relationship("Product", backref="forklift_requests")
    shift = relationship("ProductionShift", backref="forklift_requests")
    line = relationship("ProductionLine", backref="forklift_requests")
    receipt = relationship("Receipt", backref="forklift_requests", foreign_keys=[receipt_id])
    scanner = relationship("User", foreign_keys=[scanned_by], backref="scanned_forklift_requests")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_forklift_requests")


class PalletLicence(Base):
    """Individual pallet tracking with unique licence number"""
    __tablename__ = "pallet_licences"

    id = Column(String(50), primary_key=True)
    licence_number = Column(String(100), unique=True, index=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)
    forklift_request_id = Column(String(50), ForeignKey("forklift_requests.id"), nullable=True)
    product_id = Column(String(50), ForeignKey("products.id"))
    lot_number = Column(String(100))
    storage_area_id = Column(String(50), ForeignKey("storage_areas.id"), nullable=True)
    storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)
    cases = Column(Integer)
    is_partial = Column(Boolean, default=False)
    sequence = Column(Integer)
    status = Column(String(20), default="pending")  # pending, in_stock, shipped, adjusted, removed, missing_sticker, cancelled
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"), nullable=True)
    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    receipt = relationship("Receipt", backref="pallet_licences")
    forklift_request = relationship("ForkliftRequest", backref="pallet_licences")
    product = relationship("Product", backref="pallet_licences")
    storage_area = relationship("StorageArea", backref="pallet_licences")
    storage_row = relationship("StorageRow", backref="pallet_licences")
    transfer = relationship("InventoryTransfer", backref="pallet_licences")
    scanner = relationship("User", foreign_keys=[scanned_by], backref="scanned_pallet_licences")


class InventoryTransfer(Base):
    __tablename__ = "inventory_transfers"
    
    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    from_location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    from_sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    to_location_id = Column(String(50), ForeignKey("locations.id"), nullable=True)
    to_sub_location_id = Column(String(50), ForeignKey("sub_locations.id"), nullable=True)
    quantity = Column(Float, nullable=False)
    unit = Column(String(20), default="cases")
    reason = Column(Text)
    transfer_type = Column(String(50), default="warehouse-transfer")  # warehouse-transfer, shipped-out, staging
    order_number = Column(String(100), nullable=True)  # For shipped-out transfers
    source_breakdown = Column(JSON, nullable=True)  # Track source allocations
    destination_breakdown = Column(JSON, nullable=True)  # Track destination allocations
    pallet_licence_ids = Column(JSON, nullable=True)  # List of pallet licence IDs for licence-aware transfers
    status = Column(String(20), default="pending")  # pending, approved, rejected, completed
    requested_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    forklift_submitted_at = Column(DateTime(timezone=True), nullable=True)
    forklift_notes = Column(Text, nullable=True)
    skipped_pallet_ids = Column(JSON, nullable=True)
    
    receipt = relationship("Receipt", backref="transfers")
    from_location = relationship("Location", foreign_keys=[from_location_id], backref="transfers_from")
    from_sub_location = relationship("SubLocation", foreign_keys=[from_sub_location_id], backref="transfers_from")
    to_location = relationship("Location", foreign_keys=[to_location_id], backref="transfers_to")
    to_sub_location = relationship("SubLocation", foreign_keys=[to_sub_location_id], backref="transfers_to")
    requester = relationship("User", foreign_keys=[requested_by], backref="requested_transfers")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_transfers")


class TransferScanEvent(Base):
    """Log each pallet scan during ship-out picking for progress and exception reporting."""
    __tablename__ = "transfer_scan_events"

    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"), nullable=False)
    licence_number = Column(String(100), nullable=False)
    licence_id = Column(String(50), ForeignKey("pallet_licences.id"), nullable=True)
    on_list = Column(Boolean, nullable=False)
    scanned_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    scanned_at = Column(DateTime(timezone=True), server_default=func.now())

    transfer = relationship("InventoryTransfer", backref="scan_events")
    scanner = relationship("User", foreign_keys=[scanned_by], backref="transfer_scan_events")


class InventoryAdjustment(Base):
    __tablename__ = "inventory_adjustments"
    
    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=True)
    adjustment_type = Column(String(50), nullable=False)  # stock-correction, damage-reduction, donation, trash-disposal, quality-rejection
    quantity = Column(Float, nullable=False)
    reason = Column(Text, nullable=False)
    recipient = Column(String(200), nullable=True)  # For donations
    source_breakdown = Column(JSON, nullable=True)  # Track which sources the adjustment applies to
    status = Column(String(20), default="pending")  # pending, approved, rejected
    original_quantity = Column(Float, nullable=True)  # Quantity before adjustment was applied
    new_quantity = Column(Float, nullable=True)  # Quantity after adjustment was applied
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    receipt = relationship("Receipt", backref="adjustments")
    category = relationship("Category", backref="adjustments")
    product = relationship("Product", backref="adjustments")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_adjustments")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_adjustments")

class InventoryHoldAction(Base):
    __tablename__ = "inventory_hold_actions"
    
    id = Column(String(50), primary_key=True)
    receipt_id = Column(String(50), ForeignKey("receipts.id"), nullable=True)  # Made nullable for partial holds
    action = Column(String(20), nullable=False)  # hold, release
    reason = Column(Text, nullable=False)
    hold_items = Column(JSON, nullable=True)  # For partial holds - array of {receipt_id, location_id, quantity}
    total_quantity = Column(Float, nullable=True)  # Total quantity being held
    status = Column(String(20), default="pending")  # pending, approved, rejected
    submitted_by = Column(String(50), ForeignKey("users.id"))
    approved_by = Column(String(50), ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    receipt = relationship("Receipt", backref="hold_actions")
    submitter = relationship("User", foreign_keys=[submitted_by], backref="submitted_hold_actions")
    approver = relationship("User", foreign_keys=[approved_by], backref="approved_hold_actions")

class CycleCount(Base):
    __tablename__ = "cycle_counts"
    
    id = Column(String(50), primary_key=True)
    location_id = Column(String(50), ForeignKey("locations.id"), nullable=False)
    category_id = Column(String(50), ForeignKey("categories.id"), nullable=True)
    count_date = Column(String(20), nullable=False)  # Date string format (e.g. "2025-12-19")
    items = Column(JSON, nullable=False)  # List of counted items with variances
    summary = Column(JSON, nullable=False)  # Variance summary statistics
    performed_by = Column(String(100), nullable=False)
    performed_by_id = Column(String(50), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    location = relationship("Location", backref="cycle_counts")
    category = relationship("Category", backref="cycle_counts")
    performer = relationship("User", foreign_keys=[performed_by_id], backref="performed_cycle_counts")

class StagingItem(Base):
    __tablename__ = "staging_items"
    
    id = Column(String(50), primary_key=True)
    transfer_id = Column(String(50), ForeignKey("inventory_transfers.id"))
    receipt_id = Column(String(50), ForeignKey("receipts.id"))
    product_id = Column(String(50), ForeignKey("products.id"))
    
    # Quantities
    quantity_staged = Column(Float, nullable=False)  # How much went to staging
    quantity_used = Column(Float, default=0)  # How much was used for production
    quantity_returned = Column(Float, default=0)  # How much was returned to warehouse
    
    # Pallet tracking for rack space management
    pallets_staged = Column(Float, nullable=True)  # How many pallets staged (for rack space calculation)
    pallets_used = Column(Float, default=0)  # How many pallets used (frees up rack space)
    pallets_returned = Column(Float, default=0)  # How many pallets returned (frees up staging rack space)
    
    # Storage row tracking
    original_storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)  # Original rack/row before staging (to free when used/returned)
    staging_storage_row_id = Column(String(50), ForeignKey("storage_rows.id"), nullable=True)  # Which rack/row in staging location (if staging uses rows)
    
    # Status tracking
    status = Column(String(20), default="staged")  # staged, partially_used, used, returned, partially_returned
    
    # Optional grouping for future API integration
    staging_batch_id = Column(String(50), nullable=True)  # Groups items staged together
    
    # Timestamps
    staged_at = Column(DateTime(timezone=True), server_default=func.now())
    used_at = Column(DateTime(timezone=True), nullable=True)
    returned_at = Column(DateTime(timezone=True), nullable=True)
    
    # Relationships
    transfer = relationship("InventoryTransfer", backref="staging_items")
    receipt = relationship("Receipt", backref="staging_items")
    product = relationship("Product", backref="staging_items")
    original_storage_row = relationship("StorageRow", foreign_keys=[original_storage_row_id], backref="staging_items_from")
    staging_storage_row = relationship("StorageRow", foreign_keys=[staging_storage_row_id], backref="staging_items_at")


# ---------------------------------------------------------------------------
# Production staging requests (created by Production app via service API)
# ---------------------------------------------------------------------------

class StagingRequest(Base):
    """
    A request from the Production system to stage materials for a batch.
    Created automatically when QA creates a batch in Production.
    """
    __tablename__ = "staging_requests"

    id = Column(String(50), primary_key=True)
    production_batch_uid = Column(String(500), nullable=False, index=True)
    product_name = Column(String(200), nullable=True)       # What is being produced
    formula_name = Column(String(200), nullable=True)       # Which formula
    number_of_batches = Column(Integer, default=1)
    status = Column(String(20), default="pending")          # pending, in_progress, fulfilled, cancelled
    production_date = Column(Date, nullable=True)            # Planned production date (from Production)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)  # Last time we synced usage from Production
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True)

    items = relationship("StagingRequestItem", backref="request", cascade="all, delete-orphan")


class StagingRequestItem(Base):
    """
    One line-item inside a staging request (one ingredient needed).
    """
    __tablename__ = "staging_request_items"

    id = Column(String(50), primary_key=True)
    request_id = Column(String(50), ForeignKey("staging_requests.id"), nullable=False, index=True)
    product_id = Column(String(50), ForeignKey("products.id"), nullable=True)  # matched Inventory product
    sid = Column(String(50), nullable=True)                 # SID from Production ingredient
    ingredient_name = Column(String(200), nullable=False)   # Name from Production
    quantity_needed = Column(Float, nullable=False)
    quantity_fulfilled = Column(Float, default=0)
    unit = Column(String(20), nullable=True)
    status = Column(String(20), default="pending")          # pending, fulfilled, partially_fulfilled
    staging_item_ids = Column(Text, nullable=True)          # JSON array of StagingItem IDs linked to this request item

    product = relationship("Product")
