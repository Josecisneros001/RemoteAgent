# Docker Isolation with DNS-Based Network Filtering

## Overview

Docker support for RemoteAgent running AI agents (Claude/Copilot) in an isolated container with DNS-based network filtering. The AI runs freely but can only connect to allowlisted domains.

## Goals

1. **Isolation** - AI runs inside container, can only access mounted workspace folder
2. **Network filtering** - Only allowlisted domains can be resolved/accessed
3. **No TLS interception** - Works with certificate pinning, no MITM proxy
4. **Hot-reload** - Add domains without restarting container
5. **Anti-exfiltration** - Block DNS tunneling, ping, direct IP connections

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Container                                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  dnsmasq (local DNS server, port 53)                │   │
│  │  - Only resolves domains in allowlist.json          │   │
│  │  - All other queries → NXDOMAIN                     │   │
│  │  - Watches allowlist.json for hot-reload            │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  iptables firewall rules                            │   │
│  │  - Block all direct IP connections (agent user)     │   │
│  │  - Block ICMP/ping                                  │   │
│  │  - Block DNS to external servers (only local 53)    │   │
│  │  - Block FTP/SSH/SMTP ports                         │   │
│  │  - Allow HTTP/HTTPS only                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  RemoteAgent + Claude/Copilot CLI                   │   │
│  │  - Uses local DNS (resolv.conf → 127.0.0.1)         │   │
│  │  - TLS passes through untouched                     │   │
│  │  - Can only reach allowlisted domains               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
docker/
├── Dockerfile              # Node + dnsmasq + inotify-tools + iptables
├── docker-compose.yml      # Container configuration
├── entrypoint.sh           # Starts dnsmasq, configures firewall, watches allowlist
├── allowlist.json          # Allowed domains (hot-reload enabled)
└── dns/
    └── generate-dnsmasq.sh # Converts allowlist.json → dnsmasq config
```

## How It Works

1. **Container starts** → `entrypoint.sh` runs
2. **DNS setup** → `generate-dnsmasq.sh` creates dnsmasq config from `allowlist.json`
3. **Firewall setup** → iptables rules block everything except HTTP/HTTPS to resolved domains
4. **Hot-reload** → `inotifywait` watches `allowlist.json`, regenerates config on change

## Security Controls

| Threat | Mitigation |
|--------|------------|
| DNS tunneling | External DNS blocked, only local dnsmasq allowed |
| Direct IP access | No DNS resolution = no connection possible |
| Ping exfiltration | ICMP blocked for agent user |
| SSH/FTP/SMTP | Ports 21, 22, 23, 25, 465, 587 blocked |
| Certificate pinning bypass | No MITM - TLS passes through untouched |

## Default Allowlist

```json
{
  "domains": [
    "api.anthropic.com",
    "claude.ai",
    "github.com",
    "api.github.com",
    "githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
    "google.com",
    "bing.com",
    "duckduckgo.com"
  ]
}
```

Each domain automatically includes all subdomains (e.g., `github.com` also allows `raw.githubusercontent.com` won't work - you need `githubusercontent.com` to allow `raw.githubusercontent.com`).

## Usage

### Enable network filtering

```yaml
# docker-compose.yml
environment:
  - ENABLE_NETWORK_FILTER=true
```

### Add a domain (hot-reload)

Edit `allowlist.json` on the host - changes apply within seconds without restart.

### Check DNS logs

```bash
docker exec remote-agent cat /var/log/dns/dnsmasq-gen.log
```

### Test domain resolution inside container

```bash
docker exec -u agent remote-agent nslookup github.com
# Should resolve

docker exec -u agent remote-agent nslookup evil.com
# Should return NXDOMAIN
```

## Volume Mounts

```yaml
volumes:
  - ./workspace:/workspace              # Working directory
  - ./allowlist.json:/app/allowlist.json  # Domain allowlist (hot-reload)
  - ~/.claude.json:/home/agent/.claude.json  # Claude auth
  - ~/.claude-docker/:/home/agent/.claude/
```

## Capabilities Required

- `NET_ADMIN` - Required for iptables firewall rules

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_NETWORK_FILTER` | `false` | Enable DNS-based network filtering |
| `DOCKER_MODE` | `true` | Indicates running in Docker |
| `WORKSPACE_PATH` | `/workspace` | Path to workspace inside container |
