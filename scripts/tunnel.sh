#!/bin/bash

# Remote Agent Tunnel Script
# Uses Microsoft Dev Tunnels (same as VS Code)

PORT=${1:-3000}

echo "🔗 Starting tunnel for Remote Agent on port $PORT..."
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
echo "🌐 Starting tunnel with anonymous access..."
echo "   Share the URL below with your phone!"
echo ""

# Start tunnel with anonymous access
devtunnel host -p $PORT --allow-anonymous
