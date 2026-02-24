# RemoteAgent Client

React 19 + TypeScript frontend for RemoteAgent, built with Vite.

This is the browser-based UI that provides the interactive terminal, session management, and push notifications.

## Development

From the repository root:

```bash
# Run client dev server with hot reload
npm run dev:client

# Or run both server and client together
npm run watch
```

The client dev server runs on port 5173 and proxies API/WebSocket requests to the backend on port 3000.

## Key Components

- **InteractiveTerminal** - xterm.js-based terminal connected to the server PTY via WebSocket
- **SessionList** - View and manage coding sessions across workspaces
- **NewSessionForm** - Create new sessions with workspace, agent, and prompt selection
- **CommitsTab** - View git changes made during a session
- **Sidebar / MobileHeader** - Responsive navigation for desktop and mobile
