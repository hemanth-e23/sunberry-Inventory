"""Cutover endpoints: floor-sweep conversion and reconciliation (SPEC §15, Phase 6).

Thin router over ingredient_cutover_service, which owns no transaction.

The sweep is a supervisor-grade operation: it permanently moves quantity off a
legacy receipt, and a mistake compounds silently across a whole lot.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.constants import APPROVAL_ROLES
from app.database import get_db
from app.exceptions import ForbiddenError, NotFoundError
from app.models import Receipt
from app.schemas.base import BaseSchema
from app.routers.ingredient_intakes import _serialize_container
from app.services import ingredient_cutover_service as cut
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()


def _require_sweeper(current_user):
    if current_user.role not in APPROVAL_ROLES:
        raise ForbiddenError("Only supervisors and above can run the floor sweep")
    return current_user


def _get_receipt(db: Session, receipt_id: str) -> Receipt:
    receipt = (
        db.query(Receipt)
        .filter(Receipt.id == receipt_id, Receipt.is_deleted == False)  # noqa: E712
        .first()
    )
    if not receipt:
        raise NotFoundError("Receipt", receipt_id)
    return receipt


class ConvertRequest(BaseSchema):
    receipt_id: str
    storage_row_id: str
    # Cutover-time corrections: a drum whose label is legible may carry a better
    # lot/BBD than the receipt does.
    lot_number_override: Optional[str] = None
    bbd_override: Optional[str] = None
    damaged: bool = False
    # Set when the drum is already part-used, so it converts as `opened` with a
    # real remaining quantity rather than pretending to be sealed.
    opened_remaining: Optional[float] = None


@router.get("/eligibility/{receipt_id}")
async def eligibility(
    receipt_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Can this receipt be swept, and if not, why not.

    Partially-held lots are deliberately refused: `hold` is a flag but
    `held_quantity` is the real hold, and nothing records WHICH drums are held,
    so there is no correct per-drum answer. They become eligible once the hold
    is cleared or applied in full.
    """
    return cut.sweep_eligibility(db, _get_receipt(db, receipt_id))


@router.post("/convert")
async def convert(
    payload: ConvertRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Convert ONE physical drum off a legacy receipt into a serialized container.

    One transaction: decrement the receipt by the drum's NET WEIGHT (not by 1 —
    for ingredients `Receipt.quantity` is weight), decrement container_count,
    free the scanned row explicitly, mint the container, and write an
    already-approved adjustment for report continuity. The balance is asserted
    before the transaction is allowed to close.
    """
    _require_sweeper(current_user)
    receipt = _get_receipt(db, payload.receipt_id)

    bbd = None
    if payload.bbd_override:
        from datetime import datetime
        bbd = datetime.fromisoformat(payload.bbd_override.replace("Z", "+00:00"))

    result = cut.convert_one(
        db, receipt, payload.storage_row_id, current_user,
        lot_number_override=payload.lot_number_override,
        bbd_override=bbd,
        damaged=payload.damaged,
        opened_remaining=payload.opened_remaining,
    )
    db.commit()
    result["container"] = _serialize_container(db, result["container"])
    return result


@router.get("/reconciliation")
async def reconciliation(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Per-lot: legacy remaining + serialized == expected.

    Drift is reported, never auto-healed — a discrepancy means a write path is
    wrong or material moved without being scanned, and quietly correcting it is
    how the previous denormalization bugs stayed invisible.
    """
    return cut.reconciliation(db, warehouse_id=warehouse_filter(current_user))
