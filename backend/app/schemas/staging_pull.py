"""Schemas for the forklift staging-pull gun flow.

Same wire contract rules as lot receiving (see routers/lot_receiving.py's
module docstring): every soft question is a 200 with a `status`
discriminator, one response shape for every scan outcome, and the
idempotency key is minted by the gun per scan event so an offline replay
can never double-pull a rack.
"""
from typing import List, Optional

from pydantic import BaseModel, Field


class StagingPullScanRequest(BaseModel):
    # The raw sticker text — SB2 envelope or bare lot code. The server
    # unwraps it (resolve_lot_code), the gun never has to.
    code: str = Field(..., min_length=1, max_length=200)
    # The rack the worker is pulling from (sticky row context, scanned or
    # picked on the gun). Rack suggestions are advisory; this is the truth.
    storage_row_id: str = Field(..., min_length=1, max_length=50)
    units: int = Field(1, ge=1, le=200)
    # Pull one OPENED container instead of sealed ones (use up partials first).
    pull_open: bool = False
    # Replay of a parked needs_confirm scan — same idempotency_key, worker
    # said yes to the advisory (non-FEFO lot).
    allow_mismatch: bool = False
    # 8..64 so a truncated key 422s here rather than silently colliding.
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=64)


class StagingPullScanResponse(BaseModel):
    # ok | needs_confirm | unknown_lot | wrong_product | lot_held |
    # not_enough | undone | nothing_to_undo
    status: str
    message: str = ""
    warning: Optional[str] = None

    item_id: Optional[str] = None
    ingredient_name: Optional[str] = None
    lot_code: Optional[str] = None
    vendor_lot: Optional[str] = None
    units: int = 0
    quantity: float = 0.0

    # Progress snapshot so the gun renders counters from server truth.
    item_pending_qty: float = 0.0     # scanned on the gun, not yet submitted
    item_fulfilled_qty: float = 0.0   # already submitted (QuickStage or gun)
    item_needed_qty: float = 0.0
    request_pending_qty: float = 0.0


class StagingPullSubmitRequest(BaseModel):
    staging_location_id: str = Field(..., min_length=1, max_length=50)
    staging_sub_location_id: Optional[str] = Field(None, max_length=50)


class StagingPullSubmitResponse(BaseModel):
    # ok | needs_confirm | nothing_to_submit
    status: str
    message: str = ""
    warning: Optional[str] = None
    short_items: List[str] = []
    staging_item_ids: List[str] = []
    request_status: Optional[str] = None
