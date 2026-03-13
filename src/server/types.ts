// Machine management types
export interface Machine {
  id: string;                    // Unique machine ID (hash of hostname + platform)
  name: string;                  // Display name (hostname)
  tunnelUrl: string;             // DevTunnel URL for remote access
  status: 'online' | 'offline';
  isLocal: boolean;              // True for the hub machine itself
  lastSeen: string;              // ISO 8601 timestamp
  machineInfo?: {
    hostname: string;
    platform: string;
    version: string;
  };
}

export interface IdentityResponse {
  app: 'remote-agent';
  version: string;
  hostname: string;
  platform: string;
  machineId: string;             // Stable hash of hostname + platform
}

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
  tunnelName?: string;            // Persistent devtunnel name (auto-generated if not set)
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
  workspacePath: string;         // Working directory (worktree path if using worktrees)
  originalRepoPath?: string;     // Original git repo path (if using worktrees)
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

export interface WsPtyAckEvent {
  type: 'pty-ack';
  sessionId: string;
  bytes: number;  // Number of bytes acknowledged by client
}

export interface WsMachinesUpdatedEvent {
  type: 'machines-updated';
}

export type WsEvent = WsLogEvent | WsPhaseEvent | WsValidationEvent | WsImageEvent | WsErrorEvent | WsCompleteEvent | WsPtyDataEvent | WsInteractionNeededEvent | WsPtyExitEvent | WsPtyAckEvent | WsMachinesUpdatedEvent;

// Push subscription
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// CLI Session Discovery types
export interface CliSession {
  id: string;                    // CLI session UUID
  source: 'claude' | 'copilot';
  directory: string;             // Decoded absolute path to project
  directoryName: string;         // Last path segment (e.g. "RemoteAgent")
  prettyName: string;            // First 30 chars of initial prompt
  fullPrompt: string;            // Full initial prompt (up to 200 chars)
  lastActive: string;            // ISO 8601 (file mtime or updated_at)
  createdAt: string | null;      // ISO 8601
  raSessionId: string | null;    // If tracked by RA, its session ID
  isActive: boolean;             // PTY currently running in RA
}

export interface CliSessionsResponse {
  sessions: CliSession[];
  total: number;                 // Total available (for "load more")
  cacheTimestamp: string;
}

export interface ResumeCliSessionRequest {
  id: string;                    // CLI session UUID
  source: 'claude' | 'copilot';
  directory: string;             // Working directory
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

export interface HookNotificationRequest {
  sessionId: string;        // Claude CLI session UUID
  notificationType: string; // e.g., 'permission_prompt', 'idle_prompt'
}

// Push notification device types
export interface DeviceSubscription {
  id: string;
  name: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  subscribedAt: string;  // ISO 8601
}

export interface DeviceInfo {
  id: string;
  name: string;
  subscribedAt: string;
}

export interface SubscribeRequest {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  name?: string;
}

export interface UnsubscribeRequest {
  endpoint: string;
}

export interface RenameDeviceRequest {
  name: string;
}
