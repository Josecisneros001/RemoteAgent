// API Types
export type AgentType = 'copilot' | 'claude';

export interface Config {
  workspaces: WorkspaceConfig[];
  port: number;
  vapidPublicKey?: string;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  gitRepo?: string;
}

export interface Session {
  id: string;
  agent: AgentType;
  friendlyName: string;
  workspaceId: string;
  branchName?: string;
  createdAt: string;
  runCount: number;
  lastRunStatus?: RunStatus;
  interactive?: boolean;  // Interactive PTY terminal mode
}

export interface Run {
  id: string;
  sessionId: string;
  prompt: string;
  status: RunStatus;
  logs: LogEntry[];
  validation: ValidationResult;
  images: ImageInfo[];
  commitInfo?: CommitInfo;
  createdAt: string;
  completedAt?: string;
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export interface LogEntry {
  type: 'stdout' | 'stderr' | 'system';
  content: string;
  phase: 'prompt' | 'validation' | 'output';
  timestamp: string;
}

export interface ValidationResult {
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  message?: string;
}

export interface ImageInfo {
  filename: string;
  path: string;
  timestamp: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  timestamp: string;
}

export interface GitChanges {
  branch: string;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
}

export interface GitFile {
  path: string;
  status: string;
}

export interface CommitFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

// WebSocket Event Types
export interface WsEvent {
  type: 'log' | 'phase' | 'validation' | 'image' | 'complete' | 'pty-data' | 'interaction-needed' | 'pty-exit';
  sessionId: string;
  runId?: string;
  phase?: 'prompt' | 'validation' | 'output';
  content?: string;
  logType?: 'stdout' | 'stderr' | 'system';
  // PTY-specific fields
  data?: string;      // Raw terminal data for pty-data
  reason?: string;    // Reason for interaction-needed
  exitCode?: number;  // Exit code for pty-exit
}

// View States
export type ViewType = 'welcome' | 'new-session' | 'session';
export type RunViewType = 'new-run' | 'run-detail' | 'empty';
export type RunTabType = 'run' | 'commits';
