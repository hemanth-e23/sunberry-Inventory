from typing import Optional
from datetime import datetime
from app.schemas.base import BaseSchema


class NotificationOut(BaseSchema):
    id: str
    warehouse_id: Optional[str] = None
    user_id: Optional[str] = None
    type: str
    title: str
    message: str
    reference_id: Optional[str] = None
    reference_type: Optional[str] = None
    is_read: bool
    created_at: datetime
