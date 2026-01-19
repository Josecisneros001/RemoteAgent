import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getConfig } from './config.js';
import { sendNotification } from './push.js';
import { updateSessionCopilotId } from './run-store.js';
import type { Session, WsPtyDataEvent, WsInteractionNeededEvent, WsPtyExitEvent } from '../types.js';

// Patterns that indicate user interaction is needed
const INTERACTION_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/N\)/i,
  /\(Y\/n\)/i,
  /Press Enter to continue/i,
  /Enter your choice/i,
  /Do you want to proceed\?/i,
  /Type 'yes' to confirm/i,
  /Permission required:/i,
  /Approve\?/i,
  /\[Yes\/no\]/i,
  /Allow this action\?/i,
  /Continue\?/i,
  /Confirm\?/i,
  /Press any key/i,
];

// Idle threshold for detecting waiting state (ms)
const IDLE_THRESHOLD_MS = 8000;

// Copilot session state directory
const COPILOT_SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

/**
 * Get existing Copilot session IDs from ~/.copilot/session-state/
 */
function getCopilotSessionIds(): Set<string> {
  try {
    const entries = readdirSync(COPILOT_SESSION_STATE_DIR, { withFileTypes: true });
    return new Set(
      entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
    );
  } catch {
    return new Set();
  }
}

/**
 * Detect new Copilot session ID by comparing before/after session directories
 */
function detectNewCopilotSessionId(beforeIds: Set<string>): string | null {
  const afterIds = getCopilotSessionIds();
  for (const id of afterIds) {
    if (!beforeIds.has(id)) {
      return id;
    }
  }
  return null;
}

interface PtySession {
  pty: IPty;
  sessionId: string;
  clients: Set<WebSocket>;
  lastOutputTime: number;
  idleTimer: NodeJS.Timeout | null;
  isInteractionNotified: boolean;
}

// Active PTY sessions by session ID
const ptySessions = new Map<string, PtySession>();

/**
 * Start an interactive PTY session for a Claude/Copilot CLI
 */
export function startInteractiveSession(
  session: Session,
  prompt?: string,
  resume?: boolean
): PtySession | null {
  // Check if session already exists
  if (ptySessions.has(session.id)) {
    console.log(`[PTY] Session ${session.id} already active`);
    return ptySessions.get(session.id)!;
  }

  const config = getConfig();
  const workspace = config.workspaces.find(w => w.id === session.workspaceId);
  if (!workspace) {
    console.error(`[PTY] Workspace not found: ${session.workspaceId}`);
    return null;
  }

  let command: string;
  let args: string[];
  const envVars: Record<string, string> = { ...process.env } as Record<string, string>;
  // Force color output for terminal
  envVars['FORCE_COLOR'] = '1';
  envVars['TERM'] = 'xterm-256color';

  // Track existing Copilot sessions before starting (for detecting new session ID)
  let copilotSessionIdsBefore: Set<string> | null = null;

  if (session.agent === 'claude') {
    command = 'claude';
    args = [];
    
    // Add model if specified
    const model = session.defaultModel || config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    // Session management:
    // - First start: use --session-id to create a session with our UUID
    // - Resume: use --resume to continue the existing session
    if (session.copilotSessionId) {
      if (resume) {
        // Resume existing conversation
        args.push('--resume', session.copilotSessionId);
      } else {
        // First start - create session with our UUID
        args.push('--session-id', session.copilotSessionId);
      }
    }
  } else {
    // Copilot CLI
    command = 'copilot';
    args = [];

    const model = session.defaultModel || config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    // Session management for Copilot:
    // - Resume: use --resume with the captured session ID
    // - First start: we'll capture the session ID from ~/.copilot/session-state/
    console.log(`[PTY] Copilot resume=${resume}, copilotSessionId=${session.copilotSessionId}`);
    if (resume && session.copilotSessionId) {
      args.push('--resume', session.copilotSessionId);
    } else if (!resume && !session.copilotSessionId) {
      // First start for Copilot - capture existing session IDs to detect the new one
      copilotSessionIdsBefore = getCopilotSessionIds();
      console.log(`[PTY] Copilot first start - capturing ${copilotSessionIdsBefore.size} existing session IDs`);
    }

    envVars['COPILOT_ALLOW_ALL'] = 'true';
  }

  console.log(`[PTY] Starting ${session.agent} session in ${workspace.path}`);
  console.log(`[PTY] Command: ${command} ${args.join(' ')}`);
  console.log(`[PTY] Session copilotSessionId: ${session.copilotSessionId}`);

  try {
    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      env: envVars,
    });

    const ptySession: PtySession = {
      pty: ptyProcess,
      sessionId: session.id,
      clients: new Set(),
      lastOutputTime: Date.now(),
      idleTimer: null,
      isInteractionNotified: false,
    };

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      ptySession.lastOutputTime = Date.now();
      ptySession.isInteractionNotified = false;
      
      // Broadcast to all connected clients
      const event: WsPtyDataEvent = {
        type: 'pty-data',
        sessionId: session.id,
        data,
      };
      
      broadcastToClients(ptySession, event);
      
      // Check for interaction patterns
      checkForInteraction(ptySession, session, data);
      
      // Reset idle timer
      resetIdleTimer(ptySession, session);
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PTY] Session ${session.id} exited with code ${exitCode}`);
      
      const event: WsPtyExitEvent = {
        type: 'pty-exit',
        sessionId: session.id,
        exitCode,
      };
      
      broadcastToClients(ptySession, event);
      cleanupSession(session.id);
    });

    ptySessions.set(session.id, ptySession);
    
    // If we have an initial prompt, send it after a short delay
    if (prompt && !resume) {
      setTimeout(() => {
        ptyProcess.write(prompt + '\r');
      }, 500);
    }
    
    // For Copilot: detect and save the new session ID after a short delay
    if (copilotSessionIdsBefore !== null) {
      console.log(`[PTY] Will detect Copilot session ID. Before IDs count: ${copilotSessionIdsBefore.size}`);
      setTimeout(async () => {
        const newSessionId = detectNewCopilotSessionId(copilotSessionIdsBefore!);
        const afterIds = getCopilotSessionIds();
        console.log(`[PTY] After IDs count: ${afterIds.size}, new session ID: ${newSessionId}`);
        if (newSessionId) {
          console.log(`[PTY] Detected Copilot session ID: ${newSessionId}`);
          try {
            await updateSessionCopilotId(session.id, newSessionId);
            console.log(`[PTY] Saved Copilot session ID to session ${session.id}`);
          } catch (error) {
            console.error(`[PTY] Failed to save Copilot session ID:`, error);
          }
        } else {
          console.log(`[PTY] No new Copilot session ID detected`);
        }
      }, 5000); // Wait 5 seconds for Copilot to create its session
    }
    
    return ptySession;
  } catch (error) {
    console.error(`[PTY] Failed to start session:`, error);
    return null;
  }
}

/**
 * Attach a WebSocket client to a PTY session
 */
export function attachClient(sessionId: string, ws: WebSocket): boolean {
  const ptySession = ptySessions.get(sessionId);
  if (!ptySession) {
    console.log(`[PTY] No active session ${sessionId} to attach to`);
    return false;
  }

  ptySession.clients.add(ws);
  console.log(`[PTY] Client attached to session ${sessionId}, total clients: ${ptySession.clients.size}`);
  return true;
}

/**
 * Detach a WebSocket client from a PTY session
 */
export function detachClient(sessionId: string, ws: WebSocket): void {
  const ptySession = ptySessions.get(sessionId);
  if (ptySession) {
    ptySession.clients.delete(ws);
    console.log(`[PTY] Client detached from session ${sessionId}, remaining clients: ${ptySession.clients.size}`);
  }
}

/**
 * Send input to a PTY session
 */
export function sendInput(sessionId: string, data: string): boolean {
  const ptySession = ptySessions.get(sessionId);
  if (!ptySession) {
    console.log(`[PTY] No active session ${sessionId} for input`);
    return false;
  }

  ptySession.pty.write(data);
  return true;
}

/**
 * Resize a PTY session
 */
export function resizePty(sessionId: string, cols: number, rows: number): boolean {
  const ptySession = ptySessions.get(sessionId);
  if (!ptySession) {
    return false;
  }

  ptySession.pty.resize(cols, rows);
  console.log(`[PTY] Session ${sessionId} resized to ${cols}x${rows}`);
  return true;
}

/**
 * Stop a PTY session
 */
export function stopSession(sessionId: string): boolean {
  const ptySession = ptySessions.get(sessionId);
  if (!ptySession) {
    return false;
  }

  console.log(`[PTY] Stopping session ${sessionId}`);
  ptySession.pty.kill();
  cleanupSession(sessionId);
  return true;
}

/**
 * Check if a session is active
 */
export function isSessionActive(sessionId: string): boolean {
  return ptySessions.has(sessionId);
}

/**
 * Get all active session IDs
 */
export function getActiveSessions(): string[] {
  return Array.from(ptySessions.keys());
}

// Internal helpers

function broadcastToClients(ptySession: PtySession, event: WsPtyDataEvent | WsInteractionNeededEvent | WsPtyExitEvent): void {
  const message = JSON.stringify(event);
  for (const client of ptySession.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

function checkForInteraction(ptySession: PtySession, session: Session, data: string): void {
  if (ptySession.isInteractionNotified) return;

  for (const pattern of INTERACTION_PATTERNS) {
    if (pattern.test(data)) {
      notifyInteractionNeeded(ptySession, session, 'Input prompt detected');
      break;
    }
  }
}

function resetIdleTimer(ptySession: PtySession, session: Session): void {
  if (ptySession.idleTimer) {
    clearTimeout(ptySession.idleTimer);
  }

  ptySession.idleTimer = setTimeout(() => {
    if (!ptySession.isInteractionNotified) {
      // Check if still idle
      const idleTime = Date.now() - ptySession.lastOutputTime;
      if (idleTime >= IDLE_THRESHOLD_MS) {
        notifyInteractionNeeded(ptySession, session, 'Waiting for input (idle)');
      }
    }
  }, IDLE_THRESHOLD_MS);
}

async function notifyInteractionNeeded(ptySession: PtySession, session: Session, reason: string): Promise<void> {
  if (ptySession.isInteractionNotified) return;
  
  ptySession.isInteractionNotified = true;
  console.log(`[PTY] Interaction needed for session ${session.id}: ${reason}`);

  // Broadcast to connected clients
  const event: WsInteractionNeededEvent = {
    type: 'interaction-needed',
    sessionId: session.id,
    reason,
  };
  broadcastToClients(ptySession, event);

  // Send push notification
  await sendNotification(
    '🔔 Input Needed',
    `${session.friendlyName}: ${reason}`,
    { sessionId: session.id }
  );
}

function cleanupSession(sessionId: string): void {
  const ptySession = ptySessions.get(sessionId);
  if (ptySession) {
    if (ptySession.idleTimer) {
      clearTimeout(ptySession.idleTimer);
    }
    ptySession.clients.clear();
    ptySessions.delete(sessionId);
    console.log(`[PTY] Session ${sessionId} cleaned up`);
  }
}
