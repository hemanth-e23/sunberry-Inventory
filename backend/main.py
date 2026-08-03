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
import uuid
import traceback as traceback_mod
from collections import defaultdict
from typing import Dict, Tuple

from app.config import settings
from app.database import engine, Base
from app.routers import auth, users, products, receipts, inventory, master_data, service, scanner, pallet_licences, reports, inter_warehouse_transfers, notifications
from app.routers import transfers, adjustments, holds, cycle_counts, staging
from app.routers import active_production, palletizer, kpi
from app.routers import ingredient_intakes, ingredient_containers, ingredient_staging, ingredient_cutover, ingredient_rows
from app.utils.logging_setup import setup_logging

# Configure logging — writes to stdout AND a rotating file at /app/logs/app.log
setup_logging(level_name="DEBUG" if settings.DEBUG else "INFO")
logger = logging.getLogger(__name__)

# Create database tables for fresh installs.
# Schema changes are managed via Alembic: `alembic upgrade head`
Base.metadata.create_all(bind=engine)
logger.info("Database tables verified/created.")

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

def _request_user_repr(request: Request) -> str:
    """Short identifier for the user behind a request, for log lines.
    Returns '-' if the request is unauthenticated or auth never ran.

    MUST NEVER trigger a DB load. This runs in the logging path AFTER the
    route's session has closed; if the request committed or rolled back, the
    cached User is expired+detached and touching an instrumented column
    (user.username) raises DetachedInstanceError — which previously masked the
    real 4xx as a CORS-less 500. We prefer a plain string captured by auth
    while the session was live, and otherwise read straight from __dict__ so
    SQLAlchemy never tries to refresh."""
    cached = getattr(request.state, "current_user_repr", None)
    if cached:
        return cached
    user = getattr(request.state, "current_user", None)
    if not user:
        return "-"
    d = getattr(user, "__dict__", {})
    return f"{d.get('username', '?')}({d.get('role', '?')})"


def _safe_body_for_log(body: bytes, path: str) -> str:
    """Decode and trim a request body for log output. Auth bodies are redacted
    because they contain passwords."""
    if not body:
        return ""
    if path.startswith("/api/auth/"):
        return "<redacted-auth>"
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary>"
    if len(text) > 500:
        return text[:500] + "...<truncated>"
    return text


# Plain-English hints for exception types that are otherwise cryptic, so a
# supervisor reading the log doesn't have to decode a stack trace.
_EXC_HINTS = {
    "DetachedInstanceError": "a database object was read after its session "
                             "closed (it was expired by a commit/rollback, "
                             "then accessed later in the request)",
    "IntegrityError": "a database constraint was violated (a duplicate, or a "
                      "required value was missing)",
    "OperationalError": "the database was unreachable or a query timed out",
    "DataError": "a value did not fit its database column type",
    "ProgrammingError": "a database schema mismatch (a column/table the code "
                        "expects is missing — often a migration not applied)",
}


def _log_request_error(request: Request, status: int, *, body: bytes = b"",
                       reason=None, exc: BaseException = None) -> None:
    """Emit ONE human-readable banner for a failed request, with clear
    START (╔ … ▼) and END (╚ … ✗) markers and a short request id tying every
    line together. Includes a full traceback only for real crashes (5xx).

    Never raises: logging must not turn one error into another.
    """
    try:
        req_id = getattr(request.state, "request_id", None) or "------"
        start = getattr(request.state, "start_time", None)
        took = f"   took={int((time.time() - start) * 1000)}ms" if start else ""
        level = logging.ERROR if status >= 500 else logging.WARNING

        lines = [
            f"╔═ ERROR ▼ req={req_id} " + "═" * 38,
            f"║ {request.method} {request.url.path}",
            f"║ user={_request_user_repr(request)}   status={status}{took}",
        ]
        if reason:
            lines.append(f"║ reason: {reason}")
        safe_body = _safe_body_for_log(body, request.url.path)
        if safe_body:
            lines.append(f"║ body: {safe_body}")
        if exc is not None:
            hint = _EXC_HINTS.get(type(exc).__name__)
            if hint:
                lines.append(f"║ cause: {type(exc).__name__} — {hint}")
            else:
                lines.append(f"║ cause: {type(exc).__name__}: {exc}")
            lines.append("║ ── traceback " + "─" * 40)
            tb = "".join(traceback_mod.format_exception(
                type(exc), exc, exc.__traceback__))
            for tl in tb.rstrip().splitlines():
                lines.append(f"║   {tl}")
        lines.append(f"╚═ END ✗ req={req_id} " + "═" * 40)

        request.state.error_logged = True
        logger.log(level, "\n" + "\n".join(lines))
    except Exception:
        # Absolute last resort — a logging failure must never break the request.
        try:
            logger.error("error-banner logging failed for %s %s (status=%s)",
                         request.method, request.url.path, status)
        except Exception:
            pass


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Log a single banner for every FAILED request (status >= 400 or an
    unhandled exception) with the user, path, body, timing, and — for real
    crashes — the traceback. This is the audit trail that lets a supervisor
    diagnose 'the forklift driver scanned X and got an error' after the fact.

    Successful responses are NOT logged (would be too noisy). The 4xx detail
    and 5xx traceback are produced here, in one place, so each error yields
    exactly one clean banner.
    """
    async def dispatch(self, request: Request, call_next):
        # Buffer the body up front so we can both log it and let the route
        # consume it. Re-attach it via a fresh ASGI receive callable.
        body = await request.body()

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        request = Request(request.scope, receive=receive)
        request.state.request_id = uuid.uuid4().hex[:6]
        request.state.start_time = time.time()

        try:
            response = await call_next(request)
        except Exception as exc:
            # An exception escaped the inner handlers; ServerErrorMiddleware
            # (just outside us) will turn it into a 500. Log it once here, with
            # the full traceback, then re-raise so the 500 response is produced.
            _log_request_error(request, 500, body=body, exc=exc)
            raise

        if response.status_code >= 400 and not getattr(
            request.state, "error_logged", False
        ):
            _log_request_error(
                request,
                response.status_code,
                body=body,
                reason=getattr(request.state, "error_reason", None),
            )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses"""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        
        # Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Swagger UI / ReDoc load their JS/CSS from the jsdelivr CDN, which the
        # strict app-wide CSP below would block (blank docs page). These pages
        # are only mounted in DEBUG, so relax CSP just for them.
        if request.url.path in ("/docs", "/redoc") or request.url.path.startswith("/docs/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "img-src 'self' data: https://fastapi.tiangolo.com; "
                "font-src 'self' data:; "
                "connect-src 'self'"
            )
        else:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; "
                "font-src 'self' data:; "
                "connect-src 'self'"
            )

        # Only add HSTS in production (HTTPS)
        if not settings.DEBUG:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        
        return response

# Exception handlers
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Translate HTTPExceptions into JSON responses.

    400 (ValidationError) and 409 (ConflictError) carry user-correctable
    messages like "Invalid licence number format" or "Shift must be set before
    approval" — these are safe and useful to show users in production so they
    can fix their input.

    401/403/404/500 stay generic in production to avoid leaking internals.

    Logging is handled by RequestLoggingMiddleware (it logs the full path,
    user, body, and the resolved status), so this handler does not log here.
    It only stashes the REAL detail (even when the client-facing detail is
    made generic in production) so the log banner shows the true reason.
    """
    request.state.error_reason = exc.detail
    if settings.DEBUG or exc.status_code in (400, 409):
        detail = exc.detail
    elif exc.status_code == 404:
        detail = "Resource not found"
    elif exc.status_code == 401:
        detail = "Authentication required"
    elif exc.status_code == 403:
        detail = "Access denied"
    elif exc.status_code == 500:
        detail = "Internal server error"
    else:
        detail = "An error occurred"
    return JSONResponse(status_code=exc.status_code, content={"detail": detail})

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handle validation errors - hide details in production.

    The real validation errors are stashed for the log banner (logging itself
    is done once, by RequestLoggingMiddleware)."""
    request.state.error_reason = f"validation: {exc.errors()}"
    if settings.DEBUG:
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors(), "body": exc.body}
        )
    else:
        return JSONResponse(
            status_code=422,
            content={"detail": "Invalid input data"}
        )

@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle all other exceptions - hide details in production.

    The middleware normally logs the banner+traceback as the exception passes
    through it; this guard logs here only if it somehow didn't (e.g. an
    exception raised outside RequestLoggingMiddleware), avoiding a duplicate."""
    if not getattr(request.state, "error_logged", False):
        _log_request_error(request, 500, exc=exc)

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

# Middleware order: Starlette applies these in reverse — the LAST added wraps
# everything else and runs FIRST per request. So with this order the logging
# middleware sees the final response status (including rate-limit 429s).
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# Configure CORS with proper origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept", "X-View-Warehouse", "X-Api-Key"],
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
app.include_router(transfers.router, prefix="/api/inventory", tags=["Transfers"])
app.include_router(adjustments.router, prefix="/api/inventory", tags=["Adjustments"])
app.include_router(holds.router, prefix="/api/inventory", tags=["Holds"])
app.include_router(cycle_counts.router, prefix="/api/inventory", tags=["Cycle Counts"])
app.include_router(staging.router, prefix="/api/inventory", tags=["Staging"])
app.include_router(scanner.router, prefix="/api/scanner", tags=["Scanner"])
app.include_router(pallet_licences.router, prefix="/api/pallet-licences", tags=["Pallet Licences"])
app.include_router(master_data.router, prefix="/api/master-data", tags=["Master Data"])
app.include_router(service.router, prefix="/api/service", tags=["Service-to-Service"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(inter_warehouse_transfers.router, prefix="/api/inter-warehouse-transfers", tags=["Inter-Warehouse Transfers"])
app.include_router(notifications.router, prefix="/api/notifications", tags=["Notifications"])
app.include_router(active_production.router, prefix="/api/active-production", tags=["Active Production"])
app.include_router(palletizer.router, prefix="/api/palletizer", tags=["Palletizer Kiosk"])
app.include_router(kpi.router, prefix="/api/kpi", tags=["KPI"])
app.include_router(ingredient_intakes.router, prefix="/api/ingredient-intakes", tags=["Ingredient Intakes"])
app.include_router(ingredient_containers.router, prefix="/api/ingredient-containers", tags=["Ingredient Containers"])
app.include_router(ingredient_staging.router, prefix="/api/ingredient-staging", tags=["Ingredient Staging"])
app.include_router(ingredient_cutover.router, prefix="/api/ingredient-cutover", tags=["Ingredient Cutover"])
app.include_router(ingredient_rows.router, prefix="/api/ingredient-rows", tags=["Ingredient Rows"])

@app.get("/")
async def root():
    """Root endpoint"""
    response = {
        "message": "Sunberry Inventory Management API",
        "version": "1.0.0",
    }
    if settings.DEBUG:
        response["docs"] = "/docs"
        response["redoc"] = "/redoc"
    return response

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
