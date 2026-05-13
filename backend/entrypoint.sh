#!/bin/sh
# Run pending Alembic migrations before starting the app.
# `set -e` makes the container fail fast if a migration errors — better than
# starting a backend that will crash on every request because the schema is stale.
set -e

echo "[entrypoint] applying database migrations..."
alembic upgrade head
echo "[entrypoint] migrations complete."

echo "[entrypoint] starting application..."
exec "$@"
