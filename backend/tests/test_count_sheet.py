"""Count sheet by rack row (web Cycle Counting page, 2026-10-29).

The old sheet had one line per receipt: the same product + lot twice, the
location only the warehouse or room, the system figure from receipt totals.
The new sheet follows the walk — row → product → lot → licences / units — and
submitting applies at once, the way the gun does:

- FG rows go through the gun's row check: ✗ → MISSING (receipt deducted), an
  extra licence → moved here; one session for the whole sheet
- RM / packaging lines are set with lot_placement_service.set_count (a
  `counted` event holding the difference)
- a line that changed since the sheet was made, or is counted below what is
  held on the rack, is skipped with a reason; the rest still apply
- an open sheet lives as a CycleCount (kind count_sheet, open → submitted);
  another warehouse's sheet reads as not found
"""
import pytest

from app.enums import PalletStatus
from app.models import (
    CycleCount, LotPlacement, LotPlacementEvent, PalletLicence, Receipt, User, Warehouse,
)
from app.services import count_sheet_service as sheets
from app.services import lot_placement_service as lps
from app.services.report_builders import build_cycle_count_report
from app.utils.auth import create_access_token, get_password_hash
from tests.test_fg_pallet_lifecycle import LOT, _pallet, _receipt, _row, fg  # noqa: F401  (fixtures)
from tests.test_lot_placements import ROW_1, ROW_2, WH, _lot, lot_seed  # noqa: F401  (fixtures)

LOT_2 = "MP28126L1"


def _h(uid):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': uid})}"}


def _fg_stock(db):
    """row-1: 2 pallets of LOT + 2 of LOT_2; row-2: 1 pallet of LOT."""
    _receipt(db, qty=120)
    _receipt(db, rid="r-2", qty=80, lot=LOT_2)
    _pallet(db, 1)
    _pallet(db, 2)
    _pallet(db, 3, row="row-2")
    _pallet(db, 1, receipt_id="r-2", lot=LOT_2)
    _pallet(db, 2, receipt_id="r-2", lot=LOT_2)
    db.commit()


def _sheet_row(sheet, name):
    return next(r for r in sheet["summary"]["sheet"]["rows"] if r["row_name"] == name)


# ---------------------------------------------------------------------------
# FG
# ---------------------------------------------------------------------------

def test_fg_sheet_groups_by_row_then_product_lot_with_licences(db_session, fg):
    db = db_session
    _fg_stock(db)
    sheet = sheets.build_sheet(db, "wh-a", "fg")
    assert [r["row_name"] for r in sheet["rows"]] == ["FG-01", "FG-02"]
    row1 = sheet["rows"][0]
    assert row1["area_name"] == "FG"
    assert [(g["lot_number"], g["count"]) for g in row1["lines"]] == [(LOT, 2), (LOT_2, 2)]
    assert [p["licence_number"] for p in row1["lines"][0]["pallets"]] == [
        f"{LOT}-MANGO-001", f"{LOT}-MANGO-002",
    ]
    # Empty rows (dock, partials) are not on the sheet; RM sheets see no FG.
    assert sheets.build_sheet(db, "wh-a", "rm")["rows"] == []


def test_fg_not_here_goes_missing_and_extra_licence_moves_here(db_session, fg):
    db = db_session
    _fg_stock(db)
    sheet = sheets.create_open_sheet(db, user=fg["clerk"], warehouse_id="wh-a", kind="fg")
    db.commit()
    assert sheet["summary"]["sheet_no"].startswith("CC-") and sheet["items"] == []
    out = sheets.submit_sheet(db, sheet["id"], {"rows": [
        # Both LOT_2 pallets ✗; pallet 3 (system: row-2) found in row-1.
        {"row_id": "row-1", "counted": True,
         "not_here_pallet_ids": [f"pl-{LOT_2}-1", f"pl-{LOT_2}-2"],
         "extra_licences": [f"{LOT}-MANGO-003"]},
        # row-2 walked, nothing ticked: it is taken as all seen.
        {"row_id": "row-2", "counted": True},
    ]}, fg["clerk"], "wh-a")
    db.commit()
    assert out["status"] == "submitted" and out["rows_counted"] == 2 and out["skipped"] == []
    for pid in (f"pl-{LOT_2}-1", f"pl-{LOT_2}-2"):
        assert db.query(PalletLicence).get(pid).status == PalletStatus.MISSING.value
    assert db.query(Receipt).get("r-2").quantity == 0
    assert db.query(PalletLicence).get(f"pl-{LOT}-3").storage_row_id == "row-1"
    assert _row(db, "row-1").occupied_pallets == 3

    # One gun record per row, one session, tagged with the sheet.
    guns = [c for c in db.query(CycleCount).all() if c.summary.get("kind") == "gun_row_check"]
    assert len(guns) == 2
    assert {c.summary["session_id"] for c in guns} == {out["session_id"]}
    assert {c.summary["source"] for c in guns} == {"sheet"}
    assert {c.summary["sheet_no"] for c in guns} == {sheet["summary"]["sheet_no"]}

    # The sheet itself is submitted, with history-shaped items.
    cc = db.query(CycleCount).get(sheet["id"])
    assert cc.summary["status"] == "submitted"
    by_lot = {(i["location"], i["lotNo"]): i for i in cc.items}
    assert by_lot[("FG-01", LOT_2)]["actualQuantity"] == 0
    assert by_lot[("FG-01", LOT)]["actualQuantity"] == 3

    # Report lists the gun rows once — not the sheet a second time.
    rep = build_cycle_count_report(db, warehouse_id="wh-a")
    assert len([r for r in rep["rows"] if r.get("lot_number") == LOT_2]) == 1


def test_fg_rows_not_marked_counted_are_left_alone(db_session, fg):
    db = db_session
    _fg_stock(db)
    sheet = sheets.create_open_sheet(db, user=fg["clerk"], warehouse_id="wh-a", kind="fg")
    out = sheets.submit_sheet(db, sheet["id"], {"rows": [
        {"row_id": "row-1", "counted": False, "not_here_pallet_ids": [f"pl-{LOT}-1"]},
    ]}, fg["clerk"], "wh-a")
    db.commit()
    assert out["rows_counted"] == 0
    assert db.query(PalletLicence).get(f"pl-{LOT}-1").status == PalletStatus.IN_STOCK.value


def test_fg_pallet_that_left_the_row_since_printing_is_reported_skipped(db_session, fg):
    db = db_session
    _fg_stock(db)
    sheet = sheets.create_open_sheet(db, user=fg["clerk"], warehouse_id="wh-a", kind="fg")
    db.commit()
    pl = db.query(PalletLicence).get(f"pl-{LOT}-1")
    pl.storage_row_id = "row-2"
    db.commit()
    out = sheets.submit_sheet(db, sheet["id"], {"rows": [
        {"row_id": "row-1", "counted": True, "not_here_pallet_ids": [f"pl-{LOT}-1"]},
    ]}, fg["clerk"], "wh-a")
    db.commit()
    assert [s["licence_number"] for s in out["skipped"]] == [f"{LOT}-MANGO-001"]
    assert db.query(PalletLicence).get(f"pl-{LOT}-1").status == PalletStatus.IN_STOCK.value


# ---------------------------------------------------------------------------
# RM
# ---------------------------------------------------------------------------

@pytest.fixture
def rm(db_session, lot_seed):
    db = db_session
    db.add(User(id="u-rm", username="u-rm", name="RM Clerk", email="rm@p.com",
                hashed_password=get_password_hash("pw"), role="warehouse", is_active=True,
                warehouse_id=WH))
    a = _lot(db, lot_number="MG-2411")
    b = _lot(db, lot_number="MG-2412")
    lps.set_count(db, a, ROW_1, full_units=10)
    lps.set_count(db, b, ROW_2, full_units=6)
    db.commit()
    return {"user": db.query(User).get("u-rm"), "a": a, "b": b}


def _rm_entries(sheet, counts):
    """{(row name, vendor lot): counted} → submit payload rows."""
    out = []
    for r in sheet["summary"]["sheet"]["rows"]:
        lines = [
            {"placement_id": ln["placement_id"], "counted_units": counts[(r["row_name"], ln["vendor_lot_number"])]}
            for ln in r["lines"] if (r["row_name"], ln["vendor_lot_number"]) in counts
        ]
        if lines:
            out.append({"row_id": r["row_id"], "counted": True, "lines": lines})
    return out


def test_rm_sheet_lines_and_variance_sets_count_with_event(db_session, rm):
    db = db_session
    sheet = sheets.create_open_sheet(db, user=rm["user"], warehouse_id=WH, kind="rm")
    db.commit()
    row = _sheet_row(sheet, "A-01")
    assert row["area_name"] == "Barn"
    line = row["lines"][0]
    assert (line["vendor_lot_number"], line["full_units"], line["unit_label"]) == ("MG-2411", 10, "drum")
    out = sheets.submit_sheet(db, sheet["id"], {"rows": _rm_entries(sheet, {
        ("A-01", "MG-2411"): 8, ("A-02", "MG-2412"): 6,
    })}, rm["user"], WH)
    db.commit()
    assert out["applied"] == 1 and out["skipped"] == []
    pl = db.query(LotPlacement).filter_by(material_lot_id=rm["a"].id, storage_row_id=ROW_1).one()
    assert pl.full_units == 8
    ev = db.query(LotPlacementEvent).filter_by(ref_type="cycle_count", ref_id=sheet["id"]).all()
    assert [(e.event_type, e.full_units_delta) for e in ev] == [("counted", -2)]
    items = {i["lotNo"]: i for i in out["items"]}
    assert items["MG-2411"]["status"] == "shortage" and items["MG-2411"]["variance"] == -2
    assert items["MG-2412"]["status"] == "ok"


def test_rm_line_changed_since_sheet_is_skipped_rest_apply(db_session, rm):
    db = db_session
    sheet = sheets.create_open_sheet(db, user=rm["user"], warehouse_id=WH, kind="rm")
    db.commit()
    lps.set_count(db, rm["a"], ROW_1, full_units=9)     # someone took one meanwhile
    db.commit()
    out = sheets.submit_sheet(db, sheet["id"], {"rows": _rm_entries(sheet, {
        ("A-01", "MG-2411"): 7, ("A-02", "MG-2412"): 5,
    })}, rm["user"], WH)
    db.commit()
    assert [(s["row_name"], s["reason"]) for s in out["skipped"]] == [("A-01", sheets.SKIP_CHANGED)]
    assert db.query(LotPlacement).filter_by(material_lot_id=rm["a"].id).one().full_units == 9
    assert db.query(LotPlacement).filter_by(material_lot_id=rm["b"].id).one().full_units == 5


def test_rm_count_below_held_is_skipped(db_session, rm):
    db = db_session
    pl = db.query(LotPlacement).filter_by(material_lot_id=rm["a"].id).one()
    pl.held_units = 4
    db.commit()
    sheet = sheets.create_open_sheet(db, user=rm["user"], warehouse_id=WH, kind="rm")
    assert _sheet_row(sheet, "A-01")["lines"][0]["held_units"] == 4
    out = sheets.submit_sheet(db, sheet["id"], {"rows": _rm_entries(sheet, {("A-01", "MG-2411"): 3})},
                              rm["user"], WH)
    db.commit()
    assert out["skipped"][0]["reason"] == "4 held here — release first"
    assert db.query(LotPlacement).filter_by(material_lot_id=rm["a"].id).one().full_units == 10


# ---------------------------------------------------------------------------
# Lifecycle + API
# ---------------------------------------------------------------------------

def test_api_open_to_submitted_and_other_warehouse_reads_404(client, db_session, fg):
    db = db_session
    _fg_stock(db)
    db.add(Warehouse(id="wh-b", name="Plant B", code="PB", type="owned", is_active=True))
    db.add(User(id="clerk-b", username="clerk-b", name="B", email="b@p.com",
                hashed_password=get_password_hash("pw"), role="warehouse", is_active=True,
                warehouse_id="wh-b"))
    db.commit()

    preview = client.get("/api/scanner/cycle-check/sheet?kind=fg", headers=_h("clerk"))
    assert preview.status_code == 200 and len(preview.json()["rows"]) == 2
    assert client.get("/api/scanner/cycle-check/sheet?kind=nope", headers=_h("clerk")).status_code == 400

    made = client.post("/api/scanner/cycle-check/sheets", headers=_h("clerk"), json={"kind": "fg"})
    assert made.status_code == 200
    sid = made.json()["id"]
    open_list = client.get("/api/scanner/cycle-check/sheets?status=open", headers=_h("clerk")).json()
    assert [s["id"] for s in open_list] == [sid] and "sheet" not in open_list[0]["summary"]
    assert client.get(f"/api/scanner/cycle-check/sheets/{sid}", headers=_h("clerk")).status_code == 200

    # Another plant can neither read nor submit it.
    assert client.get(f"/api/scanner/cycle-check/sheets/{sid}", headers=_h("clerk-b")).status_code == 404
    assert client.post(f"/api/scanner/cycle-check/sheets/{sid}/submit", headers=_h("clerk-b"),
                       json={"rows": []}).status_code == 404
    assert client.get("/api/scanner/cycle-check/sheets?status=open", headers=_h("clerk-b")).json() == []

    sub = client.post(f"/api/scanner/cycle-check/sheets/{sid}/submit", headers=_h("clerk"),
                      json={"rows": [{"row_id": "row-2", "counted": True}]})
    assert sub.status_code == 200 and sub.json()["status"] == "submitted"
    assert client.get("/api/scanner/cycle-check/sheets?status=open", headers=_h("clerk")).json() == []
    done = client.get("/api/scanner/cycle-check/sheets?status=submitted", headers=_h("clerk")).json()
    assert [s["id"] for s in done] == [sid]
    # Submitting twice is refused.
    again = client.post(f"/api/scanner/cycle-check/sheets/{sid}/submit", headers=_h("clerk"),
                        json={"rows": []})
    assert again.status_code == 400
