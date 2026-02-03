# GitHub Copilot Instructions

## Project Overview

RemoteAgent is a mobile-friendly web control panel for AI coding agents (GitHub Copilot CLI and Claude CLI). It provides an **interactive terminal** interface to run prompts, monitor progress in real-time, and manage sessions remotely—designed for phone access via Microsoft Dev Tunnels or Docker deployment with network filtering.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Server**: Fastify with WebSocket support (`@fastify/websocket`)
- **Terminal**: node-pty for interactive PTY sessions, xterm.js on frontend
- **Push Notifications**: web-push with VAPID keys
- **Frontend**: React 19 with TypeScript, Vite, mobile-first PWA
- **Remote Access**: Microsoft Dev Tunnels (`devtunnel`) or Docker
- **AI Agents**: GitHub Copilot CLI (`copilot`) and Claude CLI (`claude`)
- **Deployment**: Docker with DNS-based network filtering for security

## Project Structure

```
src/
├── server/
│   ├── index.ts          # Server entry point, Fastify setup, WebSocket handlers
│   ├── types.ts          # Server-side TypeScript types
│   ├── routes/
│   │   └── api.ts        # REST API endpoints (sessions, workspaces, git)
│   └── services/
│       ├── config.ts     # Configuration management (~/.remote-agent/config.json)
│       ├── run-store.ts  # JSON file persistence for sessions/runs
│       ├── pty-manager.ts # Interactive PTY session management (node-pty)
│       ├── image-watcher.ts # Watch outputs/ for new images
│       ├── git.ts        # Git operations (branch, commit, checkout, clone)
│       ├── push.ts       # Push notification service (VAPID)
│       └── websocket.ts  # WebSocket broadcast for general events
├── client/
│   ├── src/
│   │   ├── App.tsx       # Main React app component
│   │   ├── types.ts      # Client-side TypeScript types
│   │   ├── api/          # API client functions
│   │   ├── context/      # React context (AppContext for global state)
│   │   ├── hooks/        # Custom hooks (useNotifications)
│   │   ├── components/   # React components
│   │   │   ├── Sidebar/
│   │   │   ├── SessionList/
│   │   │   ├── SessionView/
│   │   │   ├── NewSessionForm/
│   │   │   ├── InteractiveTerminal/  # xterm.js PTY terminal
│   │   │   ├── CommitsTab/
│   │   │   ├── MobileHeader/
│   │   │   └── WelcomeView/
│   │   └── utils/        # Helper functions
│   └── public/           # Static assets (manifest.json, sw.js)
└── docker/               # Docker deployment with network filtering
    ├── Dockerfile
    ├── docker-compose.yml
    ├── entrypoint.sh     # Starts dnsmasq, iptables, and app
    ├── allowlist.json    # Allowed domains for network access
    └── dns/              # DNS filtering scripts
```

## Key Concepts

### Sessions (Interactive Terminal)
- **Session**: A workspace-specific interactive PTY session with a git branch
- Sessions use node-pty to spawn real terminal processes
- Each session connects to Claude CLI or Copilot CLI in interactive mode
- Sessions can be **resumed** to continue previous conversations
- Each session creates its own git branch for isolation

### Multi-Agent Support
- **AgentType**: `'copilot' | 'claude'` - choose per session
- **Claude CLI**: 
  - Uses `--session-id <uuid>` for new sessions
  - Uses `--resume <uuid>` to continue existing sessions
  - Uses `--dangerously-skip-permissions` only in Docker mode
- **Copilot CLI**:
  - Session IDs auto-detected from `~/.copilot/session-state/`
  - Uses `--resume <session-id>` to continue sessions
  - Uses `--allow-all-tools --allow-all-paths` only in Docker mode

### PTY Session Lifecycle
1. **Create Session**: User selects workspace, agent, and provides initial prompt
2. **Start PTY**: Server spawns CLI with node-pty, sends initial prompt
3. **Stream Output**: PTY output batched and sent via WebSocket to xterm.js
4. **Interactive Input**: User types commands/responses sent back to PTY
5. **Resume**: Sessions can be stopped and resumed later with `--resume`

### WebSocket Events
- `/ws` - General broadcast events (legacy, for push notifications)
- `/ws/terminal/:sessionId` - Interactive PTY data stream
  - `pty-data`: Terminal output from server to client
  - `pty-input`: User input from client to server
  - `pty-resize`: Terminal resize events
  - `pty-exit`: PTY process exit notification
  - `interaction-needed`: Agent waiting for user input

## Key Patterns

### PTY Manager (`pty-manager.ts`)
- Manages active PTY sessions with `Map<sessionId, PtySession>`
- Output batching (16ms intervals, 16KB chunks) to prevent browser overload
- Idle detection (8s) triggers push notifications for interaction-needed
- Retry detection for Claude resume failures (auto-restarts with `--session-id`)
- Client attachment/detachment for WebSocket connections

### Run Store (Persistence)
- Sessions stored in `~/.remote-agent/sessions/`
- Runs stored in `~/.remote-agent/runs/` (legacy, for multi-phase workflows)
- Use `withWriteLock()` for atomic file operations

### Git Integration
- Each session creates a branch: `remote-agent/<prompt-slug>-<timestamp>`
- `checkoutMainAndPull()` before creating new branches
- Sessions checkout their branch when resumed
- Git changes viewable in CommitsTab component

## Configuration

Config file: `~/.remote-agent/config.json`

```json
{
  "workspaces": [
    { "id": "my-project", "name": "My Project", "path": "/path/to/project" }
  ],
  "defaultBrowsePath": "/home/user/projects",
  "port": 3000
}
```

Key options:
- `workspaces`: Array of `{ id, name, path, gitRepo? }`
- `defaultBrowsePath`: Default path for workspace browser dialog
- `port`: Server port (default 3000)
- `vapidPublicKey`, `vapidPrivateKey`: Auto-generated for push notifications

## Docker Deployment

The Docker setup provides **network-filtered sandboxing** for AI agents:

### Key Files
- `docker/docker-compose.yml` - Container configuration with volume mounts
- `docker/Dockerfile` - Builds RemoteAgent with Claude and Copilot CLIs
- `docker/entrypoint.sh` - Configures dnsmasq + iptables firewall
- `docker/allowlist.json` - Allowed domains (hot-reload supported)

### Network Filtering
- **dnsmasq**: Only resolves allowlisted domains
- **iptables**: Blocks external DNS, FTP, SSH, SMTP; allows HTTP/HTTPS
- **Hot-reload**: Edit `allowlist.json` to add domains without restart
- `ENABLE_NETWORK_FILTER=false` to disable filtering

### Running in Docker
```bash
cd docker
HOST_UID=$(id -u) HOST_GID=$(id -g) docker-compose up --build
```

## Common Tasks

### Adding a new API endpoint
1. Add route in `src/server/routes/api.ts`
2. Add types in `src/server/types.ts` and `src/client/src/types.ts`
3. Add API client function in `src/client/src/api/index.ts`

### Adding a new React component
1. Create folder in `src/client/src/components/<Name>/`
2. Add `<Name>.tsx` and `<Name>.css`
3. Export from component file
4. Import and use in parent component

### Modifying PTY session behavior
1. Edit `src/server/services/pty-manager.ts`
2. Update `startInteractiveSession()` for CLI argument changes
3. Update output handling in `onData` callback
4. Update WebSocket event types in `types.ts` if needed

### Adding domains to Docker allowlist
1. Edit `docker/allowlist.json` - add to `domains` array
2. Changes apply automatically via hot-reload (inotify watcher)

### Building & Running
- `npm run build` - Build server and client
- `npm run start` - Start production server
- `npm run dev` - Start dev server with watch mode
- `npm run watch` - Watch and rebuild both server and client

## Testing

- Test with `npm run dev` for development
- Use `devtunnel` or Docker to test remote access
- Check browser console for frontend errors
- Check terminal for server-side errors
- For Docker: `docker-compose logs -f` to watch logs
