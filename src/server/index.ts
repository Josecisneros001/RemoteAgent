import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig } from './services/config.js';
import { initPush } from './services/push.js';
import { addClient } from './services/websocket.js';
import { registerRoutes } from './routes/api.js';
import { attachClient, detachClient, sendInput, resizePty, isSessionActive, stopAllSessions, handleClientAck } from './services/pty-manager.js';
import { pathExists } from './utils/fs.js';
import type { WsPtyInputEvent, WsPtyResizeEvent, WsPtyAckEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load configuration
  await loadConfig();
  const config = getConfig();

  // Initialize push notifications
  await initPush();

  // Create Fastify instance
  const app = Fastify({
    logger: false,
  });

  // Register WebSocket plugin with per-message deflate compression
  // Terminal output (ANSI codes, whitespace) compresses extremely well (60-70% reduction)
  await app.register(fastifyWebsocket, {
    options: {
      perMessageDeflate: {
        zlibDeflateOptions: {
          level: 3,  // Compression level 1-9 (3 is good balance of speed/ratio)
          chunkSize: 1024,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
        // Disable context takeover for better memory usage with many connections
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        // Only compress messages larger than this threshold.
        // Lowered from 1KB to 512B because:
        // - Batched PTY output often falls in 512-1024 byte range during moderate activity
        // - Terminal output (ANSI codes, whitespace) compresses 60-70%, so 512B → ~200B
        // - Even with ~50B compression overhead, net savings is ~260B per message
        // - Mobile connections (primary use case) benefit most from bandwidth reduction
        threshold: 512,
      },
    },
  });

  // Determine which client to serve
  const reactClientPath = join(__dirname, '../client');
  const clientExists = await pathExists(reactClientPath);

  if (!clientExists) {
    console.error('Client build not found. Please build the client before starting the server.');
    process.exit(1);
  }

  console.log(`📦 Serving client from: ${reactClientPath}`);

  // Register static file serving for client
  await app.register(fastifyStatic, {
    root: reactClientPath,
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
        } else if (data.type === 'pty-ack') {
          const ackEvent = data as WsPtyAckEvent;
          // Validate ACK bytes (must be positive and reasonable)
          if (ackEvent.bytes > 0 && ackEvent.bytes <= 1000000) {
            handleClientAck(sessionId, socket, ackEvent.bytes);
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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
