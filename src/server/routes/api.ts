import type { FastifyInstance } from 'fastify';
import { readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, getWorkspace, addWorkspace } from '../services/config.js';
import { listSessions, getSession, saveSession, listRuns, getRun, getLatestRun, getRunsForSession, createSession as createSessionStore, updateSessionCopilotId, updateSessionInteractive } from '../services/run-store.js';
import { addSubscription, getVapidPublicKey } from '../services/push.js';
import { broadcast } from '../services/websocket.js';
import { syncImagesForRun } from '../services/image-watcher.js';
import { getGitChanges, getAllDiffs, getFileDiff, cloneRepo, isGitRepo, isInsideGitRepo, initGitRepo, getCommitFiles, getCommitFileDiff, generateBranchName, createWorktree, getWorktreePath } from '../services/git.js';
import { startInteractiveSession, stopSession, isSessionActive, getActiveSessions } from '../services/pty-manager.js';
import { pathExists } from '../utils/fs.js';
import { discoverAll, invalidateCache } from '../services/session-discovery.js';
import type { CreateSessionRequest, PushSubscription, CloneWorkspaceRequest, ResumeCliSessionRequest } from '../types.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ==================== CONFIG ====================

  // Get config (workspace list — only returns workspaces with valid paths)
  app.get('/api/config', async () => {
    const config = getConfig();
    const validWorkspaces = [];
    for (const ws of config.workspaces) {
      if (await pathExists(ws.path)) {
        validWorkspaces.push(ws);
      }
    }
    return {
      workspaces: validWorkspaces,
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

  // Create new session (always interactive)
  app.post<{ Body: CreateSessionRequest }>('/api/sessions', async (request, reply) => {
    const { workspaceId, prompt, agent } = request.body;

    // Validate workspace
    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      return reply.status(400).send({ error: 'Invalid workspace' });
    }

    // Check if workspace path exists
    if (!(await pathExists(workspace.path))) {
      return reply.status(400).send({ error: 'Workspace path does not exist' });
    }

    const workspacePath = workspace.path;

    // Generate a CLI session UUID for Claude only (Copilot generates its own)
    const selectedAgent = agent || 'claude';
    const cliSessionId = selectedAgent === 'claude' ? uuidv4() : undefined;

    // Create session record — CLI tools manage their own git, no worktree needed
    const session = await createSessionStore(workspaceId, prompt, '', {
      agent: selectedAgent,
      interactive: true,
      copilotSessionId: cliSessionId,
      workspacePath,
    });

    // Start PTY session
    const ptySession = await startInteractiveSession(session, prompt, false);
    if (!ptySession) {
      return reply.status(500).send({ error: 'Failed to start interactive session' });
    }

    return { sessionId: session.id, interactive: true };
  });

  // ==================== CLI SESSION DISCOVERY ====================

  // List discovered CLI sessions — always rescans for fresh results
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/cli-sessions', async (request) => {
    const limit = parseInt(request.query.limit || '15', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    invalidateCache();
    return discoverAll(limit, offset);
  });

  // Force refresh CLI sessions (invalidate cache)
  app.post('/api/cli-sessions/refresh', async () => {
    invalidateCache();
    return discoverAll(0, 0);
  });

  // Resume a CLI session (create RA session record + auto-create workspace)
  app.post<{ Params: { id: string }; Body: ResumeCliSessionRequest }>('/api/cli-sessions/:id/resume', async (request, reply) => {
    const { id, source, directory } = request.body;
    const directoryName = directory.split(/[\\/]/).filter(Boolean).pop() || 'workspace';

    // 1. Find or auto-create workspace for this directory
    const config = getConfig();
    let workspace = config.workspaces.find(ws => ws.path === directory);

    if (!workspace) {
      // Auto-create workspace
      const newWorkspace = {
        id: uuidv4(),
        name: directoryName,
        path: directory,
      };
      await addWorkspace(newWorkspace);
      workspace = newWorkspace;
    }

    // 2. Check if an RA session already tracks this CLI session ID
    const existingSessions = await listSessions();
    for (const existing of existingSessions) {
      const fullSession = await getSession(existing.id);
      if (fullSession?.copilotSessionId === id) {
        // Already tracked - return the existing RA session
        invalidateCache();
        return { sessionId: fullSession.id, workspaceId: fullSession.workspaceId };
      }
    }

    // 3. Create a new RA session record
    const session = await createSessionStore(workspace.id, '', '', {
      agent: source,
      interactive: true,
      copilotSessionId: id, // CLI session UUID - used for --resume
      workspacePath: directory,
    });

    // Set the friendly name from the CLI session info
    // We need to discover the pretty name from the CLI session
    try {
      const discovered = await discoverAll(1000, 0);
      const cliSession = discovered.sessions.find(s => s.id === id);
      if (cliSession?.prettyName) {
        session.friendlyName = cliSession.prettyName;
        await saveSession(session);
      }
    } catch {
      // Non-critical, skip
    }

    invalidateCache();
    return { sessionId: session.id, workspaceId: workspace.id };
  });

  // ==================== INTERACTIVE SESSIONS (PTY) ====================

  // Resume an interactive session (start PTY and attach to existing session)
  app.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (request, reply) => {
    const sessionId = request.params.id;

    const session = await getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Check if already active
    if (isSessionActive(sessionId)) {
      return { sessionId, active: true, message: 'Session already active' };
    }

    // Ensure worktree exists if this is a git-backed session
    // For older sessions that don't have originalRepoPath, the worktree may not exist
    if (session.originalRepoPath && session.branchName) {
      try {
        const existingWorktree = await getWorktreePath(session.originalRepoPath, session.branchName);
        if (!existingWorktree) {
          try {
            // Recreate the worktree if it was removed
            const worktreePath = await createWorktree(session.originalRepoPath, session.branchName);
            console.log(`[Git] Recreated worktree at ${worktreePath} for session ${sessionId}`);
            // Update session with new worktree path if it changed
            if (worktreePath !== session.workspacePath) {
              session.workspacePath = worktreePath;
              await saveSession(session);
            }
          } catch (createError) {
            console.error(`[Git] Failed to create worktree for session ${sessionId}:`, createError);
            return reply.status(500).send({
              error: 'Failed to prepare workspace',
              details: createError instanceof Error ? createError.message : 'Unknown error'
            });
          }
        }
      } catch (error) {
        console.error(`[Git] Failed to check worktree for session ${sessionId}:`, error);
        return reply.status(500).send({
          error: 'Failed to check workspace',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Start PTY session in resume mode
    // PTY uses session.workspacePath which is already set to the worktree path
    let ptySession;
    try {
      ptySession = await startInteractiveSession(session, undefined, true);
    } catch (err) {
      console.error(`[API] PTY start failed for session ${sessionId}:`, err);
      return reply.status(500).send({
        error: 'Failed to resume interactive session',
        details: err instanceof Error ? err.message : String(err),
      });
    }
    if (!ptySession) {
      return reply.status(500).send({ error: 'Failed to resume interactive session (returned null)' });
    }

    // Mark session as interactive
    await updateSessionInteractive(sessionId, true);

    return { sessionId, active: true };
  });

  // Stop an interactive session
  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (request, reply) => {
    const sessionId = request.params.id;
    
    const stopped = stopSession(sessionId);
    if (!stopped) {
      return reply.status(404).send({ error: 'No active PTY session found' });
    }

    return { sessionId, stopped: true };
  });

  // Get interactive session status
  app.get<{ Params: { id: string } }>('/api/sessions/:id/status', async (request, reply) => {
    const sessionId = request.params.id;
    
    const session = await getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return {
      sessionId,
      active: isSessionActive(sessionId),
      interactive: session.interactive || false,
    };
  });

  // List all active PTY sessions
  app.get('/api/sessions/active', async () => {
    const activeSessions = getActiveSessions();
    return { sessions: activeSessions };
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

  // ==================== FILESYSTEM BROWSING ====================

  // Browse filesystem directories
  app.get<{ Querystring: { path?: string } }>('/api/browse', async (request, reply) => {
    const { readdir, stat } = await import('fs/promises');
    const { homedir } = await import('os');
    const path = await import('path');
    
    // Use config.defaultBrowsePath, or /workspace in Docker mode, or fall back to home directory
    const config = getConfig();
    const isDocker = process.env.DOCKER_MODE === 'true';
    const defaultPath = config.defaultBrowsePath || (isDocker ? '/workspace' : homedir());
    const browsePath = request.query.path || defaultPath;
    
    try {
      const stats = await stat(browsePath);
      if (!stats.isDirectory()) {
        return reply.status(400).send({ error: 'Path is not a directory' });
      }
      
      const entries = await readdir(browsePath, { withFileTypes: true });
      const directories = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({
          name: entry.name,
          path: path.join(browsePath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      const parent = path.dirname(browsePath);
      
      return {
        current: browsePath,
        parent: parent !== browsePath ? parent : null,
        directories,
        isGitRepo: await isGitRepo(browsePath),
      };
    } catch (error) {
      return reply.status(400).send({ 
        error: `Cannot browse path: ${error instanceof Error ? error.message : 'Unknown error'}` 
      });
    }
  });

  // Create a new folder
  app.post<{ Body: { parentPath: string; folderName: string } }>('/api/browse/create-folder', async (request, reply) => {
    const { mkdir } = await import('fs/promises');
    const path = await import('path');
    
    const { parentPath, folderName } = request.body;
    
    if (!parentPath || !folderName) {
      return reply.status(400).send({ error: 'parentPath and folderName are required' });
    }
    
    // Sanitize folder name - remove dangerous characters
    const safeFolderName = folderName.replace(/[/\\:*?"<>|]/g, '').trim();
    if (!safeFolderName) {
      return reply.status(400).send({ error: 'Invalid folder name' });
    }
    
    const newPath = path.join(parentPath, safeFolderName);
    
    try {
      await mkdir(newPath, { recursive: false });
      return { path: newPath, name: safeFolderName };
    } catch (error) {
      return reply.status(400).send({ 
        error: `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}` 
      });
    }
  });

  // ==================== WORKSPACES ====================

  // Add a local workspace (optionally create folder and init git)
  app.post('/api/workspaces', async (request, reply) => {
    const {
      name, path,
      createFolder, initGit
    } = request.body as {
      name: string;
      path: string;
      createFolder?: boolean;
      initGit?: boolean;
    };

    if (!name || !path) {
      return reply.status(400).send({ error: 'name and path are required' });
    }

    // Check if workspace already exists in config
    const existingWorkspace = getWorkspace(path);
    if (existingWorkspace) {
      return reply.status(400).send({ error: 'Workspace already exists' });
    }

    // Handle folder creation/existence
    if (!(await pathExists(path))) {
      // Auto-create directory if it doesn't exist
      try {
        await mkdir(path, { recursive: true });

        // Initialize git repository in newly created folder
        await initGitRepo(path);
      } catch (error) {
        return reply.status(500).send({
          error: `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    } else if (createFolder) {
      // User explicitly asked to create a new folder but it already exists
      return reply.status(400).send({ error: 'Path already exists' });
    } else {
      // Existing folder - optionally init git if requested
      if (initGit) {
        const insideGit = await isInsideGitRepo(path);
        if (!insideGit) {
          await initGitRepo(path);
        }
      }
    }

    const workspace = {
      id: uuidv4(),
      name,
      path,
    };
    await addWorkspace(workspace);

    // Check git status for the response
    const isRepo = await isGitRepo(path);

    return { workspace, isGitRepo: isRepo };
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

    if (await pathExists(workspacePath)) {
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

      return { workspace, isGitRepo: true };
    } catch (error) {
      return reply.status(500).send({
        error: `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  });

  // ==================== COMMIT DETAILS ====================
  
  // Get files changed in a commit
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/commit/files', async (request, reply) => {
    const run = await getRun(request.params.runId);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    
    if (!run.commitInfo?.hash) {
      return reply.status(404).send({ error: 'No commit for this run' });
    }
    
    const session = await getSession(run.sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    
    const files = await getCommitFiles(session.workspacePath, run.commitInfo.hash);
    return { files };
  });

  // Get diff for a specific file in a commit
  app.get<{ Params: { runId: string }; Querystring: { path: string } }>(
    '/api/runs/:runId/commit/diff',
    async (request, reply) => {
      const run = await getRun(request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Run not found' });
      }
      
      if (!run.commitInfo?.hash) {
        return reply.status(404).send({ error: 'No commit for this run' });
      }
      
      const { path: filePath } = request.query;
      if (!filePath) {
        return reply.status(400).send({ error: 'path query parameter required' });
      }
      
      const session = await getSession(run.sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      
      const diff = await getCommitFileDiff(session.workspacePath, run.commitInfo.hash, filePath);
      return { diff };
    }
  );

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
      if (!image || !(await pathExists(image.path))) {
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
