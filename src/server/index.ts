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
import { getMachine, stopHealthMonitoring, getTunnelToken } from './services/machine-discovery.js';
import { pathExists } from './utils/fs.js';
import type { WsPtyInputEvent, WsPtyResizeEvent, WsPtyAckEvent } from './types.js';
import WebSocketClient from 'ws';

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

  // ==================== CACHE CONTROL ====================
  // Prevent browsers (especially mobile) from caching API responses.
  // This is critical for multi-machine switching: without it, mobile browsers
  // may serve stale session lists from a previously-selected machine.
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url.startsWith('/api/') || url.startsWith('/proxy/')) {
      reply.headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
    }
  });

  // Register API routes BEFORE static files to prevent route shadowing
  await registerRoutes(app);

  // Register static file serving for client
  await app.register(fastifyStatic, {
    root: reactClientPath,
    prefix: '/',
  });

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

  // WebSocket proxy endpoint for remote machines
  // Proxies WS connections: client ↔ hub ↔ remote machine
  app.get<{ Params: { machineId: string; '*': string } }>('/proxy/:machineId/ws/*', { websocket: true }, async (socket, req) => {
    const machineId = req.params.machineId;
    let wsPath = req.params['*'] || '';

    // Validate machineId format (defense-in-depth)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(machineId)) {
      socket.close(4007, 'Invalid machine ID');
      return;
    }

    // Decode percent-encoding before validation to prevent %2e%2e bypass
    try {
      wsPath = decodeURIComponent(wsPath);
    } catch {
      socket.close(4007, 'Invalid WebSocket path encoding');
      return;
    }

    // Validate path — reject traversal attempts
    if (wsPath.includes('..') || wsPath.includes('//')) {
      socket.close(4007, 'Invalid WebSocket path');
      return;
    }

    console.log(`[WS Proxy] Connection request for machine ${machineId}, path: /ws/${wsPath}`);

    const machine = await getMachine(machineId);
    if (!machine || machine.isLocal) {
      socket.close(4002, 'Machine not found or is local');
      return;
    }

    if (!machine.tunnelUrl) {
      socket.close(4003, 'Machine has no tunnel URL');
      return;
    }

    // Validate tunnel URL is a genuine devtunnel (defense-in-depth, matches HTTP proxy check)
    try {
      const parsed = new URL(machine.tunnelUrl);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.devtunnels.ms')) {
        socket.close(4006, 'Invalid tunnel URL');
        return;
      }
    } catch {
      socket.close(4006, 'Invalid tunnel URL');
      return;
    }

    // Convert tunnel URL from http(s) to ws(s)
    const tunnelWsUrl = machine.tunnelUrl.replace(/^http/, 'ws');
    const remoteUrl = `${tunnelWsUrl}/ws/${wsPath}`;

    console.log(`[WS Proxy] Connecting to remote: ${remoteUrl}`);

    let remoteWs: WebSocketClient;
    try {
      // Build WS headers with tunnel access token for auth
      const wsHeaders: Record<string, string> = {};
      if (machine.tunnelId) {
        const token = await getTunnelToken(machine.tunnelId);
        if (!token) {
          socket.close(4008, 'Unable to authenticate with remote tunnel');
          return;
        }
        wsHeaders['x-tunnel-authorization'] = `tunnel ${token}`;
      }

      remoteWs = new WebSocketClient(remoteUrl, {
        handshakeTimeout: 10_000,
        headers: wsHeaders,
      });
    } catch (err: any) {
      console.error(`[WS Proxy] Failed to create remote connection:`, err.message);
      socket.close(4004, 'Failed to connect to remote machine');
      return;
    }

    let clientClosed = false;
    let remoteClosed = false;
    let remoteReady = false;

    // Buffer client messages until the remote WebSocket is connected (bounded to prevent memory leak)
    const MAX_PENDING_MESSAGES = 100;
    const pendingClientMessages: (Buffer | string)[] = [];

    // Ping/pong keepalive (30s interval)
    const pingInterval = setInterval(() => {
      if (remoteWs.readyState === WebSocketClient.OPEN) {
        remoteWs.ping();
      }
    }, 30_000);

    // Remote → Client: forward messages
    remoteWs.on('message', (data: Buffer | string) => {
      if (socket.readyState === 1 /* WebSocket.OPEN — fastify uses raw socket */) {
        try {
          socket.send(data instanceof Buffer ? data : data.toString());
        } catch (err) {
          console.error('[WS Proxy] Error forwarding to client:', err);
        }
      }
    });

    // Client → Remote: forward messages (with buffering during connect)
    socket.on('message', (data: Buffer | string) => {
      if (remoteReady && remoteWs.readyState === WebSocketClient.OPEN) {
        try {
          remoteWs.send(data instanceof Buffer ? data : data.toString());
        } catch (err) {
          console.error('[WS Proxy] Error forwarding to remote:', err);
        }
      } else if (!remoteClosed) {
        // Buffer message until remote is connected (drop oldest if full)
        if (pendingClientMessages.length >= MAX_PENDING_MESSAGES) {
          pendingClientMessages.shift();
        }
        pendingClientMessages.push(data);
      }
    });

    // Handle remote connection open — flush buffered messages
    remoteWs.on('open', () => {
      console.log(`[WS Proxy] Connected to remote machine ${machine.name}`);
      remoteReady = true;

      // Flush any messages that arrived while connecting
      while (pendingClientMessages.length > 0) {
        const msg = pendingClientMessages.shift()!;
        try {
          remoteWs.send(msg instanceof Buffer ? msg : msg.toString());
        } catch (err) {
          console.error('[WS Proxy] Error flushing buffered message:', err);
          break;
        }
      }
    });

    // Handle remote connection errors
    remoteWs.on('error', (err) => {
      console.error(`[WS Proxy] Remote error for ${machine.name}:`, err.message);
      if (!clientClosed) {
        socket.close(4005, 'Remote machine disconnected');
      }
    });

    // Handle remote close → close client
    remoteWs.on('close', (code, reason) => {
      remoteClosed = true;
      clearInterval(pingInterval);
      console.log(`[WS Proxy] Remote closed: ${code} ${reason}`);
      if (!clientClosed) {
        socket.close(code ?? 4005, reason?.toString() || 'Remote disconnected');
      }
    });

    // Handle client close → close remote
    socket.on('close', () => {
      clientClosed = true;
      clearInterval(pingInterval);
      console.log(`[WS Proxy] Client closed for machine ${machineId}`);
      if (!remoteClosed && remoteWs.readyState === WebSocketClient.OPEN) {
        remoteWs.close();
      }
    });

    // Handle client errors
    socket.on('error', (err: Error) => {
      console.error(`[WS Proxy] Client error:`, err.message);
      if (!remoteClosed && remoteWs.readyState === WebSocketClient.OPEN) {
        remoteWs.close();
      }
    });
  });

  // Start server
  try {
    const port = parseInt(process.env.PORT || '') || config.port;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 Remote Agent server running at http://localhost:${port}`);
    console.log(`📁 Config directory: ~/.remote-agent/`);
    const tunnelCmd = process.platform === 'win32' ? 'npm run tunnel:win' : 'npm run tunnel';
    console.log(`\nTo expose to your phone, run: ${tunnelCmd}`);

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      console.log(`\n⚠️ Received ${signal}, shutting down gracefully...`);

      // Stop health monitoring for machine discovery
      stopHealthMonitoring();

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
