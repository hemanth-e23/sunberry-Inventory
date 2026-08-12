"""Connection-pool watchdog.

Background
----------
On 2026-08-10 and again on 2026-08-12 the backend became unresponsive and had
to be restarted by hand. In both cases the connection pool was fully checked
out, so every incoming request blocked in pool checkout and then failed — but
the *process* stayed alive. Docker's `restart: unless-stopped` only reacts to a
process exiting, and Compose does not act on healthcheck failure, so nothing
recovered the container automatically.

This module closes that gap from inside the application: if the pool stays
fully saturated for longer than any real burst could explain, we log the state
and exit. The container restart policy then brings the worker back.

Two independent recovery paths exist by design — this watchdog, and an autoheal
container watching /api/health. Either alone is enough; both together mean a
single failure of one mechanism does not turn into an outage.
"""
import logging
import os
import threading
import time
from typing import Optional

from app.config import settings
from app.database import pool_stats

logger = logging.getLogger(__name__)

# How often to sample. Short enough to time the exit threshold accurately,
# long enough to cost nothing (the sample is an in-memory counter read).
_SAMPLE_INTERVAL_SECONDS = 5

# Emit a warning once utilization crosses this, so the log shows pressure
# building well before it becomes an outage.
_WARN_UTILIZATION = 0.70

# Module-level state, published so the health endpoint can report the same
# saturation clock without maintaining a second one.
_saturated_since: Optional[float] = None
_lock = threading.Lock()


def saturated_for_seconds() -> float:
    """How long the pool has been continuously saturated. 0.0 if it is not."""
    with _lock:
        if _saturated_since is None:
            return 0.0
        return time.monotonic() - _saturated_since


def _record(stats: dict) -> float:
    """Update the saturation clock from one sample; return its duration."""
    global _saturated_since
    with _lock:
        if stats["saturated"]:
            if _saturated_since is None:
                _saturated_since = time.monotonic()
            return time.monotonic() - _saturated_since
        _saturated_since = None
        return 0.0


def _run() -> None:
    warned = False
    while True:
        time.sleep(_SAMPLE_INTERVAL_SECONDS)
        try:
            stats = pool_stats()
            if stats["capacity"] == 0:
                continue

            duration = _record(stats)

            # Early warning: pressure is visible here long before requests fail.
            if stats["utilization"] >= _WARN_UTILIZATION:
                if not warned:
                    logger.warning(
                        "DB pool pressure: %s/%s connections in use (%.0f%%)",
                        stats["checked_out"], stats["capacity"],
                        stats["utilization"] * 100,
                    )
                    warned = True
            else:
                warned = False

            if not duration:
                continue

            exit_after = settings.POOL_EXIT_AFTER_SECONDS
            if exit_after > 0 and duration >= exit_after:
                logger.critical(
                    "DB pool saturated (%s/%s) for %.0fs — exiting so the "
                    "container restart policy can recover this worker. If this "
                    "repeats, the cause is upstream: a request storm, an N+1 "
                    "query, or a pool sized too small for real traffic.",
                    stats["checked_out"], stats["capacity"], duration,
                )
                # Flush handlers before exiting — the reason for the restart is
                # the whole point, and an unflushed log loses it.
                for handler in logging.getLogger().handlers:
                    try:
                        handler.flush()
                    except Exception:
                        pass
                # os._exit, not sys.exit: we are on a non-main thread, where
                # SystemExit would only unwind this thread and leave the wedged
                # process running.
                os._exit(1)
            else:
                logger.error(
                    "DB pool fully saturated (%s/%s) for %.0fs; will exit at %ss",
                    stats["checked_out"], stats["capacity"], duration, exit_after,
                )
        except Exception:
            # A monitor must never be the thing that takes the process down.
            logger.exception("pool watchdog sample failed")


def start_watchdog() -> None:
    """Start the watchdog on a daemon thread. Safe to call once per worker."""
    if settings.POOL_EXIT_AFTER_SECONDS <= 0:
        logger.info("pool watchdog disabled (POOL_EXIT_AFTER_SECONDS=0)")
        return
    thread = threading.Thread(target=_run, name="pool-watchdog", daemon=True)
    thread.start()
    logger.info(
        "pool watchdog started: exit after %ss of saturation, capacity %s",
        settings.POOL_EXIT_AFTER_SECONDS,
        settings.DB_POOL_SIZE + settings.DB_MAX_OVERFLOW,
    )
