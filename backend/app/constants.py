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

# ─── Wrapped material ─────────────────────────────────────────────────────────
# Containers that arrive shrink-wrapped on a pallet and CANNOT be stickered one
# at a time at the dock. Only these may carry `units_per_pallet`, which answers
# a single question: how many units share one sticker and one scan.
#
# Drums, barrels and totes are absent deliberately. They do ride pallets, two or
# four to a pallet, but they do not SHARE a sticker — each is labelled and pulled
# on its own. Those two facts agree for bags and diverge for drums, and letting
# a drum lot carry the figure printed "PALLET OF DRUMS" for a 76-drum delivery
# and armed the gun to book four drums per scan.
#
# Singular and plural BOTH appear in the wild — the incoming order line stores
# "drum", the receipt form stores "drums" — so both are listed rather than
# stemmed. Stripping a trailing "s" turns "boxes" into "boxe" and silently
# answers no; this is a food-safety label, so it is spelled out instead.
PALLETISED_UNITS = frozenset({
    "bag", "bags",
    "box", "boxes",
    "bottle", "bottles",
    "case", "cases",
    "pail", "pails",
})


def is_palletised_unit(unit_label) -> bool:
    """Does this container share one sticker with the rest of its pallet?"""
    return str(unit_label or "").strip().lower() in PALLETISED_UNITS
