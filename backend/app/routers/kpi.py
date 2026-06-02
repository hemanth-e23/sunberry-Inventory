"""
KPI live-production endpoint.

External KPI dashboard polls this for today's production counts. Auth is a
single bearer token (KPI_API_TOKEN); no JWT/user machinery — this token is
for a service, not humans.

Line attribution comes from parsing the L{N} segment of the printed pallet
licence number (format: MP{DDD}{YY}L{N}-{product}-{seq}). The palletizer
kiosk is physically tied to a line and prints L{N} into the sticker, so the
licence number is the most authoritative source of "which line produced
this pallet" — more reliable than ForkliftRequest.line_id, which is a
driver-selected dropdown.
"""
from datetime import date, datetime, timedelta, time as dtime
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import Warehouse, ProductionLine
from app.utils.lot_number import extract_line_number


def verify_kpi_token(authorization: Optional[str] = Header(None)):
    """Accept Authorization: Bearer <KPI_API_TOKEN>."""
    if not settings.KPI_API_TOKEN:
        raise HTTPException(status_code=503, detail="KPI endpoint not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization[7:].strip()
    if token != settings.KPI_API_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")


router = APIRouter(dependencies=[Depends(verify_kpi_token)])


def _resolve_production_day(
    warehouse: Warehouse,
    requested_date: Optional[str],
) -> tuple[date, datetime, datetime]:
    """Return (production_day_date, window_start_tzaware, window_end_tzaware).

    Production day for date D is [D at start_time, (D+1) at start_time) in
    warehouse-local TZ when start==end (24h block). If start!=end and end<=start,
    the window spans into the next day; if end>start, same-day window.
    """
    tz = ZoneInfo(warehouse.timezone or "UTC")
    start_t: dtime = warehouse.production_day_start
    end_t: dtime = warehouse.production_day_end

    if requested_date:
        try:
            d = date.fromisoformat(requested_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    else:
        local_now = datetime.now(tz)
        # Pick D such that now falls in [D at start_t, (D+1) at start_t)
        if local_now.time() >= start_t:
            d = local_now.date()
        else:
            d = local_now.date() - timedelta(days=1)

    win_start = datetime.combine(d, start_t, tzinfo=tz)
    # If end <= start, window crosses midnight into next day. If equal, full 24h.
    if end_t <= start_t:
        win_end = datetime.combine(d + timedelta(days=1), end_t, tzinfo=tz)
    else:
        win_end = datetime.combine(d, end_t, tzinfo=tz)
    return d, win_start, win_end


@router.get("/production")
async def get_production_today(
    warehouse_id: str = Query(..., description="Warehouse to query"),
    date: Optional[str] = Query(None, description="Production day YYYY-MM-DD (warehouse-local). Defaults to current production day."),
    db: Session = Depends(get_db),
):
    """Return per-line case counts for the production day."""
    warehouse = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    prod_day, win_start, win_end = _resolve_production_day(warehouse, date)

    # Parse line number from licence_number: MP{DDD}{YY}L{N}-{product}-{seq}
    # Use regexp_match → text[]; first element is the L digit group.
    rows = db.execute(
        text(
            """
            SELECT
                (regexp_match(pl.licence_number, '^MP\\d{3}\\d{2}L(\\d+)-'))[1] AS line_number,
                COALESCE(SUM(pl.cases), 0)::int                                    AS cases,
                COUNT(*) FILTER (WHERE NOT pl.is_partial)::int                    AS full_pallets,
                COUNT(*) FILTER (WHERE pl.is_partial)::int                        AS partial_pallets,
                MAX(pl.scanned_at)                                                AS last_scan_at
            FROM pallet_licences pl
            WHERE pl.warehouse_id = :wid
              AND pl.is_deleted = false
              AND pl.scanned_at >= :win_start
              AND pl.scanned_at <  :win_end
              AND pl.licence_number ~ '^MP\\d{3}\\d{2}L\\d+-'
            GROUP BY 1
            """
        ),
        {"wid": warehouse_id, "win_start": win_start, "win_end": win_end},
    ).all()

    by_line: dict[str, dict] = {}
    for r in rows:
        if not r.line_number:
            continue
        by_line[r.line_number] = {
            "line_number": r.line_number,
            "cases": r.cases,
            "full_pallets": r.full_pallets,
            "partial_pallets": r.partial_pallets,
            "last_scan_at": r.last_scan_at.isoformat() if r.last_scan_at else None,
        }

    # Zero-fill every active production line in this warehouse so KPI never
    # has to handle a missing key.
    active_lines = (
        db.query(ProductionLine)
        .filter(ProductionLine.warehouse_id == warehouse_id, ProductionLine.is_active.is_(True))
        .all()
    )
    for line in active_lines:
        digit = extract_line_number(line.name)
        if digit and digit not in by_line:
            by_line[digit] = {
                "line_number": digit,
                "cases": 0,
                "full_pallets": 0,
                "partial_pallets": 0,
                "last_scan_at": None,
            }

    lines_sorted = sorted(by_line.values(), key=lambda x: int(x["line_number"]))

    return {
        "warehouse_id": warehouse_id,
        "date": prod_day.isoformat(),
        "window_start": win_start.isoformat(),
        "window_end": win_end.isoformat(),
        "as_of": datetime.now(ZoneInfo(warehouse.timezone or "UTC")).isoformat(),
        "lines": lines_sorted,
    }
