# Remote Agent Tunnel Script
# Uses Microsoft Dev Tunnels (same as VS Code)
# Creates a persistent tunnel that keeps the same URL across restarts

param(
    [int]$Port = 3000
)

$TunnelName = "remote-agent"

Write-Host "🔗 Starting tunnel for Remote Agent on port $Port..." -ForegroundColor Cyan
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

# Check if logged in
$userCheck = devtunnel user show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "📱 You need to log in to Dev Tunnels first." -ForegroundColor Yellow
    Write-Host "   Run: devtunnel user login -g"
    Write-Host "   (Uses your GitHub account)"
    exit 1
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
