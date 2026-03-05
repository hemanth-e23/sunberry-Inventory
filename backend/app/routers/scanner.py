"""
Scanner API for forklift pallet scanning and forklift requests.
"""
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func

from app.database import get_db
from app.models import (
    User, Product, StorageArea, StorageRow,
    ForkliftRequest, PalletLicence, Receipt, ReceiptAllocation,
    Category, ProductionShift, ProductionLine, InventoryTransfer
)
from app.schemas import (
    ForkliftRequest as ForkliftRequestSchema,
    ForkliftRequestCreate,
    ForkliftRequestUpdate,
    PalletLicenceUpdate,
    ScanPalletRequest,
    MarkMissingRequest,
)
from app.utils.auth import get_current_active_user, warehouse_filter
from app.enums import ForkliftRequestStatus, PalletStatus, ReceiptStatus
from app.constants import (
    ROLE_FORKLIFT, ROLE_ADMIN, ROLE_SUPERVISOR,
    CATEGORY_FINISHED, DEFAULT_CASES_PER_PALLET, DEFAULT_EXPIRE_YEARS, DAYS_PER_YEAR,
)


def parse_production_date_from_lot(lot_number: str) -> Optional[datetime]:
    """
    Parse production date from lot number.
    Expected format: MP{DDD}{YY}L{N}  e.g. MP06226L1 = day 62 of 2026, line 1.
    Returns a datetime at midnight UTC, or None if the lot number doesn't match.
    """
    if not lot_number:
        return None
    match = re.match(r'^MP(\d{3})(\d{2})L\d+$', lot_number, re.IGNORECASE)
    if not match:
        return None
    day_of_year = int(match.group(1))
    year = 2000 + int(match.group(2))
    try:
        # day_of_year=1 → Jan 1, day_of_year=62 → March 3
        production_date = datetime(year, 1, 1) + timedelta(days=day_of_year - 1)
        return production_date
    except (ValueError, OverflowError):
        return None


def parse_licence_number(licence_number: str) -> tuple:
    """
    Parse licence number e.g. LOT20260219-L1-MANGO-001 into (lot_number, product_code, sequence).
    Format: {LOT}-{PRODUCT_CODE}-{SEQ}
    """
    parts = licence_number.strip().split("-")
    if len(parts) < 3:
        return None, None, None
    seq_str = parts[-1]
    product_code = parts[-2]
    lot_number = "-".join(parts[:-2])
    if not re.match(r"^\d{3}$", seq_str):
        return None, None, None
    sequence = int(seq_str)
    return lot_number, product_code, sequence


def find_product_by_code(db: Session, product_code: str) -> Optional[Product]:
    """Find product by code — checks short_code first, then name, then fcc_code."""
    code_upper = product_code.upper()
    code_lower = product_code.lower()
    # Try exact match on short_code (highest priority)
    product = db.query(Product).filter(
        Product.is_active == True,
        Product.short_code.isnot(None),
        func.upper(Product.short_code) == code_upper
    ).first()
    if product:
        return product
    # Try exact match on name
    product = db.query(Product).filter(
        Product.is_active == True,
        func.lower(Product.name) == code_lower
    ).first()
    if product:
        return product
    # Try FCC code
    product = db.query(Product).filter(
        Product.is_active == True,
        func.upper(Product.fcc_code) == code_upper
    ).first()
    if product:
        return product
    # Try short_code contains
    product = db.query(Product).filter(
        Product.is_active == True,
        Product.short_code.isnot(None),
        func.upper(Product.short_code).contains(code_upper)
    ).first()
    if product:
        return product
    # Try name contains
    product = db.query(Product).filter(
        Product.is_active == True,
        func.lower(Product.name).contains(code_lower)
    ).first()
    if product:
        return product
    # Try fcc_code contains
    product = db.query(Product).filter(
        Product.is_active == True,
        Product.fcc_code.isnot(None),
        func.upper(Product.fcc_code).contains(code_upper)
    ).first()
    return product


router = APIRouter()


def require_forklift_or_admin(current_user: User = Depends(get_current_active_user)) -> User:
    """Allow forklift (for scanning) or admin/supervisor (for approvals)."""
    if current_user.role not in (ROLE_FORKLIFT, ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forklift or admin/supervisor access required"
        )
    return current_user


@router.post("/requests", response_model=ForkliftRequestSchema)
async def create_forklift_request(
    data: ForkliftRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create new forklift request (start scanning session). Parses first licence to derive product/lot."""
    if current_user.role != ROLE_FORKLIFT:
        raise HTTPException(status_code=403, detail="Only forklift users can create scan requests")
    lot_number, product_code, _ = parse_licence_number(data.licence_number)
    if not lot_number or not product_code:
        raise HTTPException(status_code=400, detail="Invalid licence number format. Expected LOT-XXX-PRODUCT-001")
    product = find_product_by_code(db, product_code)
    if not product:
        raise HTTPException(status_code=404, detail=f"Product not found for code: {product_code}")
    category = db.query(Category).filter(Category.id == product.category_id).first()
    is_finished = category and category.type == CATEGORY_FINISHED
    if not is_finished:
        raise HTTPException(status_code=400, detail="Pallet licence scanning is only for finished goods")
    cases_per_pallet = product.default_cases_per_pallet or DEFAULT_CASES_PER_PALLET
    production_date = parse_production_date_from_lot(lot_number) or datetime.now(timezone.utc)
    expire_years = product.expire_years or DEFAULT_EXPIRE_YEARS
    expiration_date = production_date + timedelta(days=DAYS_PER_YEAR * expire_years)
    line_id = None
    line_code = None
    line_number = None
    if lot_number:
        if "-" in lot_number:
            parts = lot_number.split("-")
            if len(parts) >= 2 and re.match(r"^L\d+$", parts[-1], re.I):
                line_code = parts[-1]
        if not line_code:
            suffix_match = re.search(r'(L\d+)$', lot_number, re.I)
            if suffix_match:
                line_code = suffix_match.group(1)
        if line_code:
            num_match = re.search(r'(\d+)', line_code)
            line_number = num_match.group(1) if num_match else None
            line = db.query(ProductionLine).filter(
                ProductionLine.is_active == True,
                func.upper(ProductionLine.name).contains(line_code.upper())
            ).first()
            if not line and line_number:
                for candidate in db.query(ProductionLine).filter(ProductionLine.is_active == True).all():
                    candidate_num = re.search(r'(\d+)', candidate.name)
                    if candidate_num and candidate_num.group(1) == line_number:
                        line = candidate
                        break
            if line:
                line_id = line.id
    abandoned = db.query(ForkliftRequest).filter(
        ForkliftRequest.scanned_by == str(current_user.id),
        ForkliftRequest.status == ForkliftRequestStatus.SCANNING,
    ).all()
    for old_req in abandoned:
        db.query(PalletLicence).filter(
            PalletLicence.forklift_request_id == old_req.id,
            PalletLicence.status.in_([PalletStatus.PENDING, PalletStatus.MISSING_STICKER]),
        ).delete(synchronize_session=False)
        old_req.status = ForkliftRequestStatus.CANCELLED
    if abandoned:
        db.flush()

    request_id = f"fr-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    fr = ForkliftRequest(
        id=request_id,
        product_id=product.id,
        lot_number=lot_number,
        production_date=production_date,
        expiration_date=expiration_date,
        shift_id=None,
        line_id=line_id,
        cases_per_pallet=cases_per_pallet,
        total_full_pallets=0,
        total_partial_pallets=0,
        total_cases=0,
        status=ForkliftRequestStatus.SCANNING,
        scanned_by=str(current_user.id),
        warehouse_id=current_user.warehouse_id,
    )
    db.add(fr)
    db.commit()
    db.refresh(fr)
    return fr


@router.get("/requests/active")
async def get_active_request(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin),
):
    """Return the current user's active SCANNING session with pallets, or null if none."""
    fr = db.query(ForkliftRequest).filter(
        ForkliftRequest.scanned_by == str(current_user.id),
        ForkliftRequest.status == ForkliftRequestStatus.SCANNING,
    ).order_by(ForkliftRequest.created_at.desc()).first()

    if not fr:
        return None

    pallets = db.query(PalletLicence).filter(
        PalletLicence.forklift_request_id == fr.id,
        PalletLicence.status != "cancelled",
    ).order_by(PalletLicence.sequence.asc()).all()

    # Infer the last storage row used from the most recently scanned pallet
    last_row_id = None
    for p in reversed(pallets):
        if p.storage_row_id:
            last_row_id = p.storage_row_id
            break

    return {
        "id": fr.id,
        "product_name": fr.product.name if fr.product else None,
        "lot_number": fr.lot_number,
        "last_row_id": last_row_id,
        "pallet_count": len(pallets),
        "total_cases": sum(p.cases or 0 for p in pallets),
        "created_at": fr.created_at,
        "pallets": [
            {
                "id": p.id,
                "licence_number": p.licence_number,
                "cases": p.cases,
                "is_partial": p.is_partial,
                "status": p.status,
                "scanned_at": p.scanned_at,
            }
            for p in pallets
        ],
    }


@router.post("/requests/{request_id}/scan")
async def scan_pallet(
    request_id: str,
    data: ScanPalletRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Scan a pallet into the current request."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status != ForkliftRequestStatus.SCANNING:
        raise HTTPException(status_code=400, detail="Request is no longer in scanning mode")
    if current_user.role == ROLE_FORKLIFT and str(fr.scanned_by) != str(current_user.id):
        raise HTTPException(status_code=403, detail="You can only scan into your own request")
    lot_number, product_code, sequence = parse_licence_number(data.licence_number)
    if not lot_number or not product_code:
        raise HTTPException(status_code=400, detail="Invalid licence number format")
    product = find_product_by_code(db, product_code)
    if not product or product.id != fr.product_id:
        raise HTTPException(status_code=400, detail=f"Product mismatch. Expected product for this lot.")
    row = db.query(StorageRow).filter(StorageRow.id == data.storage_row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Storage row not found")
    if not row.is_active:
        raise HTTPException(status_code=400, detail="Storage row is inactive")
    capacity = row.pallet_capacity or 0
    occupied = row.occupied_pallets or 0
    existing_in_request = db.query(func.count(PalletLicence.id)).filter(
        PalletLicence.forklift_request_id == request_id,
        PalletLicence.storage_row_id == data.storage_row_id,
        PalletLicence.status.in_([PalletStatus.PENDING, PalletStatus.MISSING_STICKER])
    ).scalar() or 0
    available = max(0, capacity - occupied - existing_in_request) if capacity > 0 else 9999
    if available < 1:
        raise HTTPException(status_code=400, detail="Row is full. Scan or select a new location.")
    existing_in_this = db.query(PalletLicence).filter(
        PalletLicence.licence_number == data.licence_number,
        PalletLicence.forklift_request_id == request_id
    ).first()
    if existing_in_this:
        if existing_in_this.storage_row_id != data.storage_row_id:
            existing_in_this.storage_row_id = data.storage_row_id
            existing_in_this.storage_area_id = row.storage_area_id
            db.commit()
            return {"status": "updated", "message": "Moved to new location"}
        return {"status": "duplicate", "message": "Already scanned"}

    existing_other = db.query(PalletLicence).filter(
        PalletLicence.licence_number == data.licence_number,
        PalletLicence.forklift_request_id != request_id
    ).first()
    if existing_other:
        if existing_other.status in (PalletStatus.PENDING, PalletStatus.MISSING_STICKER):
            other_req = db.query(ForkliftRequest).filter(
                ForkliftRequest.id == existing_other.forklift_request_id
            ).first()
            if other_req and other_req.status == ForkliftRequestStatus.SCANNING:
                db.delete(existing_other)
                db.flush()
            elif other_req and other_req.status == ForkliftRequestStatus.SUBMITTED:
                return {"status": "duplicate", "message": "This pallet is in another pending request awaiting approval."}
            else:
                db.delete(existing_other)
                db.flush()
        elif existing_other.status == PalletStatus.IN_STOCK:
            raise HTTPException(status_code=400, detail="This pallet is already received and in stock.")
        elif existing_other.status == PalletStatus.CANCELLED:
            db.delete(existing_other)
            db.flush()
        else:
            raise HTTPException(status_code=400, detail=f"This licence number already exists (status: {existing_other.status}).")

    all_licences = db.query(PalletLicence).filter(
        PalletLicence.forklift_request_id == request_id,
        PalletLicence.status.in_([PalletStatus.PENDING])
    ).order_by(PalletLicence.sequence).all()
    max_seq = max([pl.sequence for pl in all_licences], default=0)
    expected_next = max_seq + 1
    gap_missing = []
    if sequence > expected_next:
        for s in range(expected_next, sequence):
            gap_licence = f"{lot_number}-{product_code}-{str(s).zfill(3)}"
            gap_missing.append(gap_licence)
    cases = fr.cases_per_pallet
    if data.is_partial and data.partial_cases is not None:
        cases = data.partial_cases
    area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
    pl_id = f"pl-{uuid.uuid4().hex[:12]}"
    pl = PalletLicence(
        id=pl_id,
        licence_number=data.licence_number,
        receipt_id=None,
        forklift_request_id=request_id,
        product_id=product.id,
        lot_number=lot_number,
        storage_area_id=row.storage_area_id,
        storage_row_id=data.storage_row_id,
        cases=cases,
        is_partial=data.is_partial,
        sequence=sequence,
        status=PalletStatus.PENDING,
        scanned_by=str(current_user.id),
        scanned_at=datetime.now(timezone.utc),
    )
    db.add(pl)
    fr.total_full_pallets = fr.total_full_pallets + (0 if data.is_partial else 1)
    fr.total_partial_pallets = fr.total_partial_pallets + (1 if data.is_partial else 0)
    fr.total_cases = (fr.total_cases or 0) + cases
    db.commit()
    db.refresh(pl)
    row_available = max(0, (row.pallet_capacity or 0) - (row.occupied_pallets or 0) - (
        db.query(func.count(PalletLicence.id)).filter(
            PalletLicence.forklift_request_id == request_id,
            PalletLicence.storage_row_id == data.storage_row_id,
            PalletLicence.status == PalletStatus.PENDING
        ).scalar() or 0
    )) if (row.pallet_capacity or 0) > 0 else 9999
    return {
        "status": "scanned",
        "pallet": {
            "id": pl.id,
            "licence_number": pl.licence_number,
            "cases": pl.cases,
            "is_partial": pl.is_partial,
        },
        "gap_detected": len(gap_missing) > 0,
        "gap_missing": gap_missing,
        "row_available": int(row_available),
        "row_name": row.name,
        "area_name": area.name if area else "",
    }


@router.post("/requests/{request_id}/mark-missing")
async def mark_missing_pallets(
    request_id: str,
    data: MarkMissingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Mark pallets as missing (damaged sticker)."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status != ForkliftRequestStatus.SCANNING:
        raise HTTPException(status_code=400, detail="Request is no longer in scanning mode")
    lot_number, product_code, _ = parse_licence_number(data.licence_numbers[0] if data.licence_numbers else "")
    if not lot_number or not product_code:
        raise HTTPException(status_code=400, detail="Invalid licence number in list")
    for lic_num in data.licence_numbers:
        _, _, seq = parse_licence_number(lic_num)
        if seq is None:
            continue
        existing = db.query(PalletLicence).filter(
            PalletLicence.licence_number == lic_num,
            PalletLicence.forklift_request_id == request_id
        ).first()
        if existing:
            continue
        pl_id = f"pl-{uuid.uuid4().hex[:12]}"
        pl = PalletLicence(
            id=pl_id,
            licence_number=lic_num,
            forklift_request_id=request_id,
            product_id=fr.product_id,
            lot_number=lot_number,
            cases=fr.cases_per_pallet,
            is_partial=False,
            sequence=seq,
            status=PalletStatus.MISSING_STICKER,
            scanned_by=str(current_user.id),
            scanned_at=datetime.now(timezone.utc),
        )
        db.add(pl)
    db.commit()
    return {"status": "marked", "count": len(data.licence_numbers)}


@router.post("/requests/{request_id}/submit")
async def submit_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Submit completed scan session for approval."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status != ForkliftRequestStatus.SCANNING:
        raise HTTPException(status_code=400, detail="Request already submitted or closed")
    count = db.query(func.count(PalletLicence.id)).filter(
        PalletLicence.forklift_request_id == request_id,
        PalletLicence.status.in_([PalletStatus.PENDING, PalletStatus.MISSING_STICKER])
    ).scalar() or 0
    if count == 0:
        raise HTTPException(status_code=400, detail="No pallets scanned")
    fr.status = ForkliftRequestStatus.SUBMITTED
    fr.submitted_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(fr)
    return {"status": "submitted", "request": fr}


@router.get("/requests", response_model=List[ForkliftRequestSchema])
async def list_forklift_requests(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List forklift requests (for approvals page)."""
    query = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
    )
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(ForkliftRequest.warehouse_id == wh_id)
    if status_filter:
        query = query.filter(ForkliftRequest.status == status_filter)
    if current_user.role == ROLE_FORKLIFT:
        query = query.filter(ForkliftRequest.scanned_by == str(current_user.id))
    requests = query.order_by(ForkliftRequest.created_at.desc()).all()
    return requests


@router.get("/requests/{request_id}", response_model=ForkliftRequestSchema)
async def get_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Get forklift request with pallet licences."""
    fr = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
        joinedload(ForkliftRequest.shift),
        joinedload(ForkliftRequest.line),
    ).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    return fr


@router.put("/requests/{request_id}", response_model=ForkliftRequestSchema)
async def update_forklift_request(
    request_id: str,
    data: ForkliftRequestUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Update forklift request (checker corrections)."""
    fr = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
    ).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status not in (ForkliftRequestStatus.SCANNING, ForkliftRequestStatus.SUBMITTED):
        raise HTTPException(status_code=400, detail="Cannot update approved or rejected request")
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can correct")
    update_data = data.dict(exclude_unset=True)
    cases_per_pallet_changed = "cases_per_pallet" in update_data and update_data["cases_per_pallet"] != fr.cases_per_pallet
    for k, v in update_data.items():
        setattr(fr, k, v)
    if cases_per_pallet_changed:
        new_cpp = fr.cases_per_pallet
        licences = [pl for pl in fr.pallet_licences if pl.status in (PalletStatus.PENDING, PalletStatus.MISSING_STICKER)]
        for pl in licences:
            if not pl.is_partial:
                pl.cases = new_cpp
        fr.total_cases = sum(pl.cases for pl in licences)
    db.commit()
    db.refresh(fr)
    return fr


@router.post("/requests/{request_id}/approve")
async def approve_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Approve forklift request - creates receipt and links pallet licences."""
    fr = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.product),
        joinedload(ForkliftRequest.pallet_licences),
    ).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status != ForkliftRequestStatus.SUBMITTED:
        raise HTTPException(status_code=400, detail="Request is not submitted")
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can approve")
    if not fr.shift_id:
        raise HTTPException(status_code=400, detail="Shift must be set before approval")
    licences = [pl for pl in fr.pallet_licences if pl.status in (PalletStatus.PENDING, PalletStatus.MISSING_STICKER)]
    total_cases = sum(pl.cases for pl in licences)
    partial_cases = sum(pl.cases for pl in licences if pl.is_partial)
    row_groups = {}
    for pl in licences:
        if pl.storage_row_id and pl.storage_area_id:
            key = (pl.storage_area_id, pl.storage_row_id)
            if key not in row_groups:
                row_groups[key] = {"pallets": 0, "cases": 0}
            row_groups[key]["pallets"] += 1
            row_groups[key]["cases"] += pl.cases
    plan = []
    for (area_id, row_id), data in row_groups.items():
        area = db.query(StorageArea).filter(StorageArea.id == area_id).first()
        row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
        plan.append({
            "areaId": area_id,
            "rowId": row_id,
            "areaName": area.name if area else "",
            "rowName": row.name if row else "",
            "pallets": data["pallets"],
            "cases": data["cases"],
        })
    receipt_id = f"rcpt-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    category = db.query(Category).filter(Category.id == fr.product.category_id).first()
    cat_id = category.id if category else None
    location_id = sub_location_id = None
    if plan:
        first_area = db.query(StorageArea).filter(StorageArea.id == plan[0]["areaId"]).first()
        if first_area:
            location_id = first_area.location_id
            sub_location_id = first_area.sub_location_id
    rec = Receipt(
        id=receipt_id,
        product_id=fr.product_id,
        category_id=cat_id,
        lot_number=fr.lot_number,
        quantity=total_cases,
        unit="cases",
        production_date=fr.production_date,
        expiration_date=fr.expiration_date,
        receipt_date=datetime.now(timezone.utc),
        cases_per_pallet=fr.cases_per_pallet,
        full_pallets=fr.total_full_pallets,
        partial_cases=int(partial_cases),
        quantity_produced=total_cases,
        shift_id=fr.shift_id,
        line_id=fr.line_id,
        status=ReceiptStatus.APPROVED,
        location_id=location_id,
        sub_location_id=sub_location_id,
        submitted_by=str(fr.scanned_by),
        approved_by=str(current_user.id),
        approved_at=datetime.now(timezone.utc),
        submitted_at=datetime.now(timezone.utc),
        allocation={"success": True, "plan": plan, "totalCases": total_cases, "totalPallets": len(licences)},
        warehouse_id=fr.warehouse_id,
    )
    db.add(rec)
    for item in plan:
        db.add(ReceiptAllocation(
            receipt_id=receipt_id,
            storage_area_id=item["areaId"],
            pallet_quantity=float(item["pallets"]),
            cases_quantity=float(item["cases"]),
        ))
    for pl in licences:
        pl.receipt_id = receipt_id
        pl.status = PalletStatus.IN_STOCK
    for item in plan:
        row = db.query(StorageRow).filter(StorageRow.id == item["rowId"]).first()
        if row:
            row.occupied_pallets = (row.occupied_pallets or 0) + item["pallets"]
            row.occupied_cases = (row.occupied_cases or 0) + item["cases"]
            if not row.product_id:
                row.product_id = fr.product_id
    fr.status = ForkliftRequestStatus.APPROVED
    fr.receipt_id = receipt_id
    fr.approved_by = str(current_user.id)
    fr.approved_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "approved", "receipt_id": receipt_id}


@router.post("/requests/{request_id}/reject")
async def reject_forklift_request(
    request_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Reject forklift request - marks all pallet licences as cancelled."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status != ForkliftRequestStatus.SUBMITTED:
        raise HTTPException(status_code=400, detail="Request is not submitted")
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can reject")
    db.query(PalletLicence).filter(
        PalletLicence.forklift_request_id == request_id
    ).update({"status": PalletStatus.CANCELLED}, synchronize_session=False)
    fr.status = ForkliftRequestStatus.REJECTED
    db.commit()
    return {"status": "rejected"}


@router.delete("/requests/{request_id}/pallet-licences/{licence_id}")
async def remove_pallet_licence(
    request_id: str,
    licence_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Remove a pallet licence from a forklift request (supervisor correction)."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status not in (ForkliftRequestStatus.SCANNING, ForkliftRequestStatus.SUBMITTED):
        raise HTTPException(status_code=400, detail="Cannot modify approved or rejected request")
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can remove pallets")
    pl = db.query(PalletLicence).filter(
        PalletLicence.id == licence_id,
        PalletLicence.forklift_request_id == request_id
    ).first()
    if not pl:
        raise HTTPException(status_code=404, detail="Pallet licence not found in this request")
    was_partial = pl.is_partial
    cases_removed = pl.cases or 0
    db.delete(pl)
    if was_partial:
        fr.total_partial_pallets = max(0, (fr.total_partial_pallets or 0) - 1)
    else:
        fr.total_full_pallets = max(0, (fr.total_full_pallets or 0) - 1)
    fr.total_cases = max(0, (fr.total_cases or 0) - cases_removed)
    db.commit()
    return {"status": "removed", "licence_id": licence_id}


@router.put("/requests/{request_id}/pallet-licences/{licence_id}")
async def update_pallet_licence(
    request_id: str,
    licence_id: str,
    data: PalletLicenceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Update a pallet licence within a forklift request (supervisor correction)."""
    fr = db.query(ForkliftRequest).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status not in (ForkliftRequestStatus.SCANNING, ForkliftRequestStatus.SUBMITTED):
        raise HTTPException(status_code=400, detail="Cannot modify approved or rejected request")
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can edit pallets")
    pl = db.query(PalletLicence).filter(
        PalletLicence.id == licence_id,
        PalletLicence.forklift_request_id == request_id
    ).first()
    if not pl:
        raise HTTPException(status_code=404, detail="Pallet licence not found in this request")
    old_cases = pl.cases or 0
    update_data = data.dict(exclude_unset=True)
    for k, v in update_data.items():
        setattr(pl, k, v)
    new_cases = pl.cases or 0
    fr.total_cases = max(0, (fr.total_cases or 0) - old_cases + new_cases)
    db.commit()
    db.refresh(pl)
    return {"status": "updated", "licence_id": licence_id, "cases": pl.cases}


@router.post("/requests/{request_id}/add-pallet")
async def add_pallet_to_request(
    request_id: str,
    data: ScanPalletRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Add a pallet licence to a forklift request (supervisor correction for missed scans)."""
    if current_user.role not in (ROLE_ADMIN, ROLE_SUPERVISOR):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can add pallets")
    fr = db.query(ForkliftRequest).options(
        joinedload(ForkliftRequest.pallet_licences),
    ).filter(ForkliftRequest.id == request_id).first()
    if not fr:
        raise HTTPException(status_code=404, detail="Forklift request not found")
    if fr.status not in (ForkliftRequestStatus.SCANNING, ForkliftRequestStatus.SUBMITTED):
        raise HTTPException(status_code=400, detail="Cannot modify approved or rejected request")
    lot_number, product_code, sequence = parse_licence_number(data.licence_number)
    if not lot_number or not product_code:
        raise HTTPException(status_code=400, detail="Invalid licence number format")
    product = find_product_by_code(db, product_code)
    if not product or product.id != fr.product_id:
        raise HTTPException(status_code=400, detail="Product mismatch - this licence belongs to a different product")
    existing = db.query(PalletLicence).filter(
        PalletLicence.licence_number == data.licence_number
    ).first()
    if existing:
        if existing.forklift_request_id == request_id:
            raise HTTPException(status_code=400, detail="This pallet is already in this request")
        if existing.status == PalletStatus.IN_STOCK:
            raise HTTPException(status_code=400, detail="This pallet is already received and in stock")
        if existing.status in (PalletStatus.PENDING, PalletStatus.MISSING_STICKER):
            raise HTTPException(status_code=400, detail="This pallet is in another pending request")
        if existing.status == PalletStatus.CANCELLED:
            db.delete(existing)
            db.flush()
        else:
            raise HTTPException(status_code=400, detail=f"Licence already exists (status: {existing.status})")
    row = db.query(StorageRow).filter(StorageRow.id == data.storage_row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Storage row not found")
    if not row.is_active:
        raise HTTPException(status_code=400, detail="Storage row is inactive")
    cases = fr.cases_per_pallet
    if data.is_partial and data.partial_cases is not None:
        cases = data.partial_cases
    pl_id = f"pl-{uuid.uuid4().hex[:12]}"
    pl = PalletLicence(
        id=pl_id,
        licence_number=data.licence_number,
        receipt_id=None,
        forklift_request_id=request_id,
        product_id=fr.product_id,
        lot_number=lot_number,
        storage_area_id=row.storage_area_id,
        storage_row_id=data.storage_row_id,
        cases=cases,
        is_partial=data.is_partial,
        sequence=sequence if sequence else 999,
        status=PalletStatus.PENDING,
        scanned_by=str(current_user.id),
        scanned_at=datetime.now(timezone.utc),
    )
    db.add(pl)
    if data.is_partial:
        fr.total_partial_pallets = (fr.total_partial_pallets or 0) + 1
    else:
        fr.total_full_pallets = (fr.total_full_pallets or 0) + 1
    fr.total_cases = (fr.total_cases or 0) + cases
    db.commit()
    return {"status": "added", "pallet": {"id": pl.id, "licence_number": pl.licence_number, "cases": pl.cases}}


@router.post("/internal-transfer")
async def create_internal_transfer(
    data: dict,  # { moves: [{ licence_id: str, to_row_id: str }] }
    db: Session = Depends(get_db),
    current_user: User = Depends(require_forklift_or_admin)
):
    """Create internal transfer from scanner: forklift scans pallets and destinations, submit creates transfer."""
    if current_user.role != ROLE_FORKLIFT:
        raise HTTPException(status_code=403, detail="Only forklift users can create scanner transfers")
    moves = data.get("moves") or []
    if not moves:
        raise HTTPException(status_code=400, detail="No moves provided")
    licences = []
    for m in moves:
        lic_id = m.get("licence_id")
        to_row_id = m.get("to_row_id")
        if not lic_id or not to_row_id:
            continue
        pl = db.query(PalletLicence).filter(
            PalletLicence.id == lic_id,
            PalletLicence.status == PalletStatus.IN_STOCK
        ).first()
        if not pl:
            raise HTTPException(status_code=404, detail=f"Pallet licence {lic_id} not found or not in stock")
        row = db.query(StorageRow).filter(StorageRow.id == to_row_id, StorageRow.is_active == True).first()
        if not row:
            raise HTTPException(status_code=404, detail=f"Storage row {to_row_id} not found")
        licences.append((pl, to_row_id))
    if not licences:
        raise HTTPException(status_code=400, detail="No valid moves")
    receipt_id = licences[0][0].receipt_id
    if not receipt_id:
        raise HTTPException(status_code=400, detail="Pallet has no receipt")
    for pl, _ in licences:
        if pl.receipt_id != receipt_id:
            raise HTTPException(status_code=400, detail="All pallets must be from the same receipt")
    total_cases = sum(pl.cases for pl, _ in licences)
    source_breakdown_d = {}
    dest_row_to_pls = {}  # to_row_id -> [pl, ...] for correct per-pallet destination mapping
    for pl, to_row_id in licences:
        src_key = f"row-{pl.storage_row_id}" if pl.storage_row_id else "floor"
        source_breakdown_d[src_key] = source_breakdown_d.get(src_key, 0) + pl.cases
        if to_row_id not in dest_row_to_pls:
            dest_row_to_pls[to_row_id] = []
        dest_row_to_pls[to_row_id].append(pl)
    source_breakdown = [{"id": k, "quantity": v} for k, v in source_breakdown_d.items()]
    destination_breakdown = [
        {"id": f"row-{rid}", "quantity": sum(pl.cases for pl in pls), "pallet_licence_ids": [pl.id for pl in pls]}
        for rid, pls in dest_row_to_pls.items()
    ]
    receipt = db.query(Receipt).filter(Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    from_loc = to_loc = from_sub = to_sub = None
    if licences and licences[0][0].storage_area_id:
        area = db.query(StorageArea).filter(StorageArea.id == licences[0][0].storage_area_id).first()
        if area:
            from_loc = area.location_id
            from_sub = area.sub_location_id
    if licences:
        to_row = db.query(StorageRow).filter(StorageRow.id == licences[0][1]).first()
        if to_row and to_row.storage_area_id:
            area = db.query(StorageArea).filter(StorageArea.id == to_row.storage_area_id).first()
            if area:
                to_loc = area.location_id
                to_sub = area.sub_location_id
    transfer_id = f"transfer-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid.uuid4().hex[:8]}"
    tr = InventoryTransfer(
        id=transfer_id,
        receipt_id=receipt_id,
        from_location_id=from_loc,
        from_sub_location_id=from_sub,
        to_location_id=to_loc,
        to_sub_location_id=to_sub,
        quantity=total_cases,
        unit="cases",
        transfer_type="warehouse-transfer",
        source_breakdown=source_breakdown,
        destination_breakdown=destination_breakdown,
        pallet_licence_ids=[pl.id for pl, _ in licences],
        requested_by=str(current_user.id),
        status=PalletStatus.PENDING,
    )
    db.add(tr)
    receipt.hold = True
    db.commit()
    db.refresh(tr)
    return {"status": "created", "transfer_id": tr.id}


@router.get("/storage-rows")
async def list_storage_rows_with_capacity(
    request_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """List storage rows with available capacity for scanner dropdown.
    Subtracts pending scans from active requests to show real availability."""
    rows = db.query(StorageRow).filter(
        StorageRow.is_active == True,
        StorageRow.pallet_capacity > 0,
    ).all()

    pending_by_row = {}
    pending_query = db.query(
        PalletLicence.storage_row_id,
        func.count(PalletLicence.id)
    ).join(
        ForkliftRequest, ForkliftRequest.id == PalletLicence.forklift_request_id
    ).filter(
        ForkliftRequest.status == ForkliftRequestStatus.SCANNING,
        PalletLicence.status.in_([PalletStatus.PENDING, PalletStatus.MISSING_STICKER]),
        PalletLicence.storage_row_id.isnot(None),
    ).group_by(PalletLicence.storage_row_id).all()
    for row_id, count in pending_query:
        pending_by_row[row_id] = count

    result = []
    for row in rows:
        occupied = row.occupied_pallets or 0
        capacity = row.pallet_capacity or 0
        pending = pending_by_row.get(row.id, 0)
        available = max(0, capacity - occupied - pending)
        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
        result.append({
            "id": row.id,
            "name": row.name,
            "area_id": row.storage_area_id,
            "area_name": area.name if area else "",
            "capacity": capacity,
            "occupied": occupied,
            "pending": pending,
            "available": available,
        })
    return result
