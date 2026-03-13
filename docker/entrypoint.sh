#!/bin/bash
set -e

echo "=== RemoteAgent Docker Container ==="
echo "Starting..."

# Ensure devtunnel CLI is accessible to agent user (installed under /root/bin)
if [ -f /root/bin/devtunnel ]; then
  chmod 755 /root /root/bin /root/bin/devtunnel 2>/dev/null || true
fi

# Ensure devtunnel auth tokens are readable by agent user (shared volume at /app/DevTunnels)
if [ -d /app/DevTunnels ]; then
  chown -R agent:agent /app/DevTunnels 2>/dev/null || true
fi

# Create symlinks for Windows-encoded Claude project dirs → Linux-encoded equivalents.
# Sessions created on Windows host are stored under Q--engsys (Windows encoding),
# but Claude CLI on Linux looks for -q-engsys (Linux encoding).
# Symlinks let Claude find and resume sessions created on the Windows host.
CLAUDE_PROJECTS="/home/$AGENT_USER/.claude/projects"
if [ -d "$CLAUDE_PROJECTS" ]; then
  for dir in "$CLAUDE_PROJECTS"/[A-Z]--*; do
    [ -d "$dir" ] || continue
    dirname=$(basename "$dir")
    # Extract drive letter and rest: Q--engsys → q, engsys
    drive=$(echo "$dirname" | head -c1 | tr '[:upper:]' '[:lower:]')
    rest=$(echo "$dirname" | sed 's/^.--//')
    # Linux-encoded equivalent: -q-engsys
    linux_name="-${drive}-${rest}"
    linux_path="$CLAUDE_PROJECTS/$linux_name"
    if [ ! -e "$linux_path" ]; then
      ln -s "$dir" "$linux_path" 2>/dev/null || true
    fi
  done
fi

# Increase file descriptor limits
ulimit -n 65536 2>/dev/null || true

# User is created at build time with matching UID/GID
AGENT_USER="agent"
AGENT_UID=$(id -u $AGENT_USER)
AGENT_GID=$(id -g $AGENT_USER)

echo "Running as user: $AGENT_USER (UID=$AGENT_UID, GID=$AGENT_GID)"

# Create home directories if they don't exist
mkdir -p /home/$AGENT_USER/.claude /home/$AGENT_USER/.copilot /home/$AGENT_USER/.remote-agent/sessions /home/$AGENT_USER/.remote-agent/runs /home/$AGENT_USER/.config


# Ensure proper ownership of home directory and all subdirectories
# This is important for mounted volumes that may have root ownership
chown -R $AGENT_USER:$AGENT_USER /home/$AGENT_USER 2>/dev/null || true

# Fix workspace permissions (important for Windows hosts where UID/GID don't match)
if [ -d "/workspace" ]; then
    chown -R $AGENT_USER:$AGENT_USER /workspace 2>/dev/null || true
fi

# Check if network filtering is enabled
ENABLE_NETWORK_FILTER=${ENABLE_NETWORK_FILTER:-true}

if [ "$ENABLE_NETWORK_FILTER" = "true" ]; then
    echo ""
    echo "=== Network Filtering Enabled ==="

    # Generate dnsmasq config from allowlist
    echo "Generating DNS allowlist configuration..."
    /app/dns/generate-dnsmasq.sh

    # Configure dnsmasq
    echo "Configuring dnsmasq..."
    cat > /etc/dnsmasq.conf << 'EOF'
# Main dnsmasq configuration
port=53
listen-address=127.0.0.1
bind-interfaces
user=root
conf-dir=/etc/dnsmasq.d
EOF

    # Start dnsmasq
    echo "Starting dnsmasq DNS server..."
    dnsmasq --keep-in-foreground &
    DNSMASQ_PID=$!
    sleep 1

    if ! kill -0 $DNSMASQ_PID 2>/dev/null; then
        echo "ERROR: dnsmasq failed to start"
        exit 1
    fi
    echo "dnsmasq running (PID: $DNSMASQ_PID)"

    # Configure container to use local DNS
    echo "Configuring local DNS resolver..."
    echo "nameserver 127.0.0.1" > /etc/resolv.conf

    # Set up iptables firewall rules
    echo ""
    echo "Configuring firewall rules..."

    # Allow loopback (needed for local DNS and localhost services)
    iptables -A OUTPUT -o lo -j ACCEPT
    echo "  [+] Loopback traffic: allowed"

    # Allow established/related connections
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    echo "  [+] Established connections: allowed"

    # Block external DNS (force use of local dnsmasq)
    iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner $AGENT_UID ! -d 127.0.0.1 -j DROP
    iptables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner $AGENT_UID ! -d 127.0.0.1 -j DROP
    echo "  [+] External DNS: blocked (using local resolver)"

    # Block ICMP ping (prevents ping-based exfiltration)
    iptables -A OUTPUT -p icmp --icmp-type echo-request -m owner --uid-owner $AGENT_UID -j DROP
    echo "  [+] ICMP ping: blocked"

    # Block common non-HTTP exfiltration ports
    for port in 21 22 23 25 587 465; do
        iptables -A OUTPUT -p tcp --dport $port -m owner --uid-owner $AGENT_UID -j DROP
    done
    echo "  [+] FTP/SSH/Telnet/SMTP ports: blocked"

    # Allow HTTP/HTTPS (DNS controls what domains resolve)
    iptables -A OUTPUT -p tcp --dport 80 -m owner --uid-owner $AGENT_UID -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 443 -m owner --uid-owner $AGENT_UID -j ACCEPT
    echo "  [+] HTTP/HTTPS: allowed (DNS-filtered)"

    # Redirect localhost → host.docker.internal for the agent user.
    # This makes Claude's settings.json "localhost" URLs work transparently —
    # MCP servers and APIs running on the host are reachable without modifying settings.
    HOST_IP=$(getent ahosts host.docker.internal 2>/dev/null | awk '/STREAM/ {print $1; exit}')
    if [ -n "$HOST_IP" ] && [ "$HOST_IP" != "127.0.0.1" ]; then
        # Redirect TCP connections from agent user to 127.0.0.1 → host.docker.internal IP
        # Skip port 53 (DNS stays local for dnsmasq) and 3000 (RemoteAgent runs in container)
        iptables -t nat -N LOCALHOST_REDIRECT 2>/dev/null || true
        iptables -t nat -A LOCALHOST_REDIRECT -p tcp --dport 53 -j RETURN
        iptables -t nat -A LOCALHOST_REDIRECT -p tcp --dport 3000 -j RETURN
        iptables -t nat -A LOCALHOST_REDIRECT -p tcp -j DNAT --to-destination "$HOST_IP"
        iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner $AGENT_UID -d 127.0.0.1 -j LOCALHOST_REDIRECT
        # MASQUERADE so return traffic from host comes back through the container's network stack
        iptables -t nat -A POSTROUTING -p tcp -d "$HOST_IP" -m owner --uid-owner $AGENT_UID -j MASQUERADE
        echo "  [+] localhost redirect: 127.0.0.1 → $HOST_IP (host.docker.internal)"
    fi

    # Allow any port to host.docker.internal (for local development APIs)
    # Use the IP from /etc/hosts (set by docker-compose extra_hosts) or fallback to gateway
    # Handle both IPv4 and IPv6 addresses
    HOST_INTERNAL_IPS=$(getent ahosts host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u)
    if [ -z "$HOST_INTERNAL_IPS" ]; then
        HOST_INTERNAL_IPS=$(ip route | grep default | awk '{print $3}')
    fi
    for HOST_INTERNAL_IP in $HOST_INTERNAL_IPS; do
        # Check if it's an IPv6 address (contains colon)
        if echo "$HOST_INTERNAL_IP" | grep -q ':'; then
            # Use ip6tables for IPv6 addresses
            ip6tables -A OUTPUT -p tcp -d "$HOST_INTERNAL_IP" -m owner --uid-owner $AGENT_UID -j ACCEPT 2>/dev/null || true
            echo "  [+] Host machine IPv6 ($HOST_INTERNAL_IP): all ports allowed"
        else
            # Use iptables for IPv4 addresses
            iptables -A OUTPUT -p tcp -d "$HOST_INTERNAL_IP" -m owner --uid-owner $AGENT_UID -j ACCEPT
            echo "  [+] Host machine IPv4 ($HOST_INTERNAL_IP): all ports allowed"
        fi
    done

    # Block all other outbound from agent user
    iptables -A OUTPUT -m owner --uid-owner $AGENT_UID -j DROP
    echo "  [+] All other outbound: blocked"

    echo ""
    echo "Network filter active:"
    echo "  - Only allowlisted domains can be resolved"
    echo "  - DNS tunneling: blocked"
    echo "  - Direct IP connections: blocked (no DNS = no connection)"
    echo "  - Edit /app/allowlist.json to add domains (hot-reload enabled)"

    # Start allowlist watcher for hot-reload
    echo ""
    echo "Starting allowlist watcher..."
    (
        while true; do
            inotifywait -q -e modify,create /app/allowlist.json 2>/dev/null
            echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Allowlist changed, regenerating DNS config..."
            /app/dns/generate-dnsmasq.sh
            # Send SIGHUP to reload dnsmasq config
            kill -HUP $DNSMASQ_PID 2>/dev/null || true
            echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] DNS config reloaded"
        done
    ) &
    echo "Allowlist watcher running (hot-reload enabled)"

else
    echo "Network filtering disabled (set ENABLE_NETWORK_FILTER=true to enable)"
fi

echo ""

# Start RemoteAgent server as the agent user
echo "Starting RemoteAgent server as '$AGENT_USER' user (UID=$AGENT_UID)..."
cd /app

# Run as agent user (non-root)
exec su $AGENT_USER -c "node dist/server/index.js"
