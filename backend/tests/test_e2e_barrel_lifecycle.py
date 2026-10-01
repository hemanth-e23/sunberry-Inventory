"""End-to-end barrel lifecycle — the way a real plant uses the system.

One story, driven through the REAL HTTP API as the real roles (warehouse
submits, forklift scans, supervisor approves, production calls the service
API), and after EVERY step the same set of invariants is measured. The point
is to find the step where the numbers stop agreeing.

Story
-----
1. Lot A of Mango Puree arrives on TWO trucks (10 + 10 drums, same vendor lot
   and best-by, 502 lb/drum) through the lot-receiving flow: incoming order ->
   release -> start receiving -> gun scans -> forklift submit -> supervisor
   approves the receipt. Lot B (8 drums, different vendor lot) lands in ROW 2.
2. Transfers: 2 drums ROW1->ROW2, then 12 drums ROW1->ROW3 (more than either
   truck alone). While those are pending a 7-drum transfer must be refused with
   a clear message; a 3-drum one is submitted then rejected and its reservation
   must release; the first two are approved.
3. Staging: production raises a staging request, the forklift pulls 12 drums
   off ROW 3 on the gun, production uses 5,800 lb, the 224 lb remainder comes
   back to ROW 1 as an open drum.
4. Adjustment: a 3-drum "used in production" write-off is submitted WHILE an
   unrelated transfer of A is pending (must not say "on hold"); then a QA hold
   on lot A refuses adjustments and transfers; release allows them again.
5. Every report a person would open for this lot is read and compared.

Invariants (see ``Story.check``) — run after every step:
* placements per rack == what is physically there; ledger == placements
* Σ Receipt.quantity (lbs) == racked lbs + lbs still out in staging
* StorageRow occupancy counters agree with placements
* lot_scoped_availability == racked − held − pending transfers
* projection JSON lives on exactly one live carrier and matches placements
* what the transfer/adjustment form offers (rowSources.buildEntriesForProduct,
  replicated below) == placements, no duplicate or phantom rows
* the read endpoints (lots-on-hand, rack cards, production availability,
  reconciliation, point-in-time, lot trace, movement ledger, staging
  suggestions, transfer history) agree with the same numbers.

Real bugs found are NOT asserted in the main story (it would stop at the first
one). Each is a named check; ``KNOWN_BUGS`` lists them and each has its own
``xfail(strict=True)`` test below, so fixing one turns its test into an XPASS
failure that says "remove me from KNOWN_BUGS".
"""
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    Category,
    CategoryGroup,
    LotPlacement,
    Location,
    MaterialLot,
    Product,
    Receipt,
    StorageRow,
    SubLocation,
    User,
    Vendor,
    Warehouse,
)
from app.services import lot_placement_service as lps
from app.services import transfer_service
from app.utils.auth import create_access_token, get_password_hash

WH = "wh-e2e"
GROUP = "grp-e2e"
CAT = "cat-e2e-raw"
PRODUCT = "prod-e2e-mango"
SID = "SID-E2E-MANGO"
VENDOR = "vendor-e2e"
LOC = "loc-e2e"
SUB = "sub-e2e-drums"
LOC_PROD = "loc-e2e-prod"
SUB_STAGING = "sub-e2e-staging"
ROW1, ROW2, ROW3 = "e2e-r1", "e2e-r2", "e2e-r3"
ROWS = (ROW1, ROW2, ROW3)
ROW_NAMES = {ROW1: "ROW 1", ROW2: "ROW 2", ROW3: "ROW 3"}

W = 502.0  # lbs per drum
LOT_A_VENDOR_LOT = "A-LOT-0925"
LOT_B_VENDOR_LOT = "B-LOT-0926"
BBD_A = "2027-03-01"
BBD_B = "2027-09-01"

EPS = 0.05


def _hdr(username):
    return {"Authorization": f"Bearer {create_access_token(data={'sub': username})}"}


WH_H = _hdr("e2e_wh")       # warehouse clerk: submits
WH2_H = _hdr("e2e_wh2")     # a second clerk (unused for approvals)
FK_H = _hdr("e2e_fk")       # forklift: scans
SUP_H = _hdr("e2e_sup")     # supervisor: approves


@pytest.fixture
def plant(db_session):
    """Master data only: warehouse, product, vendor, a drum room with three
    racks, a production floor for staging, and the four people."""
    db_session.add(Warehouse(id=WH, name="Plant E2E", code="PE2E", type="owned",
                             is_active=True))
    db_session.add(CategoryGroup(id=GROUP, name="Fruit"))
    db_session.add(Category(id=CAT, name="Fruit Puree", type="raw", parent_id=GROUP))
    db_session.add(Product(id=PRODUCT, name="Mango Puree", category_id=CAT, sid=SID,
                           quantity_uom="lbs"))
    db_session.add(Vendor(id=VENDOR, name="Acme Fruit"))
    db_session.add(Location(id=LOC, name="Plant E2E", warehouse_id=WH))
    db_session.add(SubLocation(id=SUB, name="Drum Room", location_id=LOC,
                               storage_unit="drum", unit_capacity=40))
    for rid in ROWS:
        db_session.add(StorageRow(id=rid, name=ROW_NAMES[rid], sub_location_id=SUB,
                                  barcode=f"PE2E-{rid}", pallet_capacity=0,
                                  is_active=True))
    db_session.add(Location(id=LOC_PROD, name="Production Floor", warehouse_id=WH))
    db_session.add(SubLocation(id=SUB_STAGING, name="Staging", location_id=LOC_PROD))
    for uid, username, role in (
        ("u-e2e-wh", "e2e_wh", "warehouse"),
        ("u-e2e-wh2", "e2e_wh2", "warehouse"),
        ("u-e2e-fk", "e2e_fk", "forklift"),
        ("u-e2e-sup", "e2e_sup", "supervisor"),
    ):
        db_session.add(User(
            id=uid, username=username, name=username, email=f"{username}@x.test",
            hashed_password=get_password_hash("pw123456789"), role=role,
            is_active=True, warehouse_id=WH,
        ))
    db_session.commit()


# ─── the frontend's form builder, replicated ──────────────────────────────────

def build_entries_for_product(receipts_json, product_id):
    """Python port of frontend/src/utils/rowSources.js `buildEntriesForProduct`
    (only the fields that decide WHAT is offered and HOW MUCH). Fed the same
    `/api/receipts/` payload the ReceiptContext maps, filtered to approved the
    way TransfersTab/AdjustmentsTab do."""
    entries = []
    approved = [r for r in receipts_json if r.get("status") == "approved"]
    matching = [
        r for r in approved
        if r.get("product_id") == product_id and float(r.get("quantity") or 0) > 0
    ]
    for r in matching:
        lot = r.get("lot_number") or r["id"]
        wpc = float(r.get("weight_per_container") or 0)
        cu = r.get("container_unit")
        if not (wpc > 0 and cu):
            wpc = None
        total = float(r.get("quantity") or 0)
        allocs = [
            a for a in (r.get("raw_material_row_allocations") or [])
            if a and a.get("rowId") and float(a.get("cases") or 0) > 0
        ]
        if allocs:
            for a in allocs:
                held_units = float(a.get("heldUnits") or 0)
                gross = float(a.get("cases") or 0)
                alloc_units = float(a.get("units") or 0)
                per = wpc if wpc else (gross / alloc_units if alloc_units > 0 else 0)
                held_w = min(gross, held_units * per)
                entries.append({
                    "key": f"{r['id']}::row-{a['rowId']}",
                    "receiptId": r["id"],
                    "rowId": a["rowId"],
                    "sourceId": f"row-{a['rowId']}",
                    "lotNumber": lot,
                    "available": max(0.0, gross - held_w),
                    "isCounted": bool(r.get("material_lot_id")),
                    "displayFactor": wpc or 1,
                })
            continue
        if r.get("material_lot_id"):
            continue
        if r.get("storage_row_id"):
            entries.append({
                "key": f"{r['id']}::row-{r['storage_row_id']}",
                "receiptId": r["id"], "rowId": r["storage_row_id"],
                "sourceId": f"row-{r['storage_row_id']}", "lotNumber": lot,
                "available": total, "isCounted": False, "displayFactor": wpc or 1,
            })
            continue
        # Row-less legacy fallback (modes 3/4 collapsed): a location entry.
        entries.append({
            "key": f"{r['id']}::loc", "receiptId": r["id"], "rowId": None,
            "sourceId": r.get("sub_location_id") or r.get("location_id") or "unknown",
            "lotNumber": lot, "available": total, "isCounted": False,
            "displayFactor": wpc or 1,
        })
    return entries


# ─── the story ────────────────────────────────────────────────────────────────

class Story:
    def __init__(self, client, db):
        self.c = client
        self.db = db
        # lot key -> {lot_id, lot_code, vendor_lot, receipts: [ids]}
        self.lots = {}
        # Physical truth the test believes: lot -> row -> [full, open, open_qty]
        self.exp = defaultdict(lambda: defaultdict(lambda: [0, 0, 0.0]))
        self.staged = defaultdict(float)       # lbs out in staging, still on paper
        self.pending = {}                      # transfer_id -> (lot, lbs)
        self.held = defaultdict(bool)
        self.my_transfers = set()              # every transfer a person made
        self.adj_expected = defaultdict(float)  # approved adjustment lbs by type
        self.failures = []                     # (step, check, message)
        self.steps = []

    # ── http helpers ──
    def post(self, url, headers, json=None, params=None, ok=True):
        r = self.c.post(url, headers=headers, json=json, params=params)
        if ok:
            assert r.status_code == 200, f"POST {url} -> {r.status_code}: {r.text}"
        return r

    def get(self, url, headers=WH_H, params=None):
        r = self.c.get(url, headers=headers, params=params)
        assert r.status_code == 200, f"GET {url} -> {r.status_code}: {r.text}"
        return r.json()

    # ── receiving ──
    def receive_truck(self, key, vendor_lot, bbd, count, row):
        order = self.post("/api/lot-receiving/orders", WH_H, json={
            "vendor_id": VENDOR,
            "bol": f"BOL-{uuid.uuid4().hex[:6]}",
            "origin_name": "Supplier DC",
            "lines": [{
                "product_id": PRODUCT, "category_id": CAT,
                "vendor_lot": vendor_lot, "bbd": bbd,
                "expected_count": count, "unit_label": "drum",
                "weight_per_unit": W, "weight_unit": "lbs",
            }],
        }).json()
        self.post(f"/api/lot-receiving/orders/{order['id']}/release", WH_H,
                  json={"expected_date": "2026-10-01"})
        summary = self.post(
            f"/api/lot-receiving/orders/{order['id']}/start-receiving", WH_H,
            json={"line_id": order["lines"][0]["id"]},
        ).json()
        rid = summary["receipt_id"]
        for i in range(count):
            scan = self.post(f"/api/lot-receiving/sessions/{rid}/scan", FK_H, json={
                "lot_code": summary["lot_code"], "storage_row_id": row,
                "idempotency_key": f"rcv-{uuid.uuid4().hex}",
            }).json()
            assert scan["status"] == "ok", scan
        sub = self.post(f"/api/lot-receiving/sessions/{rid}/submit", FK_H).json()
        assert sub["status"] == "submitted", sub
        self.post(f"/api/receipts/{rid}/approve", SUP_H)

        self.db.expire_all()
        receipt = self.db.query(Receipt).filter(Receipt.id == rid).one()
        info = self.lots.setdefault(key, {
            "lot_id": receipt.material_lot_id, "lot_code": summary["lot_code"],
            "vendor_lot": vendor_lot, "receipts": [],
        })
        assert info["lot_id"] == receipt.material_lot_id, "second truck forked the lot"
        info["receipts"].append(rid)
        self.exp[key][row][0] += count
        return rid

    # ── the form, as the frontend would build it ──
    def form_entries(self):
        receipts = self.get("/api/receipts/", WH_H,
                            params={"product_id": PRODUCT, "limit": 1000})
        return build_entries_for_product(receipts, PRODUCT)

    def entry_for(self, key, row):
        vl = self.lots[key]["vendor_lot"]
        found = [e for e in self.form_entries()
                 if e["lotNumber"] == vl and e["rowId"] == row]
        assert len(found) == 1, f"form offers {len(found)} entries for lot {key} @ {row}: {found}"
        return found[0]

    # ── transfers ──
    def submit_transfer(self, key, src, dst, drums, *, ok=True):
        entry = self.entry_for(key, src)
        lbs = drums * W
        r = self.post("/api/inventory/transfers", WH_H, ok=False, json={
            "receipt_id": entry["receiptId"],
            "to_location_id": LOC, "to_sub_location_id": SUB,
            "quantity": lbs, "reason": f"move {drums} drums",
            "transfer_type": "warehouse-transfer",
            "source_breakdown": [{"id": entry["sourceId"], "quantity": lbs}],
            "destination_breakdown": [{"id": f"row-{dst}", "quantity": lbs}],
        })
        if not ok:
            return r
        assert r.status_code == 200, r.text
        tid = r.json()["id"]
        self.pending[tid] = (key, lbs, src, dst, drums)
        self.my_transfers.add(tid)
        return tid

    def approve_transfer(self, tid):
        self.post(f"/api/inventory/transfers/{tid}/approve", SUP_H)
        key, lbs, src, dst, drums = self.pending.pop(tid)
        self.exp[key][src][0] -= drums
        self.exp[key][dst][0] += drums

    def reject_transfer(self, tid):
        self.post(f"/api/inventory/transfers/{tid}/reject", SUP_H,
                  params={"reason": "not today"})
        self.pending.pop(tid)

    # ── numbers the test believes ──
    def rack_lbs(self, key):
        return sum(f * W + q for f, _o, q in self.exp[key].values())

    def rack_units(self, key):
        return sum(f + o for f, o, _q in self.exp[key].values())

    def pending_lbs(self, key):
        return sum(v[1] for v in self.pending.values() if v[0] == key)

    def lot_receipts(self, key):
        return (self.db.query(Receipt)
                .filter(Receipt.material_lot_id == self.lots[key]["lot_id"])
                .order_by(Receipt.created_at).all())

    # ── THE CHECK ──
    def check(self, step):
        self.steps.append(step)
        self.db.expire_all()
        fail = lambda check, msg: self.failures.append((step, check, msg))  # noqa: E731

        for key, info in self.lots.items():
            lot = self.db.query(MaterialLot).filter(MaterialLot.id == info["lot_id"]).one()
            exp_rows = {r: (v[0], v[1], round(v[2], 2))
                        for r, v in self.exp[key].items() if v[0] or v[1]}

            # 1. placements per rack
            got = {p.storage_row_id: (int(p.full_units or 0), int(p.open_units or 0),
                                      round(float(p.open_remaining_qty or 0), 2))
                   for p in lps.placements_for_lot(self.db, lot.id)}
            if got != exp_rows:
                fail("placements", f"lot {key}: racks {got} != expected {exp_rows}")
            drift = lps.reconcile_lot(self.db, lot.id)
            if drift["drifted"]:
                fail("ledger", f"lot {key}: ledger drift {drift['rows']}")

            # 2. paper == racked + staged
            receipts = self.lot_receipts(key)
            live_paper = [r for r in receipts if r.status in ("approved", "depleted")]
            paper = sum(float(r.quantity or 0) for r in live_paper)
            want = self.rack_lbs(key) + self.staged[key]
            if abs(paper - want) > EPS:
                fail("paper_vs_physical",
                     f"lot {key}: Σ receipt lbs {paper:g} != racked {self.rack_lbs(key):g}"
                     f" + staged {self.staged[key]:g}")
            for r in receipts:
                if float(r.quantity or 0) < -1e-6:
                    fail("paper_negative", f"receipt {r.id} quantity {r.quantity}")
                if r.status == "depleted" and float(r.quantity or 0) > EPS:
                    fail("paper_status", f"receipt {r.id} depleted with {r.quantity}")

            # 4. availability == racked − held − pending
            carrier = next((r for r in receipts if r.raw_material_row_allocations), receipts[-1])
            pool = transfer_service.lot_scoped_availability(self.db, carrier)
            held_lbs = self.rack_lbs(key) if self.held[key] else 0.0
            want_avail = self.rack_lbs(key) - held_lbs - self.pending_lbs(key)
            if abs(pool["available"] - want_avail) > EPS:
                fail("availability_vs_racks",
                     f"lot {key}: lot_scoped_availability {pool['available']:g} != racked "
                     f"{self.rack_lbs(key):g} − held {held_lbs:g} − pending "
                     f"{self.pending_lbs(key):g} = {want_avail:g}")

            # 5. projection on exactly one live carrier
            carriers = [r for r in receipts if r.raw_material_row_allocations]
            live = [r for r in receipts if r.status == "approved" and float(r.quantity or 0) > 0]
            if exp_rows and len(carriers) != 1:
                fail("projection_carrier",
                     f"lot {key}: {len(carriers)} receipts carry allocations "
                     f"{[c.id for c in carriers]}")
            if carriers and live and carriers[0] not in live:
                fail("projection_carrier",
                     f"lot {key}: projection sits on non-live receipt {carriers[0].id} "
                     f"({carriers[0].status}, {carriers[0].quantity})")
            if carriers:
                proj = {a["rowId"]: (int(a.get("units") or 0), round(float(a["cases"]), 2),
                                     int(a.get("heldUnits") or 0), int(a.get("pallets") or 0))
                        for a in carriers[0].raw_material_row_allocations}
                want_proj = {r: (f + o, round(f * W + q, 2), (f + o) if self.held[key] else 0, f + o)
                             for r, (f, o, q) in exp_rows.items()}
                if proj != want_proj:
                    fail("projection_rows", f"lot {key}: JSON {proj} != {want_proj}")

        # 3. rack counters
        for rid in ROWS:
            row = self.db.query(StorageRow).filter(StorageRow.id == rid).one()
            units = sum(self.exp[k][rid][0] + self.exp[k][rid][1] for k in self.lots)
            lbs = sum(self.exp[k][rid][0] * W + self.exp[k][rid][2] for k in self.lots)
            if int(row.occupied_pallets or 0) != units or abs(float(row.occupied_cases or 0) - lbs) > EPS:
                fail("row_counters",
                     f"{rid}: occupied_pallets={row.occupied_pallets} occupied_cases="
                     f"{row.occupied_cases} but placements say {units} drums / {lbs:g} lbs")
            if row.product_id not in (None, PRODUCT):
                fail("row_counters", f"{rid}: product_id {row.product_id}")

        # 6. the transfer / adjustment form
        entries = self.form_entries()
        keys = [e["key"] for e in entries]
        if len(keys) != len(set(keys)):
            fail("form_duplicates", f"duplicate form keys {keys}")
        by_lot_row = defaultdict(list)
        for e in entries:
            by_lot_row[(e["lotNumber"], e["rowId"])].append(e)
        for (vl, rid), es in by_lot_row.items():
            if len(es) > 1:
                fail("form_duplicates", f"{vl}@{rid} offered {len(es)} times by "
                     f"{[e['receiptId'] for e in es]}")
        for key, info in self.lots.items():
            vl = info["vendor_lot"]
            for rid in ROWS:
                f, o, q = self.exp[key][rid]
                want = 0.0 if self.held[key] else f * W + q
                offered = sum(e["available"] for e in by_lot_row.get((vl, rid), []))
                if abs(offered - want) > EPS:
                    fail("form_offer", f"lot {key} @ {rid}: form offers {offered:g} lbs, "
                         f"rack holds {want:g} available")
            stray = [e for e in entries if e["lotNumber"] == vl and e["rowId"] not in ROWS]
            if stray:
                fail("form_phantom", f"lot {key}: phantom entries {stray}")

        self._check_reads(step, fail)

    def _check_reads(self, step, fail):
        # lots-on-hand (the recount / lot card list)
        loh = {l["material_lot_id"]: l for l in self.get("/api/lot-cutover/lots-on-hand")}
        for key, info in self.lots.items():
            full = sum(v[0] for v in self.exp[key].values())
            opn = sum(v[1] for v in self.exp[key].values())
            l = loh.get(info["lot_id"])
            if full + opn == 0:
                if l:
                    fail("lots_on_hand", f"lot {key} listed with nothing on hand: {l}")
                continue
            if not l or l["full_units"] != full or l["open_units"] != opn \
                    or bool(l["is_held"]) != self.held[key]:
                fail("lots_on_hand", f"lot {key}: lots-on-hand {l and {k: l[k] for k in ('full_units', 'open_units', 'is_held')}}"
                     f" != full {full} open {opn} held {self.held[key]}")

        # rack cards (sub-locations with live rows)
        subs = {s["id"]: s for s in self.get("/api/master-data/sub-locations")}
        rows = {r["id"]: r for r in subs[SUB]["rows"]}
        for rid in ROWS:
            row = rows[rid]
            units = sum(self.exp[k][rid][0] + self.exp[k][rid][1] for k in self.lots)
            if row.get("live_units") != units or int(row.get("occupied_pallets") or 0) != units:
                fail("rack_card", f"{rid}: live_units {row.get('live_units')} occupied "
                     f"{row.get('occupied_pallets')} != {units}")
            live = {l["material_lot_id"]: (l["units"], round(l["weight"], 2), l["is_held"])
                    for l in (row.get("live_lots") or [])}
            want = {}
            for k, info in self.lots.items():
                f, o, q = self.exp[k][rid]
                if f or o:
                    want[info["lot_id"]] = (f + o, round(f * W + q, 2), self.held[k])
            if live != want:
                fail("rack_card", f"{rid}: live_lots {live} != {want}")

        # production's availability gate
        res = self.post("/api/service/check-availability", SUP_H, json={
            "items": [{"sid": SID, "quantity_needed": 1}], "warehouse_id": WH,
        }).json()["items"][0]
        want_on_hand = sum(0.0 if self.held[k] else self.rack_lbs(k) for k in self.lots)
        if abs(float(res["on_hand"]) - want_on_hand) > EPS:
            fail("production_availability", f"check-availability on_hand {res['on_hand']} "
                 f"!= unheld rack lbs {want_on_hand:g}")

        # staging suggestions (what the desk and the gun pick lots from)
        sugg = self.get("/api/inventory/staging/suggest-lots",
                        params={"product_id": PRODUCT, "quantity": 1})
        rcpt_lot = {r.id: r.material_lot_id for r in self.db.query(Receipt).all()}
        for key, info in self.lots.items():
            free = 0.0 if self.held[key] else self.rack_lbs(key)
            mine = [s for s in sugg if rcpt_lot.get(s["receipt_id"]) == info["lot_id"]]
            if free > EPS:
                if len(mine) != 1 or abs(mine[0]["available_quantity"] - free) > EPS:
                    fail("staging_suggestions",
                         f"lot {key}: {len(mine)} suggestion(s) "
                         f"{[m['available_quantity'] for m in mine]} for {free:g} lbs free")
                elif mine:
                    # The rack names must be where the drums ARE now.
                    named = set(filter(None, (mine[0].get("storage_row_name") or "").split(", ")))
                    held_rows = {ROW_NAMES[r] for r, v in self.exp[key].items() if v[0] or v[1]}
                    if named != held_rows:
                        fail("staging_suggestion_racks",
                             f"lot {key}: suggestion names {sorted(named)}, drums are on "
                             f"{sorted(held_rows)}")

        # reconciliation report — the standing alarm
        recon = self.get("/api/reports/reconciliation")
        codes = {i["lot_code"]: i for i in recon["lot_imbalances"]}
        for key, info in self.lots.items():
            if info["lot_code"] in codes:
                i = codes[info["lot_code"]]
                fail("recon_imbalance", f"lot {key} flagged: paper {i['paper_units']} racked "
                     f"{i['racked_units']} (true racked {self.rack_units(key)}, staged "
                     f"{self.staged[key]:g} lbs)")
        if recon["noop_transfers"]:
            fail("recon_noop", f"no-op transfers {recon['noop_transfers']}")
        if recon["phantom_receipts"]:
            fail("recon_phantom", f"phantom receipts {recon['phantom_receipts']}")

        # point-in-time (as of tomorrow, so today's activity is all in)
        tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
        pit = self.get("/api/reports/point-in-time",
                       params={"as_of_date": tomorrow, "product_id": PRODUCT})
        for key, info in self.lots.items():
            got = sum(r["quantity"] for r in pit["rows"] if r["lot_number"] == info["vendor_lot"])
            want = self.rack_lbs(key) + self.staged[key]
            if abs(got - want) > 0.1:
                fail("point_in_time", f"lot {key}: snapshot {got:g} != {want:g}")

        # lot trace — per delivery
        for key, info in self.lots.items():
            try:
                trace = self.get("/api/reports/lot-trace",
                                 params={"lot_number": info["vendor_lot"]})
            except Exception as exc:  # TestClient re-raises the server's 500
                fail("lot_trace_crash", f"lot {key}: lot-trace raised {type(exc).__name__}: {exc}")
                continue
            recs = trace["receipts"]
            # One entry per LOT: both trucks fold into one timeline.
            if len(recs) != 1:
                fail("lot_trace_grouping", f"lot {key}: {len(recs)} trace entries, want 1")
            for r in recs:
                ids = r.get("receipt_ids") or [r["receipt_id"]]
                delivered = sum(
                    float(rc.container_count or 0) * W
                    for rc in self.db.query(Receipt).filter(Receipt.id.in_(ids)).all()
                )
                if abs(r["initial_quantity"] - delivered) > 0.1:
                    fail("lot_trace_initial",
                         f"lot {key}: trace says received {r['initial_quantity']:g} lbs, "
                         f"deliveries brought {delivered:g}")
                # The timeline must add up to what is on hand: + in, - out,
                # moves and holds change nothing.
                sign = {"in": 1, "out": -1}
                net = sum(sign.get(ev.get("direction"), 0) * float(ev["qty"] or 0)
                          for ev in r["timeline"])
                if abs(net - r["current_quantity"]) > 0.1:
                    fail("lot_trace_timeline_sum",
                         f"lot {key}: timeline nets {net:g} but on hand is "
                         f"{r['current_quantity']:g}")
                for ev in r["timeline"]:
                    if ev["event_type"] == "received" and not ev["to_rows"]:
                        fail("lot_trace_arrival", f"lot {key}: a delivery shows no arrival rack")
            cur = sum(r["current_quantity"] for r in recs)
            want = self.rack_lbs(key) + self.staged[key]
            if abs(cur - want) > 0.1:
                fail("lot_trace_current", f"lot {key}: trace current {cur:g} != {want:g}")

        # movement ledger — running balance must end at on-hand
        led = self.get("/api/reports/movement-ledger", params={"product_id": PRODUCT})
        # Each delivery's "Receipt" line must say what that truck brought.
        for key, info in self.lots.items():
            got_in = sorted(round(e["qty_in"], 2) for e in led["events"]
                            if e["event_type"] == "Receipt" and e["lot_number"] == info["vendor_lot"])
            delivered = sorted(round(float(r.container_count or 0) * W, 2)
                               for r in self.lot_receipts(key))
            if got_in != delivered:
                fail("ledger_receipt_qty",
                     f"lot {key}: ledger receipt lines {got_in} != deliveries {delivered}")
        bal = led["events"][-1]["running_balance"] if led["events"] else 0.0
        want = sum(self.rack_lbs(k) + self.staged[k] for k in self.lots)
        if abs(bal - want) > 0.1:
            fail("movement_ledger_balance",
                 f"movement ledger ends at {bal:g} lbs, on-hand is {want:g}")

        # activity ledger — current on hand per product must be racked +
        # staged, counted ONCE (it added receipts and racks: double).
        today = datetime.now(timezone.utc).date()
        act = self.get("/api/reports/activity-ledger", params={
            "start_date": (today - timedelta(days=2)).isoformat(),
            "end_date": (today + timedelta(days=1)).isoformat(),
            "product_id": PRODUCT,
        })
        rows = act.get("rows", act) if isinstance(act, dict) else act
        want_oh = sum(self.rack_lbs(k) + self.staged[k] for k in self.lots)
        got_oh = sum(float(r["current_on_hand"]) for r in rows)
        if abs(got_oh - want_oh) > 0.1:
            fail("activity_ledger_on_hand",
                 f"activity ledger on hand {got_oh:g} != racked + staged {want_oh:g}")
        used = sum(v for t, v in self.adj_expected.items()
                   if t in ("production-consumption", "used-in-production"))
        got_used = sum(float(r.get("consumed_in_production", r.get("consumed", 0)) or 0) for r in rows)
        if abs(got_used - used) > 0.1:
            fail("activity_ledger_consumed",
                 f"activity ledger consumed {got_used:g} != production use {used:g}")

        # adjustments report as the plant sees it
        rep = self.get("/api/reports/adjustments", params={"product_id": PRODUCT})
        by_type = defaultdict(float)
        for row in rep["rows"]:
            by_type[row["adjustment_type"]] += row["quantity"]
            if row["unit"] != "lbs":
                fail("adjustments_report", f"adjustment row in {row['unit']}: {row}")
        want_types = {k: round(v, 2) for k, v in self.adj_expected.items()}
        got_types = {k: round(v, 2) for k, v in by_type.items()}
        if got_types != want_types:
            fail("adjustments_report_scope",
                 f"plant's adjustments report {got_types} != approved {want_types}")

        # transfer history as the plant sees it
        listed = {t["id"] for t in self.get("/api/inventory/transfers", params={"limit": 1000})}
        missing = self.my_transfers - listed
        if missing:
            fail("transfer_history", f"{len(missing)} transfer(s) invisible to the plant: "
                 f"{sorted(missing)}")


def run_story(client, db):
    s = Story(client, db)

    # ── 1. receiving ──────────────────────────────────────────────────────────
    t1 = s.receive_truck("A", LOT_A_VENDOR_LOT, BBD_A, 10, ROW1)
    s.check("1a truck 1 of lot A approved")
    t2 = s.receive_truck("A", LOT_A_VENDOR_LOT, BBD_A, 10, ROW1)
    assert t1 != t2
    s.check("1b truck 2 of lot A approved (same lot)")
    s.receive_truck("B", LOT_B_VENDOR_LOT, BBD_B, 8, ROW2)
    s.check("1c lot B approved into ROW 2")
    assert len(s.lot_receipts("A")) == 2

    # ── 2. transfers ──────────────────────────────────────────────────────────
    ta = s.submit_transfer("A", ROW1, ROW2, 2)
    s.check("2a 2 drums ROW1->ROW2 pending")
    tb = s.submit_transfer("A", ROW1, ROW3, 12)   # > either truck alone
    s.check("2b 12 drums ROW1->ROW3 pending")

    # 6 drums left unreserved: 7 must be refused, and say why.
    refused = s.submit_transfer("A", ROW1, ROW3, 7, ok=False)
    assert refused.status_code == 400, refused.text
    detail = refused.json()["detail"]
    assert f"{6 * W:g}" in detail and "pending" in detail, detail
    s.check("2c over-reservation refused")

    tc = s.submit_transfer("A", ROW1, ROW3, 3)
    s.check("2d 3 drums pending (to be rejected)")
    s.reject_transfer(tc)
    s.check("2e rejected: reservation released")
    # The released 3 are offerable again: 6 unreserved => 6 accepted at submit.
    probe = s.submit_transfer("A", ROW1, ROW3, 6)
    s.reject_transfer(probe)

    s.approve_transfer(ta)
    s.check("2f 2-drum transfer approved")
    s.approve_transfer(tb)
    s.check("2g 12-drum transfer approved")

    # ── 3. staging ────────────────────────────────────────────────────────────
    sr = s.post("/api/service/staging-requests", SUP_H, json={
        "production_batch_uid": "PB-E2E-001", "product_name": "Mango Nectar",
        "production_date": "2026-10-02",
        "items": [{"sid": SID, "ingredient_name": "Mango Puree",
                   "quantity_needed": 6000, "unit": "lbs"}],
    }).json()
    req_id = sr["id"]
    detail = s.get(f"/api/staging-pull/requests/{req_id}", FK_H)
    item_id = detail["items"][0]["id"]
    for _ in range(3):
        scan = s.post(f"/api/staging-pull/requests/{req_id}/scan", FK_H, json={
            "code": s.lots["A"]["lot_code"], "storage_row_id": ROW3, "units": 4,
            "idempotency_key": f"pull-{uuid.uuid4().hex}",
        }).json()
        assert scan["status"] == "ok", scan
        s.exp["A"][ROW3][0] -= 4
        s.staged["A"] += 4 * W
    s.check("3a 12 drums on the cart (pulled, not submitted)")

    sub = s.post(f"/api/staging-pull/requests/{req_id}/submit", FK_H,
                 json={"staging_location_id": LOC_PROD,
                       "staging_sub_location_id": SUB_STAGING}).json()
    assert sub["status"] == "ok", sub
    (staging_item_id,) = sub["staging_item_ids"]
    s.db.expire_all()
    from app.models import StagingItem
    si = s.db.query(StagingItem).filter(StagingItem.id == staging_item_id).one()
    s.my_transfers.add(si.transfer_id)
    s.check("3b staging submitted")

    s.post(f"/api/service/staging-requests/{req_id}/items/{item_id}/mark-used", SUP_H,
           json={"staging_item_id": staging_item_id, "quantity": 5800})
    s.staged["A"] -= 5800
    s.adj_expected["production-consumption"] += 5800
    s.check("3c production used 5,800 lb (spills across both trucks)")

    s.post(f"/api/service/staging-requests/{req_id}/items/{item_id}/return", SUP_H, json={
        "staging_item_id": staging_item_id, "quantity": 224,
        "to_location_id": LOC, "to_sub_location_id": SUB, "to_storage_row_id": ROW1,
        "full_units": 0, "weighed_partial_qty": 224,
    })
    s.staged["A"] -= 224
    s.db.expire_all()
    from app.models import InventoryTransfer
    ret = (s.db.query(InventoryTransfer)
           .filter(InventoryTransfer.reason == f"Returned from staging (request {req_id})")
           .one())
    s.my_transfers.add(ret.id)
    s.exp["A"][ROW1][1] += 1
    s.exp["A"][ROW1][2] += 224
    s.check("3d 224 lb open drum returned to ROW 1")

    # ── 4. adjustments + holds ────────────────────────────────────────────────
    td = s.submit_transfer("A", ROW2, ROW3, 2)
    s.check("4a unrelated transfer of A pending")

    entry = s.entry_for("A", ROW1)
    adj = s.post("/api/inventory/adjustments", WH_H, ok=False, json={
        "receipt_id": entry["receiptId"], "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "used-in-production", "quantity": 3 * W,
        "reason": "3 drums to the kettle, no staging",
        "source_breakdown": [{"id": entry["sourceId"], "quantity": 3 * W}],
    })
    assert adj.status_code == 200, f"write-off refused while a transfer is pending: {adj.text}"
    s.post(f"/api/inventory/adjustments/{adj.json()['id']}/approve", SUP_H)
    s.exp["A"][ROW1][0] -= 3
    s.adj_expected["used-in-production"] += 3 * W
    s.check("4b 3-drum write-off approved while transfer pending")

    s.approve_transfer(td)
    s.check("4c pending transfer approved")

    entry = s.entry_for("A", ROW1)
    hold = s.post("/api/inventory/hold-actions", WH_H, json={
        "receipt_id": entry["receiptId"], "action": "hold", "reason": "positive swab",
    }).json()
    s.post(f"/api/inventory/hold-actions/{hold['id']}/approve", SUP_H)
    s.held["A"] = True
    s.check("4d lot A on QA hold")

    carrier_id = entry["receiptId"]
    r = s.post("/api/inventory/adjustments", WH_H, ok=False, json={
        "receipt_id": carrier_id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": W, "reason": "leak",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": W}],
    })
    assert r.status_code == 400 and "hold" in r.json()["detail"].lower(), r.text
    r = s.post("/api/inventory/transfers", WH_H, ok=False, json={
        "receipt_id": carrier_id, "to_location_id": LOC, "to_sub_location_id": SUB,
        "quantity": W, "reason": "x", "transfer_type": "warehouse-transfer",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": W}],
        "destination_breakdown": [{"id": f"row-{ROW2}", "quantity": W}],
    })
    assert r.status_code == 400 and "hold" in r.json()["detail"].lower(), r.text
    s.check("4e held lot refuses adjustments and transfers")

    rel = s.post("/api/inventory/hold-actions", WH_H, json={
        "receipt_id": carrier_id, "action": "release", "reason": "swab retest clean",
    }).json()
    s.post(f"/api/inventory/hold-actions/{rel['id']}/approve", SUP_H)
    s.held["A"] = False
    s.check("4f hold released")

    adj2 = s.post("/api/inventory/adjustments", WH_H, json={
        "receipt_id": carrier_id, "product_id": PRODUCT, "category_id": CAT,
        "adjustment_type": "damage-reduction", "quantity": W, "reason": "leak",
        "source_breakdown": [{"id": f"row-{ROW1}", "quantity": W}],
    }).json()
    s.post(f"/api/inventory/adjustments/{adj2['id']}/reject", SUP_H,
           params={"reason": "probe only"})
    te = s.submit_transfer("A", ROW1, ROW2, 1)
    s.reject_transfer(te)
    s.check("4g after release: adjustment and transfer accepted again")

    return s


# ─── tests ────────────────────────────────────────────────────────────────────

# check name -> one-line warehouse symptom. Each has an xfail test below.
# Emptied 2026-10-01: all nine found by this story are fixed. A new one goes
# here (with its symptom) and gets an xfail(strict=True) test automatically.
KNOWN_BUGS = {}


def _fmt(failures):
    return "\n".join(f"  [{step}] {check}: {msg}" for step, check, msg in failures)


def test_barrel_lifecycle_story(client, plant, db_session):
    s = run_story(client, db_session)
    unexpected = [f for f in s.failures if f[1] not in KNOWN_BUGS]
    assert not unexpected, "invariants broke:\n" + _fmt(unexpected)

    # ── 5. the reports, read once more at the end with exact figures ──
    # (every per-step read check above already ran; these pin the end state)
    transfers = {t["id"]: t for t in s.get("/api/inventory/transfers", params={"limit": 1000})}
    statuses = sorted(t["status"] for t in transfers.values()
                      if t["transfer_type"] == "warehouse-transfer" and t["requested_by"] == "u-e2e-wh")
    assert statuses.count("approved") == 3 and statuses.count("rejected") == 3, statuses

    holds = s.get("/api/reports/holds")
    assert holds["totals"] == {"holds": 1, "releases": 1}

    # Best-by goes out as the calendar day typed, never an instant: midnight
    # UTC rendered as the evening before in Central (2026-10-01 browser test).
    for r in s.get("/api/receipts/", params={"product_id": PRODUCT, "limit": 1000}):
        want = BBD_A if r["lot_number"] == LOT_A_VENDOR_LOT else BBD_B
        assert r["expiration_date"] == want, r["expiration_date"]

    # The recall timeline shows the drums going to staging and coming back.
    (entry,) = s.get("/api/reports/lot-trace", params={"lot_number": LOT_A_VENDOR_LOT})["receipts"]
    kinds = [ev["event_type"] for ev in entry["timeline"]]
    assert "staging" in kinds, kinds
    assert kinds.count("received") == 2, kinds

    # Final physical picture, said plainly.
    assert s.rack_units("A") == 3 + 1 + 2   # ROW1 3 sealed + 1 open, ROW3 2
    assert s.rack_lbs("A") == pytest.approx(5 * W + 224)
    assert s.rack_lbs("B") == pytest.approx(8 * W)


def _xfail_check(name):
    def test(client, plant, db_session):
        s = run_story(client, db_session)
        hits = [f for f in s.failures if f[1] == name]
        assert not hits, KNOWN_BUGS.get(name, name) + "\n" + _fmt(hits)
    return test


for _name in KNOWN_BUGS:
    globals()[f"test_known_bug__{_name}"] = pytest.mark.xfail(
        strict=True, reason=KNOWN_BUGS[_name]
    )(_xfail_check(_name))


def test_rm_ship_out_that_drains_the_carrier_keeps_the_lot_on_the_forms(
    client, plant, db_session
):
    """Two trucks of 10 into ROW 1. One drum is moved to ROW 2 (any rack move
    re-projects onto the NEWEST live receipt, truck 2), then 12 drums ship out
    of ROW 1 — more than truck 2's paper. 7 + 1 drums remain on the racks and
    the forms must still offer them."""
    s = Story(client, db_session)
    s.receive_truck("A", LOT_A_VENDOR_LOT, BBD_A, 10, ROW1)
    s.receive_truck("A", LOT_A_VENDOR_LOT, BBD_A, 10, ROW1)
    s.approve_transfer(s.submit_transfer("A", ROW1, ROW2, 1))
    s.check("1 drum moved: projection now on truck 2")
    entry = s.entry_for("A", ROW1)
    lbs = 12 * W
    t = s.post("/api/inventory/transfers", WH_H, json={
        "receipt_id": entry["receiptId"], "quantity": lbs, "reason": "sold",
        "transfer_type": "shipped-out", "order_number": "SO-E2E-1",
        "source_breakdown": [{"id": entry["sourceId"], "quantity": lbs}],
    }).json()
    s.post(f"/api/inventory/transfers/{t['id']}/approve", SUP_H)
    s.exp["A"][ROW1][0] -= 12
    s.my_transfers.add(t["id"])
    s.check("ship-out of 12 drums approved")
    hits = [f for f in s.failures if f[1] in ("projection_carrier", "form_offer",
                                               "paper_vs_physical", "placements")]
    assert not hits, _fmt(hits)
