import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfigDir, getWorkspace } from './config.js';
import type { Run, RunSummary, LogEntry, ValidationResult, ImageResult, RunPhase, SessionInfo } from '../types.js';

// Write lock to prevent concurrent file writes - uses promise chaining
const lockQueues: Map<string, Promise<void>> = new Map();

async function withWriteLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto existing lock
  const previousLock = lockQueues.get(runId) || Promise.resolve();
  
  let releaseLock: () => void;
  const currentLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  
  // Set our lock immediately (before awaiting) to prevent race
  lockQueues.set(runId, currentLock);
  
  try {
    // Wait for previous operation to complete
    await previousLock;
    // Now execute our operation
    return await fn();
  } finally {
    // Release our lock
    releaseLock!();
    // Cleanup if we're still the current lock
    if (lockQueues.get(runId) === currentLock) {
      lockQueues.delete(runId);
    }
  }
}

function getRunsDir(): string {
  return join(getConfigDir(), 'runs');
}

function getRunPath(runId: string): string {
  return join(getRunsDir(), `${runId}.json`);
}

export async function createRun(
  workspaceId: string,
  prompt: string,
  validationInstructions: string,
  imageInstructions: string,
  continueSession?: string
): Promise<Run> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const run: Run = {
    id: uuidv4(),
    workspaceId,
    workspacePath: workspace.path,
    prompt,
    validationInstructions,
    imageInstructions,
    status: 'pending',
    logs: [],
    validation: { status: 'pending', output: '' },
    images: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    continueSession,
  };

  await saveRun(run);
  return run;
}

export async function saveRun(run: Run): Promise<void> {
  run.updatedAt = new Date().toISOString();
  await writeFile(getRunPath(run.id), JSON.stringify(run, null, 2));
}

export async function getRun(runId: string): Promise<Run | null> {
  const path = getRunPath(runId);
  if (!existsSync(path)) {
    return null;
  }
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
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

export async function listRuns(): Promise<RunSummary[]> {
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
      const workspace = getWorkspace(run.workspaceId);
      
      runs.push({
        id: run.id,
        workspaceId: run.workspaceId,
        workspaceName: workspace?.name || run.workspaceId,
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

export async function updateSessionId(runId: string, sessionId: string): Promise<void> {
  await withWriteLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) return;
    
    run.sessionId = sessionId;
    await saveRun(run);
  });
}

export async function listSessions(workspaceId?: string): Promise<SessionInfo[]> {
  const runsDir = getRunsDir();
  if (!existsSync(runsDir)) {
    return [];
  }

  const files = await readdir(runsDir);
  const sessionsMap = new Map<string, SessionInfo>();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const content = await readFile(join(runsDir, file), 'utf-8');
      const run: Run = JSON.parse(content);
      
      // Only include runs with session IDs
      if (!run.sessionId) continue;
      
      // Filter by workspace if specified
      if (workspaceId && run.workspaceId !== workspaceId) continue;
      
      const workspace = getWorkspace(run.workspaceId);
      
      // Update or create session info (keep the latest)
      const existing = sessionsMap.get(run.sessionId);
      if (!existing || new Date(run.updatedAt) > new Date(existing.updatedAt)) {
        sessionsMap.set(run.sessionId, {
          id: run.sessionId,
          workspaceId: run.workspaceId,
          workspaceName: workspace?.name || run.workspaceId,
          lastPrompt: run.prompt.slice(0, 100) + (run.prompt.length > 100 ? '...' : ''),
          createdAt: existing?.createdAt || run.createdAt,
          updatedAt: run.updatedAt,
        });
      }
    } catch (error) {
      console.error(`Error reading run file ${file}:`, error);
    }
  }

  // Sort by updatedAt descending
  return Array.from(sessionsMap.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Get all incomplete runs (for startup recovery)
export async function getIncompleteRuns(): Promise<Run[]> {
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
