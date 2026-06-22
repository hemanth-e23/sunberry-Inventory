from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from datetime import datetime, timezone
import json
import uuid
import copy
import logging

from app.database import get_db
from app.models import (
    Receipt, InventoryTransfer, InventoryTransferLine, TransferPalletSwap,
    StorageArea, StorageRow, User, Category,
    PalletLicence, TransferScanEvent, Product
)
from app.schemas import (
    InventoryTransfer as InventoryTransferSchema, InventoryTransferCreate, InventoryTransferUpdate,
    ShipOutPickListCreate, ScanPickRequest, ForkliftSubmitRequest,
    TransferEditRequest, TransferVoidRequest,
    # v2 lot-level ship-out
    ShipOutPickListCreateV2, ScanPickRequestV2, UnscanPickRequestV2, LotEscapeHatchRequest,
    RetargetLotRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter, resolve_warehouse_for_write, require_approval_access
from app.enums import TransferStatus, PalletStatus, ReceiptStatus, ShipOutScanReason
from app.services import transfer_service
from app.constants import (
    ROLE_FORKLIFT, ROLE_WAREHOUSE, APPROVAL_ROLES,
    TRANSFER_TYPE_SHIPPED_OUT,
    SWAP_SOURCE_FORKLIFT, SWAP_SOURCE_WAREHOUSE_EDIT,
)

router = APIRouter()


def _transfer_to_response(transfer, db: Session) -> dict:
    """Convert transfer to response dict including pallet licence details, lines and swaps."""
    data = {
        "id": transfer.id,
        "receipt_id": transfer.receipt_id,
        "from_location_id": transfer.from_location_id,
        "from_sub_location_id": transfer.from_sub_location_id,
        "to_location_id": transfer.to_location_id,
        "to_sub_location_id": transfer.to_sub_location_id,
        "quantity": transfer.quantity,
        "unit": transfer.unit or "cases",
        "reason": transfer.reason,
        "transfer_type": transfer.transfer_type or "warehouse-transfer",
        "order_number": transfer.order_number,
        "source_breakdown": transfer.source_breakdown,
        "destination_breakdown": transfer.destination_breakdown,
        "pallet_licence_ids": transfer.pallet_licence_ids,
        "status": transfer.status,
        "requested_by": transfer.requested_by,
        "approved_by": transfer.approved_by,
        "approved_at": transfer.approved_at,
        "submitted_at": transfer.submitted_at,
        "created_at": transfer.created_at,
        "forklift_submitted_at": getattr(transfer, "forklift_submitted_at", None),
        "forklift_notes": getattr(transfer, "forklift_notes", None),
        "skipped_pallet_ids": getattr(transfer, "skipped_pallet_ids", None) or [],
        "voided_at": getattr(transfer, "voided_at", None),
        "voided_by": getattr(transfer, "voided_by", None),
        "voided_reason": getattr(transfer, "voided_reason", None),
    }
    pl_ids = transfer.pallet_licence_ids or []
    if pl_ids:
        licences = db.query(PalletLicence).filter(PalletLicence.id.in_(pl_ids)).all()
        licence_list = []
        for pl in licences:
            row_name = None
            area_name = None
            if pl.storage_row_id:
                row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                if row:
                    row_name = row.name
                    if row.storage_area_id:
                        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                        if area:
                            area_name = area.name
            location_label = "Floor" if not row_name else f"{area_name}/{row_name}" if area_name else row_name
            licence_list.append({
                "id": pl.id,
                "licence_number": pl.licence_number or "",
                "cases": pl.cases or 0,
                "lot_number": pl.lot_number or "",
                "storage_row_id": pl.storage_row_id,
                "location": location_label,
                "product_id": pl.product_id,
                "receipt_id": pl.receipt_id,
                "status": pl.status,
            })
        data["pallet_licence_details"] = licence_list
    else:
        data["pallet_licence_details"] = []

    # Per-line breakdown for multi-product ship-outs (None for legacy single-receipt rows)
    lines = list(transfer.lines or [])
    if lines:
        line_list = []
        product_ids = {ln.product_id for ln in lines}
        receipt_ids = {ln.receipt_id for ln in lines}
        products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()} if product_ids else {}
        receipts = {r.id: r for r in db.query(Receipt).filter(Receipt.id.in_(receipt_ids)).all()} if receipt_ids else {}
        for ln in lines:
            prod = products.get(ln.product_id)
            rcpt = receipts.get(ln.receipt_id)
            line_list.append({
                "id": ln.id,
                "transfer_id": ln.transfer_id,
                "product_id": ln.product_id,
                "product_name": prod.name if prod else None,
                "product_short_code": prod.short_code if prod else None,
                "product_fcc_code": prod.fcc_code if prod else None,
                "receipt_id": ln.receipt_id,
                "lot_number": rcpt.lot_number if rcpt else None,
                "cases_requested": ln.cases_requested,
                "cases_picked": ln.cases_picked,
                # Over-pull is allowed (totals are soft) — flag it so the
                # approver sees when more shipped than was ordered.
                "is_overage": float(ln.cases_picked or 0) > float(ln.cases_requested or 0) + 0.001,
                "pallet_licence_ids": ln.pallet_licence_ids or [],
                # v2 lot-level fields (populated by the new pick-list flow;
                # backfilled for legacy rows by the migration)
                "lot_allocations": ln.lot_allocations or [],
                "picks": ln.picks or [],
                "lot_swap_history": ln.lot_swap_history or [],
                "line_seq": ln.line_seq,
            })
        data["lines"] = line_list
    else:
        data["lines"] = None

    # Swap audit trail (only meaningful for ship-outs that have had swaps)
    swaps = list(transfer.swaps or [])
    if swaps:
        swap_list = []
        all_swap_pl_ids = {s.removed_pallet_id for s in swaps} | {s.added_pallet_id for s in swaps}
        all_swap_pl_ids.discard(None)
        swap_pl_lookup = (
            {pl.id: pl for pl in db.query(PalletLicence).filter(PalletLicence.id.in_(all_swap_pl_ids)).all()}
            if all_swap_pl_ids else {}
        )
        swap_user_ids = {s.swapped_by for s in swaps}
        swap_user_ids.discard(None)
        swap_user_lookup = (
            {u.id: u for u in db.query(User).filter(User.id.in_(swap_user_ids)).all()}
            if swap_user_ids else {}
        )
        for s in swaps:
            removed = swap_pl_lookup.get(s.removed_pallet_id) if s.removed_pallet_id else None
            added = swap_pl_lookup.get(s.added_pallet_id) if s.added_pallet_id else None
            actor = swap_user_lookup.get(s.swapped_by) if s.swapped_by else None
            swap_list.append({
                "id": s.id,
                "transfer_line_id": s.transfer_line_id,
                "removed_pallet_id": s.removed_pallet_id,
                "removed_licence_number": removed.licence_number if removed else None,
                "added_pallet_id": s.added_pallet_id,
                "added_licence_number": added.licence_number if added else None,
                "swapped_by": s.swapped_by,
                "swapped_by_name": actor.name if actor else None,
                "swapped_at": s.swapped_at,
                "reason": s.reason,
                "source": s.source,
            })
        data["swaps"] = swap_list
    else:
        data["swaps"] = []
    return data


def _generate_id(prefix: str) -> str:
    return f"{prefix}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"


def _lock_pallets_for_update(db: Session, pallet_ids):
    """SELECT ... FOR UPDATE the given pallet rows. Returns {id: pallet}."""
    if not pallet_ids:
        return {}
    rows = (
        db.query(PalletLicence)
        .filter(PalletLicence.id.in_(list(pallet_ids)))
        .with_for_update()
        .all()
    )
    return {p.id: p for p in rows}


def _ship_out_only(transfer: InventoryTransfer):
    if (transfer.transfer_type or "") != TRANSFER_TYPE_SHIPPED_OUT:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a ship-out transfer")


@router.get("/transfers")
async def get_transfers(
    skip: int = 0,
    limit: int = 1000,
    status: str = None,
    transfer_type: str = None,
    requested_by: str = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get inventory transfers with pallet licence details.

    Forklift role is restricted to pending ship-out orders only — the
    scanner needs this to populate the order-picker screen. Everything
    else (other statuses, other transfer types) still 403s for forklift.
    """
    if current_user.role == ROLE_FORKLIFT:
        if status != TransferStatus.PENDING or transfer_type != TRANSFER_TYPE_SHIPPED_OUT:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Forklift can only list pending ship-out orders "
                    "(status=pending, transfer_type=shipped-out)."
                ),
            )

    query = db.query(InventoryTransfer)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(InventoryTransfer.warehouse_id == wh_id)

    if status:
        query = query.filter(InventoryTransfer.status == status)
    if transfer_type:
        query = query.filter(InventoryTransfer.transfer_type == transfer_type)
    if requested_by:
        query = query.filter(InventoryTransfer.requested_by == requested_by)

    transfers = query.order_by(InventoryTransfer.submitted_at.desc()).offset(skip).limit(limit).all()
    return [_transfer_to_response(t, db) for t in transfers]

@router.post("/transfers", response_model=InventoryTransferSchema)
async def create_transfer(
    transfer_data: InventoryTransferCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new inventory transfer"""
    # Validate receipt exists
    receipt = db.query(Receipt).filter(Receipt.id == transfer_data.receipt_id).first()
    if not receipt:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Receipt not found"
        )

    # Validate quantity
    if transfer_data.quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quantity must be greater than zero"
        )

    # Available excludes any quantity on QA hold — held inventory must not be
    # transferred or shipped. (held_quantity is the real hold; receipt.hold is
    # also set transiently by this endpoint while a transfer is pending.)
    available = receipt.quantity - (receipt.held_quantity or 0)
    if transfer_data.quantity > available:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Requested quantity exceeds available (on-hold inventory excluded)"
        )

    # Validate order number for shipped-out transfers
    if transfer_data.transfer_type == "shipped-out" and not transfer_data.order_number:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Order number is required for shipped-out transfers"
        )

    transfer_dict = transfer_data.dict()
    transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"

    db_transfer = InventoryTransfer(
        id=transfer_id,
        **transfer_dict,
        requested_by=str(current_user.id),
        warehouse_id=resolve_warehouse_for_write(current_user),
        status=TransferStatus.PENDING
    )

    # Set receipt on hold when transfer is pending (shows as "on hold" during review)
    receipt.hold = True

    db.add(db_transfer)
    db.commit()
    db.refresh(db_transfer)
    return _transfer_to_response(db_transfer, db)


@router.post("/ship-out/pick-list")
async def create_ship_out_pick_list(
    data: ShipOutPickListCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a multi-product ship-out order.

    One InventoryTransfer parent represents the whole order, and one
    InventoryTransferLine row per (product, receipt) tracks the per-product
    breakdown. All selected pallets are flipped to RESERVED inside a single
    transaction under a row-level lock to prevent concurrent double-booking.
    """
    target_warehouse_id = resolve_warehouse_for_write(current_user)

    # 1. Flatten all pallet ids, check for duplicates across lines/picks
    all_pallet_ids: list = []
    line_pick_index = []  # [(line_idx, pick_idx, product_id, receipt_id, [pallet_ids])]
    seen = set()
    for li, line in enumerate(data.lines):
        for pi, pick in enumerate(line.picks):
            for pid in pick.pallet_licence_ids:
                if pid in seen:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Pallet {pid} appears on more than one line",
                    )
                seen.add(pid)
                all_pallet_ids.append(pid)
            line_pick_index.append((li, pi, line.product_id, pick.receipt_id, list(pick.pallet_licence_ids)))

    if not all_pallet_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No pallets selected")

    # 2. Lock the pallet rows and validate each
    pallet_lookup = _lock_pallets_for_update(db, all_pallet_ids)
    missing = [pid for pid in all_pallet_ids if pid not in pallet_lookup]
    if missing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallet licences not found: {missing}")

    held = [pid for pid, pl in pallet_lookup.items() if pl.is_held]
    if held:
        held_lic = [pallet_lookup[pid].licence_number or pid for pid in held]
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallets on hold: {held_lic}")

    not_in_stock = [
        pallet_lookup[pid].licence_number or pid
        for pid in all_pallet_ids
        if pallet_lookup[pid].status != PalletStatus.IN_STOCK
    ]
    if not_in_stock:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Pallets not available (already reserved, shipped, or in another order): {not_in_stock}",
        )

    if target_warehouse_id:
        wrong_wh = [
            pallet_lookup[pid].licence_number or pid
            for pid in all_pallet_ids
            if pallet_lookup[pid].warehouse_id and pallet_lookup[pid].warehouse_id != target_warehouse_id
        ]
        if wrong_wh:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Pallets belong to another warehouse: {wrong_wh}",
            )

    # 3. Per-line/pick validation: pallets actually match claimed product + receipt
    receipt_ids = {pick_receipt for _, _, _, pick_receipt, _ in line_pick_index}
    receipts = {r.id: r for r in db.query(Receipt).filter(Receipt.id.in_(receipt_ids)).all()}
    for rid in receipt_ids:
        if rid not in receipts:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Receipt not found: {rid}")

    for li, pi, product_id, pick_receipt, pid_list in line_pick_index:
        rcpt = receipts.get(pick_receipt)
        if rcpt and rcpt.product_id != product_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Line {li + 1} claims product {product_id} but receipt {pick_receipt} "
                    f"is for product {rcpt.product_id}"
                ),
            )
        for pid in pid_list:
            pl = pallet_lookup[pid]
            if pl.receipt_id != pick_receipt:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Pallet {pl.licence_number or pid} belongs to receipt "
                        f"{pl.receipt_id}, not {pick_receipt}"
                    ),
                )
            if pl.product_id and pl.product_id != product_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Pallet {pl.licence_number or pid} is product {pl.product_id}, "
                        f"not {product_id}"
                    ),
                )

    # 4. Soft warn for duplicate order_number in the same warehouse
    dup_query = db.query(InventoryTransfer).filter(
        InventoryTransfer.order_number == data.order_number,
        InventoryTransfer.transfer_type == TRANSFER_TYPE_SHIPPED_OUT,
        InventoryTransfer.status.in_([TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED]),
    )
    if target_warehouse_id:
        dup_query = dup_query.filter(InventoryTransfer.warehouse_id == target_warehouse_id)
    duplicate_warning = dup_query.first()

    # 5. Create parent transfer + lines + flip pallets to RESERVED
    transfer_id = _generate_id("transfer")
    total_cases = 0.0
    all_pl_ids_flat: list = []
    line_rows: list = []

    for li, line in enumerate(data.lines):
        for pi, pick in enumerate(line.picks):
            pick_cases = sum(pallet_lookup[pid].cases or 0 for pid in pick.pallet_licence_ids)
            total_cases += pick_cases
            all_pl_ids_flat.extend(pick.pallet_licence_ids)
            line_row = InventoryTransferLine(
                id=_generate_id("trln"),
                transfer_id=transfer_id,
                product_id=line.product_id,
                receipt_id=pick.receipt_id,
                cases_requested=float(line.cases_requested),
                cases_picked=float(pick_cases),
                pallet_licence_ids=list(pick.pallet_licence_ids),
                line_seq=li * 100 + pi,
            )
            line_rows.append(line_row)

    if total_cases <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No cases in selected pallets")

    # source_breakdown across the flattened pallet set
    row_cases: dict = {}
    for pid in all_pl_ids_flat:
        pl = pallet_lookup[pid]
        key = f"row-{pl.storage_row_id}" if pl.storage_row_id else "floor"
        row_cases[key] = row_cases.get(key, 0) + (pl.cases or 0)
    source_breakdown = [{"id": k, "quantity": v} for k, v in row_cases.items()]

    db_transfer = InventoryTransfer(
        id=transfer_id,
        receipt_id=None,
        quantity=total_cases,
        unit="cases",
        transfer_type=TRANSFER_TYPE_SHIPPED_OUT,
        order_number=data.order_number,
        source_breakdown=source_breakdown,
        pallet_licence_ids=all_pl_ids_flat,
        requested_by=str(current_user.id),
        warehouse_id=target_warehouse_id,
        status=TransferStatus.PENDING,
    )
    db.add(db_transfer)
    for line_row in line_rows:
        db.add(line_row)

    # Reserve pallets so a second concurrent submit can't grab them
    for pid in all_pl_ids_flat:
        pallet_lookup[pid].status = PalletStatus.RESERVED

    db.commit()
    db.refresh(db_transfer)

    response = _transfer_to_response(db_transfer, db)
    if duplicate_warning:
        response["warning"] = (
            f"Order number {data.order_number} already has another open ship-out "
            f"({duplicate_warning.id})."
        )
    return response


@router.post("/transfers/{transfer_id}/scan-pick")
async def scan_pick_transfer(
    transfer_id: str,
    data: ScanPickRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Forklift scans a pallet during ship-out picking.

    Three outcomes:
    - **on list**: pallet was planned; record scan event and return success
    - **off list but same product**: try to swap an unscanned planned pallet for the scanned one
      (FCC match required). On success, update the line, reserve the new pallet, release the
      old one, and write a TransferPalletSwap row.
    - **off list, no match**: reject with a structured reason code (WRONG_PRODUCT,
      LINE_COMPLETE, PALLET_UNAVAILABLE, PALLET_NOT_FOUND).
    """
    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)
    if transfer.status not in (TransferStatus.PENDING,):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pick list is no longer open for scanning",
        )

    pl_ids = list(transfer.pallet_licence_ids or [])
    if not pl_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer has no pick list")

    # Look up the scanned pallet
    if data.licence_id:
        pl = (
            db.query(PalletLicence)
            .filter(PalletLicence.id == data.licence_id)
            .with_for_update()
            .first()
        )
    elif data.licence_number:
        pl = (
            db.query(PalletLicence)
            .filter(PalletLicence.licence_number == data.licence_number)
            .with_for_update()
            .first()
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="licence_number or licence_id required",
        )

    def _record_scan(licence_id, licence_number, on_list):
        evt = TransferScanEvent(
            id=_generate_id("scan"),
            transfer_id=transfer_id,
            licence_number=licence_number or "",
            licence_id=licence_id,
            on_list=on_list,
            scanned_by=str(current_user.id) if current_user else None,
        )
        db.add(evt)

    if not pl:
        _record_scan(None, data.licence_number or data.licence_id or "", on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.PALLET_NOT_FOUND.value,
            "message": "Pallet licence not found",
        }

    licence_label = pl.licence_number or pl.id

    # On-list scan: planned pallet, record and return.
    if pl.id in pl_ids:
        _record_scan(pl.id, pl.licence_number, on_list=True)
        db.commit()
        return {
            "success": True,
            "on_list": True,
            "licence": {"id": pl.id, "licence_number": pl.licence_number, "cases": pl.cases},
            "message": "On pick list",
        }

    # Off-list: try same-product swap.
    lines = list(transfer.lines or [])
    if not lines:
        # Legacy single-receipt ship-out: keep prior behavior (exception override).
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": True,
            "on_list": False,
            "licence": {"id": pl.id, "licence_number": pl.licence_number, "cases": pl.cases},
            "message": "Not on pick list (override allowed)",
        }

    scanned_product_id = pl.product_id
    matching_lines = [ln for ln in lines if ln.product_id == scanned_product_id]
    if not matching_lines:
        # Find FCC of expected vs scanned for a friendly message
        expected_fcc_codes = sorted({
            (db.query(Product).filter(Product.id == ln.product_id).first().fcc_code or "")
            for ln in lines
            if db.query(Product).filter(Product.id == ln.product_id).first()
        })
        scanned_prod = (
            db.query(Product).filter(Product.id == scanned_product_id).first()
            if scanned_product_id else None
        )
        scanned_fcc = scanned_prod.fcc_code if scanned_prod else None
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.WRONG_PRODUCT.value,
            "scanned_fcc": scanned_fcc,
            "expected_fcc_codes": [c for c in expected_fcc_codes if c],
            "message": (
                f"Wrong product: scanned FCC {scanned_fcc or '?'}; "
                f"expected one of {', '.join(c for c in expected_fcc_codes if c) or '(none)'}"
            ),
        }

    # Validate the replacement pallet's availability
    if pl.is_held:
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {licence_label} is on hold",
        }
    if pl.status != PalletStatus.IN_STOCK:
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": (
                f"Pallet {licence_label} is not in stock "
                f"(status: {pl.status}) — may be in another order"
            ),
        }
    if transfer.warehouse_id and pl.warehouse_id and pl.warehouse_id != transfer.warehouse_id:
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.PALLET_UNAVAILABLE.value,
            "message": f"Pallet {licence_label} belongs to another warehouse",
        }

    # Find a planned-but-unscanned pallet on a matching line to remove.
    scanned_ids = {
        e.licence_id
        for e in db.query(TransferScanEvent)
        .filter(TransferScanEvent.transfer_id == transfer_id, TransferScanEvent.on_list == True)
        .all()
    }
    skipped_ids = set(transfer.skipped_pallet_ids or [])

    target_line = None
    removed_pallet_id = None
    for ln in matching_lines:
        for cand_id in ln.pallet_licence_ids or []:
            if cand_id in scanned_ids:
                continue
            target_line = ln
            removed_pallet_id = cand_id
            break
        if target_line:
            break

    if not target_line or not removed_pallet_id:
        scanned_prod = (
            db.query(Product).filter(Product.id == scanned_product_id).first()
            if scanned_product_id else None
        )
        scanned_fcc = scanned_prod.fcc_code if scanned_prod else None
        _record_scan(pl.id, pl.licence_number, on_list=False)
        db.commit()
        return {
            "success": False,
            "on_list": False,
            "reason": ShipOutScanReason.LINE_COMPLETE.value,
            "scanned_fcc": scanned_fcc,
            "message": f"All planned pallets for FCC {scanned_fcc or '?'} are already scanned",
        }

    # Perform the swap atomically.
    removed_pl = (
        db.query(PalletLicence)
        .filter(PalletLicence.id == removed_pallet_id)
        .with_for_update()
        .first()
    )
    if not removed_pl:
        raise HTTPException(status_code=500, detail="Internal: planned pallet missing")

    new_line_pl_ids = [pid for pid in (target_line.pallet_licence_ids or []) if pid != removed_pallet_id]
    new_line_pl_ids.append(pl.id)
    target_line.pallet_licence_ids = new_line_pl_ids
    target_line.cases_picked = float(
        (target_line.cases_picked or 0) - (removed_pl.cases or 0) + (pl.cases or 0)
    )

    new_parent_pl_ids = [pid for pid in pl_ids if pid != removed_pallet_id]
    new_parent_pl_ids.append(pl.id)
    transfer.pallet_licence_ids = new_parent_pl_ids
    transfer.quantity = float((transfer.quantity or 0) - (removed_pl.cases or 0) + (pl.cases or 0))

    # Flip pallet statuses
    if removed_pl.status == PalletStatus.RESERVED:
        removed_pl.status = PalletStatus.IN_STOCK
    pl.status = PalletStatus.RESERVED

    # Record swap audit row
    swap = TransferPalletSwap(
        id=_generate_id("swap"),
        transfer_id=transfer_id,
        transfer_line_id=target_line.id,
        removed_pallet_id=removed_pallet_id,
        added_pallet_id=pl.id,
        swapped_by=str(current_user.id) if current_user else None,
        reason="forklift on-the-fly swap",
        source=SWAP_SOURCE_FORKLIFT,
    )
    db.add(swap)

    _record_scan(pl.id, pl.licence_number, on_list=True)
    db.commit()
    db.refresh(transfer)

    return {
        "success": True,
        "on_list": True,
        "swap": {
            "id": swap.id,
            "removed_pallet_id": removed_pallet_id,
            "removed_licence_number": removed_pl.licence_number,
            "added_pallet_id": pl.id,
            "added_licence_number": pl.licence_number,
        },
        "licence": {"id": pl.id, "licence_number": pl.licence_number, "cases": pl.cases},
        "message": f"Swapped {removed_pl.licence_number} for {pl.licence_number}",
    }


@router.get("/transfers/{transfer_id}/scan-progress")
async def get_transfer_scan_progress(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get ship-out picking progress with per-pallet status (for forklift UI and approvals live view)."""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    pl_ids = transfer.pallet_licence_ids or []
    total_pallets = len(pl_ids) if isinstance(pl_ids, list) else 0
    skipped_ids = set(getattr(transfer, "skipped_pallet_ids", None) or [])

    events = (
        db.query(TransferScanEvent)
        .filter(TransferScanEvent.transfer_id == transfer_id)
        .order_by(TransferScanEvent.scanned_at)
        .all()
    )

    # Build scan lookup: pallet_id -> latest scan event
    scanned_pl_ids: dict = {}
    raw_exceptions: list = []
    last_scan = None
    successful_normalized: set = set()
    for e in events:
        scanner_name = None
        if e.scanned_by:
            u = db.query(User).filter(User.id == e.scanned_by).first()
            # Show a readable label for a hard-deleted user, never the raw id.
            scanner_name = u.name if u else "Former user"
        evt = {
            "licence_number": e.licence_number,
            "on_list": e.on_list,
            "scanned_by": scanner_name,
            "scanned_at": e.scanned_at.isoformat() if e.scanned_at else None,
        }
        if e.on_list and e.licence_id:
            scanned_pl_ids[e.licence_id] = evt
        if e.on_list and e.licence_number:
            successful_normalized.add("".join(e.licence_number.split()).upper())
        if not e.on_list:
            raw_exceptions.append(evt)
        last_scan = evt

    # Suppress exceptions that the user later resolved with a successful scan
    # (whitespace-normalized + case-insensitive match against successful
    # scans). Stops failed copy-paste attempts from showing up after the
    # pallet was eventually picked correctly.
    exceptions = [
        e for e in raw_exceptions
        if "".join((e["licence_number"] or "").split()).upper() not in successful_normalized
    ]

    # Build per-pallet pick list (enriched with product info for grouped display)
    pick_list = []
    if pl_ids:
        licences = db.query(PalletLicence).filter(PalletLicence.id.in_(pl_ids)).all()
        pl_map = {pl.id: pl for pl in licences}
        product_ids = {pl.product_id for pl in licences if pl.product_id}
        products = (
            {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids)).all()}
            if product_ids else {}
        )
        for pl_id in pl_ids:
            pl = pl_map.get(pl_id)
            if not pl:
                continue
            row_name = None
            area_name = None
            if pl.storage_row_id:
                row = db.query(StorageRow).filter(StorageRow.id == pl.storage_row_id).first()
                if row:
                    row_name = row.name
                    if row.storage_area_id:
                        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
                        if area:
                            area_name = area.name
            location_label = "Floor" if not row_name else f"{area_name}/{row_name}" if area_name else row_name
            scan_evt = scanned_pl_ids.get(pl_id)
            prod = products.get(pl.product_id) if pl.product_id else None
            pick_list.append({
                "pallet_id": pl.id,
                "licence_number": pl.licence_number or "",
                "cases": pl.cases or 0,
                "lot_number": pl.lot_number or "",
                "location": location_label,
                "is_scanned": pl_id in scanned_pl_ids,
                "is_skipped": pl_id in skipped_ids,
                "scanned_at": scan_evt["scanned_at"] if scan_evt else None,
                "scanned_by": scan_evt["scanned_by"] if scan_evt else None,
                "product_id": pl.product_id,
                "product_name": prod.name if prod else None,
                "product_fcc_code": prod.fcc_code if prod else None,
            })

    # Swap log (for the approver and the forklift's "what happened" view)
    swaps_payload = []
    for s in (transfer.swaps or []):
        actor_name = None
        if s.swapped_by:
            u = db.query(User).filter(User.id == s.swapped_by).first()
            # Show a readable label for a hard-deleted user, never the raw id.
            actor_name = u.name if u else "Former user"
        removed_pl = db.query(PalletLicence).filter(PalletLicence.id == s.removed_pallet_id).first() if s.removed_pallet_id else None
        added_pl = db.query(PalletLicence).filter(PalletLicence.id == s.added_pallet_id).first() if s.added_pallet_id else None
        swaps_payload.append({
            "id": s.id,
            "removed_pallet_id": s.removed_pallet_id,
            "removed_licence_number": removed_pl.licence_number if removed_pl else None,
            "added_pallet_id": s.added_pallet_id,
            "added_licence_number": added_pl.licence_number if added_pl else None,
            "swapped_by": actor_name,
            "swapped_at": s.swapped_at.isoformat() if s.swapped_at else None,
            "source": s.source,
        })

    return {
        "transfer_id": transfer_id,
        "order_number": transfer.order_number,
        "total_pallets": total_pallets,
        "scanned_count": len(scanned_pl_ids),
        "pick_list": pick_list,
        "exceptions": exceptions,
        "last_scan": last_scan,
        "swaps": swaps_payload,
        "forklift_submitted_at": getattr(transfer, "forklift_submitted_at", None),
        "forklift_notes": getattr(transfer, "forklift_notes", None),
        "skipped_pallet_ids": list(skipped_ids),
    }


@router.post("/transfers/{transfer_id}/forklift-submit")
async def forklift_submit_transfer(
    transfer_id: str,
    data: ForkliftSubmitRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Forklift driver submits the ship-out pick as done (full or partial).
    Sets forklift_submitted_at and flips status to FORKLIFT_SUBMITTED so the
    warehouse user can review, edit, or void before approval."""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)
    if transfer.status not in (TransferStatus.PENDING,):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer cannot be submitted in its current state")

    transfer.forklift_submitted_at = datetime.now(timezone.utc)
    transfer.forklift_notes = data.notes or None
    transfer.skipped_pallet_ids = data.skipped_pallet_ids or []
    # Only flip status for new multi-line orders; legacy single-receipt ship-outs
    # keep the previous status semantics so existing approval UI sees them unchanged.
    if transfer.lines:
        transfer.status = TransferStatus.FORKLIFT_SUBMITTED
    db.commit()
    db.refresh(transfer)
    return {"success": True, "message": "Pick submitted for approval", "transfer": _transfer_to_response(transfer, db)}


# ─── Warehouse-user edit / void endpoints ───────────────────────────────────────


def _require_warehouse_role_or_higher(current_user):
    if current_user.role == ROLE_FORKLIFT:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forklift role cannot edit or void")


@router.patch("/transfers/{transfer_id}/edit")
async def edit_ship_out_transfer(
    transfer_id: str,
    data: TransferEditRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Warehouse user edits a ship-out after forklift submission, before approval.

    Supports: per-line cases / pallet adjustments, adding new lines, removing lines.
    Pallet reservations are kept consistent on every change.
    """
    _require_warehouse_role_or_higher(current_user)

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)
    if transfer.status not in (TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ship-out can only be edited before approval",
        )
    if not transfer.lines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This ship-out predates multi-line editing and must be rejected/recreated",
        )

    target_warehouse_id = transfer.warehouse_id

    lines_by_id = {ln.id: ln for ln in transfer.lines}

    # 1. Remove lines
    pallets_to_release: set = set()
    for rid in data.remove_line_ids:
        ln = lines_by_id.get(rid)
        if not ln:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Line not found: {rid}")
        pallets_to_release.update(ln.pallet_licence_ids or [])
        db.delete(ln)
        del lines_by_id[rid]

    # 2. Update lines
    pallets_to_reserve: set = set()
    swap_rows: list = []
    for upd in data.line_updates:
        ln = lines_by_id.get(upd.line_id)
        if not ln:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Line not found: {upd.line_id}")
        if upd.cases_requested is not None:
            ln.cases_requested = float(upd.cases_requested)
        if upd.pallet_licence_ids is not None:
            new_set = list(upd.pallet_licence_ids)
            old_set = list(ln.pallet_licence_ids or [])
            removed = [pid for pid in old_set if pid not in new_set]
            added = [pid for pid in new_set if pid not in old_set]
            pallets_to_release.update(removed)
            pallets_to_reserve.update(added)
            # Pair removed/added 1:1 for swap audit; uneven counts still record what we have.
            for i in range(max(len(removed), len(added))):
                swap_rows.append({
                    "line_id": ln.id,
                    "removed_pallet_id": removed[i] if i < len(removed) else None,
                    "added_pallet_id": added[i] if i < len(added) else None,
                })
            ln.pallet_licence_ids = new_set

    # 3. Add new lines (full submit-time validation against the new pallet set)
    if data.add_lines:
        new_pallet_ids: list = []
        for line in data.add_lines:
            for pick in line.picks:
                new_pallet_ids.extend(pick.pallet_licence_ids)
        pallets_to_reserve.update(new_pallet_ids)

    # 4. Lock the affected pallets and validate the reservation set
    affected = list(pallets_to_release | pallets_to_reserve)
    pallet_lookup = _lock_pallets_for_update(db, affected)

    # Validate pallets being newly reserved
    bad_status = []
    held = []
    wrong_wh = []
    for pid in pallets_to_reserve:
        pl = pallet_lookup.get(pid)
        if not pl:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallet not found: {pid}")
        # Allow IN_STOCK pallets to be newly reserved, or RESERVED pallets already on THIS transfer
        already_on_transfer = pid in (transfer.pallet_licence_ids or [])
        if pl.is_held:
            held.append(pl.licence_number or pid)
        elif pl.status != PalletStatus.IN_STOCK and not (pl.status == PalletStatus.RESERVED and already_on_transfer):
            bad_status.append(pl.licence_number or pid)
        if target_warehouse_id and pl.warehouse_id and pl.warehouse_id != target_warehouse_id:
            wrong_wh.append(pl.licence_number or pid)
    if held:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallets on hold: {held}")
    if bad_status:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallets not available: {bad_status}")
    if wrong_wh:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pallets in other warehouse: {wrong_wh}")

    # Validate that pallets newly assigned to an existing line still match that line's
    # product and receipt (e.g. a mango line can't be edited to hold a guava pallet).
    for upd in data.line_updates:
        if upd.pallet_licence_ids is None:
            continue
        ln = lines_by_id.get(upd.line_id)
        if not ln:
            continue
        for pid in upd.pallet_licence_ids:
            pl = pallet_lookup.get(pid)
            if not pl:
                continue  # Already validated above; defensive guard.
            if pl.product_id and pl.product_id != ln.product_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Pallet {pl.licence_number or pid} is product {pl.product_id}, "
                        f"line expects {ln.product_id}"
                    ),
                )
            if pl.receipt_id != ln.receipt_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Pallet {pl.licence_number or pid} is from receipt {pl.receipt_id}, "
                        f"line is for receipt {ln.receipt_id}"
                    ),
                )

    # 5. Insert add_lines (deferred so we can validate uniformly above)
    for li_idx, line in enumerate(data.add_lines):
        for pi_idx, pick in enumerate(line.picks):
            rcpt = db.query(Receipt).filter(Receipt.id == pick.receipt_id).first()
            if not rcpt:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Receipt not found: {pick.receipt_id}")
            if rcpt.product_id != line.product_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Receipt {pick.receipt_id} is for product {rcpt.product_id}, not {line.product_id}",
                )
            for pid in pick.pallet_licence_ids:
                pl = pallet_lookup.get(pid)
                if pl and pl.receipt_id != pick.receipt_id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Pallet {pl.licence_number or pid} not from receipt {pick.receipt_id}",
                    )
            pick_cases = sum(pallet_lookup[pid].cases or 0 for pid in pick.pallet_licence_ids if pid in pallet_lookup)
            max_seq = max((ln.line_seq or 0) for ln in transfer.lines) if transfer.lines else 0
            new_line = InventoryTransferLine(
                id=_generate_id("trln"),
                transfer_id=transfer.id,
                product_id=line.product_id,
                receipt_id=pick.receipt_id,
                cases_requested=float(line.cases_requested),
                cases_picked=float(pick_cases),
                pallet_licence_ids=list(pick.pallet_licence_ids),
                line_seq=max_seq + 1 + li_idx * 100 + pi_idx,
            )
            db.add(new_line)

    # 6. Apply reservation transitions
    for pid in pallets_to_release:
        pl = pallet_lookup.get(pid)
        if pl and pl.status == PalletStatus.RESERVED:
            pl.status = PalletStatus.IN_STOCK
    for pid in pallets_to_reserve:
        pl = pallet_lookup.get(pid)
        if pl and pl.status == PalletStatus.IN_STOCK:
            pl.status = PalletStatus.RESERVED

    # 7. Write swap audit rows for line_updates
    for sr in swap_rows:
        db.add(TransferPalletSwap(
            id=_generate_id("swap"),
            transfer_id=transfer.id,
            transfer_line_id=sr["line_id"],
            removed_pallet_id=sr["removed_pallet_id"],
            added_pallet_id=sr["added_pallet_id"],
            swapped_by=str(current_user.id),
            reason="warehouse edit",
            source=SWAP_SOURCE_WAREHOUSE_EDIT,
        ))

    db.flush()
    # 8. Recompute parent pallet_licence_ids and total quantity from line truth
    transfer.lines  # ensure relationship is loaded
    all_pl_ids: list = []
    total = 0.0
    fresh_lines = db.query(InventoryTransferLine).filter(InventoryTransferLine.transfer_id == transfer.id).all()
    for ln in fresh_lines:
        for pid in ln.pallet_licence_ids or []:
            all_pl_ids.append(pid)
        # Recompute cases_picked from authoritative pallet rows
        line_total = 0.0
        for pid in ln.pallet_licence_ids or []:
            pl = pallet_lookup.get(pid) or db.query(PalletLicence).filter(PalletLicence.id == pid).first()
            if pl:
                line_total += pl.cases or 0
        ln.cases_picked = float(line_total)
        total += line_total
    transfer.pallet_licence_ids = all_pl_ids
    transfer.quantity = float(total)

    db.commit()
    db.refresh(transfer)
    return {"success": True, "transfer": _transfer_to_response(transfer, db)}


@router.post("/transfers/{transfer_id}/void")
async def void_ship_out_transfer(
    transfer_id: str,
    data: TransferVoidRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Void a ship-out order.

    v1 (pallets in RESERVED): releases those pallets back to IN_STOCK.
    v2 (lot reservations + pallet picks): allowed only while zero pallets
    have been scanned. Once any pallet is SHIPPED or any line has a pick
    recorded, the only path back is an inventory adjustment (the pallets
    are physically gone from the shelf or split across two rows).
    """
    from app.services import ship_out_service

    _require_warehouse_role_or_higher(current_user)

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)
    if transfer.status in (TransferStatus.APPROVED, TransferStatus.VOIDED, TransferStatus.REJECTED):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot void an order that is already {transfer.status}",
        )

    # v2 guard: refuse if any pallet has been scanned.
    if ship_out_service.transfer_has_picks(transfer):
        pick_count = sum(len(ln.picks or []) for ln in (transfer.lines or []))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Cannot void — {pick_count} pallet(s) already picked. "
                "Return pallets and use an inventory adjustment instead."
            ),
        )

    # v1: release any RESERVED pallets back to IN_STOCK.
    pallet_ids = list(transfer.pallet_licence_ids or [])
    pallet_lookup = _lock_pallets_for_update(db, pallet_ids)
    for pid in pallet_ids:
        pl = pallet_lookup.get(pid)
        if pl and pl.status == PalletStatus.RESERVED:
            pl.status = PalletStatus.IN_STOCK

    # v2: release any lot reservations on this order.
    ship_out_service.release_reservations(db, transfer)

    transfer.status = TransferStatus.VOIDED
    transfer.voided_at = datetime.now(timezone.utc)
    transfer.voided_by = str(current_user.id)
    transfer.voided_reason = data.reason or None

    db.commit()
    db.refresh(transfer)
    return {"success": True, "transfer": _transfer_to_response(transfer, db)}


@router.put("/transfers/{transfer_id}", response_model=InventoryTransferSchema)
async def update_transfer(
    transfer_id: str,
    transfer_update: InventoryTransferUpdate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Update an inventory transfer"""
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )

    # Check permissions
    if current_user.role == ROLE_WAREHOUSE and transfer.requested_by != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit your own transfers"
        )

    # Only pre-approval transfers may be edited — once approved/rejected/voided
    # the inventory effects are committed and must not be silently altered.
    editable_statuses = {
        TransferStatus.PENDING,
        TransferStatus.SUBMITTED,
        TransferStatus.FORKLIFT_SUBMITTED,
    }
    if transfer.status not in editable_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only pending transfers can be edited"
        )

    update_data = transfer_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(transfer, field, value)

    db.commit()
    db.refresh(transfer)
    return transfer

@router.post("/transfers/{transfer_id}/approve")
async def approve_transfer(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Approve an inventory transfer

    - Admin/supervisor can approve anything
    - Warehouse worker can approve transfers submitted by OTHER users (not their own)
    """
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )

    require_approval_access(current_user, transfer)
    transfer_service.approve_transfer(db, transfer, current_user)
    db.commit()
    db.refresh(transfer)

    return {"message": "Transfer approved successfully", "transfer": transfer}

@router.post("/transfers/{transfer_id}/reject")
async def reject_transfer(
    transfer_id: str,
    reason: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Reject an inventory transfer

    - Admin/supervisor can reject anything
    - Warehouse worker can reject transfers submitted by OTHER users (not their own)
    """
    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Transfer not found"
        )

    require_approval_access(current_user, transfer)
    transfer_service.reject_transfer(db, transfer, reason, current_user)
    # v2: also release any lot reservations.
    from app.services import ship_out_service
    if (transfer.transfer_type or "") == TRANSFER_TYPE_SHIPPED_OUT:
        ship_out_service.release_reservations(db, transfer)
    db.commit()
    db.refresh(transfer)

    return {"message": "Transfer rejected successfully", "transfer": transfer}


# ═══════════════════════════════════════════════════════════════════════════
# Lot-level ship-out v2 endpoints
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/ship-out/available-lots")
async def list_available_lots(
    product_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 1 helper: lots available for a product, oldest-first, with
    cases minus active reservations and per-row breakdown."""
    from app.services import ship_out_service

    target_warehouse_id = resolve_warehouse_for_write(current_user)
    lots = ship_out_service.available_lots_for_product(db, product_id, target_warehouse_id)
    return {"lots": lots}


@router.post("/ship-out/pick-list-v2")
async def create_ship_out_pick_list_v2(
    data: ShipOutPickListCreateV2,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 1 submission: warehouse worker creates a ship-out order by
    picking lots + cases per line. Pallets stay IN_STOCK; capacity is held
    in `ship_out_lot_reservations`."""
    from app.services import ship_out_service

    target_warehouse_id = resolve_warehouse_for_write(current_user)

    # Soft warn for duplicate order_number in this warehouse
    dup_query = db.query(InventoryTransfer).filter(
        InventoryTransfer.order_number == data.order_number,
        InventoryTransfer.transfer_type == TRANSFER_TYPE_SHIPPED_OUT,
        InventoryTransfer.status.in_([TransferStatus.PENDING, TransferStatus.FORKLIFT_SUBMITTED]),
    )
    if target_warehouse_id:
        dup_query = dup_query.filter(InventoryTransfer.warehouse_id == target_warehouse_id)
    duplicate_warning = dup_query.first()

    try:
        transfer = ship_out_service.create_pick_list_v2(
            db, data, current_user, target_warehouse_id
        )
    except Exception as e:
        db.rollback()
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise

    db.commit()
    db.refresh(transfer)

    response = _transfer_to_response(transfer, db)
    if duplicate_warning:
        response["warning"] = (
            f"Order number {data.order_number} already has another open ship-out "
            f"({duplicate_warning.id})."
        )
    return response


@router.get("/transfers/{transfer_id}/scanner-view")
async def get_scanner_view(
    transfer_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 2 helper: forklift's view of a ship-out — per-line, per-open-lot,
    per-row, with pallets inside each row sorted by sequence ascending."""
    from app.services import ship_out_service

    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        view = ship_out_service.scanner_view_for_transfer(db, transfer)
    except Exception as e:
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise
    return view


@router.post("/transfers/{transfer_id}/scan-pick-v2")
async def scan_pick_v2_endpoint(
    transfer_id: str,
    data: ScanPickRequestV2,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 2 scan: lot-aware. Returns ok=False with `needs_partial_confirm`
    when the scanned pallet would overshoot the line — client re-scans with
    `cases_to_consume` set to confirm the partial pull."""
    from app.services import ship_out_service

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        result = ship_out_service.scan_pick_v2(
            db, transfer, data.licence_number, data.cases_to_consume, current_user
        )
    except Exception as e:
        db.rollback()
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise

    db.commit()
    return result


@router.post("/transfers/{transfer_id}/unscan-pick-v2")
async def unscan_pick_v2_endpoint(
    transfer_id: str,
    data: UnscanPickRequestV2,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 2 remove-a-scan: take a scanned pallet back off the order.

    `reason="wrong_pallet"` returns it to shippable stock; `reason="leaker_damaged"`
    raises a PENDING pallet hold for supervisor review. Forklift may remove freely;
    the removal surfaces on the approval view."""
    from app.services import ship_out_service

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        result = ship_out_service.unscan_pick_v2(
            db, transfer, data.pallet_licence_id, data.reason, current_user
        )
    except Exception as e:
        db.rollback()
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise

    db.commit()
    return result


@router.get("/transfers/{transfer_id}/lots-for-line")
async def lots_for_line_endpoint(
    transfer_id: str,
    line_id: str,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Reversible lot picker: all lots of a line's product, oldest first, with
    capacity + recommended/current flags. Nothing is hidden, so the forklift can
    move back to a lot it previously left."""
    from app.services import ship_out_service

    transfer = db.query(InventoryTransfer).filter(InventoryTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        return ship_out_service.available_lots_for_line(db, transfer, line_id)
    except Exception as e:
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise


@router.post("/transfers/{transfer_id}/retarget-lot")
async def retarget_lot_endpoint(
    transfer_id: str,
    data: RetargetLotRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Reversible lot move: shift a line's outstanding cases to a forklift-chosen
    lot. Moves what the target can cover and leaves the rest open (soft totals)."""
    from app.services import ship_out_service

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        result = ship_out_service.retarget_lot(
            db, transfer, data.line_id, data.from_lot, data.to_lot, data.reason, current_user,
        )
    except Exception as e:
        db.rollback()
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise

    db.commit()
    return result


@router.post("/transfers/{transfer_id}/lot-escape-hatch")
async def lot_escape_hatch_endpoint(
    transfer_id: str,
    data: LotEscapeHatchRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user),
):
    """Phase 2 escape hatch: forklift marks the current lot's rows
    inaccessible. Server swaps to next-oldest lot of the same product."""
    from app.services import ship_out_service

    transfer = (
        db.query(InventoryTransfer)
        .filter(InventoryTransfer.id == transfer_id)
        .with_for_update()
        .first()
    )
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    _ship_out_only(transfer)

    try:
        result = ship_out_service.lot_escape_hatch(
            db, transfer, data.line_id, data.blocked_lot_number,
            list(data.blocked_row_ids or []), data.reason, current_user,
        )
    except Exception as e:
        db.rollback()
        from app.exceptions import ValidationError, NotFoundError
        if isinstance(e, (ValidationError, NotFoundError)):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise

    db.commit()
    return result
