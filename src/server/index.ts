import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig } from './services/config.js';
import { initPush } from './services/push.js';
import { addClient, broadcast } from './services/websocket.js';
import { registerRoutes } from './routes/api.js';
import { recoverIncompleteRuns } from './services/orchestrator.js';

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

  // Register static file serving for client
  await app.register(fastifyStatic, {
    root: join(__dirname, '../client'),
    prefix: '/',
  });

  // Register API routes
  await registerRoutes(app);

  // WebSocket endpoint
  app.get('/ws', { websocket: true }, (socket, req) => {
    addClient(socket);
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`\n🚀 Remote Agent server running at http://localhost:${config.port}`);
    console.log(`📁 Config directory: ~/.remote-agent/`);
    console.log(`\nTo expose to your phone, run: npm run tunnel`);
    
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
