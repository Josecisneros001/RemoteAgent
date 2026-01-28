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

// Combined regex pattern for interaction detection (single test instead of 14)
const INTERACTION_PATTERN = /\[y\/n\]|\(y\/N\)|\(Y\/n\)|Press Enter to continue|Enter your choice|Do you want to proceed\?|Type 'yes' to confirm|Permission required:|Approve\?|\[Yes\/no\]|Allow this action\?|Continue\?|Confirm\?|Press any key/i;

// Idle threshold for detecting waiting state (ms)
const IDLE_THRESHOLD_MS = 8000;

// Output batching and throttling to prevent overwhelming browser during large history dumps
const OUTPUT_BATCH_INTERVAL_MS = 16; // ~60fps
const OUTPUT_MAX_CHUNK_SIZE = 16384; // 16KB max per WebSocket message
const OUTPUT_MAX_BUFFER_SIZE = 65536; // 64KB max buffer before dropping old data
const OUTPUT_THROTTLE_MS = 8; // Minimum ms between flushes during heavy load

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
  // Output batching to reduce WebSocket overhead
  outputBuffer: string;
  outputFlushTimer: NodeJS.Timeout | null;
  lastFlushTime: number; // For throttling during heavy load
  // Retry detection buffer (limited size, cleared after use)
  retryDetectionBuffer: string;
  retryDetectionComplete: boolean;
  // Flag to indicate PTY is being restarted (don't notify clients of exit)
  isRestarting: boolean;
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

    // Only skip permissions when in Docker (Docker uses network filtering)
    if (process.env.DOCKER_MODE) {
      args.push('--dangerously-skip-permissions');
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

    // Only grant full permissions when in Docker (Docker uses network filtering)
    if (process.env.DOCKER_MODE) {
      args.push('--allow-all-tools', '--allow-all-paths');
      envVars['COPILOT_ALLOW_ALL'] = 'true';
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
      // Output batching
      outputBuffer: '',
      outputFlushTimer: null,
      lastFlushTime: 0,
      // Retry detection (limited, cleared after use)
      retryDetectionBuffer: '',
      retryDetectionComplete: false,
      // Restart flag
      isRestarting: false,
    };

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      const now = Date.now();
      ptySession.lastOutputTime = now;
      ptySession.isInteractionNotified = false;

      // For Claude resume: detect "No conversation found" error and retry with --session-id
      // Only buffer first 1KB for retry detection, then stop accumulating
      if (session.agent === 'claude' && resume && !ptySession.retryDetectionComplete && session.copilotSessionId) {
        ptySession.retryDetectionBuffer += data;

        if (ptySession.retryDetectionBuffer.includes('No conversation found with session ID')) {
          console.log(`[PTY] Claude resume failed - no conversation found. Restarting with --session-id`);
          ptySession.retryDetectionComplete = true;
          ptySession.retryDetectionBuffer = ''; // Clear immediately

          // Mark that we're restarting so onExit doesn't notify clients of exit
          ptySession.isRestarting = true;

          // Kill current process - DON'T cleanup session, we'll reuse clients
          ptyProcess.kill();

          // Restart with --session-id instead of --resume
          // The onExit handler will call restartSession which preserves client connections
          return;
        }

        // Stop buffering after 1KB - error would have appeared by now
        if (ptySession.retryDetectionBuffer.length > 1024) {
          ptySession.retryDetectionComplete = true;
          ptySession.retryDetectionBuffer = ''; // Free memory
        }
      }

      // Batch output for WebSocket to reduce overhead
      ptySession.outputBuffer += data;

      // CRITICAL: Enforce buffer limit during accumulation, not just during flush
      // This prevents memory exhaustion during large history dumps
      if (ptySession.outputBuffer.length > OUTPUT_MAX_BUFFER_SIZE) {
        const truncateAmount = ptySession.outputBuffer.length - OUTPUT_MAX_BUFFER_SIZE;
        ptySession.outputBuffer = ptySession.outputBuffer.slice(truncateAmount);
      }

      // Schedule flush if not already scheduled
      if (!ptySession.outputFlushTimer) {
        ptySession.outputFlushTimer = setTimeout(() => {
          flushOutputBuffer(ptySession, session.id);
        }, OUTPUT_BATCH_INTERVAL_MS);
      }

      // Check for interaction patterns (only on new data, not buffered)
      checkForInteraction(ptySession, session, data);

      // Reset idle timer only if not already set or if it's been a while
      // This prevents constant timer churn during rapid output
      if (!ptySession.idleTimer) {
        resetIdleTimer(ptySession, session);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PTY] Session ${session.id} exited with code ${exitCode}`);

      // If we're restarting (e.g., resume failed), don't notify clients - just restart
      if (ptySession.isRestarting) {
        console.log(`[PTY] Restarting session ${session.id} with --session-id`);

        // Preserve clients before cleanup
        const existingClients = new Set(ptySession.clients);

        // Clear timers but don't remove from ptySessions yet
        if (ptySession.idleTimer) {
          clearTimeout(ptySession.idleTimer);
        }
        if (ptySession.outputFlushTimer) {
          clearTimeout(ptySession.outputFlushTimer);
        }

        // Remove the old session entry
        ptySessions.delete(session.id);

        // Restart with --session-id instead of --resume
        setTimeout(() => {
          const newPtySession = startInteractiveSession(session, prompt, false);
          if (newPtySession) {
            // Re-attach existing clients to the new session
            for (const client of existingClients) {
              if (client.readyState === 1) { // WebSocket.OPEN
                newPtySession.clients.add(client);
              }
            }
            console.log(`[PTY] Re-attached ${newPtySession.clients.size} clients to restarted session`);
          }
        }, 100);
        return;
      }

      // Flush any remaining buffered output before sending exit
      if (ptySession.outputBuffer) {
        flushOutputBuffer(ptySession, session.id);
      }

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
    
    // For Copilot: detect and save the new session ID after a delay
    // Copilot may take a while to create its session directory, so we retry
    if (copilotSessionIdsBefore !== null) {
      console.log(`[PTY] Will detect Copilot session ID. Before IDs count: ${copilotSessionIdsBefore.size}`);

      const detectWithRetry = async (attempt: number, maxAttempts: number) => {
        const newSessionId = detectNewCopilotSessionId(copilotSessionIdsBefore!);
        const afterIds = getCopilotSessionIds();
        console.log(`[PTY] Detection attempt ${attempt}/${maxAttempts}: After IDs count: ${afterIds.size}, new session ID: ${newSessionId}`);

        if (newSessionId) {
          console.log(`[PTY] Detected Copilot session ID: ${newSessionId}`);
          try {
            await updateSessionCopilotId(session.id, newSessionId);
            console.log(`[PTY] Saved Copilot session ID to session ${session.id}`);
          } catch (error) {
            console.error(`[PTY] Failed to save Copilot session ID:`, error);
          }
        } else if (attempt < maxAttempts) {
          // Retry after another delay
          setTimeout(() => detectWithRetry(attempt + 1, maxAttempts), 3000);
        } else {
          console.log(`[PTY] No new Copilot session ID detected after ${maxAttempts} attempts`);
        }
      };

      // First attempt after 3 seconds, retry up to 5 times (15 seconds total)
      setTimeout(() => detectWithRetry(1, 5), 3000);
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
  // Note: Removed console.log here to reduce I/O during rapid resize events
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

/**
 * Stop all active PTY sessions (for graceful shutdown)
 */
export function stopAllSessions(): void {
  const sessionIds = Array.from(ptySessions.keys());
  console.log(`[PTY] Stopping all ${sessionIds.length} active session(s)...`);

  for (const sessionId of sessionIds) {
    try {
      const ptySession = ptySessions.get(sessionId);
      if (ptySession) {
        ptySession.pty.kill();
        cleanupSession(sessionId);
      }
    } catch (error) {
      console.error(`[PTY] Error stopping session ${sessionId}:`, error);
    }
  }

  console.log('[PTY] All sessions stopped');
}

// Internal helpers

/**
 * Flush batched output to WebSocket clients with chunking and throttling.
 * Prevents browser crashes when resuming sessions with large history.
 */
function flushOutputBuffer(ptySession: PtySession, sessionId: string): void {
  ptySession.outputFlushTimer = null;

  if (!ptySession.outputBuffer) return;

  const now = Date.now();

  // Throttle: ensure minimum time between flushes during heavy load
  const timeSinceLastFlush = now - ptySession.lastFlushTime;
  if (timeSinceLastFlush < OUTPUT_THROTTLE_MS && ptySession.outputBuffer.length < OUTPUT_MAX_CHUNK_SIZE) {
    // Reschedule flush
    ptySession.outputFlushTimer = setTimeout(() => {
      flushOutputBuffer(ptySession, sessionId);
    }, OUTPUT_THROTTLE_MS - timeSinceLastFlush);
    return;
  }

  // If buffer is too large, truncate old data to prevent memory issues
  if (ptySession.outputBuffer.length > OUTPUT_MAX_BUFFER_SIZE) {
    const truncateAmount = ptySession.outputBuffer.length - OUTPUT_MAX_BUFFER_SIZE;
    ptySession.outputBuffer = ptySession.outputBuffer.slice(truncateAmount);
    console.log(`[PTY] Truncated ${truncateAmount} bytes from buffer to prevent overflow`);
  }

  // Send in chunks to prevent overwhelming the browser
  let dataToSend = ptySession.outputBuffer;
  ptySession.outputBuffer = '';
  ptySession.lastFlushTime = now;

  // If data is larger than max chunk, send first chunk and reschedule rest
  if (dataToSend.length > OUTPUT_MAX_CHUNK_SIZE) {
    const chunk = dataToSend.slice(0, OUTPUT_MAX_CHUNK_SIZE);
    ptySession.outputBuffer = dataToSend.slice(OUTPUT_MAX_CHUNK_SIZE);
    dataToSend = chunk;

    // Schedule next chunk with throttling
    ptySession.outputFlushTimer = setTimeout(() => {
      flushOutputBuffer(ptySession, sessionId);
    }, OUTPUT_THROTTLE_MS);
  }

  const event: WsPtyDataEvent = {
    type: 'pty-data',
    sessionId,
    data: dataToSend,
  };

  broadcastToClients(ptySession, event);
}

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

  // Single regex test instead of looping through 14 patterns
  if (INTERACTION_PATTERN.test(data)) {
    notifyInteractionNeeded(ptySession, session, 'Input prompt detected');
  }
}

function resetIdleTimer(ptySession: PtySession, session: Session): void {
  // Clear existing timer
  if (ptySession.idleTimer) {
    clearTimeout(ptySession.idleTimer);
    ptySession.idleTimer = null;
  }

  // Set new timer - will be triggered after IDLE_THRESHOLD_MS of no output
  ptySession.idleTimer = setTimeout(() => {
    ptySession.idleTimer = null; // Clear reference so new timer can be set
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
    if (ptySession.outputFlushTimer) {
      clearTimeout(ptySession.outputFlushTimer);
    }
    // Clear buffers to free memory
    ptySession.outputBuffer = '';
    ptySession.retryDetectionBuffer = '';
    ptySession.clients.clear();
    ptySessions.delete(sessionId);
    console.log(`[PTY] Session ${sessionId} cleaned up`);
  }
}
