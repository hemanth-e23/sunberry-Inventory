"""Application logging setup.

Logs are written to two sinks:
  1. stdout — visible via `docker logs sunberry-backend`
  2. {LOG_DIR}/app.log — persisted on disk, rotated at 10 MB with 30 backups
     kept (~300 MB max). LOG_DIR defaults to /app/logs. In docker-compose the
     `./backend:/app` bind mount makes this appear on the host at
     `./backend/logs/`, so a supervisor can `tail -f backend/logs/app.log`.

If the log directory cannot be created (e.g. running tests outside docker
without write permission to /app), file logging is skipped silently — stdout
still works.
"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


def setup_logging(level_name: str = "INFO", log_dir: str | None = None) -> None:
    """Configure the root logger. Safe to call once at process start."""
    log_dir = log_dir or os.environ.get("LOG_DIR", "/app/logs")
    level = getattr(logging, level_name.upper(), logging.INFO)
    formatter = logging.Formatter(_FORMAT)

    root = logging.getLogger()
    root.setLevel(level)

    # Replace any pre-existing handlers so calling setup_logging twice
    # (e.g. uvicorn auto-reload) doesn't multiply log lines.
    for h in list(root.handlers):
        root.removeHandler(h)

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(stream)

    try:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            os.path.join(log_dir, "app.log"),
            maxBytes=10 * 1024 * 1024,
            backupCount=30,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as e:
        root.warning("File logging disabled (could not use %s): %s", log_dir, e)
