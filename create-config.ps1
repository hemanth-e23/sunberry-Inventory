# PowerShell script to create config.py file
# Run this script from the project root directory

# Create directory if it doesn't exist
New-Item -ItemType Directory -Force -Path "backend\app" | Out-Null

# Create config.py file
$configContent = @"
from pydantic_settings import BaseSettings
from typing import List, Optional
import os
from dotenv import load_dotenv
import sys

# Load environment variables
load_dotenv()

class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://username:password@localhost:5432/sunberry_inventory")
    
    # JWT
    SECRET_KEY: str = os.getenv("SECRET_KEY", "your-super-secret-key-change-this-in-production")
    ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    
    # Application
    DEBUG: bool = os.getenv("DEBUG", "True").lower() == "true"
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    
    # CORS - Comma-separated list of allowed origins
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000")
    
    # Rate limiting
    RATE_LIMIT_ENABLED: bool = os.getenv("RATE_LIMIT_ENABLED", "True").lower() == "true"
    RATE_LIMIT_PER_MINUTE: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "60"))
    RATE_LIMIT_LOGIN_PER_MINUTE: int = int(os.getenv("RATE_LIMIT_LOGIN_PER_MINUTE", "5"))
    
    class Config:
        env_file = ".env"
    
    def get_cors_origins(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        if self.DEBUG:
            # In debug mode, allow localhost and common dev ports
            return [
                "http://localhost:5173",
                "http://localhost:3000",
                "http://127.0.0.1:5173",
                "http://127.0.0.1:3000",
            ] + [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]
        else:
            # In production, only allow specified origins
            origins = [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]
            if not origins:
                raise ValueError("CORS_ORIGINS must be set in production mode")
            return origins

settings = Settings()

# Validate SECRET_KEY in production
if not settings.DEBUG:
    default_key = "your-super-secret-key-change-this-in-production"
    if settings.SECRET_KEY == default_key:
        print("ERROR: SECRET_KEY is using default value. This is INSECURE!")
        print("Please set a strong SECRET_KEY in your .env file or environment variable.")
        print("Generate one with: openssl rand -hex 32")
        sys.exit(1)
    
    if len(settings.SECRET_KEY) < 32:
        print("WARNING: SECRET_KEY is too short. Recommended minimum: 32 characters")
"@

$configContent | Out-File -FilePath "backend\app\config.py" -Encoding utf8

Write-Host "config.py file created successfully!" -ForegroundColor Green
Write-Host "Location: backend\app\config.py" -ForegroundColor Cyan
