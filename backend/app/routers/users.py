from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.schemas import User as UserSchema, UserCreate, UserUpdate
from app.utils.auth import get_current_active_user, require_role, require_superadmin, warehouse_filter, get_password_hash
import uuid
import secrets

router = APIRouter()

@router.get("/directory", response_model=List[dict])
def get_user_directory(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Lightweight name directory — id, username, name for all users.
    Open to any authenticated user so the UI can resolve submitter / approver
    names everywhere (receipts, transfers, holds, adjustments, reports).
    Returns no sensitive fields (no email / role / badge / warehouse / password)."""
    users = db.query(User.id, User.username, User.name).all()
    return [{"id": u.id, "username": u.username, "name": u.name} for u in users]

@router.post("/", response_model=UserSchema)
def create_user(
    user_data: UserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_superadmin)
):
    """Create a new user (admin only)"""
    # Check if username already exists
    existing_user = db.query(User).filter(User.username == user_data.username).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists"
        )
    
    # Check if email already exists
    existing_email = db.query(User).filter(User.email == user_data.email).first()
    if existing_email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already exists"
        )

    # Check if badge_id already exists (badge_id has a unique DB constraint)
    if user_data.badge_id:
        existing_badge = db.query(User).filter(User.badge_id == user_data.badge_id).first()
        if existing_badge:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Badge ID '{user_data.badge_id}' is already assigned to user '{existing_badge.username}'"
            )

    # Resolve password: forklift workers login via badge scan, so a missing password
    # is replaced with a high-entropy server-generated value (only satisfies the NOT NULL
    # constraint — never returned, never logged). Non-forklift roles must supply one.
    raw_password = user_data.password
    if not raw_password:
        if user_data.role == "forklift":
            raw_password = secrets.token_urlsafe(24)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Password is required for non-forklift users"
            )

    # Create new user
    user_kwargs = dict(
        id=f"user-{uuid.uuid4().hex[:12]}",
        username=user_data.username,
        name=user_data.name,
        email=user_data.email,
        role=user_data.role,
        hashed_password=get_password_hash(raw_password),
        is_active=True
    )
    if user_data.badge_id:
        user_kwargs["badge_id"] = user_data.badge_id
    if user_data.warehouse_id:
        user_kwargs["warehouse_id"] = user_data.warehouse_id
    new_user = User(**user_kwargs)
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

@router.get("/", response_model=List[UserSchema])
def get_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin"))
):
    """Get all users. Superadmin sees all; admin sees only their warehouse users."""
    query = db.query(User)
    wh_id = warehouse_filter(current_user)
    if wh_id:
        query = query.filter(User.warehouse_id == wh_id)
    return query.offset(skip).limit(limit).all()

@router.get("/{user_id}", response_model=UserSchema)
def get_user(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin"))
):
    """Get a specific user by ID (admin only)"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    return user

@router.put("/{user_id}", response_model=UserSchema)
def update_user(
    user_id: str,
    user_update: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin"))
):
    """Update a user (admin only)"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # Update fields
    update_data = user_update.dict(exclude_unset=True)

    # Prevent elevating a user's role to equal or higher than the updater's own role
    if "role" in update_data:
        from app.schemas.user import ROLE_HIERARCHY
        def _role_rank(role: str) -> int:
            try:
                return ROLE_HIERARCHY.index(role)
            except ValueError:
                return -1
        if _role_rank(update_data["role"]) >= _role_rank(current_user.role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot assign a role equal to or higher than your own"
            )

    # Handle password hashing if password is being updated
    if "password" in update_data:
        update_data["hashed_password"] = get_password_hash(update_data.pop("password"))

    # Exclude badge_id from generic setattr if it's being cleared
    if "badge_id" in update_data and update_data["badge_id"] == "":
        update_data["badge_id"] = None

    # Check badge_id uniqueness when assigning a non-empty value to a different user
    if update_data.get("badge_id"):
        existing_badge = db.query(User).filter(
            User.badge_id == update_data["badge_id"],
            User.id != user_id,
        ).first()
        if existing_badge:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Badge ID '{update_data['badge_id']}' is already assigned to user '{existing_badge.username}'"
            )

    for field, value in update_data.items():
        setattr(user, field, value)
    
    db.commit()
    db.refresh(user)
    return user

@router.delete("/{user_id}")
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_superadmin)
):
    """Delete a user (admin only)"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    # Soft delete by deactivating
    user.is_active = False
    db.commit()
    
    return {"message": "User deactivated successfully"}

@router.post("/{user_id}/toggle-status")
def toggle_user_status(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_superadmin)
):
    """Toggle user active status (admin only)"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)
    
    return {
        "message": f"User {'activated' if user.is_active else 'deactivated'} successfully",
        "is_active": user.is_active
    }
