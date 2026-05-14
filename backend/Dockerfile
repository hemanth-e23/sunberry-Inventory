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

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/api/health')" || exit 1

# Entrypoint runs `alembic upgrade head` before exec'ing the CMD, so a fresh
# container always boots against a migrated schema. Stop/start is enough — no
# more manual migration step.
#
# We invoke `sh` explicitly instead of `["/app/entrypoint.sh"]` so the script
# does not need a POSIX executable bit. The compose bind-mount (./backend:/app)
# can strip +x when the host is Windows/NTFS, which would otherwise make the
# entrypoint unexecutable even though `chmod +x` ran in the image build.
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
