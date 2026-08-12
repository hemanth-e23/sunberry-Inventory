# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --upgrade pip && \
    pip install -r requirements.txt

# Copy application code
COPY . .

# Make sure the entrypoint is executable even if git lost the +x bit on checkout.
RUN chmod +x /app/entrypoint.sh

# Create non-root user for security
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8000

# Health check.
#
# Uses urllib from the standard library, NOT requests and NOT curl. Neither is
# available here: `requests` is not in requirements.txt and this image installs
# only gcc and postgresql-client on top of python-slim, which ships no curl. The
# previous `import requests` check could therefore never succeed — harmless
# while nothing consumed the result, but now that an autoheal container acts on
# health status, a check that cannot pass would restart this container forever.
#
# urlopen raises on a non-2xx, so a 503 from a saturated pool correctly fails.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=5)" || exit 1

# Entrypoint runs `alembic upgrade head` before exec'ing the CMD, so a fresh
# container always boots against a migrated schema. Stop/start is enough — no
# more manual migration step.
#
# We invoke `sh` explicitly instead of `["/app/entrypoint.sh"]` so the script
# does not need a POSIX executable bit. The compose bind-mount (./backend:/app)
# can strip +x when the host is Windows/NTFS, which would otherwise make the
# entrypoint unexecutable even though `chmod +x` ran in the image build.
# Worker processes. This ran single-process until 2026-08, which meant one
# blocked request could stall every other request in the system: the endpoints
# are declared `async def` but execute synchronous SQLAlchemy, so a slow query
# blocks the event loop rather than yielding it. Multiple workers contain that
# blast radius to one process.
#
# uvicorn reads --workers from $WEB_CONCURRENCY, so this is overridable per
# environment without rebuilding the image. Total PostgreSQL connections =
# WEB_CONCURRENCY * (DB_POOL_SIZE + DB_MAX_OVERFLOW); keep that below the
# server's max_connections.
ENV WEB_CONCURRENCY=4

ENTRYPOINT ["sh", "/app/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
