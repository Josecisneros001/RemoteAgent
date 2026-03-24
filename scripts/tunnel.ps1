# Remote Agent Tunnel Script
# Uses Microsoft Dev Tunnels (same as VS Code)
# Creates a persistent tunnel that keeps the same URL across restarts

param(
    [int]$Port = 3000
)

# Tunnel name: use TUNNEL_NAME env var, or default to remote-agent-<hostname>
# This ensures each machine gets its own persistent tunnel URL
$HostId = (hostname).ToLower() -replace '[^a-z0-9]+', '-' -replace '-$', ''
if ($env:TUNNEL_NAME) {
    $TunnelName = $env:TUNNEL_NAME
} else {
    $TunnelName = "remote-agent-$HostId"
}

Write-Host "🔗 Starting tunnel '$TunnelName' on port $Port..." -ForegroundColor Cyan
Write-Host '   (Override with: $env:TUNNEL_NAME="my-name" before running)'
Write-Host ""

# Check if devtunnel is installed
$devtunnel = Get-Command devtunnel -ErrorAction SilentlyContinue
if (-not $devtunnel) {
    Write-Host "❌ devtunnel not found. Installing..." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install options:" -ForegroundColor Yellow
    Write-Host "  1. winget install Microsoft.devtunnel"
    Write-Host "  2. Download from: https://aka.ms/TunnelsCliDownload/win-x64"
    Write-Host ""
    Write-Host "After installing, restart your terminal and run this script again."
    exit 1
}

# Check if logged in, auto-login if not
$userCheck = devtunnel user show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "📱 Not logged in to Dev Tunnels. Logging in with GitHub..." -ForegroundColor Yellow
    devtunnel user login -g
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to log in to Dev Tunnels" -ForegroundColor Red
        Write-Host "   Try manually: devtunnel user login -g"
        exit 1
    }
}

Write-Host "✅ Authenticated with Dev Tunnels" -ForegroundColor Green
Write-Host ""

# Check if the persistent tunnel already exists
$tunnelCheck = devtunnel show $TunnelName 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Using existing persistent tunnel: $TunnelName" -ForegroundColor Green
} else {
    Write-Host "📦 Creating persistent tunnel: $TunnelName..." -ForegroundColor Cyan
    devtunnel create $TunnelName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to create tunnel" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "🔌 Adding port $Port to tunnel..." -ForegroundColor Cyan
    devtunnel port create $TunnelName -p $Port
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to add port" -ForegroundColor Red
        exit 1
    }
    
    Write-Host "✅ Persistent tunnel created!" -ForegroundColor Green
}

Write-Host ""
Write-Host "🌐 Starting tunnel with same-account access..." -ForegroundColor Cyan
Write-Host "   You'll need to authenticate with the same Microsoft/GitHub account on your phone."
Write-Host "   The tunnel URL will remain the same each time you run this script."
Write-Host ""

# Host the persistent tunnel
devtunnel host $TunnelName
