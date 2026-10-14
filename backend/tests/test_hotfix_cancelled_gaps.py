"""Hotfix 2026-10-14: a misread sticker blocked approval.

Production: request for MP28226L2-MAN64O held a cancelled 'P28226L2-MAN64O-005'
(the gun dropped the leading 'M'; the reviewer removed it). The approval gap
check still grouped it, invented lot 'P28226L2' and refused approval until its
#001-004 were "added", which the review card (hiding cancelled pallets) never
showed.
"""
import pytest

from app.enums import ForkliftRequestStatus, PalletStatus
from app.exceptions import ValidationError
from app.models import ForkliftRequest, PalletLicence
from app.services import scanner_service

# Fixtures and helpers shared with the FG lifecycle tests.
from tests.test_fg_pallet_lifecycle import LOT, _pallet, _session, fg  # noqa: F401


def _misread(db, fr_id, seq, status=PalletStatus.CANCELLED):
    lot = LOT[1:]  # 'P28026L1' — first character dropped by the scanner
    pl = PalletLicence(
        id=f"pl-misread-{seq}", licence_number=f"{lot}-MANGO-{seq:03d}", receipt_id=None,
        forklift_request_id=fr_id, product_id="p-mango", lot_number=lot, sequence=seq,
        cases=40, status=status.value, storage_row_id="row-1", storage_area_id="area-1",
        warehouse_id="wh-a", is_held=False, is_deleted=False,
    )
    db.add(pl)
    return pl


def test_cancelled_misread_does_not_block_approval(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"], status=ForkliftRequestStatus.SUBMITTED)
    for s in range(1, 10):
        _pallet(db, s, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    _misread(db, fr.id, 5)
    db.commit()
    fr = db.query(ForkliftRequest).get(fr.id)
    assert scanner_service._unresolved_missing_for_fr(db, fr) == []
    assert scanner_service.closing_status_by_lot(fr).keys() == {LOT}


def test_live_misread_still_counts_until_removed(db_session, fg):
    """Only CANCELLED is ignored: a misread still pending on the card is real
    work for the reviewer, so its invented gaps still show."""
    db = db_session
    fr = _session(db, fg["fk-1"], status=ForkliftRequestStatus.SUBMITTED)
    _pallet(db, 1, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    _misread(db, fr.id, 3, status=PalletStatus.PENDING)
    db.commit()
    fr = db.query(ForkliftRequest).get(fr.id)
    assert scanner_service._unresolved_missing_for_fr(db, fr) == [
        f"{LOT[1:]}-MANGO-001", f"{LOT[1:]}-MANGO-002",
    ]


@pytest.mark.parametrize("bad", [f"{LOT[1:]}-MANGO-005", "M28026L1-MANGO-005", "MP2802L1-MANGO-005"])
def test_gun_refuses_a_misread_lot(db_session, fg, bad):
    db = db_session
    _session(db, fg["fk-1"])
    db.commit()
    with pytest.raises(ValidationError) as e:
        scanner_service.scan_pallet(db, "fr-1", bad, "row-1", False, None, fg["fk-1"])
    assert "scan it again" in str(e.value)
    assert db.query(PalletLicence).filter(PalletLicence.licence_number == bad).first() is None


def test_gun_accepts_a_real_lot(db_session, fg):
    db = db_session
    _session(db, fg["fk-1"])
    db.commit()
    out = scanner_service.scan_pallet(db, "fr-1", f"{LOT}-MANGO-001", "row-1", False, None, fg["fk-1"])
    assert out["status"] == "scanned"


def test_supervisor_add_refuses_a_misread_lot(db_session, fg):
    db = db_session
    _session(db, fg["fk-1"], status=ForkliftRequestStatus.SUBMITTED)
    db.commit()
    with pytest.raises(ValidationError):
        scanner_service.add_pallet_to_request(
            db, "fr-1", f"{LOT[1:]}-MANGO-005", "row-1", False, None, fg["sup"],
        )
