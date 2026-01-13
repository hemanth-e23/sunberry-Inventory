# Windows Server Deployment Guide

## Prerequisites

1. **Install Docker Desktop for Windows** or **Docker Engine** on Windows Server
   - Download from: https://www.docker.com/products/docker-desktop
   - For Windows Server, use: https://docs.docker.com/engine/install/server-windows/

2. **Install Git for Windows**
   - Download from: https://git-scm.com/download/win

3. **Open PowerShell as Administrator** (for most commands)

## Deployment Commands

### 1. Install Docker (if not already installed)

```powershell
# For Windows Server with Chocolatey (if available)
choco install docker-desktop -y

# Or download and install Docker Desktop manually from docker.com
# After installation, restart your computer
```

### 2. Clone the Repository

```powershell
# Navigate to your desired directory (e.g., C:\Projects)
cd C:\Projects

# Clone the repository
git clone https://github.com/hemanth-e23/sunberry-Inventory.git

# Navigate into the project directory
cd sunberry-Inventory
```

### 3. Create Environment File (.env)

```powershell
# Create .env file using PowerShell
@"
# Database Configuration
POSTGRES_DB=sunberry_inventory
POSTGRES_USER=sunberry
POSTGRES_PASSWORD=YOUR_SECURE_PASSWORD_HERE
DB_PORT=5432

# Backend Configuration
SECRET_KEY=YOUR_SECRET_KEY_HERE
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
DEBUG=False
BACKEND_PORT=8000

# Frontend Configuration
FRONTEND_PORT=80

# CORS Configuration (replace with your server IP/domain)
CORS_ORIGINS=http://YOUR_SERVER_IP,http://YOUR_DOMAIN

# Rate Limiting
RATE_LIMIT_ENABLED=True
RATE_LIMIT_PER_MINUTE=60
RATE_LIMIT_LOGIN_PER_MINUTE=5
"@ | Out-File -FilePath .env -Encoding utf8
```

### 4. Generate Secure SECRET_KEY

```powershell
# Generate a secure SECRET_KEY using PowerShell
$secretKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object {[char]$_})
Write-Host "Generated SECRET_KEY: $secretKey"
Write-Host "Copy this value and replace YOUR_SECRET_KEY_HERE in .env file"

# Or use OpenSSL if available
# openssl rand -hex 32
```

### 5. Edit .env File

```powershell
# Open .env file in Notepad
notepad .env

# Or use VS Code if installed
code .env

# Replace the following values:
# - YOUR_SECURE_PASSWORD_HERE with a strong database password
# - YOUR_SECRET_KEY_HERE with the generated secret key
# - YOUR_SERVER_IP with your server's IP address (use: ipconfig to find it)
# - YOUR_DOMAIN with your domain name (if applicable)
```

### 6. Get Your Server IP Address

```powershell
# Get your server's IP address
ipconfig | Select-String "IPv4"

# Or get just the IP
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notlike "*Loopback*"}).IPAddress
```

### 7. Create config.py File

**Option 1: Using PowerShell Here-String (Recommended)**

```powershell
# Make sure the directory exists
New-Item -ItemType Directory -Force -Path "backend\app" | Out-Null

# Create backend/app/config.py file
@"
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
"@ | Out-File -FilePath "backend\app\config.py" -Encoding utf8
```

**Option 2: Using Notepad (Simpler Alternative)**

```powershell
# Create the file and open it in Notepad
New-Item -ItemType File -Force -Path "backend\app\config.py" | Out-Null
notepad "backend\app\config.py"
```

Then copy and paste this content into Notepad:

```python
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
```

Save the file (Ctrl+S) and close Notepad.

### 8. Build and Start All Services

```powershell
# Make sure Docker Desktop is running (check system tray)

# Build and start all containers
docker compose up -d --build

# If the above doesn't work, try:
docker-compose up -d --build
```

### 9. Check Container Status

```powershell
# Check if all containers are running
docker compose ps

# Or
docker ps
```

### 10. View Logs

```powershell
# View all logs
docker compose logs -f

# View logs for a specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f db
```

### 11. Create Admin User

```powershell
# Wait for backend to be ready (about 10-15 seconds), then create admin user
Start-Sleep -Seconds 15
docker compose exec backend python create_admin_user.py
```

### 12. Run Database Migrations

```powershell
# Run database migrations
docker compose exec backend python -c "from app.database import engine; from app.models import Base; Base.metadata.create_all(bind=engine)"
```

### 13. Test the Services

```powershell
# Test backend health
Invoke-WebRequest -Uri "http://localhost:8000/api/health" -UseBasicParsing

# Test frontend
Invoke-WebRequest -Uri "http://localhost" -UseBasicParsing

# Or open in browser
Start-Process "http://localhost"
Start-Process "http://localhost:8000/docs"
```

### 14. Access the Application

- **Frontend**: http://YOUR_SERVER_IP or http://localhost
- **Backend API**: http://YOUR_SERVER_IP:8000 or http://localhost:8000
- **API Documentation**: http://YOUR_SERVER_IP:8000/docs or http://localhost:8000/docs

## Quick Deployment Script (PowerShell)

Save this as `deploy.ps1` and run: `.\deploy.ps1`

```powershell
# deploy.ps1 - Quick Deployment Script for Windows

Write-Host "Starting Sunberry Inventory Deployment..." -ForegroundColor Green

# Check if Docker is running
try {
    docker --version | Out-Null
    Write-Host "Docker is installed" -ForegroundColor Green
} catch {
    Write-Host "Docker is not installed or not running. Please install Docker Desktop." -ForegroundColor Red
    exit 1
}

# Clone repository (if not already cloned)
if (-not (Test-Path ".\sunberry-Inventory")) {
    Write-Host "Cloning repository..." -ForegroundColor Yellow
    git clone https://github.com/hemanth-e23/sunberry-Inventory.git
    cd sunberry-Inventory
} else {
    Write-Host "Repository already exists, updating..." -ForegroundColor Yellow
    cd sunberry-Inventory
    git pull
}

# Generate secure passwords
$dbPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
$secretKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object {[char]$_})
$serverIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*"} | Select-Object -First 1).IPAddress

# Create .env file
Write-Host "Creating .env file..." -ForegroundColor Yellow
@"
POSTGRES_DB=sunberry_inventory
POSTGRES_USER=sunberry
POSTGRES_PASSWORD=$dbPassword
DB_PORT=5432
SECRET_KEY=$secretKey
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
DEBUG=False
BACKEND_PORT=8000
FRONTEND_PORT=80
CORS_ORIGINS=http://$serverIP,http://localhost
RATE_LIMIT_ENABLED=True
RATE_LIMIT_PER_MINUTE=60
RATE_LIMIT_LOGIN_PER_MINUTE=5
"@ | Out-File -FilePath .env -Encoding utf8

Write-Host "Generated credentials saved to .env file" -ForegroundColor Green
Write-Host "Database Password: $dbPassword" -ForegroundColor Cyan
Write-Host "Secret Key: $secretKey" -ForegroundColor Cyan
Write-Host "Server IP: $serverIP" -ForegroundColor Cyan

# Create config.py if it doesn't exist
if (-not (Test-Path "backend\app\config.py")) {
    Write-Host "Creating config.py..." -ForegroundColor Yellow
    # (Use the config.py content from step 7 above)
}

# Build and start containers
Write-Host "Building and starting containers..." -ForegroundColor Yellow
docker compose up -d --build

# Wait for services to be ready
Write-Host "Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

# Create admin user
Write-Host "Creating admin user..." -ForegroundColor Yellow
docker compose exec backend python create_admin_user.py

Write-Host "`nDeployment complete!" -ForegroundColor Green
Write-Host "Frontend: http://$serverIP" -ForegroundColor Cyan
Write-Host "Backend API: http://$serverIP:8000" -ForegroundColor Cyan
Write-Host "API Docs: http://$serverIP:8000/docs" -ForegroundColor Cyan
```

## Useful Management Commands (Windows)

### Stop All Services
```powershell
docker compose down
```

### Stop and Remove Volumes (WARNING: Deletes Database Data)
```powershell
docker compose down -v
```

### Restart a Specific Service
```powershell
docker compose restart backend
docker compose restart frontend
docker compose restart db
```

### View Logs for a Specific Service
```powershell
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f db
```

### Update from Git and Rebuild
```powershell
git pull
docker compose up -d --build
```

### Backup Database
```powershell
docker compose exec db pg_dump -U sunberry sunberry_inventory > backup.sql
```

### Restore Database
```powershell
Get-Content backup.sql | docker compose exec -T db psql -U sunberry sunberry_inventory
```

### Check Container Resource Usage
```powershell
docker stats
```

### Remove All Containers and Images (Cleanup)
```powershell
docker compose down -v --rmi all
```

## Windows Firewall Configuration

```powershell
# Open ports in Windows Firewall (Run PowerShell as Administrator)
New-NetFirewallRule -DisplayName "Sunberry Frontend" -Direction Inbound -LocalPort 80 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "Sunberry Backend" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow

# Or use GUI: Windows Defender Firewall > Advanced Settings > Inbound Rules > New Rule
```

## Troubleshooting

### Docker Compose Command Not Found
```powershell
# Try using docker-compose (with hyphen) instead
docker-compose up -d --build

# Or install Docker Compose plugin
```

### Port Already in Use
```powershell
# Check what's using the port
netstat -ano | findstr :8000
netstat -ano | findstr :80

# Kill the process (replace PID with actual process ID)
taskkill /PID <PID> /F
```

### Permission Denied Errors
```powershell
# Run PowerShell as Administrator
# Right-click PowerShell > Run as Administrator
```

### Docker Desktop Not Starting
- Make sure Windows Hyper-V is enabled
- Check Windows Features: Control Panel > Programs > Turn Windows features on or off > Hyper-V
- Restart your computer after enabling Hyper-V

### Containers Keep Restarting
```powershell
# Check logs to see what's wrong
docker compose logs backend
docker compose logs frontend
docker compose logs db
```

## Notes

1. **File Paths**: Windows uses backslashes (`\`) in paths, but Docker Compose works with forward slashes (`/`) in the docker-compose.yml file.

2. **Line Endings**: If you create files using PowerShell, they will have Windows line endings (CRLF), which is fine for most files.

3. **Environment Variables**: The `.env` file format is the same on Windows and Linux.

4. **Docker Desktop**: Make sure Docker Desktop is running before executing docker commands. Check the system tray for the Docker icon.

5. **PowerShell vs CMD**: These commands are for PowerShell. For CMD, use slightly different syntax (e.g., `docker-compose` instead of `docker compose`).
