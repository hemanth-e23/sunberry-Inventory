"""Phase 3 — moving the warehouse onto the lot model without a stickering weekend.

Three steps, in this order:

**1. Zero out.** Old ingredient receipts KEEP their records — past batches were
consumed from them, and deleting the rows would empty any recall trace covering
pre-cutover production — but their remaining quantity goes to zero and their
status to `depleted`. Nothing double-counts and no history is lost.

**2. Enter today's stock by hand.** One opening-balance entry per (lot, rack):
product, vendor, vendor lot, BBD, weight per unit, rack, unit count. It creates
the `material_lot` and its `lot_placement` in a single action. No stickers, no
scanning, no bringing drums out of the barn.

**3. Sticker lazily.** Existing stock sits unstickered with a known count.
Stickers are printed and applied at first staging, and on demand for a
slow-moving lot that would otherwise sit unstickered for months. Over a few weeks
the warehouse converts itself as material is naturally used.

NOTHING IS DERIVED FROM THE OLD DATA, and that is the load-bearing decision. The
pallet numbers in `raw_material_row_allocations` have no fixed ratio to drums —
`row_allocation`'s own docstring says a single barrel can occupy a whole pallet —
and nothing anywhere records that a drum was opened. `container_count` is worse
than useless as an opening balance: it is the AS-RECEIVED count, frozen at
delivery, so using it would restore stock production already consumed. Both
numbers must come from a person who walked the rack. The old figures are offered
as a HINT beside the input box, never as a default in it.
"""

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import ReceiptStatus
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    LotPlacement,
    MaterialLot,
    Product,
    Receipt,
    StorageRow,
    Vendor,
)
from app.services import lot_placement_service as lps
from app.utils.category_rules import is_ingredient_category

# Written into the ledger so a cutover entry is never mistaken for a real
# receipt or a real count later.
REF_TYPE_CUTOVER = "cutover"


def _mint_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ─── step 1: zero out ─────────────────────────────────────────────────────────

def _ingredient_category_ids(db: Session) -> List[str]:
    return [
        c.id for c in db.query(Category).all() if is_ingredient_category(c)
    ]


def _zero_out_query(db: Session, warehouse_id: Optional[str] = None):
    """Ingredient receipts still carrying stock.

    Scoped to categories typed `ingredient` — raw materials and packaging are NOT
    part of this cutover and their receipts must not be touched.
    """
    cat_ids = _ingredient_category_ids(db)
    if not cat_ids:
        return db.query(Receipt).filter(False)

    q = db.query(Receipt).filter(
        Receipt.category_id.in_(cat_ids),
        Receipt.is_deleted == False,  # noqa: E712
        Receipt.quantity > 0,
        Receipt.status != ReceiptStatus.DEPLETED,
        # LEGACY RECEIPTS ONLY. A receipt already carrying a material lot has been
        # received under the new model — its units are counted in lot_placements
        # and its quantity is not double-counted. Without this filter the cutover
        # would (a) never report complete, because normal receiving keeps adding
        # matching rows, and (b) destroy live stock if anyone re-ran it: the
        # zero-out empties raw_material_row_allocations, so the receipt drops out
        # of the session list mid-truck and the drums already on the rack become
        # unreachable from the receiving screen.
        Receipt.material_lot_id.is_(None),
    )
    if warehouse_id:
        q = q.filter(Receipt.warehouse_id == warehouse_id)
    return q


def preview_zero_out(db: Session, warehouse_id: Optional[str] = None) -> dict:
    """What step 1 would do, without doing it.

    Reviewed before it runs, every time. A zero-out is reversible only by hand.
    """
    receipts = _zero_out_query(db, warehouse_id).all()
    by_product: dict = {}
    for receipt in receipts:
        entry = by_product.setdefault(
            receipt.product_id,
            {"product_id": receipt.product_id, "product_name": "", "receipts": 0,
             "quantity": 0.0, "units": [], "unit": receipt.unit},
        )
        entry["receipts"] += 1
        entry["quantity"] += float(receipt.quantity or 0)
        if receipt.container_count:
            entry["units"].append(int(receipt.container_count))

    for product_id, entry in by_product.items():
        product = db.query(Product).filter(Product.id == product_id).first()
        entry["product_name"] = product.name if product else product_id
        # The as-received count, offered ONLY as a sanity hint for whoever is
        # about to walk the rack. It is frozen at delivery and says nothing about
        # what is left, so it must never prefill an opening balance.
        entry["as_received_units_hint"] = sum(entry.pop("units"))

    return {
        "warehouse_id": warehouse_id,
        "receipt_count": len(receipts),
        "total_quantity": round(sum(float(r.quantity or 0) for r in receipts), 3),
        "products": sorted(by_product.values(), key=lambda e: e["product_name"]),
        "already_counted_lots": _counted_lot_count(db, warehouse_id),
    }


def _counted_lot_count(db: Session, warehouse_id: Optional[str] = None) -> int:
    q = db.query(func.count(func.distinct(LotPlacement.material_lot_id)))
    if warehouse_id:
        q = q.filter(LotPlacement.warehouse_id == warehouse_id)
    return int(q.scalar() or 0)


def execute_zero_out(
    db: Session, *, warehouse_id: Optional[str] = None, user_id: str, note: str = None
) -> dict:
    """Run step 1. Records are kept; only the remaining quantity goes to zero.

    Deliberately does NOT soft-delete: past production consumed from these
    receipts, and `build_lot_trace` reads them. A deleted receipt empties the
    recall trace for every batch that ever used it.
    """
    if not warehouse_id:
        # A None scope silently means EVERY warehouse — `_zero_out_query` guards
        # the filter with `if warehouse_id:`. A company-wide admin account has
        # `warehouse_id = None`, and that is exactly the account somebody would
        # use to run a cutover, so one click would zero every site at once.
        raise ValidationError(
            "Pick a specific warehouse before running the zero-out — "
            "the cutover converts one plant at a time."
        )

    receipts = _zero_out_query(db, warehouse_id).all()
    stamp = datetime.now(timezone.utc)
    marker = note or f"Zeroed at lot-model cutover {stamp.date().isoformat()}"

    zeroed = 0
    for receipt in receipts:
        receipt.quantity = 0
        receipt.status = ReceiptStatus.DEPLETED
        # The allocation JSON described where the OLD quantity sat. Leaving it
        # populated would keep the row cards claiming stock that is now zero.
        receipt.raw_material_row_allocations = []
        receipt.note = f"{receipt.note}\n{marker}" if receipt.note else marker
        zeroed += 1

    db.flush()
    return {"zeroed": zeroed, "warehouse_id": warehouse_id, "at": stamp}


# ─── step 2: opening balances ─────────────────────────────────────────────────

def create_opening_balance(
    db: Session,
    *,
    product_id: str,
    storage_row_id: str,
    full_units: int,
    vendor_id: Optional[str] = None,
    vendor_lot: Optional[str] = None,
    bbd: Optional[datetime] = None,
    unit_label: str = "drum",
    weight_per_unit: Optional[float] = None,
    weight_unit: Optional[str] = None,
    open_units: int = 0,
    open_remaining_qty: float = 0.0,
    warehouse_id: Optional[str] = None,
    user_id: Optional[str] = None,
    note: Optional[str] = None,
) -> dict:
    """One (lot, rack) counted by hand. Creates the lot and its placement together.

    Adds to an existing placement rather than replacing it: a rack holding this
    lot in two spots, or a second entry correcting a miscount, both mean "there
    is more here than I have recorded so far". Replacing would silently discard
    the first count, and the person entering the second has no way to know they
    did.
    """
    if full_units < 0 or open_units < 0:
        raise ValidationError("A count cannot be negative")
    if full_units == 0 and open_units == 0:
        raise ValidationError("Enter at least one unit")
    if open_units == 0 and open_remaining_qty > 0:
        raise ValidationError("Remaining quantity needs at least one open unit")

    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()
    if not row:
        raise NotFoundError("Storage row", storage_row_id)
    product = db.query(Product).filter(Product.id == product_id).first()
    if not product:
        raise NotFoundError("Product", product_id)

    lot = lps.find_or_create_lot(
        db,
        product_id=product_id,
        vendor_id=vendor_id,
        vendor_lot_number=vendor_lot,
        bbd=bbd,
        unit_label=unit_label,
        weight_per_unit=weight_per_unit,
        weight_unit=weight_unit,
        warehouse_id=warehouse_id,
        lot_unknown=not bool(vendor_lot),
    )

    lps.apply_delta(
        db, lot, storage_row_id,
        event_type=lps.EVENT_OPENING_BALANCE,
        full_units_delta=int(full_units),
        open_units_delta=int(open_units),
        open_qty_delta=float(open_remaining_qty),
        actor_id=user_id,
        ref_type=REF_TYPE_CUTOVER,
        reason=note or "Opening balance — counted at cutover",
        reason_code="opening_balance",
    )

    placement = lps._lock_placement(db, lot.id, storage_row_id)
    return {
        "material_lot_id": lot.id,
        "lot_code": lot.lot_code,
        "product_id": product_id,
        "product_name": product.name,
        "storage_row_id": storage_row_id,
        "storage_row_name": row.name,
        "full_units": int(placement.full_units or 0),
        "open_units": int(placement.open_units or 0),
        "unit_label": lot.unit_label,
        "derived_weight": lps.derived_weight(lot, placement),
        "weight_unit": lot.weight_unit,
        "needs_labels": lot.label_printed_at is None,
    }


def count_row(
    db: Session,
    *,
    material_lot_id: str,
    storage_row_id: str,
    full_units: int,
    open_units: int = 0,
    open_remaining_qty: float = 0.0,
    user_id: Optional[str] = None,
    note: Optional[str] = None,
) -> dict:
    """A physical count. Sets an ABSOLUTE figure and records the variance.

    THIS IS THE FIRST FLOW IN THE SYSTEM THAT CAN LEGITIMATELY INCREASE STOCK.
    `AdjustmentType.FOUND` has existed in the enum since before this model and is
    rejected at creation because it is not in `DEDUCTION_TYPES`; nothing anywhere
    could raise a receipt from a physical count.

    It is implemented here rather than by finally wiring FOUND into
    `InventoryAdjustment`, deliberately. That machinery is finished-goods shaped
    — it is measured in cases and keyed on pallet licences — and routing a drum
    count through it would put the same fact in two ledgers that can disagree.
    `LotPlacementEvent` already records the signed delta, the actor, the reason
    and a total order, which is everything an adjustment row would have carried.

    The variance is what makes this worth doing: the system said 40, the counter
    says 38, and the -2 is kept rather than the new figure quietly overwriting
    the old one.
    """
    lot = db.query(MaterialLot).filter(MaterialLot.id == material_lot_id).first()
    if not lot:
        raise NotFoundError("Material lot", material_lot_id)

    before = lps._lock_placement(db, material_lot_id, storage_row_id)
    before_units = int(before.full_units or 0) if before else 0

    lps.set_count(
        db, lot, storage_row_id,
        full_units=full_units,
        open_units=open_units,
        open_remaining_qty=open_remaining_qty,
        actor_id=user_id,
        reason=note or "Physical count",
    )
    after = lps._lock_placement(db, material_lot_id, storage_row_id)
    row = db.query(StorageRow).filter(StorageRow.id == storage_row_id).first()

    return {
        "material_lot_id": material_lot_id,
        "lot_code": lot.lot_code,
        "storage_row_id": storage_row_id,
        "storage_row_name": row.name if row else storage_row_id,
        "system_units": before_units,
        "counted_units": int(after.full_units or 0),
        # Signed. Positive is FOUND, negative is missing. Counted in whole units,
        # because a variance of "-0.18 drums" is not something anyone can act on.
        "variance": int(after.full_units or 0) - before_units,
        "unit_label": lot.unit_label,
        "derived_weight": lps.derived_weight(lot, after),
    }


# ─── step 3: what still needs stickers ────────────────────────────────────────

def lots_on_hand(
    db: Session,
    warehouse_id: Optional[str] = None,
    *,
    unlabelled_only: bool = False,
) -> List[dict]:
    """Lots physically holding stock.

    With `unlabelled_only` this is the cutover's working list — lots that have
    never had a sticker printed. It shrinks on its own as material is staged and
    stickered, so a lot that stays on it for weeks is a slow mover somebody
    should print for on demand rather than a mistake.

    Without it, this is the list a recount picks from: replacing a figure means
    naming which lot on which rack, and a person at a keyboard cannot be expected
    to know a lot code by heart.
    """
    q = (
        db.query(MaterialLot)
        .join(LotPlacement, LotPlacement.material_lot_id == MaterialLot.id)
        .filter(
            MaterialLot.is_deleted == False,  # noqa: E712
            (LotPlacement.full_units > 0) | (LotPlacement.open_units > 0),
        )
    )
    if unlabelled_only:
        q = q.filter(MaterialLot.label_printed_at.is_(None))
    if warehouse_id:
        q = q.filter(LotPlacement.warehouse_id == warehouse_id)

    out = []
    for lot in q.distinct().all():
        product = db.query(Product).filter(Product.id == lot.product_id).first()
        vendor = (
            db.query(Vendor).filter(Vendor.id == lot.vendor_id).first()
            if lot.vendor_id else None
        )
        on_hand = lps.units_on_hand(db, lot.id)
        out.append({
            "material_lot_id": lot.id,
            "lot_code": lot.lot_code,
            "product_id": lot.product_id,
            "product_name": product.name if product else "",
            "vendor_name": vendor.name if vendor else "",
            "vendor_lot": lot.vendor_lot_number,
            "lot_unknown": bool(lot.lot_unknown),
            "bbd": lot.bbd_current,
            "unit_label": lot.unit_label,
            "full_units": on_hand["full_units"],
            "open_units": on_hand["open_units"],
            "row_count": on_hand["row_count"],
            "needs_review": bool(lot.needs_review),
        })
    return sorted(out, key=lambda e: (e["product_name"], e["lot_code"]))


def unlabelled_lots(db: Session, warehouse_id: Optional[str] = None) -> List[dict]:
    """Kept as a name of its own — it is what the cutover's third step means."""
    return lots_on_hand(db, warehouse_id, unlabelled_only=True)


def cutover_status(db: Session, warehouse_id: Optional[str] = None) -> dict:
    """How far through the cutover this warehouse is.

    `rooms` reports "3 of 5 lots counted" per room rather than a total, because a
    partly-converted room must be treated as legacy by every gate — a total would
    hide exactly the state that matters.
    """
    remaining = _zero_out_query(db, warehouse_id).count()
    counted_lots = _counted_lot_count(db, warehouse_id)
    unlabelled = len(unlabelled_lots(db, warehouse_id))

    return {
        "warehouse_id": warehouse_id,
        "legacy_receipts_with_stock": remaining,
        "counted_lots": counted_lots,
        "lots_awaiting_labels": unlabelled,
        "step": (
            "zero_out" if remaining > 0
            else "opening_balances" if counted_lots == 0
            else "labelling" if unlabelled > 0
            else "complete"
        ),
    }
