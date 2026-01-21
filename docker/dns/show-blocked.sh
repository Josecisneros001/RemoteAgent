#!/bin/bash
# Show blocked DNS queries (domains that returned NXDOMAIN)
#
# Usage:
#   ./show-blocked.sh          # Show all blocked domains
#   ./show-blocked.sh -f       # Follow (tail) blocked domains in real-time
#   ./show-blocked.sh -u       # Show unique blocked domains only

LOG_FILE="/var/log/dns/queries.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "No DNS log file found at $LOG_FILE"
    exit 1
fi

case "$1" in
    -f|--follow)
        echo "=== Following blocked DNS queries (Ctrl+C to stop) ==="
        tail -f "$LOG_FILE" | grep --line-buffered "NXDOMAIN" | while read line; do
            domain=$(echo "$line" | grep -oP 'reply \K[^ ]+(?= is)')
            timestamp=$(echo "$line" | awk '{print $1, $2, $3}')
            echo "[$timestamp] BLOCKED: $domain"
        done
        ;;
    -u|--unique)
        echo "=== Unique blocked domains ==="
        grep "NXDOMAIN" "$LOG_FILE" | grep -oP 'reply \K[^ ]+(?= is)' | sort -u
        ;;
    *)
        echo "=== Blocked DNS queries ==="
        grep "NXDOMAIN" "$LOG_FILE" | while read line; do
            domain=$(echo "$line" | grep -oP 'reply \K[^ ]+(?= is)')
            timestamp=$(echo "$line" | awk '{print $1, $2, $3}')
            echo "[$timestamp] BLOCKED: $domain"
        done
        ;;
esac
