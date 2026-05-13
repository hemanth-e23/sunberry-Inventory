# ─── Roles ────────────────────────────────────────────────────────────────────
ROLE_ADMIN = "admin"
ROLE_SUPERADMIN = "superadmin"
ROLE_CORPORATE_ADMIN = "corporate_admin"
ROLE_SUPERVISOR = "supervisor"
ROLE_WAREHOUSE = "warehouse"
ROLE_FORKLIFT = "forklift"

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
