# GitHub Copilot Instructions

## Project Overview

RemoteAgent is a mobile-friendly web control panel for AI coding agents (GitHub Copilot CLI and Claude CLI). It provides a web interface to run prompts, validate changes, and generate output images remotely—designed for phone access via Microsoft Dev Tunnels.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Server**: Fastify with WebSocket support (`@fastify/websocket`)
- **File Watching**: chokidar for monitoring output images
- **Push Notifications**: web-push with VAPID keys
- **Frontend**: React 19 with TypeScript, Vite, mobile-first PWA
- **Remote Access**: Microsoft Dev Tunnels (`devtunnel`)
- **AI Agents**: GitHub Copilot CLI (`copilot`) and Claude CLI (`claude`)

## Project Structure

```
src/
├── server/
│   ├── index.ts          # Server entry point, Fastify setup
│   ├── types.ts          # Server-side TypeScript types
│   ├── routes/
│   │   └── api.ts        # REST API endpoints
│   └── services/
│       ├── config.ts     # Configuration management
│       ├── run-store.ts  # JSON file persistence for sessions/runs
│       ├── orchestrator.ts # CLI execution & phase orchestration
│       ├── image-watcher.ts # Watch outputs/ for new images
│       ├── git.ts        # Git operations (branch, commit, push)
│       ├── push.ts       # Push notification service
│       └── websocket.ts  # WebSocket connection management
├── client/
│   ├── src/
│   │   ├── App.tsx       # Main React app component
│   │   ├── types.ts      # Client-side TypeScript types
│   │   ├── api/          # API client functions
│   │   ├── context/      # React context (AppContext)
│   │   ├── components/   # React components
│   │   │   ├── Sidebar/
│   │   │   ├── SessionList/
│   │   │   ├── SessionView/
│   │   │   ├── NewSessionForm/
│   │   │   ├── RunDetail/
│   │   │   ├── RunsList/
│   │   │   └── ...
│   │   └── utils/        # Helper functions
│   └── public/           # Static assets (manifest, sw.js)
└── client-dist/          # Built client files (served by server)
```

## Key Concepts

### Sessions & Runs
- **Session**: A workspace-specific conversation context with a git branch
- **Run**: A single prompt execution within a session (prompt → validation → output phases)
- Sessions can have multiple runs, each run inherits session context
- Each session creates its own git branch for isolation

### Multi-Agent Support
- **AgentType**: `'copilot' | 'claude'` - choose per session
- **Copilot CLI**: Uses `-p <prompt>`, `--allow-all-tools`, `--resume <session>`
- **Claude CLI**: Uses `-p` (print mode), `--dangerously-skip-permissions`, `--session-id <uuid>`, `--resume`
- Important: Claude CLI requires `stdin.end()` after spawn or it hangs

### Three-Phase Execution
1. **Prompt Phase**: Execute user's prompt (reuses main CLI session)
2. **Validation Phase**: Run validation in separate session (preserves main context)
3. **Output Phase**: Generate images/outputs in separate session

Validation and output phases receive context about the original prompt:
```
CONTEXT - Original task that was executed:
"""<original user prompt>"""

VALIDATION/OUTPUT TASK:
<configured prompt>
```

### Model Resolution Cascade
Models are resolved in order: Run → Session → Workspace → Global config
- `defaultModel`: Used for prompt phase
- `validationModel`: Used for validation phase  
- `outputModel`: Used for output phase

## Key Patterns

### Run Store (Persistence)
- Sessions stored in `~/.remote-agent/sessions/`
- Runs stored in `~/.remote-agent/runs/`
- Use `withWriteLock()` for atomic file operations

### WebSocket Streaming
- Real-time log streaming from CLI to browser
- Events: `log`, `phase`, `validation`, `image`, `complete`
- Connection maintained throughout run execution

### Git Integration
- Each session creates a branch: `remote-agent/<timestamp>-<prompt-slug>`
- Commits after prompt phase with message: `RemoteAgent: <prompt summary>`
- Auto-push to remote if configured

## Configuration

Config file: `~/.remote-agent/config.json`

Key options:
- `workspaces`: Array of `{ id, name, path, defaultModel?, validationModel?, outputModel? }`
- `defaultModel`, `defaultValidationModel`, `defaultOutputModel`: Global defaults
- `tunnel.subdomain`: Dev tunnel subdomain
- `vapidKeys`: Auto-generated push notification keys

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

### Modifying orchestration logic
1. Edit `src/server/services/orchestrator.ts`
2. Update `executePhases()` for phase flow changes
3. Update `runCopilotPhase()` for CLI argument changes

### Building & Running
- `npm run build` - Build server and client
- `npm run start` - Start production server
- `npm run dev` - Start dev server with watch mode
- `npm run watch` - Watch and rebuild on changes

## Testing

- Test with `npm run dev` for development
- Use `devtunnel` to test remote access
- Check browser console for frontend errors
- Check terminal for server-side errors
