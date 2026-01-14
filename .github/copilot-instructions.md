# GitHub Copilot Instructions

## Project Overview

RemoteAgent is a mobile-friendly web control panel for GitHub Copilot CLI. It provides a web interface to run prompts, validate changes, and generate output images remotely—designed for phone access via Microsoft Dev Tunnels.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Server**: Fastify with WebSocket support (`@fastify/websocket`)
- **File Watching**: chokidar for monitoring output images
- **Push Notifications**: web-push with VAPID keys
- **Frontend**: Vanilla JavaScript (no framework), mobile-first PWA
- **Remote Access**: Microsoft Dev Tunnels (`devtunnel`)
- **Git Integration**: Automatic branch management per session

## Project Structure

```
src/
├── server/
│   ├── index.ts              # Server entry point, Fastify setup
│   ├── types.ts              # TypeScript type definitions
│   ├── routes/
│   │   └── api.ts            # REST API endpoints
│   └── services/
│       ├── config.ts         # Configuration management
│       ├── run-store.ts      # JSON file persistence for sessions/runs
│       ├── orchestrator.ts   # Copilot CLI execution & phase orchestration
│       ├── git.ts            # Git operations (branch, commit, clone)
│       ├── image-watcher.ts  # Watch outputs/ for new images
│       ├── push.ts           # Push notification service
│       └── websocket.ts      # WebSocket client management
├── client/
│   ├── index.html            # Main HTML page
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                 # Service worker for PWA
│   ├── js/
│   │   └── app.js            # Frontend application logic
│   └── styles/
│       └── main.css          # Mobile-first styles
```

## Core Concepts

### Session-Centric Architecture
- **Session**: A logical container for related work on a workspace
  - Has a unique ID, friendly name (from first prompt), and git branch
  - Contains multiple runs (iterations)
  - Maintains separate Copilot CLI sessions for prompt, validation, and output phases
- **Run**: A single execution iteration within a session
  - Executes three phases: prompt → validation → output
  - Can override session defaults for model/prompts

### Model Hierarchy (Cascade)
Models are resolved in this order: Run → Session → Workspace → Global Default
- `defaultModel`: Model for prompt phase (global default: claude-opus-4.5)
- `validationModel`: Model for validation phase (global default: claude-sonnet-4.5)
- `outputModel`: Model for output phase (global default: claude-sonnet-4.5)

### Three-Phase Execution
1. **Prompt Phase**: Execute user's prompt with Copilot CLI (uses main session)
2. **Validation Phase**: Run validation prompt in isolated session (preserves main context)
3. **Output Phase**: Generate images/outputs in isolated session

### Git Branch Management
- Each session creates a dedicated git branch: `remote-agent/<prompt-slug>-<timestamp>`
- Auto-commits changes after prompt phase completion
- Supports workspaces with or without git

## Key Patterns

### Run Store (Persistence)
- Sessions stored in `~/.remote-agent/sessions/`
- Runs stored in `~/.remote-agent/runs/`
- Use `withWriteLock()` for atomic file operations to prevent race conditions
- JSON retry logic for handling concurrent read/write

### WebSocket Streaming
- Real-time log streaming from Copilot CLI to browser
- Events: `log`, `phase`, `validation`, `image`, `complete`
- Debounced UI updates to prevent excessive re-renders

### Image Handling
- Images saved to `<workspace>/outputs/` directory
- `image-watcher.ts` monitors for new files using chokidar
- `syncImagesForRun()` scans existing images when loading completed runs

## Configuration

Config file location: `~/.remote-agent/config.json`

### Key Config Options
```typescript
interface Config {
  workspaces: WorkspaceConfig[];      // Workspace definitions
  mcps: McpConfig[];                  // MCP server configurations
  availableModels: string[];          // List of available models
  defaultModel: string;               // Global default for prompt phase
  defaultValidationModel: string;     // Global default for validation phase
  defaultOutputModel: string;         // Global default for output phase
  port: number;                       // Server port (default: 3000)
  vapidPublicKey?: string;            // Push notification keys
  vapidPrivateKey?: string;
  vapidEmail?: string;
}
```

### Workspace Configuration
```typescript
interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  validationPrompt?: string;          // Default validation prompt
  outputPrompt?: string;              // Default output prompt
  defaultModel?: string;              // Override global prompt model
  validationModel?: string;           // Override global validation model
  outputModel?: string;               // Override global output model
  gitRepo?: string;                   // Git URL (for cloned workspaces)
}
```

## API Endpoints

### Sessions
- `GET /api/sessions` - List all sessions (with optional workspaceId filter)
- `GET /api/sessions/:id` - Get session details with runs
- `POST /api/sessions` - Create new session and start first run
- `POST /api/sessions/:id/runs` - Add new run to existing session

### Runs
- `GET /api/runs/:id` - Get run details
- `POST /api/runs/abort` - Abort current running execution

### Workspaces
- `POST /api/workspaces` - Add workspace (existing folder, create new, or init git)
- `POST /api/workspaces/clone` - Clone repository as new workspace

### Git
- `GET /api/sessions/:id/git/changes` - Get uncommitted changes for session

### Config
- `GET /api/config` - Get configuration (models, workspaces, etc.)

### Push Notifications
- `GET /api/push/vapid-key` - Get VAPID public key
- `POST /api/push/subscribe` - Register push subscription

## Coding Conventions

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Use descriptive variable names
- Handle errors gracefully with try/catch
- Log important events for debugging
- Keep functions small and focused
- Use `withWriteLock()` for any file write operations

## Common Tasks

### Adding a new API endpoint
1. Add route in `src/server/routes/api.ts`
2. Add types in `src/server/types.ts` if needed
3. Implement service logic in appropriate service file

### Adding a new service
1. Create file in `src/server/services/`
2. Export functions or class
3. Import and use in routes or other services

### Modifying the UI
1. Update HTML in `src/client/index.html`
2. Add styles in `src/client/styles/main.css`
3. Add logic in `src/client/js/app.js`
4. Test on mobile viewport sizes
5. **Note**: Restart server to pick up HTML/CSS changes (tsx watch only monitors .ts files)

### Adding a new workspace creation option
1. Update HTML form in workspace modal
2. Add JS handler in `handleAddWorkspace()`
3. Update API endpoint in `api.ts`
4. Add git operations in `git.ts` if needed

## Testing

- Run `npm run dev` for development (uses tsx watch)
- Use `devtunnel` to test remote access from phone
- Check browser console for frontend errors
- Check terminal for server-side errors
- Use Playwright MCP for automated UI testing

## Available Models

Models are fetched from `copilot -h`:
- claude-opus-4.5, claude-sonnet-4.5, claude-haiku-4.5, claude-sonnet-4
- gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.2, gpt-5.1, gpt-5
- gpt-5.1-codex-mini, gpt-5-mini, gpt-4.1
- gemini-3-pro-preview

