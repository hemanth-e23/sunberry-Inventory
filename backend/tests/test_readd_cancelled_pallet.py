"""2026-10-29: a pallet removed from its own session could not be put back.

Production: MP30126L1-GVN128C-116..119 were removed from
fr-1793222589285-20607d43 by mistake. The review card then showed them as
missing, but Add refused with "already in this request" (the cancelled row
still carries the request id), leaving only "Skip — Not Produced".
"""
from app.enums import ForkliftRequestStatus, PalletStatus
from app.models import ForkliftRequest, PalletLicence
from app.services import scanner_service

from tests.test_fg_pallet_lifecycle import LOT, _pallet, _session, fg  # noqa: F401


def _remove(db, fr, seq, user):
    pl = db.query(PalletLicence).filter(PalletLicence.licence_number == f"{LOT}-MANGO-{seq:03d}").one()
    scanner_service.remove_pallet_licence(db, fr.id, pl.id, user)
    return pl.id


def test_supervisor_add_revives_pallet_removed_from_same_request(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"], status=ForkliftRequestStatus.SUBMITTED)
    for s in range(1, 4):
        _pallet(db, s, PalletStatus.PENDING, receipt_id=None, fr_id=fr.id)
    fr.total_full_pallets, fr.total_cases = 3, 120
    db.commit()
    pl_id = _remove(db, fr, 2, fg["sup"])

    out = scanner_service.add_pallet_to_request(
        db, fr.id, f"{LOT}-MANGO-002", "row-2", False, None, fg["sup"],
    )

    assert out["status"] == "added"
    assert out["pallet"]["id"] == pl_id  # same row, history kept
    db.expire_all()
    pl = db.query(PalletLicence).get(pl_id)
    assert pl.status == PalletStatus.PENDING.value
    assert pl.is_deleted is False and pl.deleted_at is None
    assert pl.storage_row_id == "row-2"
    fr = db.query(ForkliftRequest).get(fr.id)
    assert (fr.total_full_pallets, fr.total_cases) == (3, 120)


def test_gun_rescan_revives_pallet_removed_from_same_request(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"])
    db.commit()
    scanner_service.scan_pallet(db, fr.id, f"{LOT}-MANGO-001", "row-1", False, None, fg["fk-1"])
    _remove(db, fr, 1, fg["sup"])

    out = scanner_service.scan_pallet(db, fr.id, f"{LOT}-MANGO-001", "row-2", False, None, fg["fk-1"])

    assert out["status"] == "scanned"
    db.expire_all()
    pl = db.query(PalletLicence).filter(PalletLicence.licence_number == f"{LOT}-MANGO-001").one()
    assert pl.status == PalletStatus.PENDING.value and pl.is_deleted is False
    assert pl.storage_row_id == "row-2"
    fr = db.query(ForkliftRequest).get(fr.id)
    assert (fr.total_full_pallets, fr.total_cases) == (1, 40)
