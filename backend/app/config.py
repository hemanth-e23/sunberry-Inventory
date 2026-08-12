from pydantic_settings import BaseSettings
from typing import List, Optional
import sys


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql://username:password@localhost:5432/sunberry_inventory"

    # JWT
    SECRET_KEY: str = "your-super-secret-key-change-this-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # Application
    DEBUG: bool = False
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # CORS - comma-separated list of allowed origins
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # Service-to-service API key (used by /api/service/* endpoints)
    SERVICE_API_KEY: str = ""

    # KPI dashboard bearer token (used by /api/kpi/* endpoints)
    KPI_API_TOKEN: str = ""

    # Production app integration (optional — leave empty to disable)
    PRODUCTION_API_URL: str = ""
    PRODUCTION_API_KEY: str = ""

    # Rate limiting — configure in .env
    # Enabled by default: a runaway client loop (a React effect that refires on
    # its own state change) once put ~800 requests through in four minutes and
    # exhausted the connection pool. The limiter is the backstop for that.
    RATE_LIMIT_ENABLED: bool = True
    RATE_LIMIT_PER_MINUTE: int = 300
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 5
    # Cap on how many distinct client IPs we track. The store is in-process and
    # unbounded growth is itself a leak, so the oldest bucket is evicted.
    RATE_LIMIT_MAX_TRACKED_IPS: int = 10000

    # ── Database connection pool ────────────────────────────────────────────
    # These were previously SQLAlchemy defaults (5 + 10, 30s timeout), which
    # capped the whole app at 15 concurrent DB-touching requests. Because
    # get_db() holds its connection for the entire request (auth included),
    # that ceiling was reached routinely and every further request blocked 30s
    # in checkout before failing. Sized here for 40-100 concurrent devices:
    # DB_POOL_SIZE + DB_MAX_OVERFLOW connections per uvicorn worker.
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 10
    # Fail fast. A short checkout timeout sheds load instead of building a
    # multi-minute backlog of requests whose clients have already given up.
    DB_POOL_TIMEOUT: int = 10
    DB_POOL_RECYCLE: int = 1800
    # Hard ceiling enforced by PostgreSQL itself, so no application bug can
    # produce an unbounded query. Reports are the only legitimately slow path;
    # raise this (or override per-session) if one needs longer.
    DB_STATEMENT_TIMEOUT_MS: int = 30000

    # ── Resilience ──────────────────────────────────────────────────────────
    # Seconds of continuous pool saturation before /api/health reports 503.
    # Must exceed a normal traffic burst so a spike doesn't trigger a restart.
    POOL_UNHEALTHY_AFTER_SECONDS: int = 60
    # Seconds of continuous saturation before the watchdog exits the process so
    # the container restart policy can recover it. 0 disables the watchdog.
    POOL_EXIT_AFTER_SECONDS: int = 120
    # Server-side request deadline. Set above DB_STATEMENT_TIMEOUT_MS so a
    # runaway query surfaces as a real database error rather than a timeout.
    REQUEST_TIMEOUT_SECONDS: int = 45

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    def get_cors_origins(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        if self.DEBUG:
            return [
                "http://localhost:5173",
                "http://localhost:3000",
                "http://127.0.0.1:5173",
                "http://127.0.0.1:3000",
            ] + [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        else:
            origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
            if not origins:
                raise ValueError("CORS_ORIGINS must be set in production mode")
            return origins


settings = Settings()

# Validate SECRET_KEY in production
if not settings.DEBUG:
    default_key = "your-super-secret-key-change-this-in-production"
    if settings.SECRET_KEY == default_key:
        print("ERROR: SECRET_KEY is using default value. This is INSECURE!")
        print("Generate one with: openssl rand -hex 32")
        sys.exit(1)
    if len(settings.SECRET_KEY) < 32:
        print("WARNING: SECRET_KEY is too short. Recommended minimum: 32 characters")

if not settings.SERVICE_API_KEY:
    print("WARNING: SERVICE_API_KEY is not set. Service-to-service endpoints will only accept JWT auth.")
