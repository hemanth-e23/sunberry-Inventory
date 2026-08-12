from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.config import settings


def _engine_kwargs() -> dict:
    """Pool and timeout settings for the application engine.

    Previously this engine was created with no arguments at all, which meant
    SQLAlchemy's defaults: pool_size=5, max_overflow=10, pool_timeout=30. Since
    get_db() checks out a connection for the whole request (authentication
    included), that capped the entire application at 15 concurrent
    DB-touching requests — and every request past the cap blocked for a full
    30 seconds before failing, so a burst produced a backlog that outlived the
    clients waiting on it.
    """
    kwargs = {
        "pool_size": settings.DB_POOL_SIZE,
        "max_overflow": settings.DB_MAX_OVERFLOW,
        "pool_timeout": settings.DB_POOL_TIMEOUT,
        "pool_recycle": settings.DB_POOL_RECYCLE,
        # Verify a connection is alive before handing it out, so a database
        # restart or a dropped idle connection surfaces as one retry rather
        # than an error handed to a user.
        "pool_pre_ping": True,
    }
    # statement_timeout is PostgreSQL-specific. Applied as a connection option
    # so the database itself aborts a runaway query — a ceiling that holds
    # regardless of what the application code does. Guarded by dialect so a
    # non-PostgreSQL URL (a SQLite test harness, say) still works.
    if settings.DATABASE_URL.startswith("postgresql") and settings.DB_STATEMENT_TIMEOUT_MS > 0:
        kwargs["connect_args"] = {
            "options": f"-c statement_timeout={settings.DB_STATEMENT_TIMEOUT_MS}"
        }
    return kwargs


# Create database engine
engine = create_engine(settings.DATABASE_URL, **_engine_kwargs())

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Create base class for models
Base = declarative_base()


def pool_stats() -> dict:
    """Snapshot of connection-pool usage.

    Reads SQLAlchemy's in-memory counters only — it never checks out a
    connection, so it stays accurate (and cheap) precisely when the pool is
    exhausted and everything else is failing. Single source of truth for the
    health endpoint and the watchdog.
    """
    pool = engine.pool
    # QueuePool exposes these; other pool types (NullPool in some test setups)
    # do not, so degrade gracefully rather than raising from a health check.
    try:
        checked_out = pool.checkedout()
        capacity = settings.DB_POOL_SIZE + settings.DB_MAX_OVERFLOW
        return {
            "checked_out": checked_out,
            "capacity": capacity,
            "available": max(0, capacity - checked_out),
            "utilization": round(checked_out / capacity, 3) if capacity else 0.0,
            "saturated": checked_out >= capacity,
        }
    except AttributeError:
        return {
            "checked_out": 0,
            "capacity": 0,
            "available": 0,
            "utilization": 0.0,
            "saturated": False,
        }


# Dependency to get database session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
