#!/bin/bash
set -e

echo "=== RemoteAgent Docker Container ==="
echo "Starting..."

# Increase file descriptor limits
ulimit -n 65536 2>/dev/null || true

# User is created at build time with matching UID/GID
AGENT_USER="agent"
AGENT_UID=$(id -u $AGENT_USER)
AGENT_GID=$(id -g $AGENT_USER)

echo "Running as user: $AGENT_USER (UID=$AGENT_UID, GID=$AGENT_GID)"

# Create home directories if they don't exist
mkdir -p /home/$AGENT_USER/.claude /home/$AGENT_USER/.copilot /home/$AGENT_USER/.remote-agent /home/$AGENT_USER/.config

# Check if proxy filtering is enabled
ENABLE_PROXY=${ENABLE_PROXY:-false}

if [ "$ENABLE_PROXY" = "true" ]; then
    echo "Network filtering enabled..."

    MITMPROXY_DIR="/home/$AGENT_USER/.mitmproxy"
    PROXY_PORT=8080

    # Generate mitmproxy CA certificate if it doesn't exist
    if [ ! -f "$MITMPROXY_DIR/mitmproxy-ca-cert.pem" ]; then
        echo "Generating mitmproxy CA certificate..."
        mkdir -p "$MITMPROXY_DIR"
        chown $AGENT_UID:$AGENT_GID "$MITMPROXY_DIR"
        su $AGENT_USER -c "mitmdump --mode transparent -q &"
        sleep 2
        pkill -f mitmdump || true
    fi

    # Install CA certificate system-wide
    if [ -f "$MITMPROXY_DIR/mitmproxy-ca-cert.pem" ]; then
        echo "Installing CA certificate..."
        cp "$MITMPROXY_DIR/mitmproxy-ca-cert.pem" /usr/local/share/ca-certificates/mitmproxy.crt
        update-ca-certificates
        export NODE_EXTRA_CA_CERTS="$MITMPROXY_DIR/mitmproxy-ca-cert.pem"
    fi

    # Set up iptables to redirect HTTP/HTTPS traffic through mitmproxy
    echo "Configuring transparent proxy..."
    iptables -t nat -A OUTPUT -p tcp --dport 80 -m owner --uid-owner $AGENT_UID -j REDIRECT --to-port $PROXY_PORT
    iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner --uid-owner $AGENT_UID -j REDIRECT --to-port $PROXY_PORT

    # Block ICMP (ping) for user
    iptables -A OUTPUT -p icmp --icmp-type echo-request -m owner --uid-owner $AGENT_UID -j DROP
    echo "  - ICMP (ping): Blocked"

    # Start mitmproxy in background as user
    echo "Starting mitmproxy with filter..."
    su $AGENT_USER -c "mitmdump \
        --mode transparent \
        --ssl-insecure \
        --set stream_large_bodies=1m \
        -s /app/proxy/filter.py \
        --listen-port $PROXY_PORT \
        > /var/log/proxy/mitmproxy.log 2>&1 &"

    sleep 2

    # Verify proxy is running
    if ! pgrep -f mitmdump > /dev/null; then
        echo "WARNING: mitmproxy failed to start, continuing without proxy"
        cat /var/log/proxy/mitmproxy.log
    else
        echo "Proxy ready. Network filter active:"
        echo "  - GET/HEAD/OPTIONS: Always allowed"
        echo "  - POST/PUT/DELETE/PATCH: Only whitelisted domains"
        echo "  - Blocked requests logged to: /var/log/proxy/blocked-requests.log"
    fi
else
    echo "Network filtering disabled (set ENABLE_PROXY=true to enable)"
fi

echo ""

# Start RemoteAgent server as the agent user
echo "Starting RemoteAgent server as '$AGENT_USER' user (UID=$AGENT_UID)..."
cd /app

# Run as agent user (non-root)
exec su $AGENT_USER -c "node dist/server/index.js"
