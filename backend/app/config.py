from pydantic_settings import BaseSettings
from typing import List, Optional
import sys


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql://username:password@localhost:5432/sunberry_inventory"

    # JWT
    SECRET_KEY: str = "your-super-secret-key-change-this-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # Application
    DEBUG: bool = False
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # CORS - comma-separated list of allowed origins
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # Service-to-service API key (used by /api/service/* endpoints)
    SERVICE_API_KEY: str = ""

    # Production app integration (optional — leave empty to disable)
    PRODUCTION_API_URL: str = ""
    PRODUCTION_API_KEY: str = ""

    # Rate limiting — configure in .env
    RATE_LIMIT_ENABLED: bool = False
    RATE_LIMIT_PER_MINUTE: int = 60
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 5

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    def get_cors_origins(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        if self.DEBUG:
            return [
                "http://localhost:5173",
                "http://localhost:3000",
                "http://127.0.0.1:5173",
                "http://127.0.0.1:3000",
            ] + [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        else:
            origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
            if not origins:
                raise ValueError("CORS_ORIGINS must be set in production mode")
            return origins


settings = Settings()

# Validate SECRET_KEY in production
if not settings.DEBUG:
    default_key = "your-super-secret-key-change-this-in-production"
    if settings.SECRET_KEY == default_key:
        print("ERROR: SECRET_KEY is using default value. This is INSECURE!")
        print("Generate one with: openssl rand -hex 32")
        sys.exit(1)
    if len(settings.SECRET_KEY) < 32:
        print("WARNING: SECRET_KEY is too short. Recommended minimum: 32 characters")

if not settings.SERVICE_API_KEY:
    print("WARNING: SERVICE_API_KEY is not set. Service-to-service endpoints will only accept JWT auth.")
