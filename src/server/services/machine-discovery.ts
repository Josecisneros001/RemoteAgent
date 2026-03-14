import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { hostname, platform } from 'os';
import { getConfig, getMachineName } from './config.js';
import { broadcast } from './websocket.js';
import type { Machine, IdentityResponse } from '../types.js';

const execFileAsync = promisify(execFile);

// Cache for discovered machines
let machineCache: Machine[] = [];
let cacheTimestamp = 0;
let discoveryInProgress: Promise<Machine[]> | null = null;
let discoveryGeneration = 0; // Prevents stale discovery from overwriting newer results
const CACHE_TTL_MS = 30_000; // 30 seconds
const OFFLINE_GRACE_MS = 2 * 60 * 1000; // Keep machine "online" for 2 min after last seen connected

// Tunnel access token cache: tunnelId -> { token, expiresAt }
const tunnelTokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

// Health check interval
let healthInterval: ReturnType<typeof setInterval> | null = null;
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 3_000; // 3 second timeout for identity check

/**
 * Get stable machine ID for the local machine
 */
export function getLocalMachineId(): string {
  const host = hostname();
  const plat = platform();
  return createHash('sha256').update(`${host}:${plat}`).digest('hex').slice(0, 16);
}

/**
 * Get the local machine as a Machine object
 */
export function getLocalMachine(): Machine {
  let name: string;
  try {
    name = getMachineName();
  } catch {
    name = hostname(); // Config not loaded yet
  }
  return {
    id: 'local',
    name,
    tunnelUrl: '',
    status: 'online',
    isLocal: true,
    lastSeen: new Date().toISOString(),
    machineInfo: {
      hostname: hostname(),
      platform: platform(),
      version: '1.0.0',
    },
  };
}

/**
 * Resolve devtunnel command path (cached after first resolution)
 */
let cachedDevtunnelCmd: string | null = null;

function resolveDevtunnelCommand(): string {
  if (cachedDevtunnelCmd) return cachedDevtunnelCmd;

  // Check common install locations first (Docker installs to /root/bin/)
  const knownPaths = ['/root/bin/devtunnel', '/usr/local/bin/devtunnel'];
  for (const p of knownPaths) {
    try {
      execFileSync(p, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
      cachedDevtunnelCmd = p;
      return p;
    } catch {
      // not at this path
    }
  }

  try {
    const isWindows = process.platform === 'win32';
    const result = execFileSync(
      isWindows ? 'where' : 'which',
      ['devtunnel'],
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const lines = result.split(/\r?\n/).filter(Boolean);

    if (isWindows) {
      const cmdOrExe = lines.find(l => /\.(cmd|exe)$/i.test(l));
      if (cmdOrExe) { cachedDevtunnelCmd = cmdOrExe; return cmdOrExe; }
    }

    if (lines[0]) { cachedDevtunnelCmd = lines[0]; return lines[0]; }
  } catch {
    // devtunnel not installed
  }
  return 'devtunnel';
}

/**
 * Get an access token for a tunnel (async, non-blocking).
 * Tokens are cached and refreshed before expiry.
 * Falls back to stale-but-not-expired token when refresh fails.
 * Deduplicates concurrent requests for the same tunnel.
 */
const tokenInFlight = new Map<string, Promise<string | null>>();

export async function getTunnelToken(tunnelId: string): Promise<string | null> {
  // Check cache first — return immediately if fresh
  const cached = tunnelTokenCache.get(tunnelId);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return cached.token;
  }

  // Deduplicate concurrent requests for the same tunnel
  const existing = tokenInFlight.get(tunnelId);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    try {
      const devtunnelCmd = resolveDevtunnelCommand();
      const { stdout } = await execFileAsync(devtunnelCmd, ['token', tunnelId, '--scopes', 'connect', '--json'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const json = JSON.parse(stdout);
      if (json.token) {
        // Parse expiration with NaN guard
        let expiresAt = Date.now() + 23 * 60 * 60 * 1000; // Default: 23 hours
        if (json.expiration) {
          const parsed = new Date(json.expiration).getTime();
          if (!isNaN(parsed)) expiresAt = parsed;
        }
        tunnelTokenCache.set(tunnelId, { token: json.token, expiresAt });
        console.log(`[Discovery] Generated access token for tunnel ${tunnelId}`);
        return json.token;
      }
    } catch (err: any) {
      console.warn(`[Discovery] Failed to generate token for tunnel ${tunnelId}: ${err.message?.substring(0, 80)}`);
    }

    // Fall back to stale-but-not-expired cached token
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[Discovery] Using near-expiry cached token for ${tunnelId}`);
      return cached.token;
    }

    return null;
  })();

  tokenInFlight.set(tunnelId, promise);
  promise.finally(() => tokenInFlight.delete(tunnelId));
  return promise;
}

/**
 * Parse `devtunnel list` output to extract tunnel URLs.
 * Tries JSON format first (`--json`), falls back to text parsing.
 */
export function parseDevtunnelList(output: string): string[] {
  const urls: string[] = [];

  // Try JSON parse first (from `devtunnel list --json` — has no URLs, only tunnel IDs)
  // Fall back to text parsing for URLs in output
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    // Match URLs that look like devtunnel URLs (e.g., https://xxx.devtunnels.ms/)
    const urlMatch = line.match(/(https?:\/\/[^\s"]+\.devtunnels\.ms[^\s"]*)/i);
    if (urlMatch) {
      // Clean the URL - remove trailing slashes
      const url = urlMatch[1].replace(/\/+$/, '');
      urls.push(url);
    }
  }

  return [...new Set(urls)]; // Deduplicate
}

/**
 * Info about a discovered tunnel from `devtunnel show --json`
 */
interface TunnelInfo {
  tunnelId: string;
  url: string;
  hostConnections: number;
}

/**
 * Get tunnel IDs from `devtunnel list --json`, then resolve URLs via `devtunnel show --json`.
 * Returns tunnel info including URL, host connection count, and tunnel ID.
 * Fully async — does not block the event loop.
 */
async function discoverTunnels(devtunnelCmd: string): Promise<TunnelInfo[]> {
  // Step 1: Get tunnel list with hostConnections (available in list --json)
  let listOutput: string;
  try {
    const result = await execFileAsync(devtunnelCmd, ['list', '--json'], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    listOutput = result.stdout;
  } catch (err: any) {
    console.warn(`[Discovery] devtunnel list failed: ${err.message?.substring(0, 80)}`);
    return [];
  }

  interface TunnelListEntry {
    tunnelId?: string;
    hostConnections?: number;
    portCount?: number;
  }

  let tunnelEntries: TunnelListEntry[];
  try {
    const json = JSON.parse(listOutput);
    tunnelEntries = json.tunnels || [];
  } catch {
    console.warn('[Discovery] Failed to parse devtunnel list JSON');
    return [];
  }

  // Filter: only resolve details for tunnels with active host connections AND ports
  // This avoids expensive `show` calls for stale/disconnected tunnels
  const activeTunnels = tunnelEntries.filter(t =>
    t.tunnelId && (t.hostConnections ?? 0) > 0 && (t.portCount ?? 0) > 0
  );

  // Also include tunnels that are in the current cache (grace period handling)
  const cachedIds = new Set(machineCache.filter(m => !m.isLocal).map(m => m.tunnelId).filter(Boolean));
  const tunnelsToResolve = tunnelEntries.filter(t =>
    t.tunnelId && (
      (t.hostConnections ?? 0) > 0 ||
      cachedIds.has(t.tunnelId.split('.')[0])
    )
  );

  if (tunnelsToResolve.length === 0) {
    console.log(`[Discovery] No active tunnels (${tunnelEntries.length} total, 0 hosting)`);
    return [];
  }
  console.log(`[Discovery] ${activeTunnels.length} active of ${tunnelEntries.length} total, resolving ${tunnelsToResolve.length} details...`);

  // Step 2: Get URLs for active tunnels via `devtunnel show --json` (parallel)
  const tunnelPromises = tunnelsToResolve.map(async (entry) => {
    const id = entry.tunnelId!.split('.')[0];
    try {
      const result = await execFileAsync(devtunnelCmd, ['show', id, '--json'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const showJson = JSON.parse(result.stdout);
      const tunnel = showJson?.tunnel;
      if (!tunnel) return [];

      // Use hostConnections from show (more current than list snapshot)
      const hostConns = tunnel.hostConnections ?? entry.hostConnections ?? 0;
      const ports = tunnel.ports || [];
      const infos: TunnelInfo[] = [];
      for (const port of ports) {
        if (port.portUri && port.portNumber === 3000) {
          infos.push({
            tunnelId: id,
            url: port.portUri.replace(/\/+$/, ''),
            hostConnections: hostConns,
          });
        }
      }
      return infos;
    } catch (err: any) {
      console.warn(`[Discovery] Failed to get details for tunnel ${id}: ${err.message?.substring(0, 80)}`);
      return [];
    }
  });

  const results = await Promise.all(tunnelPromises);
  return results.flat();
}

/**
 * Check if a URL points to a RemoteAgent instance by calling /api/identity
 */
export async function checkIdentity(url: string): Promise<IdentityResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/api/identity`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return null;

    const data = await response.json() as IdentityResponse;

    // Verify this is actually a RemoteAgent instance
    if (data.app !== 'remote-agent') return null;

    // Validate shape and length of untrusted remote fields
    if (typeof data.machineId !== 'string' || data.machineId.length === 0 || data.machineId.length > 64) return null;
    if (typeof data.hostname !== 'string' || data.hostname.length === 0 || data.hostname.length > 256) return null;
    if (typeof data.platform !== 'string' || data.platform.length === 0 || data.platform.length > 32) return null;
    if (typeof data.version !== 'string' || data.version.length > 32) return null;

    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Discover machines by running `devtunnel list` and checking each tunnel URL
 */
export async function discoverMachines(): Promise<Machine[]> {
  const gen = ++discoveryGeneration;
  const localMachine = getLocalMachine();
  const machines: Machine[] = [localMachine];

  try {
    const devtunnelCmd = resolveDevtunnelCommand();

    // Discover tunnels via devtunnel CLI (fully async — no event loop blocking)
    const tunnels = await discoverTunnels(devtunnelCmd);
    console.log(`[Discovery] Found ${tunnels.length} tunnel(s) with port 3000`);

    // Get our own tunnel name from config to skip ourselves in discovery
    let ownTunnelName: string | undefined;
    try {
      ownTunnelName = getConfig().tunnelName;
    } catch {
      // Config not loaded yet — fall back to hostname matching
    }

    for (const tunnel of tunnels) {
      // Derive a machine ID from the tunnel ID (e.g., "remote-agent-abc123" -> "abc123")
      const machineIdFromTunnel = tunnel.tunnelId.replace(/^remote-agent-/, '');

      // Skip if this is our own tunnel
      if (ownTunnelName && tunnel.tunnelId === ownTunnelName) continue;
      // Fallback: skip if tunnel ID matches our hostname pattern
      if (!ownTunnelName && machineIdFromTunnel === hostname().toLowerCase().replace(/[^a-z0-9]/g, '')) continue;

      // Skip tunnels with no host connections AND no cached presence
      // (never-seen tunnels with 0 connections are truly offline/stale)
      const cached = machineCache.find(m => m.id === machineIdFromTunnel);
      if (tunnel.hostConnections <= 0 && !cached) continue;

      // Determine status: online if hosting, or within grace period of last seen online
      let status: 'online' | 'offline' = 'online';
      if (tunnel.hostConnections <= 0) {
        // Not currently hosting — check grace period
        const lastOnline = cached?.lastSeen ? new Date(cached.lastSeen).getTime() : 0;
        const elapsed = Date.now() - lastOnline;
        if (elapsed > OFFLINE_GRACE_MS) {
          status = 'offline';
          console.log(`[Discovery] ${machineIdFromTunnel}: hostConns=0, grace expired (${Math.round(elapsed/1000)}s ago) → offline`);
        } else {
          console.log(`[Discovery] ${machineIdFromTunnel}: hostConns=0, within grace (${Math.round(elapsed/1000)}s ago) → keeping online`);
        }
      }

      const machine: Machine = {
        id: machineIdFromTunnel,
        name: machineIdFromTunnel,
        tunnelUrl: tunnel.url,
        tunnelId: tunnel.tunnelId,
        status,
        isLocal: false,
        // Only update lastSeen if actually connected (don't reset on blips)
        lastSeen: tunnel.hostConnections > 0 ? new Date().toISOString() : (cached?.lastSeen || new Date().toISOString()),
        machineInfo: {
          hostname: machineIdFromTunnel,
          platform: 'unknown',
          version: 'unknown',
        },
      };

      // Merge with existing cache to preserve richer info from previous discovery
      if (cached) {
        machine.name = cached.name;
        machine.machineInfo = cached.machineInfo || machine.machineInfo;
      }

      machines.push(machine);
    }

    // Check for machines that were previously cached but not found in tunnel list at all
    for (const cached of machineCache) {
      if (cached.isLocal) continue;
      if (!machines.find(m => m.id === cached.id)) {
        // Tunnel no longer exists — check grace period before dropping
        const lastOnline = cached.lastSeen ? new Date(cached.lastSeen).getTime() : 0;
        if (Date.now() - lastOnline <= OFFLINE_GRACE_MS) {
          // Within grace period — keep as online (might be a discovery blip)
          machines.push({ ...cached });
        }
        // Beyond grace period — drop entirely (don't show stale machines)
      }
    }
  } catch (err) {
    console.error('[Discovery] Unexpected error during discovery:', err);
  }

  // Only write to cache if this is still the latest discovery (prevents stale overwrite)
  if (gen === discoveryGeneration) {
    // Only broadcast if the machine list actually changed (prevents UI flicker)
    const prevSummary = machineCache.map(m => `${m.id}:${m.status}`).sort().join(',');
    const newSummary = machines.map(m => `${m.id}:${m.status}`).sort().join(',');

    if (prevSummary !== newSummary) {
      console.log(`[Discovery] Machine list changed: [${prevSummary}] → [${newSummary}]`);
    }

    machineCache = machines;
    cacheTimestamp = Date.now();

    if (prevSummary !== newSummary) {
      broadcast({ type: 'machines-updated' });
    }
  }
  return machines;
}

/**
 * Get cached machines — returns immediately (never blocks the caller).
 * If cache is empty, returns local machine instantly and triggers background discovery.
 * If cache is stale, returns stale cache and triggers background refresh.
 */
export async function getCachedMachines(): Promise<Machine[]> {
  // Cache is fresh — return immediately
  if (machineCache.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return machineCache;
  }

  // Kick off background discovery (deduplicated)
  if (!discoveryInProgress) {
    const thisDiscovery = discoverMachines().finally(() => {
      if (discoveryInProgress === thisDiscovery) {
        discoveryInProgress = null;
      }
    });
    discoveryInProgress = thisDiscovery;
  }

  // Return what we have NOW — don't wait for discovery
  // First call: return just the local machine so the UI is usable immediately
  // Subsequent calls with stale cache: return stale cache (will be updated in background)
  if (machineCache.length > 0) {
    return machineCache;
  }
  return [getLocalMachine()];
}

/**
 * Force refresh — invalidates cache, runs discovery, and waits for result.
 * This is the only call that blocks until discovery completes (used by POST /api/machines/refresh).
 */
export async function refreshMachines(): Promise<Machine[]> {
  cacheTimestamp = 0;
  discoveryInProgress = null;
  // Start fresh discovery
  const thisDiscovery = discoverMachines().finally(() => {
    if (discoveryInProgress === thisDiscovery) {
      discoveryInProgress = null;
    }
  });
  discoveryInProgress = thisDiscovery;
  return thisDiscovery;
}

/**
 * Get a specific machine by ID
 */
export async function getMachine(id: string): Promise<Machine | undefined> {
  const machines = await getCachedMachines();
  return machines.find(m => m.id === id);
}

/**
 * Start the background health monitoring loop.
 * Note: For devtunnel-based machines, health is determined by discovery
 * (hostConnections count), not HTTP identity checks (which require tunnel auth tokens).
 * This health check only runs for machines with direct (non-tunnel) URLs.
 */
export function startHealthMonitoring(): void {
  if (healthInterval) return;

  healthInterval = setInterval(async () => {
    if (machineCache.length <= 1) return; // Only local machine, no need to health-check

    // Capture the current cache reference — only mutate if it hasn't been swapped by discoverMachines()
    const cacheRef = machineCache;
    // Skip devtunnel machines — their status is managed by discovery via hostConnections.
    // HTTP identity checks would fail due to tunnel auth wall.
    const directMachines = cacheRef.filter(m => !m.isLocal && m.tunnelUrl && !m.tunnelId);

    if (directMachines.length === 0) return;

    await Promise.all(
      directMachines.map(async (machine) => {
        const identity = await checkIdentity(machine.tunnelUrl);

        // Only update if the cache hasn't been replaced by a concurrent discovery
        if (machineCache !== cacheRef) return;

        if (identity) {
          machine.status = 'online';
          machine.lastSeen = new Date().toISOString();
          machine.machineInfo = {
            hostname: identity.hostname,
            platform: identity.platform,
            version: identity.version,
          };
        } else {
          machine.status = 'offline';
        }
      })
    );
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop health monitoring
 */
export function stopHealthMonitoring(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}
