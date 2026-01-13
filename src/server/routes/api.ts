import type { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { getConfig, getWorkspace } from '../services/config.js';
import { listRuns, getRun, getLatestRun, listSessions } from '../services/run-store.js';
import { startRun, abortCurrentRun, getCurrentRunId } from '../services/orchestrator.js';
import { addSubscription, getVapidPublicKey } from '../services/push.js';
import { broadcast } from '../services/websocket.js';
import { syncImagesForRun } from '../services/image-watcher.js';
import type { StartRunRequest, PushSubscription } from '../types.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Get config (workspace list)
  app.get('/api/config', async () => {
    const config = getConfig();
    return {
      workspaces: config.workspaces,
      model: config.model,
    };
  });

  // Get VAPID public key for push notifications
  app.get('/api/push/vapid-key', async () => {
    return { publicKey: getVapidPublicKey() };
  });

  // Subscribe to push notifications
  app.post<{ Body: PushSubscription }>('/api/push/subscribe', async (request, reply) => {
    const subscription = request.body;
    await addSubscription(subscription);
    return { success: true };
  });

  // List all runs
  app.get('/api/runs', async () => {
    const runs = await listRuns();
    return { runs };
  });

  // List sessions (for session continuation)
  app.get<{ Querystring: { workspaceId?: string } }>('/api/sessions', async (request) => {
    const { workspaceId } = request.query;
    const sessions = await listSessions(workspaceId);
    return { sessions };
  });

  // Get latest run
  app.get('/api/runs/latest', async () => {
    const run = await getLatestRun();
    return { run };
  });

  // Get specific run
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = await getRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    
    // Sync images from outputs folder (in case they were missed by watcher)
    if (run.status === 'completed' || run.status === 'output') {
      await syncImagesForRun(run.workspacePath, run.id);
      // Re-fetch to get updated images
      const updatedRun = await getRun(request.params.id);
      return { run: updatedRun || run };
    }
    
    return { run };
  });

  // Start a new run
  app.post<{ Body: StartRunRequest }>('/api/run', async (request, reply) => {
    const { workspaceId, prompt, validationInstructions, imageInstructions, continueSession } = request.body;

    // Validate workspace
    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      return reply.status(400).send({ error: 'Invalid workspace' });
    }

    // Check if workspace path exists
    if (!existsSync(workspace.path)) {
      return reply.status(400).send({ error: 'Workspace path does not exist' });
    }

    // Check if a run is already in progress
    if (getCurrentRunId()) {
      return reply.status(409).send({ error: 'A run is already in progress' });
    }

    // Start the run
    const run = await startRun(
      workspaceId,
      prompt,
      validationInstructions || '',
      imageInstructions || '',
      broadcast,
      continueSession
    );

    return { runId: run.id };
  });

  // Abort current run
  app.post('/api/run/abort', async () => {
    const aborted = abortCurrentRun();
    return { aborted };
  });

  // Get current run status
  app.get('/api/run/current', async () => {
    const runId = getCurrentRunId();
    if (!runId) {
      return { run: null };
    }
    const run = await getRun(runId);
    return { run };
  });

  // Serve images
  app.get<{ Params: { runId: string; filename: string } }>(
    '/api/images/:runId/:filename',
    async (request, reply) => {
      const { runId, filename } = request.params;
      const run = await getRun(runId);
      
      if (!run) {
        return reply.status(404).send({ error: 'Run not found' });
      }

      const image = run.images.find(i => i.filename === filename);
      if (!image || !existsSync(image.path)) {
        return reply.status(404).send({ error: 'Image not found' });
      }

      const content = await readFile(image.path);
      const ext = filename.toLowerCase().split('.').pop();
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
      };

      return reply
        .header('Content-Type', mimeTypes[ext || 'png'] || 'application/octet-stream')
        .send(content);
    }
  );
}
