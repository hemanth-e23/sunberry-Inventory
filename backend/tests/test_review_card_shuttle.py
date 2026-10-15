"""Forklift review card: the full story of a run that went onto the Moyel shuttle.

Production 2026-10-14 (MP28726L1 Arnold Palmer): the driver scanned 97 pallets,
the clerk loaded 99 onto trailer 0123 — 96 of the scanned plus #025/#026/#093
that were never scanned. The card said "Pallet Licences (97)" and its row
summary "1 pallet" (only #100, still on the floor).
"""
from app.enums import ForkliftRequestStatus, PalletStatus
from app.models import ForkliftRequest, PalletLicence
from app.services import moyel_shuttle_service, scanner_service

from tests.test_fg_pallet_lifecycle import LOT, _pallet, _session, fg  # noqa: F401


def _run(db, fg):
    """Scanned #1-3 and #5-6 (pending, dock), never scanned #4. #1, #2, #4, #5
    go on the shuttle; #3 and #6 stay."""
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    for s in (1, 2, 3, 5, 6):
        _pallet(db, s, PalletStatus.PENDING, row="dock-1", receipt_id=None, fr_id=fr.id)
    db.commit()
    moyel_shuttle_service.create_shuttle(
        db, trailer_number="0123", seal_number="S-1", destination_id=None,
        pallet_ids=[f"pl-{LOT}-1", f"pl-{LOT}-2", f"pl-{LOT}-5"],
        missing_licences=[f"{LOT}-MANGO-004"],
        warehouse_id="wh-a", current_user=fg["clerk"],
    )
    db.commit()
    return db.query(ForkliftRequest).get(fr.id)


def test_card_lists_the_shuttle_added_pallet(db_session, fg):
    fr = _run(db_session, fg)
    added = scanner_service.shuttle_added_pallets(db_session, fr)
    assert [a["licence_number"] for a in added] == [f"{LOT}-MANGO-004"]
    assert added[0]["status"] == PalletStatus.SHIPPED.value
    assert "trailer 0123" in added[0]["note"] and "added on shuttle" in added[0]["note"]


def test_production_summary_counts_everything_produced(db_session, fg):
    fr = _run(db_session, fg)
    added = scanner_service.shuttle_added_pallets(db_session, fr)
    summary = scanner_service.production_summary(db_session, fr, added)
    assert summary["produced"] == {"pallets": 6, "cases": 240}
    assert summary["in_warehouse"] == {"pallets": 2, "cases": 80}
    [trailer] = summary["shipped"]
    assert trailer["kind"] == "shuttle" and trailer["ref"] == "0123"
    assert (trailer["pallets"], trailer["cases"]) == (4, 160)
    assert trailer["added"] == [f"{LOT}-MANGO-004"]


def test_summary_when_the_whole_run_left_on_the_shuttle(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    for s in (1, 2):
        _pallet(db, s, PalletStatus.PENDING, row="dock-1", receipt_id=None, fr_id=fr.id)
    db.commit()
    moyel_shuttle_service.create_shuttle(
        db, trailer_number="0124", seal_number="S-2", destination_id=None,
        pallet_ids=[f"pl-{LOT}-1", f"pl-{LOT}-2"], missing_licences=[],
        warehouse_id="wh-a", current_user=fg["clerk"],
    )
    db.commit()
    fr = db.query(ForkliftRequest).get(fr.id)
    summary = scanner_service.production_summary(db, fr, [])
    assert summary["produced"]["pallets"] == 2
    assert summary["in_warehouse"] == {"pallets": 0, "cases": 0}


def test_cancelled_scans_are_not_production(db_session, fg):
    db = db_session
    fr = _session(db, fg["fk-1"], ForkliftRequestStatus.SUBMITTED)
    _pallet(db, 1, PalletStatus.PENDING, row="dock-1", receipt_id=None, fr_id=fr.id)
    _pallet(db, 2, PalletStatus.CANCELLED, row="dock-1", receipt_id=None, fr_id=fr.id)
    db.commit()
    fr = db.query(ForkliftRequest).get(fr.id)
    assert scanner_service.production_summary(db, fr, [])["produced"]["pallets"] == 1


def test_approval_still_adopts_the_same_pallets(db_session, fg):
    """The card and approval use one query, so what the card lists is what
    approval books."""
    fr = _run(db_session, fg)
    listed = {a["id"] for a in scanner_service.shuttle_added_pallets(db_session, fr)}
    orphans = {o.id for o in scanner_service._adoptable_orphans(db_session, LOT, fr.product_id)}
    assert listed == orphans
    assert db_session.query(PalletLicence).get(next(iter(listed))).forklift_request_id is None


def test_api_sends_the_new_fields(client, db_session, fg):
    _run(db_session, fg)
    from app.utils.auth import create_access_token
    token = create_access_token({"sub": fg["sup"].username})
    resp = client.get("/api/scanner/requests?status_filter=submitted",
                      headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    [fr] = [r for r in resp.json() if r["id"] == "fr-1"]
    assert [a["licence_number"] for a in fr["shuttle_added"]] == [f"{LOT}-MANGO-004"]
    assert fr["production_summary"]["produced"]["pallets"] == 6
