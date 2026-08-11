# ─── Roles ────────────────────────────────────────────────────────────────────
ROLE_ADMIN = "admin"
ROLE_SUPERADMIN = "superadmin"
ROLE_CORPORATE_ADMIN = "corporate_admin"
ROLE_SUPERVISOR = "supervisor"
ROLE_WAREHOUSE = "warehouse"
ROLE_FORKLIFT = "forklift"

# ─── Bill of Lading numbering ─────────────────────────────────────────────────
# The BOL number is a GSIN (Global Shipment Identification Number), not a
# counter: 17 digits = a 10-digit GS1 company prefix + a 6-digit shipment
# serial + a mod-10 check digit. Carriers and customers read it as a real GS1
# code, so the format is not ours to choose, and it must continue the series the
# legacy system issued rather than restarting. See app/utils/gs1.py.
BOL_GSIN_PREFIX = "0850039525"
BOL_SERIAL_DIGITS = 6

# Role groups
ADMIN_ROLES = frozenset({ROLE_ADMIN, ROLE_SUPERADMIN, ROLE_CORPORATE_ADMIN})
APPROVAL_ROLES = frozenset({ROLE_ADMIN, ROLE_SUPERADMIN, ROLE_CORPORATE_ADMIN, ROLE_SUPERVISOR})

# ─── Category Types ───────────────────────────────────────────────────────────
CATEGORY_FINISHED = "finished"
CATEGORY_RAW_MATERIAL = "raw-material"
CATEGORY_INGREDIENT = "ingredient"
CATEGORY_PACKAGING = "packaging"

# ─── Default Business Values ──────────────────────────────────────────────────
DEFAULT_CASES_PER_PALLET = 40
DEFAULT_EXPIRE_YEARS = 2
DAYS_PER_YEAR = 365
FORKLIFT_TOKEN_EXPIRE_MINUTES = 1440  # 24 hours

# After this many hours of no scan activity, a SCANNING session is either
# auto-submitted (if it has pallets) or auto-cancelled with reason="empty_timeout"
# (if it has none). Surfaces forgotten work to supervisors automatically.
STALE_FORKLIFT_SESSION_HOURS = 3

# ─── Ship-out transfer types ──────────────────────────────────────────────────
TRANSFER_TYPE_SHIPPED_OUT = "shipped-out"

# ─── Pallet swap source markers ───────────────────────────────────────────────
SWAP_SOURCE_FORKLIFT = "forklift"
SWAP_SOURCE_WAREHOUSE_EDIT = "warehouse_edit"
