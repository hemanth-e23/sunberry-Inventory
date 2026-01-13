# PowerShell script to find next available port
# Usage: .\find-available-port.ps1 [startPort] [maxPort]

param(
    [int]$StartPort = 9000,
    [int]$MaxPort = 9100
)

function Find-AvailablePort {
    param(
        [int]$StartPort = 9000,
        [int]$MaxPort = 9100
    )
    
    Write-Host "Checking for available ports between $StartPort and $MaxPort..." -ForegroundColor Yellow
    
    for ($port = $StartPort; $port -le $MaxPort; $port++) {
        $connection = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $connection) {
            return $port
        }
    }
    
    throw "No available port found between $StartPort and $MaxPort"
}

try {
    # Find available port for frontend
    $frontendPort = Find-AvailablePort -StartPort $StartPort -MaxPort $MaxPort
    Write-Host "`nAvailable FRONTEND port found: $frontendPort" -ForegroundColor Green
    
    # Update .env file if it exists
    if (Test-Path ".env") {
        $envContent = Get-Content ".env" -Raw
        
        # Update or add FRONTEND_PORT
        if ($envContent -match "FRONTEND_PORT=(\d+)") {
            $envContent = $envContent -replace "FRONTEND_PORT=\d+", "FRONTEND_PORT=$frontendPort"
            Write-Host "Updated .env file with FRONTEND_PORT=$frontendPort" -ForegroundColor Cyan
        } else {
            if (-not $envContent.EndsWith("`n")) {
                $envContent += "`n"
            }
            $envContent += "FRONTEND_PORT=$frontendPort`n"
            Write-Host "Added FRONTEND_PORT=$frontendPort to .env file" -ForegroundColor Cyan
        }
        
        $envContent | Set-Content ".env" -NoNewline
        Write-Host "`n.env file updated successfully!" -ForegroundColor Green
    } else {
        Write-Host "`nFRONTEND_PORT=$frontendPort" -ForegroundColor Yellow
        Write-Host "Add this line to your .env file: FRONTEND_PORT=$frontendPort" -ForegroundColor Yellow
    }
    
    Write-Host "`nAccess your application at: http://YOUR_SERVER_IP:$frontendPort" -ForegroundColor Cyan
    
    return $frontendPort
} catch {
    Write-Host "`nError: $_" -ForegroundColor Red
    Write-Host "Try running with different port range: .\find-available-port.ps1 9000 9100" -ForegroundColor Yellow
    exit 1
}
