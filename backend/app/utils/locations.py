"""Location/warehouse resolution helpers shared across services."""
from typing import Optional

from sqlalchemy.orm import Session

from app.models.location import StorageRow, StorageArea, SubLocation, Location


def warehouse_id_for_row(db: Session, row_id) -> Optional[str]:
    """Resolve the warehouse that physically contains a storage row, via its
    storage area (or sub-location) → location → warehouse chain.

    Returns None when the row or any link in the chain is missing. Used to keep
    a pallet's warehouse_id consistent with the row it sits in, so it stays
    visible to the correct warehouse's ship-out picker.
    """
    if not row_id:
        return None
    row = db.query(StorageRow).filter(StorageRow.id == row_id).first()
    if not row:
        return None

    location_id = None
    if row.storage_area_id:
        area = db.query(StorageArea).filter(StorageArea.id == row.storage_area_id).first()
        if area:
            location_id = area.location_id
    if not location_id and row.sub_location_id:
        sub = db.query(SubLocation).filter(SubLocation.id == row.sub_location_id).first()
        if sub:
            location_id = sub.location_id
    if not location_id:
        return None

    loc = db.query(Location).filter(Location.id == location_id).first()
    return loc.warehouse_id if loc else None
