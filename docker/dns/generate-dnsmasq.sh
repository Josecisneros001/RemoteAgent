#!/bin/bash
# Generate dnsmasq configuration from allowlist.json

ALLOWLIST_PATH="${ALLOWLIST_PATH:-/app/allowlist.json}"
DNSMASQ_CONF="/etc/dnsmasq.d/allowlist.conf"
LOG_FILE="/var/log/dns/dnsmasq-gen.log"

log() {
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $1" | tee -a "$LOG_FILE"
}

if [ ! -f "$ALLOWLIST_PATH" ]; then
    log "ERROR: Allowlist not found at $ALLOWLIST_PATH"
    exit 1
fi

log "Generating dnsmasq config from $ALLOWLIST_PATH"

# Start with base config
cat > "$DNSMASQ_CONF" << 'EOF'
# Auto-generated from allowlist.json - do not edit manually
# This file is regenerated when allowlist.json changes

# Don't use /etc/resolv.conf (we are the resolver)
no-resolv

# Don't use /etc/hosts
no-hosts

# Log all queries (helps identify blocked domains)
log-queries
log-facility=/var/log/dns/queries.log

# Return NXDOMAIN for ALL domains by default
# Only domains with explicit server=/domain/... entries will resolve
address=/#/

EOF

# Add allowed domains (dnsmasq automatically allows subdomains)
log "Adding allowed domains..."
jq -r '.domains[]' "$ALLOWLIST_PATH" 2>/dev/null | while read -r domain; do
    if [ -n "$domain" ]; then
        # Allow this domain + all subdomains (use upstream DNS)
        echo "server=/$domain/8.8.8.8" >> "$DNSMASQ_CONF"
        log "  + $domain (+ subdomains)"
    fi
done

# Handle host.docker.internal specially
# First check if it's already defined in /etc/hosts (from docker-compose extra_hosts)
HOST_INTERNAL_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
if [ -z "$HOST_INTERNAL_IP" ]; then
    # Fallback to default gateway
    HOST_INTERNAL_IP=$(ip route | grep default | awk '{print $3}')
fi
if [ -n "$HOST_INTERNAL_IP" ]; then
    echo "" >> "$DNSMASQ_CONF"
    echo "# Docker host access" >> "$DNSMASQ_CONF"
    echo "address=/host.docker.internal/$HOST_INTERNAL_IP" >> "$DNSMASQ_CONF"
    log "  + host.docker.internal -> $HOST_INTERNAL_IP"
fi

# Allow localhost
echo "" >> "$DNSMASQ_CONF"
echo "# Localhost" >> "$DNSMASQ_CONF"
echo "address=/localhost/127.0.0.1" >> "$DNSMASQ_CONF"

log "dnsmasq config generated successfully"
log "Total domains: $(jq -r '.domains | length' "$ALLOWLIST_PATH")"
