"""Browser test PART 4 (2026-10-02) — reports after counts and staging.

P4  the Inventory Snapshot counts approved + depleted receipts only (never a
    rejected delivery) and adds lots known only by their racks, once.
P5  the Cycle Counts report lists raw-material rack counts (who, lot, rack,
    system vs counted, variance, unit) next to finished-goods cycle counts.
P6  staging consumption records the LOT's paper before/after; old rows that
    recorded one delivery's paper (or a negative) report no before/after.
P7  Vendor Receipts shows what each truck brought, and what is left of it.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    InventoryAdjustment, MaterialLot, Receipt,
)
from app.services import lot_placement_service as lps
from app.services import report_builders as rb
from tests.test_browser_part3_staging_fixes import (  # noqa: F401  (fixtures)
    A, B, VL, _gun_pull, _gun_submit, _item_id, _request, story,
)
from tests.test_e2e_barrel_lifecycle import (  # noqa: F401  (fixtures)
    CAT, PRODUCT, ROW1, ROW2, ROW3, SUP_H, VENDOR, WH, plant,
)

LOT_TOTAL = 4 * A + 6 * B  # truck 1: 4 × 502, truck 2: 6 × 474


def _today(db):
    """Today in the warehouse's own zone — the report's date filters mean
    local calendar days."""
    return rb.local_today(rb.report_timezone(db, WH)).isoformat()


def _lot(db, s):
    db.expire_all()
    return db.query(MaterialLot).filter(MaterialLot.id == s.lots["A"]["lot_id"]).one()


def _consumption_rows(db):
    db.expire_all()
    return (
        db.query(InventoryAdjustment)
        .filter(InventoryAdjustment.adjustment_type == "production-consumption")
        .order_by(InventoryAdjustment.approved_at)
        .all()
    )


# ── P6: staging consumption writes lot-level before/after ────────────────────

def test_request_mark_used_records_the_lots_paper_before_and_after(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    (si_id,) = sub["staging_item_ids"]

    s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": si_id, "quantity": 2 * A})

    (adj,) = _consumption_rows(db_session)
    assert adj.original_quantity == pytest.approx(LOT_TOTAL)
    assert adj.new_quantity == pytest.approx(LOT_TOTAL - 2 * A)
    assert adj.unit == "lbs"

    report = rb.build_adjustments_report(db_session, warehouse_id=WH)
    (row,) = [r for r in report["rows"] if r["adjustment_type"] == "production-consumption"]
    assert row["qty_before"] == pytest.approx(LOT_TOTAL)
    assert row["qty_after"] == pytest.approx(LOT_TOTAL - 2 * A)


def test_staging_overview_mark_used_records_the_lots_paper_too(story, db_session):
    s = story
    sr = _request(s, needed=2 * A)
    _gun_pull(s, sr["id"], ROW1, 2)
    sub = _gun_submit(s, sr["id"])
    (si_id,) = sub["staging_item_ids"]

    s.post(f"/api/inventory/staging/{si_id}/mark-used", SUP_H, json={"quantity": 300})

    (adj,) = _consumption_rows(db_session)
    assert adj.original_quantity == pytest.approx(LOT_TOTAL)
    assert adj.new_quantity == pytest.approx(LOT_TOTAL - 300)
    assert adj.unit == "lbs"


def test_consumption_spilling_across_trucks_never_records_a_negative(story, db_session):
    """Everything staged and used: whatever delivery the pull was pinned to,
    the figures are the lot's and stay >= 0 (it read "0 → −202")."""
    s = story
    sr = _request(s, needed=4 * A + 6 * B)
    _gun_pull(s, sr["id"], ROW1, 4)
    _gun_pull(s, sr["id"], ROW2, 6)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    db_session.expire_all()
    from app.models import StagingItem

    for si_id in sub["staging_item_ids"]:
        si = db_session.query(StagingItem).filter(StagingItem.id == si_id).one()
        left = si.quantity_staged - si.quantity_used - si.quantity_returned
        s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
               json={"staging_item_id": si_id, "quantity": left})

    rows = _consumption_rows(db_session)
    assert rows
    for adj in rows:
        assert adj.original_quantity >= 0 and adj.new_quantity >= 0
        assert adj.original_quantity - adj.new_quantity == pytest.approx(adj.quantity)
    assert rows[-1].new_quantity == pytest.approx(0)


# ── P6: legacy per-delivery rows in the report ───────────────────────────────

def _legacy_adj(db, receipt_id, qty, before, after, unit=None):
    adj = InventoryAdjustment(
        id=f"adj-{uuid.uuid4().hex[:10]}", receipt_id=receipt_id, warehouse_id=WH,
        product_id=PRODUCT, adjustment_type="production-consumption", quantity=qty,
        unit=unit, reason="Used from staging for production (legacy)", status="approved",
        approved_at=datetime.now(timezone.utc), original_quantity=before, new_quantity=after,
    )
    db.add(adj)
    db.commit()
    return adj.id


def test_report_hides_per_delivery_and_negative_before_after(story, db_session):
    s = story
    r1, r2 = s.lots["A"]["receipts"]
    neg = _legacy_adj(db_session, r1, 202, 0, -202)
    per_delivery = _legacy_adj(db_session, r2, 55, 275, 220)
    lot_level = _legacy_adj(db_session, r2, 55, 4852, 4797, unit="lbs")

    rows = {r["adjustment_id"]: r for r in rb.build_adjustments_report(db_session)["rows"]}
    assert (rows[neg]["qty_before"], rows[neg]["qty_after"]) == (None, None)
    assert (rows[per_delivery]["qty_before"], rows[per_delivery]["qty_after"]) == (None, None)
    assert (rows[lot_level]["qty_before"], rows[lot_level]["qty_after"]) == (4852, 4797)


def test_single_delivery_lot_keeps_its_legacy_figures():
    class _A:
        original_quantity, new_quantity, unit = 275.0, 220.0, None

    class _R:
        material_lot_id = "mlot-1"

    assert rb.adjustment_before_after(_A(), _R(), lot_deliveries=1) == (275.0, 220.0)
    assert rb.adjustment_before_after(_A(), _R(), lot_deliveries=2) == (None, None)
    assert rb.adjustment_before_after(_A(), None) == (275.0, 220.0)


# ── P5: raw-material counts in the Cycle Counts report ───────────────────────

def test_cycle_counts_report_lists_rm_recounts_and_found_lots(story, db_session):
    s = story
    lot = _lot(db_session, s)
    # Recount ROW1: system 4, counted 5 (+1). Then ROW2: 6 → 5 with one open.
    lps.set_count(db_session, lot, ROW1, full_units=5, actor_id="u-e2e-sup",
                  reason="Physical count")
    lps.set_count(db_session, lot, ROW2, full_units=5, open_units=1,
                  open_remaining_qty=210.0, actor_id="u-e2e-sup")
    # "Add what I found": a lot with no receipt, 1 drum on ROW3.
    found = lps.find_or_create_lot(
        db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot_number="B-FOUND",
        bbd=None, unit_label="drum", weight_per_unit=B, weight_unit="lbs",
        warehouse_id=WH, lot_unknown=False,
    )
    lps.apply_delta(db_session, found, ROW3, event_type=lps.EVENT_OPENING_BALANCE,
                    full_units_delta=1, actor_id="u-e2e-sup", ref_type="cutover",
                    reason="Found on the rack", reason_code="opening_balance")
    db_session.commit()

    rep = rb.build_cycle_count_report(db_session, warehouse_id=WH,
                                      start_date=_today(db_session), end_date=_today(db_session))
    rm = [r for r in rep["rows"] if r.get("source") == "raw-material"]
    assert len(rm) == 3
    by_rack = {r["location"]: r for r in rm}

    up = by_rack["ROW 1"]
    assert (up["system_count"], up["actual_count"], up["variance"]) == (4, 5, 1)
    assert up["lot_number"] == VL and up["unit"] == "drums"
    assert up["counted_by"] == "e2e_sup" and up["count_kind"] == "Recount"
    assert up["variance_weight"] == pytest.approx(float(lot.weight_per_unit))

    down = by_rack["ROW 2"]
    assert (down["system_count"], down["actual_count"], down["variance"]) == (6, 5, -1)
    assert down["actual_detail"] == "5 drums + 1 open (210 lbs)"
    assert down["system_detail"] == "6 drums"

    f = by_rack["ROW 3"]
    assert f["lot_number"] == "B-FOUND" and f["count_kind"] == "Found"
    assert (f["system_count"], f["actual_count"], f["variance"]) == (0, 1, 1)

    assert rep["totals"]["rm_counts"] == 3
    assert rep["totals"]["variance_by_unit"] == {"drums": 1}

    # Out of the date range, out of the report; another warehouse sees none.
    old = (datetime.now(timezone.utc) - timedelta(days=10)).date().isoformat()
    assert not rb.build_cycle_count_report(
        db_session, warehouse_id=WH, start_date=old, end_date=old)["rows"]
    assert not [r for r in rb.build_cycle_count_report(db_session, warehouse_id="wh-other")["rows"]
                if r.get("source") == "raw-material"]


def test_cycle_counts_endpoint_includes_rm_counts(story, client, db_session):
    s = story
    lot = _lot(db_session, s)
    lps.set_count(db_session, lot, ROW1, full_units=3, actor_id="u-e2e-sup")
    db_session.commit()
    body = client.get("/api/reports/cycle-counts", headers=SUP_H).json()
    rm = [r for r in body["rows"] if r.get("source") == "raw-material"]
    assert len(rm) == 1 and rm[0]["variance"] == -1 and rm[0]["unit"] == "drums"


# ── P7: Vendor Receipts shows what each truck brought ────────────────────────

def test_vendor_receipts_show_received_and_remaining(story, db_session):
    s = story
    sr = _request(s, needed=4 * A)
    _gun_pull(s, sr["id"], ROW1, 4)
    sub = _gun_submit(s, sr["id"])
    item_id = _item_id(db_session, sr["id"])
    for si_id in sub["staging_item_ids"]:
        s.post(f"/api/service/staging-requests/{sr['id']}/items/{item_id}/mark-used", SUP_H,
               json={"staging_item_id": si_id, "quantity": 4 * A})

    rep = rb.build_vendor_receipts_report(db_session, warehouse_id=WH)
    by_id = {r["receipt_id"]: r for r in rep["rows"]}
    r1, r2 = s.lots["A"]["receipts"]
    assert by_id[r1]["quantity_received"] == pytest.approx(4 * A)
    assert by_id[r1]["quantity"] == pytest.approx(4 * A)
    assert by_id[r1]["containers"] == 4 and by_id[r1]["container_unit"] == "drums"
    assert by_id[r2]["quantity_received"] == pytest.approx(6 * B)
    remaining = by_id[r1]["quantity_remaining"] + by_id[r2]["quantity_remaining"]
    assert remaining == pytest.approx(LOT_TOTAL - 4 * A)
    (vendor,) = rep["by_vendor"].values()
    assert vendor["quantity"] == pytest.approx(LOT_TOTAL)
    assert vendor["remaining"] == pytest.approx(LOT_TOTAL - 4 * A)


# ── P4: Inventory Snapshot ───────────────────────────────────────────────────

def test_snapshot_skips_a_rejected_delivery_and_adds_a_found_lot_once(story, db_session):
    s = story
    r1 = s.lots["A"]["receipts"][0]
    src = db_session.query(Receipt).filter(Receipt.id == r1).one()
    db_session.add(Receipt(
        id=f"rcpt-{uuid.uuid4().hex[:8]}", product_id=PRODUCT, category_id=CAT,
        warehouse_id=WH, quantity=150, unit="lbs", status="rejected",
        lot_number=VL, material_lot_id=src.material_lot_id,
        receipt_date=datetime.now(timezone.utc),
    ))
    found = lps.find_or_create_lot(
        db_session, product_id=PRODUCT, vendor_id=VENDOR, vendor_lot_number="B-FOUND",
        bbd=None, unit_label="drum", weight_per_unit=B, weight_unit="lbs",
        warehouse_id=WH, lot_unknown=False,
    )
    lps.apply_delta(db_session, found, ROW3, event_type=lps.EVENT_OPENING_BALANCE,
                    full_units_delta=1, actor_id="u-e2e-sup", ref_type="cutover")
    db_session.commit()

    snap = rb.build_point_in_time_snapshot(db_session, _today(db_session), warehouse_id=WH)
    total = sum(r["quantity"] for r in snap["rows"] if r["product_id"] == PRODUCT)
    assert total == pytest.approx(LOT_TOTAL + B)
    assert [r["lot_number"] for r in snap["rows"] if r.get("counted_lot")] == ["B-FOUND"]

    # Before the found drum existed, the snapshot does not show it.
    yesterday = (datetime.now(timezone.utc) - timedelta(days=2)).date().isoformat()
    past = rb.build_point_in_time_snapshot(db_session, yesterday, warehouse_id=WH)
    assert not [r for r in past["rows"] if r.get("counted_lot")]
