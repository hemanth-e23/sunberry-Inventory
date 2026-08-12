"""Guard the query count of /scan-progress.

This endpoint is polled every 3-5 seconds by three separate screens for the
entire duration of a ship-out, so its cost per call is multiplied by every
forklift and office tab that has the order open.

It used to run four N+1 loops: one query per scan event to resolve a scanner's
name, two per pallet for the storage row and area, and three per swap. A
200-pallet pick therefore issued hundreds of round-trips per poll, several
times a second, while holding a connection for the whole request. That is the
kind of load that exhausted the connection pool on 2026-08-10 and 2026-08-12.

The point of this test is NOT the exact number. It is that the number does not
grow with the size of the pick: run it against two transfers of very different
sizes and the query count must stay flat. That is what makes an N+1
reintroduction fail the build rather than quietly slow production down.
"""
import pytest
from sqlalchemy import event

from app.models import (
    InventoryTransfer,
    PalletLicence,
    TransferScanEvent,
    User,
)
from app.utils.auth import get_password_hash


class QueryCounter:
    """Count SQL statements issued on a connection while inside the block."""

    def __init__(self, bind):
        self.bind = bind
        self.statements = []

    def __enter__(self):
        event.listen(self.bind, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *exc):
        event.remove(self.bind, "before_cursor_execute", self._record)

    def _record(self, conn, cursor, statement, params, context, executemany):
        self.statements.append(statement)

    @property
    def count(self):
        return len(self.statements)


def _build_ship_out(db_session, seed_data, *, transfer_id, pallets, scanners):
    """Create a ship-out transfer with `pallets` pallets, each one scanned."""
    users = []
    for i in range(scanners):
        u = User(
            id=f"{transfer_id}-scanner-{i}",
            username=f"{transfer_id}-scanner-{i}",
            name=f"Scanner {i}",
            email=f"{transfer_id}-scanner-{i}@example.test",
            hashed_password=get_password_hash("x"),
            role="forklift",
        )
        db_session.add(u)
        users.append(u)

    pallet_ids = []
    for i in range(pallets):
        pl_id = f"{transfer_id}-pl-{i}"
        pallet_ids.append(pl_id)
        db_session.add(PalletLicence(
            id=pl_id,
            licence_number=f"{transfer_id}-LIC-{i}",
            product_id=seed_data["product"].id,
            storage_row_id=seed_data["storage_row"].id,
            storage_area_id="area-1",
            cases=40,
            sequence=i,
            status="in_stock",
        ))

    db_session.add(InventoryTransfer(
        id=transfer_id,
        order_number=f"ORD-{transfer_id}",
        transfer_type="shipped-out",
        status="pending",
        quantity=40 * pallets,
        unit="cases",
        pallet_licence_ids=pallet_ids,
    ))

    for i, pl_id in enumerate(pallet_ids):
        db_session.add(TransferScanEvent(
            id=f"{transfer_id}-evt-{i}",
            transfer_id=transfer_id,
            licence_number=f"{transfer_id}-LIC-{i}",
            licence_id=pl_id,
            on_list=True,
            scanned_by=users[i % len(users)].id,
        ))

    db_session.commit()
    return pallet_ids


@pytest.mark.parametrize("pallets", [2, 40])
def test_scan_progress_returns_correct_data(
    client, admin_auth_headers, db_session, seed_data, pallets
):
    """Correctness first — batching must not change what the endpoint returns."""
    tid = f"t-correct-{pallets}"
    _build_ship_out(db_session, seed_data, transfer_id=tid, pallets=pallets, scanners=3)

    resp = client.get(f"/api/inventory/transfers/{tid}/scan-progress",
                      headers=admin_auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["total_pallets"] == pallets
    assert body["scanned_count"] == pallets
    assert len(body["pick_list"]) == pallets
    # Names must still resolve, and via the batched lookup rather than per-row.
    # Scanners are assigned round-robin, so a 2-pallet pick only uses two of them.
    expected_scanners = {f"Scanner {i % 3}" for i in range(pallets)}
    assert {p["scanned_by"] for p in body["pick_list"]} == expected_scanners
    # Location is assembled from the batched row/area maps.
    assert body["pick_list"][0]["location"] == "Area 1/Row A"
    assert body["pick_list"][0]["product_name"] == "Sunberry Concentrate"


def test_scan_progress_query_count_does_not_grow_with_pallets(
    client, admin_auth_headers, db_session, seed_data
):
    """The regression guard: 20x the pallets must not mean 20x the queries."""
    _build_ship_out(db_session, seed_data, transfer_id="t-small", pallets=2, scanners=2)
    _build_ship_out(db_session, seed_data, transfer_id="t-large", pallets=40, scanners=5)

    bind = db_session.get_bind()

    with QueryCounter(bind) as small:
        r1 = client.get("/api/inventory/transfers/t-small/scan-progress",
                        headers=admin_auth_headers)
    with QueryCounter(bind) as large:
        r2 = client.get("/api/inventory/transfers/t-large/scan-progress",
                        headers=admin_auth_headers)

    assert r1.status_code == 200 and r2.status_code == 200

    # 20x the pallets and 2.5x the scanners. With the N+1 loops this was ~60
    # extra queries; batched, the count is identical. A small allowance covers
    # incidental differences without letting a per-row query slip back in.
    assert large.count <= small.count + 2, (
        f"query count scaled with pallet count: {small.count} -> {large.count}. "
        "An N+1 has been reintroduced in scan-progress; batch the lookup with "
        ".in_() as the surrounding code does."
    )
