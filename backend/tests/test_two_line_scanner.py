"""
Tests for one-driver / two-line forklift scanning.

Covers the three backend changes:
  1. Session guard is per-(driver, line): L1 + L2 may run together, but a second
     session for the SAME line is refused. A 3rd line is capped.
  2. The 3h auto-submit is per-driver, not per-session: a quiet line does NOT
     close while the other line is active; a fully-idle driver closes both.
  3. A mis-stickered pallet (right line suffix, wrong product) is rejected with
     a message naming the line and the product the line is running.
"""
from datetime import datetime, timezone, timedelta

import pytest

from app.models import (
    User, Warehouse, Category, Product, ProductionLine,
    Location, SubLocation, StorageArea, StorageRow,
    ForkliftRequest, PalletLicence,
)
from app.utils.auth import get_password_hash
from app.enums import ForkliftRequestStatus, PalletStatus
from app.constants import STALE_FORKLIFT_SESSION_HOURS
from app.services import scanner_service
from app.exceptions import ValidationError


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def warehouse(db_session):
    wh = Warehouse(id="wh-a", name="Plant A", code="PA", type="owned", is_active=True)
    db_session.add(wh)
    db_session.commit()
    return wh


@pytest.fixture
def forklift(db_session, warehouse):
    user = User(
        id="fk-1", username="driver", name="Driver",
        email="driver@plant.com", hashed_password=get_password_hash("pw"),
        role="forklift", is_active=True, warehouse_id="wh-a",
    )
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def fg_setup(db_session, warehouse):
    """Finished category, two production lines (+ a third), two products, a row."""
    cat = Category(id="cat-fg", name="Finished", type="finished")
    db_session.add(cat)

    lines = [
        ProductionLine(id="line-1", name="L1", warehouse_id="wh-a", is_active=True),
        ProductionLine(id="line-2", name="L2", warehouse_id="wh-a", is_active=True),
        ProductionLine(id="line-3", name="L3", warehouse_id="wh-a", is_active=True),
    ]
    db_session.add_all(lines)

    mango = Product(id="p-mango", name="Mango", category_id="cat-fg",
                    short_code="MANGO", is_active=True, default_cases_per_pallet=50, expire_years=1)
    pine = Product(id="p-pine", name="Pineapple", category_id="cat-fg",
                   short_code="PINE", is_active=True, default_cases_per_pallet=50, expire_years=1)
    guava = Product(id="p-guava", name="Guava", category_id="cat-fg",
                    short_code="GUAVA", is_active=True, default_cases_per_pallet=50, expire_years=1)
    db_session.add_all([mango, pine, guava])

    loc = Location(id="loc-1", name="Main", warehouse_id="wh-a")
    subloc = SubLocation(id="subloc-1", name="Sub", location_id="loc-1")
    area = StorageArea(id="area-1", name="Area", location_id="loc-1", sub_location_id="subloc-1")
    row = StorageRow(id="row-1", name="FG-01", sub_location_id="subloc-1",
                     storage_area_id="area-1", pallet_capacity=20, occupied_pallets=0)
    db_session.add_all([loc, subloc, area, row])
    db_session.commit()
    return {"category": cat, "mango": mango, "pine": pine, "row": row}


def _make_session(db, *, line_id, lot, scanned_by, last_activity, pallets=0):
    """Create a SCANNING ForkliftRequest directly, with N pending pallets."""
    now = datetime.now(timezone.utc)
    fr = ForkliftRequest(
        id=f"fr-{line_id}-{scanned_by}",
        product_id="p-mango",
        lot_number=lot,
        production_date=now,
        expiration_date=now + timedelta(days=365),
        line_id=line_id,
        cases_per_pallet=50,
        total_full_pallets=pallets,
        total_partial_pallets=0,
        total_cases=pallets * 50,
        status=ForkliftRequestStatus.SCANNING,
        scanned_by=scanned_by,
        warehouse_id="wh-a",
        last_activity_at=last_activity,
    )
    db.add(fr)
    db.flush()
    for i in range(pallets):
        db.add(PalletLicence(
            id=f"pl-{fr.id}-{i}", licence_number=f"{lot}-MANGO-{i + 1:03d}",
            forklift_request_id=fr.id, product_id="p-mango", lot_number=lot,
            cases=50, is_partial=False, sequence=i + 1,
            status=PalletStatus.PENDING, scanned_by=scanned_by, warehouse_id="wh-a",
        ))
    db.commit()
    return fr


# ---------------------------------------------------------------------------
# 1. Per-(driver, line) session guard + 2-line cap
# ---------------------------------------------------------------------------

class TestPerLineGuard:
    def test_two_lines_allowed_together(self, db_session, forklift, fg_setup):
        fr1 = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", forklift)
        fr2 = scanner_service.create_forklift_request(db_session, "MP06226L2-PINE-001", forklift)
        assert fr1.line_id == "line-1"
        assert fr2.line_id == "line-2"
        open_lines = {
            s.line_id for s in db_session.query(ForkliftRequest)
            .filter(ForkliftRequest.scanned_by == "fk-1",
                    ForkliftRequest.status == ForkliftRequestStatus.SCANNING).all()
        }
        assert open_lines == {"line-1", "line-2"}

    def test_second_session_same_line_refused(self, db_session, forklift, fg_setup):
        scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", forklift)
        with pytest.raises(ValidationError, match="already have an open session for this line"):
            scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-050", forklift)

    def test_third_line_capped(self, db_session, forklift, fg_setup):
        scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", forklift)
        scanner_service.create_forklift_request(db_session, "MP06226L2-PINE-001", forklift)
        with pytest.raises(ValidationError, match="Only 2 lines"):
            scanner_service.create_forklift_request(db_session, "MP06226L3-GUAVA-001", forklift)

    def test_unreadable_line_refused(self, db_session, forklift, fg_setup):
        # A lot with no resolvable line (no configured line / no suffix).
        with pytest.raises(ValidationError, match="Could not read the production line"):
            scanner_service.create_forklift_request(db_session, "PLAINLOT-MANGO-001", forklift)


# ---------------------------------------------------------------------------
# 2. Per-driver 3h auto-submit
# ---------------------------------------------------------------------------

class TestPerDriverAutoSubmit:
    def test_idle_line_kept_open_while_other_active(self, db_session, forklift, fg_setup):
        now = datetime.now(timezone.utc)
        old = now - timedelta(hours=STALE_FORKLIFT_SESSION_HOURS + 1)
        # L1 idle for hours, L2 scanned just now → driver is still active.
        _make_session(db_session, line_id="line-1", lot="MP06226L1", scanned_by="fk-1", last_activity=old, pallets=3)
        _make_session(db_session, line_id="line-2", lot="MP06226L2", scanned_by="fk-1", last_activity=now, pallets=2)

        result = scanner_service.auto_close_stale_sessions(db_session)
        assert result == {"auto_submitted": 0, "auto_cancelled_empty": 0}
        statuses = {fr.line_id: fr.status for fr in db_session.query(ForkliftRequest).all()}
        assert statuses == {"line-1": ForkliftRequestStatus.SCANNING,
                            "line-2": ForkliftRequestStatus.SCANNING}

    def test_fully_idle_driver_closes_both(self, db_session, forklift, fg_setup):
        old = datetime.now(timezone.utc) - timedelta(hours=STALE_FORKLIFT_SESSION_HOURS + 1)
        # Both lines idle past the window: one with pallets, one empty.
        _make_session(db_session, line_id="line-1", lot="MP06226L1", scanned_by="fk-1", last_activity=old, pallets=4)
        _make_session(db_session, line_id="line-2", lot="MP06226L2", scanned_by="fk-1", last_activity=old, pallets=0)

        result = scanner_service.auto_close_stale_sessions(db_session)
        assert result == {"auto_submitted": 1, "auto_cancelled_empty": 1}
        by_line = {fr.line_id: fr for fr in db_session.query(ForkliftRequest).all()}
        assert by_line["line-1"].status == ForkliftRequestStatus.SUBMITTED
        assert by_line["line-1"].auto_submitted_at is not None
        assert by_line["line-2"].status == ForkliftRequestStatus.CANCELLED
        assert by_line["line-2"].cancelled_reason == "empty_timeout"


# ---------------------------------------------------------------------------
# 3. Mis-sticker rejection message
# ---------------------------------------------------------------------------

class TestMisStickerMessage:
    def test_wrong_product_for_line_named_in_error(self, db_session, forklift, fg_setup):
        fr = scanner_service.create_forklift_request(db_session, "MP06226L1-MANGO-001", forklift)
        # Same L1 lot/suffix but the L2 product (PINE) — a mis-stickered pallet.
        with pytest.raises(ValidationError) as exc:
            scanner_service.scan_pallet(
                db_session, fr.id, "MP06226L1-PINE-002", "row-1",
                False, None, forklift,
            )
        msg = str(exc.value)
        assert "Check the sticker" in msg
        assert "Mango" in msg  # names what the line is running
