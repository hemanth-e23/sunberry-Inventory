"""
Notifications API — per-user / per-warehouse in-app alerts.
"""
from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Notification
from app.schemas import NotificationOut
from app.utils.auth import get_current_active_user

router = APIRouter()


def _user_query(db: Session, current_user):
    """Build a notification query scoped to the current user's visibility."""
    q = db.query(Notification)
    if current_user.warehouse_id:
        # Plant user: warehouse-wide notifications OR personal
        q = q.filter(
            (Notification.warehouse_id == current_user.warehouse_id)
            | (Notification.user_id == current_user.id)
        )
    else:
        # Corporate / superadmin: corporate-wide (NULL warehouse) OR personal
        q = q.filter(
            (Notification.warehouse_id == None)  # noqa: E711
            | (Notification.user_id == current_user.id)
        )
    return q


@router.get("/", response_model=List[NotificationOut])
async def list_notifications(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    """Return the 50 most-recent notifications for the current user."""
    return (
        _user_query(db, current_user)
        .order_by(Notification.created_at.desc())
        .limit(50)
        .all()
    )


@router.get("/unread-count")
async def unread_count(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    count = _user_query(db, current_user).filter(Notification.is_read == False).count()  # noqa: E712
    return {"count": count}


@router.put("/read-all")
async def mark_all_read(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    _user_query(db, current_user).filter(Notification.is_read == False).update(  # noqa: E712
        {"is_read": True}, synchronize_session=False
    )
    db.commit()
    return {"ok": True}


@router.put("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_active_user),
):
    notif = db.query(Notification).filter(Notification.id == notification_id).first()
    if notif:
        notif.is_read = True
        db.commit()
    return {"ok": True}
