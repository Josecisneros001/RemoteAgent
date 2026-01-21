# Docker Isolation with Network Filtering

## Overview

Add Docker support to RemoteAgent for running AI agents (Claude/Copilot) in an isolated container with network filtering. The AI can run freely but outbound POST/PUT/DELETE requests are blocked unless the domain is whitelisted.

## Goals

1. **Isolation** - AI runs inside container, can only access mounted workspace folder
2. **Network filtering** - Allow all GET requests, block POST/PUT/DELETE except whitelisted domains
3. **Transparency** - Log blocked requests for visibility
4. **Support both CLIs** - Claude and Copilot CLI work inside container

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Docker Container                                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │  mitmproxy (transparent proxy)                    │  │
│  │  - Inspects all HTTP/HTTPS traffic                │  │
│  │  - Allows GET requests                            │  │
│  │  - Checks POST/PUT/DELETE against whitelist.json  │  │
│  │  - Blocks & logs non-whitelisted mutations        │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │  RemoteAgent Server                               │  │
│  │  - Fastify + WebSocket                            │  │
│  │  - PTY sessions for Claude/Copilot CLI            │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │  Claude/Copilot CLI                               │  │
│  │  - Normal permission prompts (no skip flags)      │  │
│  │  - Network calls route through proxy              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   /workspace (mounted)          Allowed external APIs
   (host folder)                 (api.anthropic.com, etc.)
```

## File Structure

```
docker/
├── Dockerfile              # Multi-stage build: Node app + mitmproxy
├── docker-compose.yml      # Easy startup with volume mounts
├── whitelist.json          # Allowed domains for POST/PUT/DELETE
├── proxy/
│   └── filter.py           # mitmproxy script for filtering logic
└── entrypoint.sh           # Starts proxy + RemoteAgent server
```

## Proxy Filtering Logic

```python
def request(flow):
    method = flow.request.method
    host = flow.request.host

    # Always allow GET/HEAD/OPTIONS
    if method in ["GET", "HEAD", "OPTIONS"]:
        return

    # POST/PUT/DELETE/PATCH - check whitelist
    if host in whitelist["allowedDomains"]:
        return

    # Block and log
    log_blocked_request(method, host, flow.request.path)
    flow.kill()
```

## Default Whitelist

- `api.anthropic.com` - Claude API
- `api.githubcopilot.com` - Copilot API
- `registry.npmjs.org` - npm install
- `pypi.org` - pip install
- `files.pythonhosted.org` - pip packages
- `github.com` - git operations
- `api.github.com` - GitHub API

## Volume Mounts

```yaml
volumes:
  - ./workspace:/workspace              # Working directory
  - ./docker/whitelist.json:/app/whitelist.json
  - ~/.claude:/root/.claude             # Claude auth
  - ~/.copilot:/root/.copilot           # Copilot auth
  - ~/.config/github-copilot:/root/.config/github-copilot
```

## Changes to Existing Code

- `orchestrator.ts`: Detect Docker environment, remove `--dangerously-skip-permissions` when in container
- Config: Add `DOCKER_MODE` environment variable detection
