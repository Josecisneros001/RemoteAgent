// Configuration types
export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  gitRepo?: string;              // Git URL for cloning new workspaces
}

export interface Config {
  workspaces: WorkspaceConfig[];
  defaultBrowsePath?: string;     // Default path for workspace browser
  port: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidEmail?: string;
}

// Agent types - which CLI to use
export type AgentType = 'copilot' | 'claude';

// Session types - main concept now
export interface Session {
  id: string;                    // Our internal session ID (UUID)
  agent: AgentType;              // Which CLI agent owns this session
  copilotSessionId?: string;     // CLI session ID (works for both agents)
  workspaceId: string;
  workspacePath: string;
  friendlyName: string;          // First ~50 chars of initial prompt
  branchName: string;            // Git branch for this session
  createdAt: string;
  updatedAt: string;
  interactive?: boolean;          // Interactive terminal mode (PTY)
}

// Run (iteration) types - kept for backwards compatibility with stored data
export type RunPhase = 'pending' | 'prompt' | 'validation' | 'output' | 'completed' | 'failed';

export interface LogEntry {
  timestamp: string;
  phase: RunPhase;
  type: 'stdout' | 'stderr' | 'system';
  content: string;
}

export interface ValidationResult {
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  output: string;
  timestamp?: string;
}

export interface ImageResult {
  filename: string;
  path: string;
  timestamp: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  branch: string;
  timestamp: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface Run {
  id: string;
  sessionId: string;            // Links to parent session
  prompt: string;
  status: RunPhase;
  logs: LogEntry[];
  validation: ValidationResult;
  images: ImageResult[];
  commitInfo?: CommitInfo;      // Git commit info for this run
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SessionSummary {
  id: string;
  agent: AgentType;
  friendlyName: string;
  branchName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runCount: number;
  lastRunStatus?: RunPhase;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  sessionId: string;
  prompt: string;
  status: RunPhase;
  createdAt: string;
}

// Git changes
export interface GitFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  insertions?: number;
  deletions?: number;
}

export interface GitChanges {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

export interface FileDiff {
  path: string;
  diff: string;
}

// WebSocket event types
export interface WsLogEvent {
  type: 'log';
  runId: string;
  sessionId: string;
  entry: LogEntry;
}

export interface WsPhaseEvent {
  type: 'phase';
  runId: string;
  sessionId: string;
  phase: RunPhase;
}

export interface WsValidationEvent {
  type: 'validation';
  runId: string;
  sessionId: string;
  validation: ValidationResult;
}

export interface WsImageEvent {
  type: 'image';
  runId: string;
  sessionId: string;
  image: ImageResult;
}

export interface WsErrorEvent {
  type: 'error';
  runId: string;
  sessionId: string;
  error: string;
}

export interface WsCompleteEvent {
  type: 'complete';
  runId: string;
  sessionId: string;
  status: 'completed' | 'failed';
}

// PTY (Interactive Terminal) WebSocket events
export interface WsPtyDataEvent {
  type: 'pty-data';
  sessionId: string;
  data: string;  // Raw terminal output
}

export interface WsPtyInputEvent {
  type: 'pty-input';
  sessionId: string;
  data: string;  // User keystroke(s)
}

export interface WsPtyResizeEvent {
  type: 'pty-resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface WsInteractionNeededEvent {
  type: 'interaction-needed';
  sessionId: string;
  reason: string;  // e.g., "permission prompt", "confirmation needed"
}

export interface WsPtyExitEvent {
  type: 'pty-exit';
  sessionId: string;
  exitCode: number;
}

export type WsEvent = WsLogEvent | WsPhaseEvent | WsValidationEvent | WsImageEvent | WsErrorEvent | WsCompleteEvent | WsPtyDataEvent | WsInteractionNeededEvent | WsPtyExitEvent;

// Push subscription
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// API request types
export interface CreateSessionRequest {
  workspaceId: string;
  prompt: string;
  agent?: AgentType;
}

export interface CloneWorkspaceRequest {
  gitUrl: string;
  name: string;
  targetPath?: string;
}
