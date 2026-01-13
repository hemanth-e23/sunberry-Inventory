# Network Access Guide for Sunberry Inventory

## Overview
By default, the application runs on `localhost` which only allows access from the same machine. To access the application from other devices on your network, you need to configure network access.

## Step 1: Get Your Server's IP Address

### On Windows Server:
```powershell
# Get your server's IP address
ipconfig | Select-String "IPv4"

# Or get just the IP address
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*"} | Select-Object -First 1).IPAddress
```

Example output: `192.168.1.100` (your actual IP will be different)

## Step 2: Update CORS Configuration

The backend needs to allow requests from your network IP address.

### Edit .env file:
```powershell
notepad .env
```

### Update CORS_ORIGINS:
Add your server's IP address to the CORS_ORIGINS variable:

```env
# Replace YOUR_SERVER_IP with your actual IP (e.g., 192.168.1.100)
CORS_ORIGINS=http://YOUR_SERVER_IP,http://localhost,http://127.0.0.1
```

**Example:**
```env
CORS_ORIGINS=http://192.168.1.100,http://localhost,http://127.0.0.1
```

### For Multiple Network Devices:
If you want to allow access from multiple IPs or the entire local network:

```env
# Allow from specific IPs
CORS_ORIGINS=http://192.168.1.100,http://192.168.1.101,http://localhost

# Or allow from entire local network (less secure, but convenient)
# Note: This allows any device on 192.168.1.x network
CORS_ORIGINS=http://192.168.1.0/24,http://localhost
```

## Step 3: Restart Docker Containers

After updating .env, restart the containers:

```powershell
docker compose down
docker compose up -d
```

## Step 4: Configure Windows Firewall

Allow incoming connections on port 80 (HTTP):

```powershell
# Run PowerShell as Administrator
New-NetFirewallRule -DisplayName "Sunberry Inventory HTTP" -Direction Inbound -LocalPort 80 -Protocol TCP -Action Allow
```

Or use the GUI:
1. Open **Windows Defender Firewall**
2. Click **Advanced Settings**
3. Click **Inbound Rules** → **New Rule**
4. Select **Port** → **Next**
5. Select **TCP** and enter port **80** → **Next**
6. Select **Allow the connection** → **Next**
7. Check all profiles → **Next**
8. Name it "Sunberry Inventory HTTP" → **Finish**

## Step 5: Access from Network Devices

### From the Server Itself:
- **Local access**: `http://localhost` or `http://127.0.0.1`
- **Network access**: `http://YOUR_SERVER_IP` (e.g., `http://192.168.1.100`)

### From Other Devices on the Network:
1. Make sure the device is on the same network (same Wi-Fi or LAN)
2. Open a web browser
3. Navigate to: `http://YOUR_SERVER_IP`
   - Example: `http://192.168.1.100`

### From Mobile Devices:
- Same as above: `http://YOUR_SERVER_IP`
- Make sure your mobile device is connected to the same Wi-Fi network

## Step 6: Verify Network Access

### Test from Another Computer:
```powershell
# On another computer, test if the server is reachable
ping YOUR_SERVER_IP

# Test if the web server is accessible
Invoke-WebRequest -Uri "http://YOUR_SERVER_IP" -UseBasicParsing
```

### Test from Browser:
1. Open browser on another device
2. Go to `http://YOUR_SERVER_IP`
3. You should see the Sunberry Inventory login page

## Troubleshooting

### Issue: "This site can't be reached"
**Solutions:**
- Check Windows Firewall rules (Step 4)
- Verify the server IP address is correct
- Make sure both devices are on the same network
- Check if Docker container is running: `docker compose ps`

### Issue: CORS Error in Browser Console
**Solutions:**
- Verify CORS_ORIGINS in .env includes your server IP
- Restart Docker containers after changing .env
- Check backend logs: `docker compose logs backend`

### Issue: Can't Access from Mobile Device
**Solutions:**
- Ensure mobile device is on the same Wi-Fi network
- Some corporate networks block device-to-device communication
- Try accessing from a different network device first to verify

### Issue: IP Address Changed
If your server's IP address changes (DHCP), you'll need to:
1. Get the new IP address
2. Update CORS_ORIGINS in .env
3. Restart Docker containers

**To set a static IP (recommended for servers):**
1. Open **Network Settings**
2. Go to **Adapter Options**
3. Right-click your network adapter → **Properties**
4. Select **Internet Protocol Version 4 (TCP/IPv4)** → **Properties**
5. Select **Use the following IP address**
6. Enter your desired static IP, subnet mask, and gateway
7. Click **OK**

## Quick Reference

### Common Commands:
```powershell
# Get server IP
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notlike "*Loopback*"}).IPAddress

# Check if port 80 is open
netstat -ano | findstr :80

# Check Docker containers
docker compose ps

# View backend logs
docker compose logs backend

# Restart containers
docker compose restart
```

### Default Access URLs:
- **Local**: `http://localhost` or `http://127.0.0.1`
- **Network**: `http://YOUR_SERVER_IP` (replace with your actual IP)

## Security Notes

⚠️ **Important Security Considerations:**

1. **Local Network Only**: This setup allows access from your local network only. For internet access, you'll need additional security measures (VPN, reverse proxy with SSL, etc.)

2. **Change Default Passwords**: Make sure to change the default admin password after first login

3. **Firewall**: Only allow port 80 if you need network access. Consider restricting to specific IPs if possible

4. **HTTPS**: For production use over the internet, set up HTTPS with SSL certificates (Let's Encrypt, etc.)

5. **Strong Secrets**: Ensure your `.env` file has strong `SECRET_KEY` and database passwords
