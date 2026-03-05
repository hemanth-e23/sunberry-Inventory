from typing import List, Optional
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import uuid

from app.database import get_db
from app.models import CycleCount
from app.schemas import CycleCount as CycleCountSchema, CycleCountCreate
from app.utils.auth import get_current_active_user, warehouse_filter

router = APIRouter()


@router.post("/cycle-counts", response_model=CycleCountSchema)
async def create_cycle_count(
    cycle_count_data: CycleCountCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Create a new cycle count"""
    cycle_count_dict = cycle_count_data.dict()

    db_cycle_count = CycleCount(
        id=f"cycle-{uuid.uuid4().hex[:12]}",
        warehouse_id=current_user.warehouse_id,
        **cycle_count_dict
    )

    db.add(db_cycle_count)
    db.commit()
    db.refresh(db_cycle_count)

    return db_cycle_count

@router.get("/cycle-counts", response_model=List[CycleCountSchema])
async def get_cycle_counts(
    location_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_active_user)
):
    """Get all cycle counts, optionally filtered by location"""
    query = db.query(CycleCount)

    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(CycleCount.warehouse_id == wh_id)

    if location_id:
        query = query.filter(CycleCount.location_id == location_id)

    cycle_counts = query.order_by(CycleCount.count_date.desc()).all()
    return cycle_counts
