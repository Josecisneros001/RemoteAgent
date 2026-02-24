import { readdir, stat, readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, basename, sep } from 'path';
import { homedir } from 'os';
import { listSessions } from './run-store.js';
import { isSessionActive } from './pty-manager.js';
import { pathExists } from '../utils/fs.js';
import type { CliSession } from '../types.js';

// Claude projects directory: ~/.claude/projects/
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Copilot session state directory: ~/.copilot/session-state/
const COPILOT_SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

// UUID pattern for session files
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache settings
const CACHE_TTL_MS = 30_000; // 30 seconds

// Concurrency limit for parallel file scanning
const CONCURRENCY_LIMIT = 10;

// Max bytes/lines to read from JSONL files
const MAX_JSONL_BYTES = 65536; // 64KB
const MAX_JSONL_LINES = 50;

interface CacheEntry {
  sessions: CliSession[];
  timestamp: number;
}

let cache: CacheEntry | null = null;
let scanPromise: Promise<CliSession[]> | null = null;

/**
 * Decode a Claude project directory name to an absolute path.
 *
 * Claude encodes paths like:
 *   Q:\src\RemoteAgent     ->  Q--src-RemoteAgent  (Windows)
 *   /home/user/project     ->  -home-user-project  (Linux)
 *   C:\Users\josci\car-finder -> C--Users-josci-car-finder
 *
 * On Windows the pattern is: {drive}--{rest with - as separator}
 * On Linux/Mac: -{rest with - as separator}
 *
 * Because directory names can contain hyphens (e.g. "car-finder"),
 * naive replacement doesn't work. We try the naive decode first,
 * and if it doesn't exist, we try all possible splits recursively.
 */
async function decodeClaudeProjectPath(encoded: string): Promise<string | null> {
  // Windows pattern: single letter followed by --
  const windowsMatch = encoded.match(/^([A-Za-z])--(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = windowsMatch[2];
    const prefix = `${drive}:${sep}`;

    // Try naive decode first (fastest path)
    const naive = prefix + rest.replace(/-/g, sep);
    if (await pathExists(naive)) return naive;

    // Try smart decode — find valid path by testing filesystem
    const segments = rest.split('-');
    const result = await findValidPath(prefix, segments);
    return result;
  }

  // Unix pattern: starts with -
  if (encoded.startsWith('-')) {
    const rest = encoded.slice(1);
    const prefix = '/';

    const naive = prefix + rest.replace(/-/g, '/');
    if (await pathExists(naive)) return naive;

    const segments = rest.split('-');
    const result = await findValidPath(prefix, segments);
    return result;
  }

  return null;
}

/**
 * Recursively find a valid filesystem path by trying to combine
 * hyphen-separated segments in different ways.
 *
 * For segments ["Users", "josci", "car", "finder"], tries:
 *   Users/josci/car/finder  (all separators)
 *   Users/josci/car-finder  (last two joined)
 *   Users/josci-car/finder  etc.
 *   Users-josci/car/finder  etc.
 *
 * Stops as soon as a valid path is found.
 */
async function findValidPath(prefix: string, segments: string[]): Promise<string | null> {
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    const candidate = join(prefix, segments[0]);
    return (await pathExists(candidate)) ? candidate : null;
  }

  // Try combining first N segments as one directory name, then recurse on the rest
  // Start with single segment (most likely) and work up to joining all
  for (let i = 1; i <= segments.length; i++) {
    const dirName = segments.slice(0, i).join('-');
    const candidateDir = join(prefix, dirName);

    if (i === segments.length) {
      // All segments joined — this is the full path
      if (await pathExists(candidateDir)) return candidateDir;
    } else {
      // Check if this directory exists, then recurse for remaining segments
      if (await pathExists(candidateDir)) {
        const rest = await findValidPath(candidateDir, segments.slice(i));
        if (rest) return rest;
      }
    }
  }

  return null;
}

/**
 * Run async functions with limited concurrency.
 */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Read the first user message from a Claude JSONL session file.
 * Streams only the first 64KB or 50 lines.
 */
async function readClaudeSessionInfo(
  filePath: string
): Promise<{ prettyName: string; fullPrompt: string; createdAt: string | null; sessionId: string | null }> {
  return new Promise((resolve) => {
    let lineCount = 0;
    let bytesRead = 0;
    let prettyName = '';
    let fullPrompt = '';
    let createdAt: string | null = null;
    let sessionId: string | null = null;
    let resolved = false;

    const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 16384 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      if (!resolved) {
        resolved = true;
        rl.close();
        stream.destroy();
        resolve({ prettyName: prettyName || 'Untitled session', fullPrompt: fullPrompt || prettyName || 'Untitled session', createdAt, sessionId });
      }
    };

    rl.on('line', (line) => {
      lineCount++;
      bytesRead += line.length;

      try {
        const entry = JSON.parse(line);

        // Capture session ID from any entry that has it
        if (!sessionId && entry.sessionId) {
          sessionId = entry.sessionId;
        }

        // Look for the first user message
        if (entry.type === 'user' && entry.message?.role === 'user') {
          const content = entry.message.content;
          let text = '';

          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            // Content can be an array of content blocks
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                text = block.text;
                break;
              }
            }
          }

          if (text) {
            const cleaned = text.replace(/\s+/g, ' ').trim();
            prettyName = cleaned.length > 30 ? cleaned.slice(0, 27) + '...' : cleaned;
            fullPrompt = cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned;
          }

          if (entry.timestamp) {
            createdAt = entry.timestamp;
          }

          finish();
          return;
        }

        // Also try summary entries as fallback
        if (!prettyName && entry.type === 'summary' && entry.summary) {
          const cleaned = entry.summary.replace(/\s+/g, ' ').trim();
          prettyName = cleaned.length > 30 ? cleaned.slice(0, 27) + '...' : cleaned;
          fullPrompt = cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned;
        }

        // Capture timestamp from early entries
        if (!createdAt && entry.timestamp) {
          createdAt = entry.timestamp;
        }
      } catch {
        // Skip malformed lines
      }

      // Abort if we've read enough
      if (lineCount >= MAX_JSONL_LINES || bytesRead >= MAX_JSONL_BYTES) {
        finish();
      }
    });

    rl.on('close', finish);
    rl.on('error', finish);
    stream.on('error', finish);
  });
}

/**
 * Read the first user message from a Copilot events.jsonl file.
 */
async function readCopilotFirstPrompt(eventsPath: string): Promise<{ prettyName: string; fullPrompt: string }> {
  const untitled = { prettyName: 'Untitled session', fullPrompt: 'Untitled session' };
  if (!(await pathExists(eventsPath))) return untitled;

  return new Promise((resolve) => {
    let lineCount = 0;
    let bytesRead = 0;
    let resolved = false;

    const stream = createReadStream(eventsPath, { encoding: 'utf-8', highWaterMark: 16384 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const finish = (result: { prettyName: string; fullPrompt: string }) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        stream.destroy();
        resolve(result);
      }
    };

    rl.on('line', (line) => {
      lineCount++;
      bytesRead += line.length;

      try {
        const entry = JSON.parse(line);
        // Look for user message events
        if (entry.role === 'user' && entry.content) {
          let text = '';
          if (typeof entry.content === 'string') {
            text = entry.content;
          } else if (Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'text' && block.text) {
                text = block.text;
                break;
              }
            }
          }
          if (text) {
            const cleaned = text.replace(/\s+/g, ' ').trim();
            finish({
              prettyName: cleaned.length > 30 ? cleaned.slice(0, 27) + '...' : cleaned,
              fullPrompt: cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned,
            });
            return;
          }
        }
      } catch {
        // Skip malformed lines
      }

      if (lineCount >= MAX_JSONL_LINES || bytesRead >= MAX_JSONL_BYTES) {
        finish(untitled);
      }
    });

    rl.on('close', () => finish(untitled));
    rl.on('error', () => finish(untitled));
    stream.on('error', () => finish(untitled));
  });
}

/**
 * Parse a simple flat YAML file (workspace.yaml) without dependencies.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

/**
 * Scan Claude projects directory for sessions.
 */
async function scanClaudeSessions(): Promise<CliSession[]> {
  if (!(await pathExists(CLAUDE_PROJECTS_DIR))) {
    return [];
  }

  const sessions: CliSession[] = [];

  let projectDirs: string[];
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }

  // Build tasks for each project directory
  const tasks: (() => Promise<CliSession[]>)[] = projectDirs.map(
    (dirName) => async (): Promise<CliSession[]> => {
      const projectPath = join(CLAUDE_PROJECTS_DIR, dirName);
      const decodedPath = await decodeClaudeProjectPath(dirName);

      if (!decodedPath) return [];

      const directoryName = basename(decodedPath);

      // List .jsonl files directly in this project dir (skip subdirectories)
      let files: string[];
      try {
        const entries = await readdir(projectPath, { withFileTypes: true });
        files = entries
          .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
          .map(e => e.name);
      } catch {
        return [];
      }

      const projectSessions: CliSession[] = [];

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        if (!UUID_PATTERN.test(sessionId)) continue;

        const filePath = join(projectPath, file);

        try {
          const fileStat = await stat(filePath);
          const info = await readClaudeSessionInfo(filePath);

          projectSessions.push({
            id: sessionId,
            source: 'claude',
            directory: decodedPath,
            directoryName,
            prettyName: info.prettyName,
            fullPrompt: info.fullPrompt,
            lastActive: fileStat.mtime.toISOString(),
            createdAt: info.createdAt,
            raSessionId: null, // Will be filled in dedup step
            isActive: false,   // Will be filled in dedup step
          });
        } catch {
          // Skip files that can't be read
        }
      }

      return projectSessions;
    }
  );

  // Run with concurrency limit
  const results = await parallelLimit(tasks, CONCURRENCY_LIMIT);
  for (const projectSessions of results) {
    sessions.push(...projectSessions);
  }

  return sessions;
}

/**
 * Scan Copilot session-state directory for sessions.
 */
async function scanCopilotSessions(): Promise<CliSession[]> {
  if (!(await pathExists(COPILOT_SESSION_STATE_DIR))) {
    return [];
  }

  const sessions: CliSession[] = [];

  let sessionDirs: string[];
  try {
    const entries = await readdir(COPILOT_SESSION_STATE_DIR, { withFileTypes: true });
    sessionDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }

  const tasks: (() => Promise<CliSession | null>)[] = sessionDirs.map(
    (dirName) => async (): Promise<CliSession | null> => {
      const sessionDir = join(COPILOT_SESSION_STATE_DIR, dirName);
      const workspaceYaml = join(sessionDir, 'workspace.yaml');

      if (!(await pathExists(workspaceYaml))) return null;

      try {
        const yamlContent = await readFile(workspaceYaml, 'utf-8');
        const parsed = parseSimpleYaml(yamlContent);

        const id = parsed.id || dirName;
        const directory = parsed.cwd || parsed.git_root || '';
        if (!directory) return null;

        const directoryName = basename(directory);
        let prettyName = parsed.summary || '';

        let fullPrompt = '';

        // If no summary, try reading first prompt from events.jsonl
        if (!prettyName) {
          const eventsPath = join(sessionDir, 'events.jsonl');
          const promptInfo = await readCopilotFirstPrompt(eventsPath);
          prettyName = promptInfo.prettyName;
          fullPrompt = promptInfo.fullPrompt;
        } else {
          // Truncate summary to 30 chars, keep full version
          fullPrompt = prettyName.length > 200 ? prettyName.slice(0, 197) + '...' : prettyName;
          prettyName = prettyName.length > 30 ? prettyName.slice(0, 27) + '...' : prettyName;
        }

        return {
          id,
          source: 'copilot',
          directory,
          directoryName,
          prettyName,
          fullPrompt: fullPrompt || prettyName,
          lastActive: parsed.updated_at || parsed.created_at || new Date().toISOString(),
          createdAt: parsed.created_at || null,
          raSessionId: null,
          isActive: false,
        };
      } catch {
        return null;
      }
    }
  );

  const results = await parallelLimit(tasks, CONCURRENCY_LIMIT);
  for (const session of results) {
    if (session) sessions.push(session);
  }

  return sessions;
}

/**
 * Perform full scan, dedup with RA sessions, and return sorted results.
 */
async function fullScan(): Promise<CliSession[]> {
  // Scan both sources in parallel
  const [claudeSessions, copilotSessions] = await Promise.all([
    scanClaudeSessions(),
    scanCopilotSessions(),
  ]);

  const allSessions = [...claudeSessions, ...copilotSessions];

  // Load RA sessions for deduplication
  try {
    const raSessions = await listSessions();

    // Build lookup maps for RA sessions
    // For Claude: RA session.copilotSessionId === CLI session.id (RA stores Claude session UUID as copilotSessionId)
    // For Copilot: RA session.copilotSessionId === CLI session.id
    const raByCliId = new Map<string, string>();
    for (const ra of raSessions) {
      // RA stores the CLI session UUID in the `id` field for Claude sessions
      // created via RA (since RA uses --session-id with the same UUID)
      // But the session.id in RA is the RA session ID, and copilotSessionId is the CLI session ID
      if (ra.id) {
        // For Claude sessions created by RA, the RA session's copilotSessionId IS the Claude session UUID
        // We need to check the actual Session object, not SessionSummary
        // SessionSummary doesn't have copilotSessionId, so we match by RA session ID
        // Actually, for Claude: RA creates session with copilotSessionId = claude UUID, and uses --session-id with that
        // So copilotSessionId in RA = the Claude CLI session UUID
        raByCliId.set(ra.id, ra.id); // RA session ID -> RA session ID (for matching by RA ID later)
      }
    }

    // We need the actual Session objects to get copilotSessionId
    // listSessions returns SessionSummary which doesn't include copilotSessionId
    // Instead, we'll do a simpler approach: load each RA session file to check
    // Actually, let's use a pragmatic approach:
    // For each CLI session, check if any RA session has a matching ID pattern
    // RA stores Claude session UUID as copilotSessionId in the Session record

    // Read RA session files to get copilotSessionId
    const { getSession } = await import('./run-store.js');
    const raCopilotIdMap = new Map<string, string>(); // CLI session ID -> RA session ID

    for (const ra of raSessions) {
      try {
        const fullSession = await getSession(ra.id);
        if (fullSession?.copilotSessionId) {
          raCopilotIdMap.set(fullSession.copilotSessionId, fullSession.id);
        }
      } catch {
        // Skip sessions that can't be loaded
      }
    }

    // Apply dedup
    for (const session of allSessions) {
      const raSessionId = raCopilotIdMap.get(session.id) || null;
      session.raSessionId = raSessionId;
      if (raSessionId) {
        session.isActive = isSessionActive(raSessionId);
      }
    }
  } catch (error) {
    console.error('[Discovery] Error during RA session dedup:', error);
  }

  // Sort by lastActive descending (most recent first)
  allSessions.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());

  return allSessions;
}

/**
 * Get all discovered sessions with caching, pagination, and concurrency protection.
 */
export async function discoverAll(
  limit: number = 15,
  offset: number = 0
): Promise<{ sessions: CliSession[]; total: number; cacheTimestamp: string }> {
  const now = Date.now();

  // Check cache
  if (cache && (now - cache.timestamp) < CACHE_TTL_MS) {
    // limit=0 means return all
    const paginated = limit === 0 ? cache.sessions : cache.sessions.slice(offset, offset + limit);
    return {
      sessions: paginated,
      total: cache.sessions.length,
      cacheTimestamp: new Date(cache.timestamp).toISOString(),
    };
  }

  // Prevent thundering herd - single scan promise
  if (!scanPromise) {
    scanPromise = fullScan().finally(() => {
      scanPromise = null;
    });
  }

  const sessions = await scanPromise;
  cache = { sessions, timestamp: Date.now() };

  // limit=0 means return all
  const paginated = limit === 0 ? sessions : sessions.slice(offset, offset + limit);
  return {
    sessions: paginated,
    total: sessions.length,
    cacheTimestamp: new Date(cache.timestamp).toISOString(),
  };
}

/**
 * Invalidate the cache, forcing a rescan on next request.
 */
export function invalidateCache(): void {
  cache = null;
}
