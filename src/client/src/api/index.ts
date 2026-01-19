import type { Config, Session, Run, GitChanges, CommitFile, AgentType } from '../types';

const API_BASE = '';

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function fetchSessions(workspaceId?: string): Promise<{ sessions: Session[] }> {
  const url = workspaceId 
    ? `${API_BASE}/api/sessions?workspaceId=${workspaceId}` 
    : `${API_BASE}/api/sessions`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function fetchSession(sessionId: string): Promise<{ session: Session; runs: Run[] }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error('Failed to fetch session');
  return res.json();
}

export async function fetchRun(runId: string): Promise<{ run: Run }> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`);
  if (!res.ok) throw new Error('Failed to fetch run');
  return res.json();
}

export async function fetchGitChanges(sessionId: string): Promise<{ changes: GitChanges }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/git/changes`);
  if (!res.ok) throw new Error('Failed to fetch git changes');
  return res.json();
}

export async function fetchCommitFiles(runId: string): Promise<{ files: CommitFile[] }> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/commit/files`);
  if (!res.ok) throw new Error('Failed to fetch commit files');
  return res.json();
}

export async function fetchCommitDiff(runId: string, filePath: string): Promise<{ diff: string }> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}/commit/diff?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error('Failed to fetch diff');
  return res.json();
}

// ==================== Interactive Session API ====================

export async function resumeSession(sessionId: string): Promise<{ sessionId: string; active: boolean }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/resume`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}

export async function stopSession(sessionId: string): Promise<{ sessionId: string; stopped: boolean }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}

export async function getSessionStatus(sessionId: string): Promise<{ sessionId: string; active: boolean; interactive: boolean }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/status`);
  if (!res.ok) throw new Error('Failed to fetch session status');
  return res.json();
}

// ==================== Session/Run Creation ====================

export interface CreateSessionParams {
  workspaceId: string;
  prompt: string;
  agent?: AgentType;
  validationPrompt?: string;
  outputPrompt?: string;
  model?: string;
  validationModel?: string;
  outputModel?: string;
  interactive?: boolean;
}

export async function createSession(params: CreateSessionParams): Promise<{ sessionId: string; runId?: string; interactive?: boolean }> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export interface CreateRunParams {
  sessionId: string;
  prompt: string;
  validationPrompt?: string;
  outputPrompt?: string;
  model?: string;
  validationModel?: string;
  outputModel?: string;
}

export async function createRun(params: CreateRunParams): Promise<{ runId: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${params.sessionId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function abortRun(): Promise<void> {
  await fetch(`${API_BASE}/api/run/abort`, { method: 'POST' });
}

export interface AddWorkspaceParams {
  name: string;
  path: string;
  createFolder?: boolean;
  initGit?: boolean;
  validationPrompt?: string;
  outputPrompt?: string;
  defaultModel?: string;
  validationModel?: string;
  outputModel?: string;
}

export interface CloneWorkspaceParams {
  gitUrl: string;
  name: string;
  targetPath?: string;
  validationPrompt?: string;
  outputPrompt?: string;
  defaultModel?: string;
  validationModel?: string;
  outputModel?: string;
}

export async function addWorkspace(params: AddWorkspaceParams): Promise<{ workspace: { id: string; path: string }; isGitRepo: boolean }> {
  const res = await fetch(`${API_BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function cloneWorkspace(params: CloneWorkspaceParams): Promise<{ workspace: { id: string; path: string }; isGitRepo: boolean }> {
  const res = await fetch(`${API_BASE}/api/workspaces/clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function fetchVapidKey(): Promise<{ publicKey: string }> {
  const res = await fetch(`${API_BASE}/api/push/vapid-key`);
  return res.json();
}

export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  await fetch(`${API_BASE}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
}
