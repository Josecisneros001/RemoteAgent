import type { Config, Session, Run, GitChanges, CommitFile, AgentType, CliSessionsResponse, DeviceInfo, Machine } from '../types';

// ==================== Fetch Helpers ====================

/** Standard fetch options to prevent mobile browsers from caching API responses */
const NO_CACHE: RequestInit = { cache: 'no-store' };

/** Merge no-cache with additional fetch options */
function fetchOpts(opts?: RequestInit): RequestInit {
  return opts ? { ...NO_CACHE, ...opts } : NO_CACHE;
}

// ==================== Machine-Aware API Base ====================

let currentMachineId: string = 'local';

/**
 * Set the current machine ID for proxied API requests.
 * 'local' = direct requests to this hub, anything else = proxy via /proxy/:machineId
 */
export function setCurrentMachineId(id: string): void {
  currentMachineId = id;
}

export function getCurrentMachineId(): string {
  return currentMachineId;
}

/**
 * Get the API base URL for the current machine.
 * Returns '' for local (no prefix), '/proxy/:machineId' for remote machines.
 */
export function getApiBase(): string {
  if (currentMachineId === 'local') return '';
  return `/proxy/${currentMachineId}`;
}

/**
 * Get the WebSocket base path prefix for the current machine.
 * Returns '' for local, '/proxy/:machineId' for remote machines.
 */
export function getWsBase(): string {
  if (currentMachineId === 'local') return '';
  return `/proxy/${currentMachineId}`;
}

// ==================== Machine API (always local — no proxy prefix) ====================

export async function fetchMachines(): Promise<{ machines: Machine[] }> {
  const res = await fetch('/api/machines', NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch machines');
  return res.json();
}

export async function refreshMachinesApi(): Promise<{ machines: Machine[] }> {
  const res = await fetch('/api/machines/refresh', fetchOpts({ method: 'POST' }));
  if (!res.ok) throw new Error('Failed to refresh machines');
  return res.json();
}

// ==================== Config ====================

export async function fetchConfig(): Promise<Config> {
  const res = await fetch(`${getApiBase()}/api/config`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function fetchSessions(workspaceId?: string): Promise<{ sessions: Session[] }> {
  const url = workspaceId
    ? `${getApiBase()}/api/sessions?workspaceId=${workspaceId}`
    : `${getApiBase()}/api/sessions`;
  const res = await fetch(url, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function fetchSession(sessionId: string): Promise<{ session: Session; runs: Run[] }> {
  const res = await fetch(`${getApiBase()}/api/sessions/${sessionId}`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch session');
  return res.json();
}

export async function fetchRun(runId: string): Promise<{ run: Run }> {
  const res = await fetch(`${getApiBase()}/api/runs/${runId}`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch run');
  return res.json();
}

export async function fetchGitChanges(sessionId: string): Promise<{ changes: GitChanges }> {
  const res = await fetch(`${getApiBase()}/api/sessions/${sessionId}/git/changes`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch git changes');
  return res.json();
}

export async function fetchCommitFiles(runId: string): Promise<{ files: CommitFile[] }> {
  const res = await fetch(`${getApiBase()}/api/runs/${runId}/commit/files`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch commit files');
  return res.json();
}

export async function fetchCommitDiff(runId: string, filePath: string): Promise<{ diff: string }> {
  const res = await fetch(`${getApiBase()}/api/runs/${runId}/commit/diff?path=${encodeURIComponent(filePath)}`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch diff');
  return res.json();
}

// ==================== Interactive Session API ====================

export async function resumeSession(sessionId: string): Promise<{ sessionId: string; active: boolean }> {
  const res = await fetch(`${getApiBase()}/api/sessions/${sessionId}/resume`, fetchOpts({
    method: 'POST',
  }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}

export async function stopSession(sessionId: string): Promise<{ sessionId: string; stopped: boolean }> {
  const res = await fetch(`${getApiBase()}/api/sessions/${sessionId}/stop`, fetchOpts({
    method: 'POST',
  }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}

export async function getSessionStatus(sessionId: string): Promise<{ sessionId: string; active: boolean; interactive: boolean }> {
  const res = await fetch(`${getApiBase()}/api/sessions/${sessionId}/status`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch session status');
  return res.json();
}

// ==================== Session Creation ====================

export interface CreateSessionParams {
  workspaceId: string;
  prompt: string;
  agent?: AgentType;
}

export async function createSession(params: CreateSessionParams): Promise<{ sessionId: string; interactive?: boolean }> {
  const res = await fetch(`${getApiBase()}/api/sessions`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function abortRun(): Promise<void> {
  await fetch(`${getApiBase()}/api/run/abort`, fetchOpts({ method: 'POST' }));
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
  const res = await fetch(`${getApiBase()}/api/workspaces`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function cloneWorkspace(params: CloneWorkspaceParams): Promise<{ workspace: { id: string; path: string }; isGitRepo: boolean }> {
  const res = await fetch(`${getApiBase()}/api/workspaces/clone`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// Browse filesystem directories
export interface BrowseResult {
  current: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  isGitRepo: boolean;
}

export async function browseDirectory(path?: string): Promise<BrowseResult> {
  const url = path
    ? `${getApiBase()}/api/browse?path=${encodeURIComponent(path)}`
    : `${getApiBase()}/api/browse`;
  const res = await fetch(url, NO_CACHE);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function createFolder(parentPath: string, folderName: string): Promise<{ path: string; name: string }> {
  const res = await fetch(`${getApiBase()}/api/browse/create-folder`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, folderName }),
  }));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function fetchVapidKey(): Promise<{ publicKey: string }> {
  const res = await fetch(`${getApiBase()}/api/push/vapid-key`, NO_CACHE);
  return res.json();
}

export async function subscribePush(subscription: PushSubscriptionJSON, name?: string): Promise<{ success: boolean; device: { id: string; name: string; subscribedAt: string } }> {
  const res = await fetch(`${getApiBase()}/api/push/subscribe`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...subscription, name }),
  }));
  if (!res.ok) throw new Error('Failed to subscribe');
  return res.json();
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  await fetch(`${getApiBase()}/api/push/unsubscribe`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }));
}

export async function fetchDevices(): Promise<{ devices: DeviceInfo[] }> {
  const res = await fetch(`${getApiBase()}/api/push/devices`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch devices');
  return res.json();
}

export async function deleteDevice(id: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/push/devices/${id}`, fetchOpts({ method: 'DELETE' }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to delete device');
  }
}

export async function renameDevice(id: string, name: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/push/devices/${id}`, fetchOpts({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to rename device');
  }
}

export async function testDevice(id: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/push/devices/${id}/test`, fetchOpts({ method: 'POST' }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to send test notification');
  }
}

// ==================== CLI Session Discovery API ====================

export async function fetchCliSessions(limit: number = 15, offset: number = 0): Promise<CliSessionsResponse> {
  const res = await fetch(`${getApiBase()}/api/cli-sessions?limit=${limit}&offset=${offset}`, NO_CACHE);
  if (!res.ok) throw new Error('Failed to fetch CLI sessions');
  return res.json();
}

export async function refreshCliSessions(): Promise<CliSessionsResponse> {
  const res = await fetch(`${getApiBase()}/api/cli-sessions/refresh`, fetchOpts({
    method: 'POST',
  }));
  if (!res.ok) throw new Error('Failed to refresh CLI sessions');
  return res.json();
}

export async function resumeCliSession(req: {
  id: string;
  source: 'claude' | 'copilot';
  directory: string;
}): Promise<{ sessionId: string; workspaceId: string }> {
  const res = await fetch(`${getApiBase()}/api/cli-sessions/${req.id}/resume`, fetchOpts({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }));
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}
