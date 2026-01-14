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

## Project Structure

```
src/
├── server/
│   ├── index.ts          # Server entry point, Fastify setup
│   ├── routes/
│   │   ├── api.ts        # REST API endpoints
│   │   └── websocket.ts  # WebSocket handlers for streaming
│   └── services/
│       ├── run-store.ts  # JSON file persistence for runs
│       ├── run-executor.ts # Copilot CLI execution logic
│       ├── image-watcher.ts # Watch outputs/ for new images
│       └── push.ts       # Push notification service
├── client/
│   ├── index.html        # Main HTML page
│   ├── js/
│   │   └── app.js        # Frontend application logic
│   └── css/
│       └── styles.css    # Mobile-first styles
└── types/
    └── index.ts          # Shared TypeScript types
```

## Key Patterns

### Run Store (Persistence)
- Runs are stored as JSON files in `~/.remote-agent/runs/`
- Use `withWriteLock()` for atomic file operations to prevent race conditions
- Always acquire lock before any async operations

### Three-Phase Execution
1. **Prompt Phase**: Execute user's prompt with Copilot CLI
2. **Validation Phase**: Run validation prompt to check changes
3. **Output Phase**: Generate images/outputs based on results

### WebSocket Streaming
- Real-time log streaming from Copilot CLI to browser
- Messages include phase identifier and log content
- Connection maintained throughout run execution

### Image Handling
- Images are saved to `./outputs/` directory
- `image-watcher.ts` monitors for new files using chokidar
- `syncImagesForRun()` scans existing images when loading completed runs

## Configuration

Config file location: `~/.remote-agent/config.json`

Key config options:
- `workspaces`: Array of workspace configurations
- `prompts`: Phase prompts (userPrompt, validationPrompt, outputPrompt)
- `tunnel.subdomain`: Dev tunnel subdomain for remote access
- `vapidKeys`: Auto-generated push notification keys

## Coding Conventions

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Use descriptive variable names
- Handle errors gracefully with try/catch
- Log important events for debugging
- Keep functions small and focused

## Common Tasks

### Adding a new API endpoint
1. Add route in `src/server/routes/api.ts`
2. Add types in `src/types/index.ts` if needed
3. Implement service logic in appropriate service file

### Adding a new service
1. Create file in `src/server/services/`
2. Export functions or class
3. Import and use in routes or other services

### Modifying the UI
1. Update HTML in `src/client/index.html`
2. Add styles in `src/client/css/styles.css`
3. Add logic in `src/client/js/app.js`
4. Test on mobile viewport sizes

## Testing

- Test with `npm run dev` for development
- Use `devtunnel` to test remote access
- Check browser console for frontend errors
- Check terminal for server-side errors
