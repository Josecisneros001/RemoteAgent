#!/bin/bash

# Remote Agent Tunnel Script
# Uses Microsoft Dev Tunnels (same as VS Code)
# Creates a persistent tunnel that keeps the same URL across restarts

PORT=${1:-3000}

# Tunnel name: use TUNNEL_NAME env var, or default to remote-agent-<hostname>
# This ensures each machine gets its own persistent tunnel URL
HOST_ID=$(hostname | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/-$//')
TUNNEL_NAME="${TUNNEL_NAME:-remote-agent-$HOST_ID}"

echo "🔗 Starting tunnel '$TUNNEL_NAME' on port $PORT..."
echo "   (Override with: TUNNEL_NAME=my-name npm run tunnel)"
echo ""

# Check if devtunnel is installed
if ! command -v devtunnel &> /dev/null; then
    echo "❌ devtunnel not found. Installing..."
    curl -sL https://aka.ms/DevTunnelCliInstall | bash
    echo ""
    echo "Please restart your terminal and run this script again."
    exit 1
fi

# Check if logged in
if ! devtunnel user show &> /dev/null; then
    echo "📱 You need to log in to Dev Tunnels first."
    echo "   Run: devtunnel user login -g"
    echo "   (Uses your GitHub account)"
    exit 1
fi

echo "✅ Authenticated with Dev Tunnels"
echo ""

# Check if the persistent tunnel already exists
if devtunnel show "$TUNNEL_NAME" &> /dev/null; then
    echo "✅ Using existing persistent tunnel: $TUNNEL_NAME"
else
    echo "📦 Creating persistent tunnel: $TUNNEL_NAME..."
    devtunnel create "$TUNNEL_NAME" || { echo "❌ Failed to create tunnel"; exit 1; }
    
    echo "🔌 Adding port $PORT to tunnel..."
    devtunnel port create "$TUNNEL_NAME" -p $PORT || { echo "❌ Failed to add port"; exit 1; }
    
    echo "✅ Persistent tunnel created!"
fi

echo ""
echo "🌐 Starting tunnel with same-account access..."
echo "   You'll need to authenticate with the same Microsoft/GitHub account on your phone."
echo "   The tunnel URL will remain the same each time you run this script."
echo ""

# Host the persistent tunnel
devtunnel host "$TUNNEL_NAME"
