from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn
import time
import logging
from collections import defaultdict
from typing import Dict, Tuple

from app.config import settings
from app.database import engine, Base
from app.routers import auth, users, products, receipts, inventory, master_data, service, scanner, pallet_licences, reports

# Configure logging
logging.basicConfig(level=logging.INFO if settings.DEBUG else logging.WARNING)
logger = logging.getLogger(__name__)

# Create database tables (runs on every startup/reload)
Base.metadata.create_all(bind=engine)
logger.info("Database tables verified/created.")

# Auto-migration: widen production_batch_uid from VARCHAR(100) to VARCHAR(500)
try:
    from sqlalchemy import inspect as sa_inspect, text
    _inspector = sa_inspect(engine)
    if "staging_requests" in _inspector.get_table_names():
        for col in _inspector.get_columns("staging_requests"):
            if col["name"] == "production_batch_uid":
                col_type = str(col["type"])
                # Check if column is still shorter than 500
                if "100" in col_type or "200" in col_type or "250" in col_type:
                    with engine.begin() as conn:
                        conn.execute(text("ALTER TABLE staging_requests ALTER COLUMN production_batch_uid TYPE VARCHAR(500)"))
                    logger.info("Migration: widened staging_requests.production_batch_uid to VARCHAR(500)")
                break
except Exception as e:
    logger.warning(f"Migration warning (production_batch_uid): {e}")

# Auto-migration: add staging_item_ids column to staging_request_items
try:
    from sqlalchemy import inspect as sa_inspect2, text as text2
    _inspector2 = sa_inspect2(engine)
    if "staging_request_items" in _inspector2.get_table_names():
        existing_cols = [c["name"] for c in _inspector2.get_columns("staging_request_items")]
        if "staging_item_ids" not in existing_cols:
            with engine.begin() as conn:
                conn.execute(text2("ALTER TABLE staging_request_items ADD COLUMN staging_item_ids TEXT"))
            logger.info("Migration: added staging_item_ids column to staging_request_items")
except Exception as e:
    logger.warning(f"Migration warning (staging_item_ids): {e}")

# Auto-migration: add production_date and last_synced_at to staging_requests
try:
    from sqlalchemy import inspect as sa_inspect_pd, text as text_pd
    _inspector_pd = sa_inspect_pd(engine)
    if "staging_requests" in _inspector_pd.get_table_names():
        existing_cols_pd = [c["name"] for c in _inspector_pd.get_columns("staging_requests")]
        if "production_date" not in existing_cols_pd:
            with engine.begin() as conn:
                conn.execute(text_pd("ALTER TABLE staging_requests ADD COLUMN production_date DATE"))
            logger.info("Migration: added production_date column to staging_requests")
        if "last_synced_at" not in existing_cols_pd:
            with engine.begin() as conn:
                conn.execute(text_pd("ALTER TABLE staging_requests ADD COLUMN last_synced_at TIMESTAMP WITH TIME ZONE"))
            logger.info("Migration: added last_synced_at column to staging_requests")
except Exception as e:
    logger.warning(f"Migration warning (production_date/last_synced_at): {e}")

# Auto-migration: add container/weight columns to receipts
try:
    from sqlalchemy import inspect as sa_inspect3, text as text3
    _inspector3 = sa_inspect3(engine)
    if "receipts" in _inspector3.get_table_names():
        existing_cols3 = [c["name"] for c in _inspector3.get_columns("receipts")]
        new_cols = {
            "container_count": "FLOAT",
            "container_unit": "VARCHAR(30)",
            "weight_per_container": "FLOAT",
            "weight_unit": "VARCHAR(10)",
        }
        for col_name, col_type in new_cols.items():
            if col_name not in existing_cols3:
                with engine.begin() as conn:
                    conn.execute(text3(f"ALTER TABLE receipts ADD COLUMN {col_name} {col_type}"))
                logger.info(f"Migration: added {col_name} column to receipts")
except Exception as e:
    logger.warning(f"Migration warning (receipt container/weight columns): {e}")

# Auto-migration: add raw_material_row_allocations column to receipts
try:
    from sqlalchemy import inspect as sa_inspect_rmra, text as text_rmra
    _inspector_rmra = sa_inspect_rmra(engine)
    if "receipts" in _inspector_rmra.get_table_names():
        existing_cols_rmra = [c["name"] for c in _inspector_rmra.get_columns("receipts")]
        if "raw_material_row_allocations" not in existing_cols_rmra:
            with engine.begin() as conn:
                conn.execute(text_rmra("ALTER TABLE receipts ADD COLUMN raw_material_row_allocations JSON"))
            logger.info("Migration: added raw_material_row_allocations column to receipts")
except Exception as e:
    logger.warning(f"Migration warning (raw_material_row_allocations): {e}")

# Auto-migration: add inventory_tracked column to products
try:
    from sqlalchemy import inspect as sa_inspect4, text as text4
    _inspector4 = sa_inspect4(engine)
    if "products" in _inspector4.get_table_names():
        existing_cols4 = [c["name"] for c in _inspector4.get_columns("products")]
        if "inventory_tracked" not in existing_cols4:
            with engine.begin() as conn:
                conn.execute(text4("ALTER TABLE products ADD COLUMN inventory_tracked BOOLEAN DEFAULT TRUE"))
            logger.info("Migration: added inventory_tracked column to products")
except Exception as e:
    logger.warning(f"Migration warning (inventory_tracked): {e}")

# Auto-migration: add gal_per_case column to products (for BOL report: gallons per case for finished goods)
try:
    from sqlalchemy import inspect as sa_inspect_gpc, text as text_gpc
    _inspector_gpc = sa_inspect_gpc(engine)
    if "products" in _inspector_gpc.get_table_names():
        existing_cols_gpc = [c["name"] for c in _inspector_gpc.get_columns("products")]
        if "gal_per_case" not in existing_cols_gpc:
            with engine.begin() as conn:
                conn.execute(text_gpc("ALTER TABLE products ADD COLUMN gal_per_case FLOAT"))
            logger.info("Migration: added gal_per_case column to products")
except Exception as e:
    logger.warning(f"Migration warning (gal_per_case): {e}")

# Auto-migration: add short_code column to products and backfill from names
try:
    from sqlalchemy import inspect as sa_inspect_sc, text as text_sc
    _inspector_sc = sa_inspect_sc(engine)
    if "products" in _inspector_sc.get_table_names():
        existing_cols_sc = [c["name"] for c in _inspector_sc.get_columns("products")]
        if "short_code" not in existing_cols_sc:
            with engine.begin() as conn:
                conn.execute(text_sc("ALTER TABLE products ADD COLUMN short_code VARCHAR(20)"))
                conn.execute(text_sc("CREATE UNIQUE INDEX ix_products_short_code ON products(short_code) WHERE short_code IS NOT NULL"))
            logger.info("Migration: added short_code column to products")

            # Backfill short codes for existing finished goods from their names
            import re as _re
            _FLAVOR_MAP = {
                "PASSION FRUIT": "PF", "PASSIONFRUIT": "PF",
                "DRAGON FRUIT": "DF", "DRAGONFRUIT": "DF",
                "MANGO": "MG", "GUAVA": "GV", "LEMON": "LM",
                "ORANGE": "OR", "PINEAPPLE": "PA", "COCONUT": "CO",
                "LYCHEE": "LY", "TAMARIND": "TM", "PAPAYA": "PP",
                "STRAWBERRY": "SB", "BANANA": "BN", "WATERMELON": "WM",
                "SOURSOP": "SS", "ACAI": "AC", "HIBISCUS": "HB",
                "BLUEBERRY": "BB", "PEACH": "PC", "GRAPE": "GR",
                "CRANBERRY": "CR", "POMEGRANATE": "PM", "GINGER": "GI",
                "CALAMANSI": "CL", "TURMERIC": "TR",
            }
            _FORM_MAP = {"JUICE": "J", "NECTAR": "N", "PUREE": "P", "CONCENTRATE": "X", "BLEND": "B"}
            _TYPE_MAP = {"CONVENTIONAL": "C", "ORGANIC": "O", "CONV": "C", "ORG": "O"}

            def _gen_short_code(name):
                upper = name.upper()
                size_match = _re.search(r"(\d+)\s*OZ", upper)
                size = size_match.group(1) if size_match else ""
                flavor = ""
                for flav, code in sorted(_FLAVOR_MAP.items(), key=lambda x: -len(x[0])):
                    if flav in upper:
                        flavor = code
                        break
                form = ""
                for f, code in _FORM_MAP.items():
                    if f in upper:
                        form = code
                        break
                ptype = ""
                for t, code in _TYPE_MAP.items():
                    if t in upper:
                        ptype = code
                        break
                if flavor and size:
                    return f"{flavor}{form}{size}{ptype}"
                return None

            from app.database import SessionLocal as _SL
            from app.models import Product as _P, Category as _C
            _sess = _SL()
            try:
                _finished_cats = [c.id for c in _sess.query(_C).filter(_C.type == "finished").all()]
                _products = _sess.query(_P).filter(_P.category_id.in_(_finished_cats), _P.short_code.is_(None)).all()
                _used_codes = set()
                for p in _products:
                    sc = _gen_short_code(p.name)
                    if sc and sc not in _used_codes:
                        p.short_code = sc
                        _used_codes.add(sc)
                        logger.info(f"Backfill short_code: '{p.name}' -> '{sc}'")
                    elif sc:
                        dedup = f"{sc}{p.id[-3:]}"
                        p.short_code = dedup
                        _used_codes.add(dedup)
                        logger.info(f"Backfill short_code (dedup): '{p.name}' -> '{dedup}'")
                _sess.commit()
            finally:
                _sess.close()
except Exception as e:
    logger.warning(f"Migration warning (short_code): {e}")

# Auto-migration: add badge_id column to users (for forklift badge login)
try:
    from sqlalchemy import inspect as sa_inspect_badge, text as text_badge
    _inspector_badge = sa_inspect_badge(engine)
    if "users" in _inspector_badge.get_table_names():
        existing_cols_badge = [c["name"] for c in _inspector_badge.get_columns("users")]
        if "badge_id" not in existing_cols_badge:
            with engine.begin() as conn:
                conn.execute(text_badge("ALTER TABLE users ADD COLUMN badge_id VARCHAR(50) UNIQUE"))
                conn.execute(text_badge("CREATE INDEX ix_users_badge_id ON users(badge_id)"))
            logger.info("Migration: added badge_id column to users")
except Exception as e:
    logger.warning(f"Migration warning (badge_id): {e}")

# Auto-migration: create forklift_requests table (if not exists)
try:
    from sqlalchemy import inspect as sa_inspect_fr, text as text_fr
    _inspector_fr = sa_inspect_fr(engine)
    if "forklift_requests" not in _inspector_fr.get_table_names():
        with engine.begin() as conn:
            conn.execute(text_fr("""
                CREATE TABLE forklift_requests (
                    id VARCHAR(50) PRIMARY KEY,
                    product_id VARCHAR(50) NOT NULL REFERENCES products(id),
                    lot_number VARCHAR(100),
                    production_date TIMESTAMP WITH TIME ZONE,
                    expiration_date TIMESTAMP WITH TIME ZONE,
                    shift_id VARCHAR(50) REFERENCES production_shifts(id),
                    line_id VARCHAR(50) REFERENCES production_lines(id),
                    cases_per_pallet INTEGER,
                    total_full_pallets INTEGER DEFAULT 0,
                    total_partial_pallets INTEGER DEFAULT 0,
                    total_cases FLOAT DEFAULT 0,
                    status VARCHAR(20) DEFAULT 'scanning',
                    receipt_id VARCHAR(50) REFERENCES receipts(id),
                    scanned_by VARCHAR(50) NOT NULL REFERENCES users(id),
                    approved_by VARCHAR(50) REFERENCES users(id),
                    approved_at TIMESTAMP WITH TIME ZONE,
                    submitted_at TIMESTAMP WITH TIME ZONE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            """))
        logger.info("Migration: created forklift_requests table")
except Exception as e:
    logger.warning(f"Migration warning (forklift_requests): {e}")

# Auto-migration: create pallet_licences table (if not exists)
try:
    from sqlalchemy import inspect as sa_inspect_pl, text as text_pl
    _inspector_pl = sa_inspect_pl(engine)
    if "pallet_licences" not in _inspector_pl.get_table_names():
        with engine.begin() as conn:
            conn.execute(text_pl("""
                CREATE TABLE pallet_licences (
                    id VARCHAR(50) PRIMARY KEY,
                    licence_number VARCHAR(100) UNIQUE NOT NULL,
                    receipt_id VARCHAR(50) REFERENCES receipts(id),
                    forklift_request_id VARCHAR(50) REFERENCES forklift_requests(id),
                    product_id VARCHAR(50) NOT NULL REFERENCES products(id),
                    lot_number VARCHAR(100),
                    storage_area_id VARCHAR(50) REFERENCES storage_areas(id),
                    storage_row_id VARCHAR(50) REFERENCES storage_rows(id),
                    cases INTEGER,
                    is_partial BOOLEAN DEFAULT FALSE,
                    sequence INTEGER,
                    status VARCHAR(20) DEFAULT 'pending',
                    transfer_id VARCHAR(50) REFERENCES inventory_transfers(id),
                    scanned_by VARCHAR(50) REFERENCES users(id),
                    scanned_at TIMESTAMP WITH TIME ZONE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE
                )
            """))
            conn.execute(text_pl("CREATE INDEX ix_pallet_licences_licence_number ON pallet_licences(licence_number)"))
            conn.execute(text_pl("CREATE INDEX ix_pallet_licences_receipt_id ON pallet_licences(receipt_id)"))
            conn.execute(text_pl("CREATE INDEX ix_pallet_licences_status ON pallet_licences(status)"))
        logger.info("Migration: created pallet_licences table")
except Exception as e:
    logger.warning(f"Migration warning (pallet_licences): {e}")

# Auto-migration: add pallet_licence_ids to inventory_transfers
try:
    from sqlalchemy import inspect as sa_inspect_pli, text as text_pli
    _inspector_pli = sa_inspect_pli(engine)
    if "inventory_transfers" in _inspector_pli.get_table_names():
        existing_cols_pli = [c["name"] for c in _inspector_pli.get_columns("inventory_transfers")]
        if "pallet_licence_ids" not in existing_cols_pli:
            with engine.begin() as conn:
                conn.execute(text_pli("ALTER TABLE inventory_transfers ADD COLUMN pallet_licence_ids JSON"))
            logger.info("Migration: added pallet_licence_ids column to inventory_transfers")
except Exception as e:
    logger.warning(f"Migration warning (pallet_licence_ids): {e}")

# Auto-migration: create transfer_scan_events table
try:
    from sqlalchemy import inspect as sa_inspect_ts, text as text_ts
    _inspector_ts = sa_inspect_ts(engine)
    if "transfer_scan_events" not in _inspector_ts.get_table_names():
        with engine.begin() as conn:
            conn.execute(text_ts("""
                CREATE TABLE transfer_scan_events (
                    id VARCHAR(50) PRIMARY KEY,
                    transfer_id VARCHAR(50) NOT NULL REFERENCES inventory_transfers(id),
                    licence_number VARCHAR(100) NOT NULL,
                    licence_id VARCHAR(50) REFERENCES pallet_licences(id),
                    on_list BOOLEAN NOT NULL,
                    scanned_by VARCHAR(50) REFERENCES users(id),
                    scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            """))
            conn.execute(text_ts("CREATE INDEX ix_transfer_scan_events_transfer_id ON transfer_scan_events(transfer_id)"))
        logger.info("Migration: created transfer_scan_events table")
except Exception as e:
    logger.warning(f"Migration warning (transfer_scan_events): {e}")

# Auto-migration: add forklift submission fields to inventory_transfers
try:
    from sqlalchemy import inspect as sa_inspect_fks, text as text_fks
    _inspector_fks = sa_inspect_fks(engine)
    if "inventory_transfers" in _inspector_fks.get_table_names():
        existing_cols_fks = [c["name"] for c in _inspector_fks.get_columns("inventory_transfers")]
        fks_cols = {
            "forklift_submitted_at": "TIMESTAMP WITH TIME ZONE",
            "forklift_notes": "TEXT",
            "skipped_pallet_ids": "JSON",
        }
        for col_name, col_type in fks_cols.items():
            if col_name not in existing_cols_fks:
                with engine.begin() as conn:
                    conn.execute(text_fks(f"ALTER TABLE inventory_transfers ADD COLUMN {col_name} {col_type}"))
                logger.info(f"Migration: added {col_name} to inventory_transfers")
except Exception as e:
    logger.warning(f"Migration warning (forklift submission fields): {e}")

# Data fix: populate missing sub_location_id from storage_row's parent sub_location (v2)
try:
    from sqlalchemy import text as text_fix
    with engine.begin() as conn:
        result = conn.execute(text_fix("""
            UPDATE receipts r
            SET sub_location_id = sr.sub_location_id
            FROM storage_rows sr
            WHERE r.storage_row_id = sr.id
              AND r.sub_location_id IS NULL
              AND sr.sub_location_id IS NOT NULL
        """))
        if result.rowcount > 0:
            logger.info(f"Data fix: populated sub_location_id for {result.rowcount} receipt(s) from storage_row")
except Exception as e:
    logger.warning(f"Data fix warning (sub_location_id): {e}")

# Initialize FastAPI app
app = FastAPI(
    title="Sunberry Inventory Management API",
    description="Backend API for Sunberry Inventory Management System",
    version="1.0.0",
    docs_url="/docs" if settings.DEBUG else None,  # Disable in production
    redoc_url="/redoc" if settings.DEBUG else None,  # Disable in production
)

# Rate limiting storage (in-memory, use Redis for production)
rate_limit_store: Dict[str, list] = defaultdict(list)

class RateLimitMiddleware(BaseHTTPMiddleware):
    """Simple rate limiting middleware"""
    async def dispatch(self, request: Request, call_next):
        if not settings.RATE_LIMIT_ENABLED:
            return await call_next(request)
        
        # Get client IP
        client_ip = request.client.host if request.client else "unknown"
        
        # Check if it's a login endpoint
        is_login = request.url.path in ("/api/auth/login", "/api/auth/badge-login")
        limit = settings.RATE_LIMIT_LOGIN_PER_MINUTE if is_login else settings.RATE_LIMIT_PER_MINUTE
        
        # Clean old entries (older than 1 minute)
        current_time = time.time()
        rate_limit_store[client_ip] = [
            timestamp for timestamp in rate_limit_store[client_ip]
            if current_time - timestamp < 60
        ]
        
        # Check rate limit
        if len(rate_limit_store[client_ip]) >= limit:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": f"Rate limit exceeded. Maximum {limit} requests per minute."
                }
            )
        
        # Add current request
        rate_limit_store[client_ip].append(current_time)
        
        return await call_next(request)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses"""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        
        # Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        
        # Only add HSTS in production (HTTPS)
        if not settings.DEBUG:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        
        return response

# Exception handlers
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Handle HTTP exceptions - hide details in production"""
    if settings.DEBUG:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail}
        )
    else:
        # In production, return generic messages
        if exc.status_code == 404:
            detail = "Resource not found"
        elif exc.status_code == 401:
            detail = "Authentication required"
        elif exc.status_code == 403:
            detail = "Access denied"
        elif exc.status_code == 500:
            detail = "Internal server error"
        else:
            detail = "An error occurred"
        
        logger.error(f"HTTP {exc.status_code}: {exc.detail} - Path: {request.url.path}")
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": detail}
        )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handle validation errors - hide details in production"""
    if settings.DEBUG:
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors(), "body": exc.body}
        )
    else:
        logger.warning(f"Validation error: {exc.errors()} - Path: {request.url.path}")
        return JSONResponse(
            status_code=422,
            content={"detail": "Invalid input data"}
        )

@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle all other exceptions - hide details in production"""
    logger.exception(f"Unhandled exception: {exc} - Path: {request.url.path}")
    
    if settings.DEBUG:
        import traceback
        return JSONResponse(
            status_code=500,
            content={
                "detail": str(exc),
                "traceback": traceback.format_exc()
            }
        )
    else:
        return JSONResponse(
            status_code=500,
            content={"detail": "An internal error occurred"}
        )

# Add security headers middleware (first)
app.add_middleware(SecurityHeadersMiddleware)

# Add rate limiting middleware
app.add_middleware(RateLimitMiddleware)

# Configure CORS with proper origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept"],
    expose_headers=["Content-Type", "Authorization"],
)

# Security scheme
security = HTTPBearer()

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(users.router, prefix="/api/users", tags=["Users"])
app.include_router(products.router, prefix="/api/products", tags=["Products"])
app.include_router(receipts.router, prefix="/api/receipts", tags=["Receipts"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(scanner.router, prefix="/api/scanner", tags=["Scanner"])
app.include_router(pallet_licences.router, prefix="/api/pallet-licences", tags=["Pallet Licences"])
app.include_router(master_data.router, prefix="/api/master-data", tags=["Master Data"])
app.include_router(service.router, prefix="/api/service", tags=["Service-to-Service"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "Sunberry Inventory Management API",
        "version": "1.0.0",
        "docs": "/docs",
        "redoc": "/redoc"
    }

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "message": "API is running"}

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG
    )
