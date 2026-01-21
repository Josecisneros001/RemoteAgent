"""
mitmproxy filter script for RemoteAgent Docker isolation.

Allows all GET/HEAD/OPTIONS requests.
Blocks POST/PUT/DELETE/PATCH unless domain is in whitelist.
"""

import json
import os
from datetime import datetime
from mitmproxy import http, ctx

# Load whitelist
WHITELIST_PATH = os.environ.get("WHITELIST_PATH", "/app/whitelist.json")
LOG_PATH = os.environ.get("PROXY_LOG_PATH", "/var/log/proxy/blocked-requests.log")

def load_whitelist():
    """Load allowed domains from whitelist.json"""
    try:
        with open(WHITELIST_PATH, "r") as f:
            data = json.load(f)
            return set(data.get("allowedDomains", []))
    except Exception as e:
        ctx.log.error(f"Failed to load whitelist: {e}")
        return set()

# Load whitelist at startup
ALLOWED_DOMAINS = load_whitelist()

# Methods that are always allowed
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Methods that require whitelist check
MUTATION_METHODS = {"POST", "PUT", "DELETE", "PATCH"}


def log_blocked_request(method: str, host: str, path: str, body_size: int):
    """Log blocked request to file"""
    timestamp = datetime.utcnow().isoformat()
    log_entry = {
        "timestamp": timestamp,
        "method": method,
        "host": host,
        "path": path,
        "body_size": body_size,
        "action": "BLOCKED"
    }

    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception as e:
        ctx.log.error(f"Failed to write log: {e}")

    ctx.log.warn(f"BLOCKED: {method} {host}{path} (body: {body_size} bytes)")


def is_domain_allowed(host: str) -> bool:
    """Check if domain is in whitelist (supports subdomains)"""
    # Exact match
    if host in ALLOWED_DOMAINS:
        return True

    # Check if it's a subdomain of an allowed domain
    for allowed in ALLOWED_DOMAINS:
        if host.endswith("." + allowed):
            return True

    return False


def request(flow: http.HTTPFlow) -> None:
    """Process incoming request"""
    method = flow.request.method
    host = flow.request.host
    path = flow.request.path

    # Always allow safe methods
    if method in SAFE_METHODS:
        ctx.log.info(f"ALLOWED: {method} {host}{path}")
        return

    # Check mutation methods against whitelist
    if method in MUTATION_METHODS:
        if is_domain_allowed(host):
            ctx.log.info(f"ALLOWED (whitelisted): {method} {host}{path}")
            return

        # Block and log
        body_size = len(flow.request.content) if flow.request.content else 0
        log_blocked_request(method, host, path, body_size)

        # Return 403 Forbidden
        flow.response = http.Response.make(
            403,
            json.dumps({
                "error": "Request blocked by network filter",
                "message": f"{method} requests to {host} are not allowed",
                "hint": "Add this domain to whitelist.json if needed"
            }),
            {"Content-Type": "application/json"}
        )
        return

    # Unknown method - allow but log
    ctx.log.warn(f"UNKNOWN METHOD: {method} {host}{path}")
