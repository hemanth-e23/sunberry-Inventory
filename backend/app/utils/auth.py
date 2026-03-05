from datetime import datetime, timedelta, timezone
from typing import Optional, List
from jose import JWTError, jwt
import bcrypt
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User
from app.schemas import TokenData
from app.constants import ROLE_FORKLIFT, ROLE_SUPERADMIN, ROLE_ADMIN

# JWT token handling
security = HTTPBearer()

# Roles that can see ALL warehouses (no warehouse filter applied)
CORPORATE_ROLES = {"superadmin", "corporate_admin", "corporate_viewer"}


def warehouse_filter(user) -> Optional[str]:
    """
    Returns warehouse_id to use as a query filter.
    - Plant users: always their own warehouse_id.
    - Corporate/superadmin: returns _view_warehouse_id if set via X-View-Warehouse header,
      otherwise None (see all warehouses).
    """
    if user.role not in CORPORATE_ROLES and user.warehouse_id is not None:
        return user.warehouse_id
    # Corporate users: respect the per-request warehouse override if set
    return getattr(user, '_view_warehouse_id', None)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash"""
    if isinstance(hashed_password, str):
        hashed_password = hashed_password.encode('utf-8')
    if isinstance(plain_password, str):
        plain_password = plain_password.encode('utf-8')
    return bcrypt.checkpw(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    """Hash a password"""
    if isinstance(password, str):
        password = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password, salt)
    return hashed.decode('utf-8')

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    """Create a JWT access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

def verify_token(token: str) -> Optional[TokenData]:
    """Verify and decode a JWT token"""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            return None
        return TokenData(username=username)
    except JWTError:
        return None

def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    """Authenticate a user with username and password"""
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    if not user.is_active:
        return None
    return user


def authenticate_by_badge(db: Session, badge_id: str) -> Optional[User]:
    """Authenticate a user by badge ID (for forklift users)"""
    user = db.query(User).filter(User.badge_id == badge_id).first()
    if not user:
        return None
    if user.role != ROLE_FORKLIFT:
        return None
    return user

def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    """Get the current authenticated user"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    token_data = verify_token(credentials.credentials)
    if token_data is None:
        raise credentials_exception

    user = db.query(User).filter(User.username == token_data.username).first()
    if user is None:
        raise credentials_exception

    # For corporate users: check X-View-Warehouse header to scope their view
    if user.role in CORPORATE_ROLES:
        view_as = request.headers.get("X-View-Warehouse")
        if view_as:
            from app.models import Warehouse
            wh = db.query(Warehouse).filter(Warehouse.id == view_as).first()
            if wh:
                user._view_warehouse_id = view_as

    return user

def get_current_active_user(current_user: User = Depends(get_current_user)) -> User:
    """Get the current active user"""
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user

def require_role(required_role: str):
    """Dependency to require a specific role. superadmin always passes."""
    def role_checker(current_user: User = Depends(get_current_active_user)) -> User:
        if current_user.role == ROLE_SUPERADMIN:
            return current_user
        if current_user.role != required_role and current_user.role != ROLE_ADMIN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not enough permissions"
            )
        return current_user
    return role_checker


def require_superadmin(current_user: User = Depends(get_current_active_user)) -> User:
    """Dependency that only allows superadmin."""
    if current_user.role != ROLE_SUPERADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only superadmin can perform this action"
        )
    return current_user


def get_accessible_category_ids(db: Session, user) -> Optional[List[str]]:
    """
    Returns list of category IDs accessible to the user, or None (no filter = see all).
    - Superadmin and corporate roles: None (see everything)
    - Plant users with no warehouse assignments: [] (see nothing)
    - Plant users with assignments: categories under their assigned category groups
    """
    from app.models import WarehouseCategoryAccess, Category
    if user.role in CORPORATE_ROLES or user.warehouse_id is None:
        return None
    rows = db.query(WarehouseCategoryAccess).filter(
        WarehouseCategoryAccess.warehouse_id == user.warehouse_id
    ).all()
    group_ids = [r.category_group_id for r in rows]
    if not group_ids:
        return []
    cats = db.query(Category).filter(Category.parent_id.in_(group_ids)).all()
    return [c.id for c in cats]


def get_accessible_group_ids(db: Session, user) -> Optional[List[str]]:
    """
    Returns list of category GROUP IDs accessible to the user, or None (see all).
    """
    from app.models import WarehouseCategoryAccess
    if user.role in CORPORATE_ROLES or user.warehouse_id is None:
        return None
    rows = db.query(WarehouseCategoryAccess).filter(
        WarehouseCategoryAccess.warehouse_id == user.warehouse_id
    ).all()
    return [r.category_group_id for r in rows]


def can_create_products(db: Session, user) -> bool:
    """True if user is allowed to create/edit products."""
    from app.models import Warehouse
    if user.role == ROLE_SUPERADMIN:
        return True
    if user.role not in (ROLE_ADMIN, "supervisor"):
        return False
    if not user.warehouse_id:
        return False
    wh = db.query(Warehouse).filter(Warehouse.id == user.warehouse_id).first()
    return wh is not None and wh.allow_product_creation
