import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { loadConfig, getConfig } from './services/config.js';
import { initPush } from './services/push.js';
import { addClient, broadcast } from './services/websocket.js';
import { registerRoutes } from './routes/api.js';
import { recoverIncompleteRuns } from './services/orchestrator.js';
import { attachClient, detachClient, sendInput, resizePty, isSessionActive, stopAllSessions } from './services/pty-manager.js';
import type { WsPtyInputEvent, WsPtyResizeEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load configuration
  await loadConfig();
  const config = getConfig();

  // Initialize push notifications
  await initPush();

  // Create Fastify instance
  const app = Fastify({
    logger: true,
  });

  // Register WebSocket plugin
  await app.register(fastifyWebsocket);

  // Determine which client to serve
  const reactClientPath = join(__dirname, '../client');
  const clientPath = existsSync(reactClientPath) ? reactClientPath : new Error('Client build not found. Please build the client before starting the server.');
  
  if (clientPath instanceof Error) {
    console.error(clientPath.message);
    process.exit(1);
  }

  console.log(`📦 Serving client from: ${clientPath}`);

  // Register static file serving for client
  await app.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
  });

  // Register API routes
  await registerRoutes(app);

  // WebSocket endpoint for general events (logs, phases, etc.)
  app.get('/ws', { websocket: true }, (socket, req) => {
    addClient(socket);
  });

  // WebSocket endpoint for interactive PTY terminal
  app.get<{ Params: { sessionId: string } }>('/ws/terminal/:sessionId', { websocket: true }, (socket, req) => {
    const sessionId = req.params.sessionId;
    console.log(`[WS] Terminal connection for session ${sessionId}`);

    // Attach client to PTY session
    if (!isSessionActive(sessionId)) {
      console.log(`[WS] No active PTY session ${sessionId}, closing connection`);
      socket.close(4000, 'No active PTY session');
      return;
    }

    const attached = attachClient(sessionId, socket);
    if (!attached) {
      socket.close(4001, 'Failed to attach to PTY session');
      return;
    }

    // Handle incoming messages (user input, resize)
    socket.on('message', (message: Buffer | string) => {
      try {
        const messageStr = message.toString();

        // Limit message size to prevent DoS (64KB should be more than enough for input/resize)
        if (messageStr.length > 65536) {
          console.warn(`[WS] Dropping oversized message (${messageStr.length} bytes) for session ${sessionId}`);
          return;
        }

        const data = JSON.parse(messageStr);

        if (data.type === 'pty-input') {
          const inputEvent = data as WsPtyInputEvent;
          // Limit input data size (16KB max for a single input event)
          if (inputEvent.data && inputEvent.data.length <= 16384) {
            sendInput(sessionId, inputEvent.data);
          }
        } else if (data.type === 'pty-resize') {
          const resizeEvent = data as WsPtyResizeEvent;
          // Validate resize dimensions
          if (resizeEvent.cols > 0 && resizeEvent.cols <= 500 &&
              resizeEvent.rows > 0 && resizeEvent.rows <= 500) {
            resizePty(sessionId, resizeEvent.cols, resizeEvent.rows);
          }
        }
      } catch (error) {
        console.error(`[WS] Error processing terminal message:`, error);
      }
    });

    // Handle disconnect
    socket.on('close', () => {
      console.log(`[WS] Terminal connection closed for session ${sessionId}`);
      detachClient(sessionId, socket);
    });
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`\n🚀 Remote Agent server running at http://localhost:${config.port}`);
    console.log(`📁 Config directory: ~/.remote-agent/`);
    console.log(`\nTo expose to your phone, run: npm run tunnel`);

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      console.log(`\n⚠️ Received ${signal}, shutting down gracefully...`);

      // Stop all PTY sessions first
      stopAllSessions();

      // Close the server
      await app.close();
      console.log('👋 Server closed');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Recover incomplete runs after server starts
    console.log('\n🔄 Checking for incomplete runs...');
    recoverIncompleteRuns(broadcast).catch(err => {
      console.error('Error during run recovery:', err);
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
