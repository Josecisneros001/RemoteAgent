// Configuration types
export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  validationPrompt?: string;
  outputPrompt?: string;
  defaultModel?: string;         // Default model for prompt phase
  validationModel?: string;      // Default model for validation phase
  outputModel?: string;          // Default model for output phase
  gitRepo?: string;              // Git URL for cloning new workspaces
}

export interface McpConfig {
  id: string;
  name: string;
  enabled: boolean;
}

export interface Config {
  workspaces: WorkspaceConfig[];
  mcps: McpConfig[];
  availableModels: string[];
  defaultModel: string;           // Global default for prompt phase
  defaultValidationModel: string; // Global default for validation phase
  defaultOutputModel: string;     // Global default for output phase
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
  copilotSessionId?: string;     // CLI session ID for main prompt (works for both agents)
  validationSessionId?: string;  // Hidden session for validation
  outputSessionId?: string;      // Hidden session for output generation
  workspaceId: string;
  workspacePath: string;
  friendlyName: string;          // First ~50 chars of initial prompt
  branchName: string;            // Git branch for this session
  createdAt: string;
  updatedAt: string;
  defaultValidationPrompt?: string;
  defaultOutputPrompt?: string;
  defaultModel?: string;
  validationModel?: string;       // Model for validation phase
  outputModel?: string;           // Model for output phase
  enabledMcps?: string[];
}

// Run (iteration) types - a run is one iteration within a session
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
  validationPrompt?: string;    // Override for this run
  outputPrompt?: string;        // Override for this run
  model?: string;               // Override model for prompt phase
  validationModel?: string;     // Override model for validation phase
  outputModel?: string;         // Override model for output phase
  enabledMcps?: string[];       // Override MCPs for this run
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

export type WsEvent = WsLogEvent | WsPhaseEvent | WsValidationEvent | WsImageEvent | WsErrorEvent | WsCompleteEvent;

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
  validationPrompt?: string;
  outputPrompt?: string;
  model?: string;
  validationModel?: string;
  outputModel?: string;
  enabledMcps?: string[];
}

export interface StartRunRequest {
  sessionId: string;
  prompt: string;
  validationPrompt?: string;
  outputPrompt?: string;
  model?: string;
  validationModel?: string;
  outputModel?: string;
  enabledMcps?: string[];
}

export interface CloneWorkspaceRequest {
  gitUrl: string;
  name: string;
  targetPath?: string;
  validationPrompt?: string;
  outputPrompt?: string;
  defaultModel?: string;
  validationModel?: string;
  outputModel?: string;
}
