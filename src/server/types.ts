// Configuration types
export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  validationPrompt?: string;
  outputPrompt?: string;
}

export interface Config {
  workspaces: WorkspaceConfig[];
  mcps: string[];
  model: string;
  port: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidEmail?: string;
}

// Run types
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

export interface Run {
  id: string;
  workspaceId: string;
  workspacePath: string;
  prompt: string;
  validationInstructions: string;
  imageInstructions: string;
  status: RunPhase;
  logs: LogEntry[];
  validation: ValidationResult;
  images: ImageResult[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  // Session management
  sessionId?: string;        // Copilot session ID for the main prompt
  continueSession?: string;  // Session ID to continue from (if any)
}

export interface RunSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  prompt: string;
  status: RunPhase;
  createdAt: string;
}

// WebSocket event types
export interface WsLogEvent {
  type: 'log';
  runId: string;
  entry: LogEntry;
}

export interface WsPhaseEvent {
  type: 'phase';
  runId: string;
  phase: RunPhase;
}

export interface WsValidationEvent {
  type: 'validation';
  runId: string;
  validation: ValidationResult;
}

export interface WsImageEvent {
  type: 'image';
  runId: string;
  image: ImageResult;
}

export interface WsErrorEvent {
  type: 'error';
  runId: string;
  error: string;
}

export interface WsCompleteEvent {
  type: 'complete';
  runId: string;
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
export interface StartRunRequest {
  workspaceId: string;
  prompt: string;
  validationInstructions: string;
  imageInstructions: string;
  continueSession?: string;  // Optional session ID to continue
}

// Session info
export interface SessionInfo {
  id: string;
  workspaceId: string;
  workspaceName: string;
  lastPrompt: string;
  createdAt: string;
  updatedAt: string;
}
