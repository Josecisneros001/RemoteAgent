import type { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, getWorkspace, addWorkspace } from '../services/config.js';
import { listSessions, getSession, listRuns, getRun, getLatestRun, getRunsForSession } from '../services/run-store.js';
import { startNewSession, continueSession, abortCurrentRun, getCurrentRunId, getCurrentSessionId } from '../services/orchestrator.js';
import { addSubscription, getVapidPublicKey } from '../services/push.js';
import { broadcast } from '../services/websocket.js';
import { syncImagesForRun } from '../services/image-watcher.js';
import { getGitChanges, getAllDiffs, getFileDiff, cloneRepo, isGitRepo } from '../services/git.js';
import type { CreateSessionRequest, StartRunRequest, PushSubscription, CloneWorkspaceRequest } from '../types.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ==================== CONFIG ====================
  
  // Get config (workspace list, models, mcps)
  app.get('/api/config', async () => {
    const config = getConfig();
    return {
      workspaces: config.workspaces,
      mcps: config.mcps,
      availableModels: config.availableModels,
      defaultModel: config.defaultModel,
      defaultValidationModel: config.defaultValidationModel,
      defaultOutputModel: config.defaultOutputModel,
    };
  });

  // ==================== PUSH NOTIFICATIONS ====================
  
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

  // ==================== SESSIONS ====================
  
  // List all sessions
  app.get<{ Querystring: { workspaceId?: string } }>('/api/sessions', async (request) => {
    const { workspaceId } = request.query;
    const sessions = await listSessions(workspaceId);
    return { sessions };
  });

  // Get specific session with its runs
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    
    const runs = await getRunsForSession(session.id);
    return { session, runs };
  });

  // Create new session and start first run
  app.post<{ Body: CreateSessionRequest }>('/api/sessions', async (request, reply) => {
    const { workspaceId, prompt, validationPrompt, outputPrompt, model, enabledMcps } = request.body;

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

    // Start new session with first run
    const { session, run } = await startNewSession(
      workspaceId,
      prompt,
      { validationPrompt, outputPrompt, model, enabledMcps },
      broadcast
    );

    return { sessionId: session.id, runId: run.id };
  });

  // Add a new run to existing session
  app.post<{ Params: { id: string }; Body: StartRunRequest }>('/api/sessions/:id/runs', async (request, reply) => {
    const sessionId = request.params.id;
    const { prompt, validationPrompt, outputPrompt, model, enabledMcps } = request.body;

    const session = await getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Check if a run is already in progress
    if (getCurrentRunId()) {
      return reply.status(409).send({ error: 'A run is already in progress' });
    }

    // Continue session with new run
    const run = await continueSession(
      sessionId,
      prompt,
      { validationPrompt, outputPrompt, model, enabledMcps },
      broadcast
    );

    return { runId: run.id };
  });

  // ==================== RUNS ====================
  
  // List all runs
  app.get('/api/runs', async () => {
    const runs = await listRuns();
    return { runs };
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
    const session = await getSession(run.sessionId);
    if (session && (run.status === 'completed' || run.status === 'output')) {
      await syncImagesForRun(session.workspacePath, run.id);
      // Re-fetch to get updated images
      const updatedRun = await getRun(request.params.id);
      return { run: updatedRun || run };
    }
    
    return { run };
  });

  // Abort current run
  app.post('/api/run/abort', async () => {
    const aborted = abortCurrentRun();
    return { aborted };
  });

  // Get current run status
  app.get('/api/run/current', async () => {
    const runId = getCurrentRunId();
    const sessionId = getCurrentSessionId();
    if (!runId) {
      return { run: null, session: null };
    }
    const run = await getRun(runId);
    const session = sessionId ? await getSession(sessionId) : null;
    return { run, session };
  });

  // ==================== GIT ====================
  
  // Get git changes for a workspace/session
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/git/changes', async (request, reply) => {
    const session = await getSession(request.params.sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    
    const changes = await getGitChanges(session.workspacePath);
    return { changes };
  });

  // Get git diffs for a workspace/session
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/git/diffs', async (request, reply) => {
    const session = await getSession(request.params.sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    
    const diffs = await getAllDiffs(session.workspacePath);
    return { diffs };
  });

  // Get specific file diff
  app.get<{ Params: { sessionId: string }; Querystring: { path: string; staged?: string } }>(
    '/api/sessions/:sessionId/git/diff',
    async (request, reply) => {
      const session = await getSession(request.params.sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      
      const { path, staged } = request.query;
      if (!path) {
        return reply.status(400).send({ error: 'Path is required' });
      }
      
      const diff = await getFileDiff(session.workspacePath, path, staged === 'true');
      return { diff };
    }
  );

  // ==================== WORKSPACES ====================

  // Add a local workspace
  app.post('/api/workspaces', async (request, reply) => {
    const { name, path, validationPrompt, outputPrompt, defaultModel, validationModel, outputModel } = request.body as {
      name: string;
      path: string;
      validationPrompt?: string;
      outputPrompt?: string;
      defaultModel?: string;
      validationModel?: string;
      outputModel?: string;
    };

    if (!name || !path) {
      return reply.status(400).send({ error: 'name and path are required' });
    }

    // Check if path exists
    if (!existsSync(path)) {
      return reply.status(400).send({ error: 'Path does not exist' });
    }

    // Check if workspace already exists
    const existingWorkspace = getWorkspace(path);
    if (existingWorkspace) {
      return reply.status(400).send({ error: 'Workspace already exists' });
    }

    const workspace = {
      id: uuidv4(),
      name,
      path,
      validationPrompt,
      outputPrompt,
      defaultModel,
      validationModel,
      outputModel,
    };
    await addWorkspace(workspace);

    return { workspace };
  });
  
  // Clone a new workspace
  app.post<{ Body: CloneWorkspaceRequest }>('/api/workspaces/clone', async (request, reply) => {
    const { gitUrl, name, targetPath } = request.body;
    
    if (!gitUrl || !name) {
      return reply.status(400).send({ error: 'gitUrl and name are required' });
    }
    
    // Default target path
    const basePath = targetPath || join(process.env.HOME || '/tmp', 'remote-agent-workspaces');
    const workspacePath = join(basePath, name.toLowerCase().replace(/\s+/g, '-'));
    
    if (existsSync(workspacePath)) {
      return reply.status(400).send({ error: 'Workspace path already exists' });
    }
    
    try {
      await cloneRepo(gitUrl, workspacePath);
      
      // Add to config
      const workspace = {
        id: uuidv4(),
        name,
        path: workspacePath,
        gitRepo: gitUrl,
      };
      await addWorkspace(workspace);
      
      return { workspace };
    } catch (error) {
      return reply.status(500).send({ 
        error: `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}` 
      });
    }
  });

  // ==================== IMAGES ====================
  
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
