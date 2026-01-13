# Remote Agent

A mobile-friendly web control panel for GitHub Copilot CLI. Run prompts, validate changes, and generate output images—all from your phone.

## Features

- **Three-phase orchestration**: User prompt → Validation → Output generation
- **Real-time streaming logs**: WebSocket streaming of copilot output for all phases
- **Session continuation**: Continue previous copilot sessions or start fresh
- **Retry logic**: Automatic retries (3 attempts) for failed phases
- **Startup recovery**: Automatically resumes incomplete runs on server restart
- **Push notifications**: Get alerts when runs complete (or fail)
- **Run history**: View past runs and their results
- **Image gallery**: View generated images directly in the UI with lightbox
- **Mobile-first PWA**: Installable app designed for phone access via tunnel
- **Multi-workspace support**: Switch between different project workspaces

## Prerequisites

Before running Remote Agent, you need to install and authenticate with both GitHub Copilot CLI and Microsoft Dev Tunnels.

### 1. Install GitHub Copilot CLI

```bash
# Install via npm (requires Node.js 18+)
npm install -g @githubnext/github-copilot-cli

# Or via GitHub CLI extension
gh extension install github/gh-copilot
```

### 2. Login to GitHub Copilot

```bash
# Authenticate with GitHub
gh auth login

# Verify copilot is working
copilot "say hello"
```

> **Note**: You need an active GitHub Copilot subscription.

### 3. Install Microsoft Dev Tunnels CLI

```bash
# Linux/macOS
curl -sL https://aka.ms/DevTunnelCliInstall | bash

# Or via npm
npm install -g @devtunnels/cli
```

### 4. Login to Dev Tunnels

```bash
# Login with your GitHub account
devtunnel user login -g

# Verify login
devtunnel user show
```

## Quick Start

```bash
# Install dependencies
npm install

# Create config directory and edit config
mkdir -p ~/.remote-agent
cp config.example.json ~/.remote-agent/config.json
# Edit ~/.remote-agent/config.json to add your workspaces

# Start the server
npm run dev

# In another terminal, start the tunnel
npm run tunnel
```

## Configuration

Edit `~/.remote-agent/config.json`:

```json
{
  "workspaces": [
    {
      "id": "my-app",
      "name": "My Application",
      "path": "/home/user/projects/my-app",
      "validationPrompt": "Verify the changes are correct. Run any relevant tests.",
      "outputPrompt": "Generate images in ./outputs/. Create the directory if needed."
    }
  ],
  "mcps": [],
  "model": "claude-sonnet-4",
  "port": 3000
}
```

### Config Options

| Option | Description |
|--------|-------------|
| `workspaces` | Array of workspaces you can access from phone |
| `workspaces[].validationPrompt` | Per-workspace template for validation phase |
| `workspaces[].outputPrompt` | Per-workspace template for output/image generation phase |
| `mcps` | Additional MCP servers to use (e.g., `["playwright"]`) |
| `model` | AI model to use (e.g., `claude-sonnet-4`, `gpt-5`) |
| `port` | Server port (default: 3000) |

### Push Notifications (VAPID Keys)

VAPID keys are required for push notifications. They are **automatically generated** on first server startup and saved to your config file:

```json
{
  "vapidPublicKey": "...",
  "vapidPrivateKey": "...",
  "vapidEmail": "mailto:admin@localhost"
}
```

If you need to regenerate them manually, delete these fields from your config and restart the server, or generate new keys:

```bash
npx web-push generate-vapid-keys
```

Then add the keys to `~/.remote-agent/config.json`.

## How It Works

1. **Select workspace** from the dropdown (populated from config)
2. **Optionally select a previous session** to continue
3. **Enter your prompt** (what you want copilot to do)
4. **Add validation instructions** (optional) - how to verify the changes
5. **Add image instructions** (optional) - what images to generate
6. **Submit** and watch the live streaming logs

The orchestrator runs three copilot commands in sequence:
1. `copilot -p "<your prompt>" --allow-all-tools`
2. `copilot -p "<validation prompt>" --allow-all-tools` (isolated session)
3. `copilot -p "<output prompt>" --allow-all-tools` (isolated session)

Each phase has automatic retry logic (3 attempts with 2-second delays).

Images written to `./outputs/` in the workspace are automatically detected and shown in the UI.

## UI Sections

When viewing a run, you'll see four collapsible sections:

1. **Prompt Output** - Streaming logs from the main prompt phase
2. **Validation** - Validation status (passed/failed) and logs
3. **Image Generation Logs** - Streaming logs from the output generation phase
4. **Generated Images** - Gallery of images created in `./outputs/`

## Tunnel Setup

The tunnel uses Microsoft Dev Tunnels (same service VS Code uses):

```bash
# Start tunnel (run alongside the server)
npm run tunnel
```

This gives you a public `https://*.devtunnels.ms` URL accessible from your phone.

## Development

```bash
# Run with auto-reload
npm run dev

# Build for production
npm run build
npm start
```

## Project Structure

```
RemoteAgent/
├── src/
│   ├── server/
│   │   ├── index.ts          # Fastify server entry
│   │   ├── types.ts          # TypeScript types
│   │   ├── routes/
│   │   │   └── api.ts        # REST API endpoints
│   │   └── services/
│   │       ├── config.ts     # Config loading
│   │       ├── run-store.ts  # Run persistence
│   │       ├── orchestrator.ts # Three-phase execution
│   │       ├── image-watcher.ts # File watcher
│   │       ├── push.ts       # Push notifications
│   │       └── websocket.ts  # WS client management
│   └── client/
│       ├── index.html        # Main HTML
│       ├── styles/main.css   # Mobile-first styles
│       ├── js/app.js         # Client app
│       ├── sw.js             # Service worker
│       └── manifest.json     # PWA manifest
├── scripts/
│   └── tunnel.sh             # Dev tunnel script
├── package.json
└── tsconfig.json
```

## Data Storage

All data is stored in `~/.remote-agent/`:

```
~/.remote-agent/
├── config.json           # Your configuration
├── runs/                 # Run history (JSON files)
│   ├── <run-id>.json
│   └── ...
└── push-subscriptions.json  # Push notification subscriptions
```
