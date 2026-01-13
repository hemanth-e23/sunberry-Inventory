# PowerShell script to find next available port starting from 8000
# Usage: .\find-available-port.ps1

function Find-AvailablePort {
    param(
        [int]$StartPort = 8000,
        [int]$MaxPort = 8100
    )
    
    for ($port = $StartPort; $port -le $MaxPort; $port++) {
        $connection = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $connection) {
            return $port
        }
    }
    
    throw "No available port found between $StartPort and $MaxPort"
}

try {
    $availablePort = Find-AvailablePort -StartPort 8000 -MaxPort 8100
    Write-Host "Available port found: $availablePort" -ForegroundColor Green
    
    # Update .env file if it exists
    if (Test-Path ".env") {
        $envContent = Get-Content ".env" -Raw
        if ($envContent -match "BACKEND_PORT=(\d+)") {
            $envContent = $envContent -replace "BACKEND_PORT=\d+", "BACKEND_PORT=$availablePort"
            Write-Host "Updated .env file with BACKEND_PORT=$availablePort" -ForegroundColor Cyan
        } else {
            $envContent += "`nBACKEND_PORT=$availablePort`n"
            Write-Host "Added BACKEND_PORT=$availablePort to .env file" -ForegroundColor Cyan
        }
        $envContent | Set-Content ".env" -NoNewline
    } else {
        Write-Host "BACKEND_PORT=$availablePort" -ForegroundColor Yellow
        Write-Host "Add this line to your .env file: BACKEND_PORT=$availablePort" -ForegroundColor Yellow
    }
    
    return $availablePort
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
