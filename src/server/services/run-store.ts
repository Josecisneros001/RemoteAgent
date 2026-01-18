import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfigDir, getWorkspace } from './config.js';
import type { 
  Session, SessionSummary, 
  Run, RunSummary, LogEntry, ValidationResult, ImageResult, RunPhase, CommitInfo,
  AgentType
} from '../types.js';

// Write lock to prevent concurrent file writes - uses promise chaining
const lockQueues: Map<string, Promise<void>> = new Map();

async function withWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto existing lock
  const previousLock = lockQueues.get(id) || Promise.resolve();
  
  let releaseLock: () => void;
  const currentLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  
  // Set our lock immediately (before awaiting) to prevent race
  lockQueues.set(id, currentLock);
  
  try {
    // Wait for previous operation to complete
    await previousLock;
    // Now execute our operation
    return await fn();
  } finally {
    // Release our lock
    releaseLock!();
    // Cleanup if we're still the current lock
    if (lockQueues.get(id) === currentLock) {
      lockQueues.delete(id);
    }
  }
}

// Directory helpers
function getSessionsDir(): string {
  return join(getConfigDir(), 'sessions');
}

function getRunsDir(): string {
  return join(getConfigDir(), 'runs');
}

function getSessionPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.json`);
}

function getRunPath(runId: string): string {
  return join(getRunsDir(), `${runId}.json`);
}

// Ensure directories exist
async function ensureDirs(): Promise<void> {
  const sessionsDir = getSessionsDir();
  const runsDir = getRunsDir();
  if (!existsSync(sessionsDir)) {
    await mkdir(sessionsDir, { recursive: true });
  }
  if (!existsSync(runsDir)) {
    await mkdir(runsDir, { recursive: true });
  }
}

// Generate friendly name from prompt (first ~50 chars)
function generateFriendlyName(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 50) return cleaned;
  return cleaned.slice(0, 47) + '...';
}

// ==================== SESSION OPERATIONS ====================

export async function createSession(
  workspaceId: string,
  initialPrompt: string,
  branchName: string,
  options: {
    agent?: AgentType;
    validationPrompt?: string;
    outputPrompt?: string;
    model?: string;
    validationModel?: string;
    outputModel?: string;
    enabledMcps?: string[];
  } = {}
): Promise<Session> {
  await ensureDirs();
  
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const session: Session = {
    id: uuidv4(),
    agent: options.agent || 'copilot',
    workspaceId,
    workspacePath: workspace.path,
    friendlyName: generateFriendlyName(initialPrompt),
    branchName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultValidationPrompt: options.validationPrompt || workspace.validationPrompt,
    defaultOutputPrompt: options.outputPrompt || workspace.outputPrompt,
    defaultModel: options.model || workspace.defaultModel,
    validationModel: options.validationModel || workspace.validationModel,
    outputModel: options.outputModel || workspace.outputModel,
    enabledMcps: options.enabledMcps,
  };

  await saveSession(session);
  return session;
}

export async function saveSession(session: Session): Promise<void> {
  await ensureDirs();
  session.updatedAt = new Date().toISOString();
  await writeFile(getSessionPath(session.id), JSON.stringify(session, null, 2));
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const path = getSessionPath(sessionId);
  if (!existsSync(path)) {
    return null;
  }
  
  // Retry logic to handle race condition where file is being written
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (i === maxRetries - 1) {
        console.error(`Failed to parse session file after ${maxRetries} attempts:`, error);
        return null;
      }
      // Wait a bit before retrying (file might be mid-write)
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return null;
}

export async function updateSessionCopilotId(sessionId: string, copilotSessionId: string): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    
    session.copilotSessionId = copilotSessionId;
    await saveSession(session);
  });
}

export async function updateSessionValidationId(sessionId: string, validationSessionId: string): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    
    session.validationSessionId = validationSessionId;
    await saveSession(session);
  });
}

export async function updateSessionOutputId(sessionId: string, outputSessionId: string): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    
    session.outputSessionId = outputSessionId;
    await saveSession(session);
  });
}

export async function listSessions(workspaceId?: string): Promise<SessionSummary[]> {
  await ensureDirs();
  const sessionsDir = getSessionsDir();
  
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const files = await readdir(sessionsDir);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const content = await readFile(join(sessionsDir, file), 'utf-8');
      const session: Session = JSON.parse(content);
      
      // Filter by workspace if specified
      if (workspaceId && session.workspaceId !== workspaceId) continue;
      
      const workspace = getWorkspace(session.workspaceId);
      
      // Get runs for this session to count and find last status
      const runs = await getRunsForSession(session.id);
      const lastRun = runs[0]; // runs are sorted descending by createdAt
      
      summaries.push({
        id: session.id,
        agent: session.agent || 'copilot',
        friendlyName: session.friendlyName,
        branchName: session.branchName,
        workspaceId: session.workspaceId,
        workspaceName: workspace?.name || session.workspaceId,
        workspacePath: session.workspacePath,
        runCount: runs.length,
        lastRunStatus: lastRun?.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    } catch (error) {
      console.error(`Error reading session file ${file}:`, error);
    }
  }

  // Sort by updatedAt descending (most recent first)
  return summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// ==================== RUN OPERATIONS ====================

export async function createRun(
  sessionId: string,
  prompt: string,
  options: {
    validationPrompt?: string;
    outputPrompt?: string;
    model?: string;
    validationModel?: string;
    outputModel?: string;
    enabledMcps?: string[];
  } = {}
): Promise<Run> {
  await ensureDirs();
  
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const run: Run = {
    id: uuidv4(),
    sessionId,
    prompt,
    validationPrompt: options.validationPrompt,
    outputPrompt: options.outputPrompt,
    model: options.model,
    validationModel: options.validationModel,
    outputModel: options.outputModel,
    enabledMcps: options.enabledMcps,
    status: 'pending',
    logs: [],
    validation: { status: 'pending', output: '' },
    images: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveRun(run);
  
  // Update session's updatedAt
  await withWriteLock(sessionId, async () => {
    const sess = await getSession(sessionId);
    if (sess) {
      await saveSession(sess);
    }
  });
  
  return run;
}

export async function saveRun(run: Run): Promise<void> {
  await ensureDirs();
  run.updatedAt = new Date().toISOString();
  await writeFile(getRunPath(run.id), JSON.stringify(run, null, 2));
}

export async function getRun(runId: string): Promise<Run | null> {
  const path = getRunPath(runId);
  if (!existsSync(path)) {
    return null;
  }
  
  // Retry logic to handle race condition where file is being written
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (i === maxRetries - 1) {
        console.error(`Failed to parse run file after ${maxRetries} attempts:`, error);
        return null;
      }
      // Wait a bit before retrying (file might be mid-write)
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return null;
}

export async function appendLog(runId: string, entry: LogEntry): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    run.logs.push(entry);
    await saveRun(run);
  });
}

export async function updateRunPhase(runId: string, phase: RunPhase, error?: string): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    run.status = phase;
    if (error) {
      run.error = error;
    }
    await saveRun(run);
  });
}

export async function updateValidation(runId: string, validation: ValidationResult): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    run.validation = validation;
    await saveRun(run);
  });
}

export async function addImage(runId: string, image: ImageResult): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    // Avoid duplicates
    if (!run.images.some(i => i.filename === image.filename)) {
      run.images.push(image);
      await saveRun(run);
    }
  });
}

export async function updateRunCommit(runId: string, commitInfo: CommitInfo): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    run.commitInfo = commitInfo;
    await saveRun(run);
  });
}

export async function getRunsForSession(sessionId: string): Promise<Run[]> {
  await ensureDirs();
  const runsDir = getRunsDir();
  
  if (!existsSync(runsDir)) {
    return [];
  }

  const files = await readdir(runsDir);
  const runs: Run[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const content = await readFile(join(runsDir, file), 'utf-8');
      const run: Run = JSON.parse(content);
      
      if (run.sessionId === sessionId) {
        runs.push(run);
      }
    } catch (error) {
      console.error(`Error reading run file ${file}:`, error);
    }
  }

  // Sort by createdAt descending (most recent first)
  return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDirs();
  const runsDir = getRunsDir();
  
  if (!existsSync(runsDir)) {
    return [];
  }

  const files = await readdir(runsDir);
  const runs: RunSummary[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const content = await readFile(join(runsDir, file), 'utf-8');
      const run: Run = JSON.parse(content);
      
      runs.push({
        id: run.id,
        sessionId: run.sessionId,
        prompt: run.prompt.slice(0, 100) + (run.prompt.length > 100 ? '...' : ''),
        status: run.status,
        createdAt: run.createdAt,
      });
    } catch (error) {
      console.error(`Error reading run file ${file}:`, error);
    }
  }

  // Sort by createdAt descending
  return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getLatestRun(): Promise<Run | null> {
  const summaries = await listRuns();
  if (summaries.length === 0) return null;
  return getRun(summaries[0].id);
}

// Get all incomplete runs (for startup recovery)
export async function getIncompleteRuns(): Promise<Run[]> {
  await ensureDirs();
  const runsDir = getRunsDir();
  
  if (!existsSync(runsDir)) {
    return [];
  }

  const files = await readdir(runsDir);
  const incompleteRuns: Run[] = [];
  const incompleteStatuses = ['pending', 'prompt', 'validation', 'output'];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const content = await readFile(join(runsDir, file), 'utf-8');
      const run: Run = JSON.parse(content);
      
      if (incompleteStatuses.includes(run.status)) {
        incompleteRuns.push(run);
      }
    } catch (error) {
      console.error(`Error reading run file ${file}:`, error);
    }
  }

  // Sort by createdAt ascending (oldest first)
  return incompleteRuns.sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}
