from sqlalchemy.orm import Session
from app.models.audit import AuditLog


def log_action(
    db: Session,
    user_id: str | None,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: dict | None = None,
) -> None:
    """
    Record an audit log entry. Does NOT commit — caller must commit with their transaction.

    Usage:
        log_action(db, current_user.id, "approve_receipt", "receipt", receipt.id,
                   {"before": {"status": "recorded"}, "after": {"status": "approved"}})
        db.commit()
    """
    entry = AuditLog(
        user_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
    )
    db.add(entry)
