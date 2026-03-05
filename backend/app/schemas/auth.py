from typing import Optional
from pydantic import Field
from app.schemas.base import BaseSchema


class Token(BaseSchema):
    access_token: str
    token_type: str


class TokenData(BaseSchema):
    username: Optional[str] = None


class LoginRequest(BaseSchema):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class BadgeLoginRequest(BaseSchema):
    badge_id: str = Field(..., min_length=1, max_length=50)
