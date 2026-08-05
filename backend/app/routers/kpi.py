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
    #
    # Production day is attributed by the forklift SESSION's created_at, NOT the
    # pallet's scanned_at. Two reasons:
    #   - Fix-ups: when a warehouse user adds a missed pallet to an already-
    #     submitted request days later, add_pallet_to_request keeps it on the
    #     ORIGINAL session. scanned_at is "today" but the session was created on
    #     the real production day — so it counts then, not now.
    #   - Overnight runs: the lot number rolls at midnight but the production day
    #     runs 05:30→05:30. created_at is a real timestamp, so the window groups
    #     a run that crosses midnight into one production day regardless of the
    #     lot date flipping mid-run.
    # The INNER join also drops manual / no-session pallets, which are out-of-band
    # corrections we deliberately exclude from production KPI.
    rows = db.execute(
        text(
            """
            SELECT
                (regexp_match(pl.licence_number, '^MP\\d{3}\\d{2}L(\\d+)-'))[1] AS line_number,
                COALESCE(SUM(pl.cases), 0)::int                                    AS cases,
                COUNT(*) FILTER (WHERE NOT pl.is_partial)::int                    AS full_pallets,
                COUNT(*) FILTER (WHERE pl.is_partial)::int                        AS partial_pallets,
                MIN(pl.scanned_at)                                                AS first_scan_at,
                MAX(pl.scanned_at)                                                AS last_scan_at
            FROM pallet_licences pl
            JOIN forklift_requests fr ON fr.id = pl.forklift_request_id
            WHERE pl.warehouse_id = :wid
              AND pl.is_deleted = false
              AND fr.created_at >= :win_start
              AND fr.created_at <  :win_end
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
            "first_scan_at": r.first_scan_at.isoformat() if r.first_scan_at else None,
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
                "first_scan_at": None,
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


@router.get("/production/detail")
async def get_production_detail(
    warehouse_id: str = Query(..., description="Warehouse to query"),
    date: Optional[str] = Query(None, description="Production day YYYY-MM-DD (warehouse-local). Defaults to current production day."),
    bucket_minutes: int = Query(30, description="Timeline bucket width: 15, 30, or 60 minutes."),
    db: Session = Depends(get_db),
):
    """Per-PRODUCT day totals plus a time-bucketed case timeline.

    `products` splits the day's output by product (and line) using the SAME
    day-attribution rule as /production (forklift session created_at), so it
    sums to the headline gauge number — this powers "today we're doing Guava
    3000 · POG 4000".

    `timeline` buckets pallets by their actual scanned_at into fixed windows
    (hourly / 30-min / 15-min) for the drill-down. A pallet lands its whole
    case count in the window it was scanned/closed in, so the series is
    pallet-granular (chunky), not per-case smooth. Pallets with no scanned_at
    can't be placed in time and are omitted here (still counted in `products`).
    """
    if bucket_minutes not in (15, 30, 60):
        raise HTTPException(status_code=400, detail="bucket_minutes must be 15, 30, or 60")

    warehouse = db.query(Warehouse).filter(Warehouse.id == warehouse_id).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    prod_day, win_start, win_end = _resolve_production_day(warehouse, date)

    # Per-product, per-line day totals. No scanned_at filter → matches headline.
    prod_rows = db.execute(
        text(
            """
            SELECT
                (regexp_match(pl.licence_number, '^MP\\d{3}\\d{2}L(\\d+)-'))[1] AS line_number,
                pl.product_id                                                  AS product_id,
                p.name                                                         AS product_name,
                p.short_code                                                   AS short_code,
                COALESCE(SUM(pl.cases), 0)::int                                AS cases,
                COUNT(*) FILTER (WHERE NOT pl.is_partial)::int                 AS full_pallets,
                COUNT(*) FILTER (WHERE pl.is_partial)::int                     AS partial_pallets
            FROM pallet_licences pl
            JOIN forklift_requests fr ON fr.id = pl.forklift_request_id
            LEFT JOIN products p ON p.id = pl.product_id
            WHERE pl.warehouse_id = :wid
              AND pl.is_deleted = false
              AND fr.created_at >= :win_start
              AND fr.created_at <  :win_end
              AND pl.licence_number ~ '^MP\\d{3}\\d{2}L\\d+-'
            GROUP BY 1, 2, 3, 4
            ORDER BY cases DESC
            """
        ),
        {"wid": warehouse_id, "win_start": win_start, "win_end": win_end},
    ).all()

    products = [
        {
            "line_number": r.line_number,
            "product_id": r.product_id,
            "product_name": r.product_name,
            "short_code": r.short_code,
            "cases": r.cases,
            "full_pallets": r.full_pallets,
            "partial_pallets": r.partial_pallets,
        }
        for r in prod_rows if r.line_number
    ]

    # Time-bucketed timeline. bucket_idx = whole windows elapsed since the
    # production-day start, measured on the pallet's actual scanned_at. Both
    # operands are absolute instants (timestamptz), so the subtraction is TZ-safe.
    bucket_sec = bucket_minutes * 60
    tl_rows = db.execute(
        text(
            """
            SELECT
                FLOOR(EXTRACT(EPOCH FROM (pl.scanned_at - CAST(:win_start AS timestamptz))) / CAST(:bsec AS double precision))::int AS bucket_idx,
                (regexp_match(pl.licence_number, '^MP\\d{3}\\d{2}L(\\d+)-'))[1]       AS line_number,
                pl.product_id                                                        AS product_id,
                p.name                                                               AS product_name,
                p.short_code                                                         AS short_code,
                COALESCE(SUM(pl.cases), 0)::int                                      AS cases,
                COUNT(*)::int                                                        AS pallets
            FROM pallet_licences pl
            JOIN forklift_requests fr ON fr.id = pl.forklift_request_id
            LEFT JOIN products p ON p.id = pl.product_id
            WHERE pl.warehouse_id = :wid
              AND pl.is_deleted = false
              AND fr.created_at >= :win_start
              AND fr.created_at <  :win_end
              AND pl.scanned_at IS NOT NULL
              AND pl.licence_number ~ '^MP\\d{3}\\d{2}L\\d+-'
            GROUP BY 1, 2, 3, 4, 5
            ORDER BY 1
            """
        ),
        {"wid": warehouse_id, "win_start": win_start, "win_end": win_end, "bsec": bucket_sec},
    ).all()

    n_buckets = max(1, int((win_end - win_start).total_seconds() // bucket_sec))
    timeline = []
    for r in tl_rows:
        # Drop out-of-window rows (e.g. a late fix-up whose scanned_at falls
        # outside this production day's clock).
        if r.line_number is None or r.bucket_idx is None or r.bucket_idx < 0 or r.bucket_idx >= n_buckets:
            continue
        bstart = win_start + timedelta(seconds=r.bucket_idx * bucket_sec)
        timeline.append({
            "bucket_start": bstart.isoformat(),
            "bucket_index": r.bucket_idx,
            "line_number": r.line_number,
            "product_id": r.product_id,
            "product_name": r.product_name,
            "short_code": r.short_code,
            "cases": r.cases,
            "pallets": r.pallets,
        })

    return {
        "warehouse_id": warehouse_id,
        "date": prod_day.isoformat(),
        "window_start": win_start.isoformat(),
        "window_end": win_end.isoformat(),
        "bucket_minutes": bucket_minutes,
        "num_buckets": n_buckets,
        "as_of": datetime.now(ZoneInfo(warehouse.timezone or "UTC")).isoformat(),
        "products": products,
        "timeline": timeline,
    }
