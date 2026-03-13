import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { hostname, platform } from 'os';
import { getConfig } from './config.js';
import { broadcast } from './websocket.js';
import type { Machine, IdentityResponse } from '../types.js';

// Cache for discovered machines
let machineCache: Machine[] = [];
let cacheTimestamp = 0;
let discoveryInProgress: Promise<Machine[]> | null = null;
let discoveryGeneration = 0; // Prevents stale discovery from overwriting newer results
const CACHE_TTL_MS = 30_000; // 30 seconds

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
  const host = hostname();
  return {
    id: 'local',
    name: host,
    tunnelUrl: '',
    status: 'online',
    isLocal: true,
    lastSeen: new Date().toISOString(),
    machineInfo: {
      hostname: host,
      platform: platform(),
      version: '1.0.0',
    },
  };
}

/**
 * Resolve devtunnel command path (reuses pattern from pty-manager.ts)
 */
function resolveDevtunnelCommand(): string {
  // Check common install locations first (Docker installs to /root/bin/)
  const knownPaths = ['/root/bin/devtunnel', '/usr/local/bin/devtunnel'];
  for (const p of knownPaths) {
    try {
      execFileSync(p, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
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
      if (cmdOrExe) return cmdOrExe;
    }

    if (lines[0]) return lines[0];
  } catch {
    // devtunnel not installed
  }
  return 'devtunnel';
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
 */
function discoverTunnels(devtunnelCmd: string): TunnelInfo[] {
  // Step 1: Get tunnel IDs via JSON list
  let listOutput: string;
  try {
    listOutput = execFileSync(devtunnelCmd, ['list', '--json'], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
  } catch (err: any) {
    console.warn(`[Discovery] devtunnel list failed: ${err.message?.substring(0, 80)}`);
    return [];
  }

  let tunnelIds: string[];
  try {
    const json = JSON.parse(listOutput);
    tunnelIds = (json.tunnels || []).map((t: { tunnelId?: string }) => t.tunnelId).filter(Boolean);
  } catch {
    console.warn('[Discovery] Failed to parse devtunnel list JSON');
    return [];
  }

  if (tunnelIds.length === 0) {
    console.log('[Discovery] No tunnels found in devtunnel list');
    return [];
  }
  console.log(`[Discovery] Found ${tunnelIds.length} tunnel(s), resolving details...`);

  // Step 2: Get details for each tunnel via `devtunnel show --json`
  const tunnels: TunnelInfo[] = [];
  for (const tunnelId of tunnelIds) {
    const id = tunnelId.split('.')[0];
    try {
      const showOutput = execFileSync(devtunnelCmd, ['show', id, '--json'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const showJson = JSON.parse(showOutput);
      const tunnel = showJson?.tunnel;
      if (!tunnel) continue;

      const hostConns = tunnel.hostConnections ?? 0;
      const ports = tunnel.ports || [];
      for (const port of ports) {
        if (port.portUri && port.portNumber === 3000) {
          tunnels.push({
            tunnelId: id,
            url: port.portUri.replace(/\/+$/, ''),
            hostConnections: hostConns,
          });
        }
      }
    } catch (err: any) {
      console.warn(`[Discovery] Failed to get details for tunnel ${id}: ${err.message?.substring(0, 80)}`);
    }
  }

  return tunnels;
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

    // Discover tunnels via devtunnel CLI (no HTTP calls needed — uses CLI JSON output)
    const tunnels = discoverTunnels(devtunnelCmd);
    console.log(`[Discovery] Found ${tunnels.length} tunnel(s) with port 3000`);

    // Get our own tunnel name from config to skip ourselves in discovery
    let ownTunnelName: string | undefined;
    try {
      ownTunnelName = getConfig().tunnelName;
    } catch {
      // Config not loaded yet — fall back to hostname matching
    }

    for (const tunnel of tunnels) {
      // Only show tunnels that are actively hosted (skip disconnected/stale tunnels)
      if (tunnel.hostConnections <= 0) continue;

      // Derive a machine ID from the tunnel ID (e.g., "remote-agent-abc123" -> "abc123")
      const machineIdFromTunnel = tunnel.tunnelId.replace(/^remote-agent-/, '');

      // Skip if this is our own tunnel
      if (ownTunnelName && tunnel.tunnelId === ownTunnelName) continue;
      // Fallback: skip if tunnel ID matches our hostname pattern
      if (!ownTunnelName && machineIdFromTunnel === hostname().toLowerCase().replace(/[^a-z0-9]/g, '')) continue;

      const machine: Machine = {
        id: machineIdFromTunnel,
        name: machineIdFromTunnel,
        tunnelUrl: tunnel.url,
        status: 'online',
        isLocal: false,
        lastSeen: new Date().toISOString(),
        machineInfo: {
          hostname: machineIdFromTunnel,
          platform: 'unknown',
          version: 'unknown',
        },
      };

      // Merge with existing cache to preserve richer info from previous identity checks
      const cached = machineCache.find(m => m.id === machine.id);
      if (cached) {
        machine.name = cached.name;
        machine.machineInfo = cached.machineInfo || machine.machineInfo;
      }

      machines.push(machine);
    }

    // Check for machines that were previously online but not found this time
    for (const cached of machineCache) {
      if (cached.isLocal) continue;
      if (!machines.find(m => m.id === cached.id)) {
        // Machine went offline — keep it in the list with offline status
        machines.push({
          ...cached,
          status: 'offline',
        });
      }
    }
  } catch (err) {
    console.error('[Discovery] Unexpected error during discovery:', err);
  }

  // Only write to cache if this is still the latest discovery (prevents stale overwrite)
  if (gen === discoveryGeneration) {
    const hadRemoteBefore = machineCache.some(m => !m.isLocal);
    machineCache = machines;
    cacheTimestamp = Date.now();

    // Notify connected clients when remote machines are discovered (or list changes)
    const hasRemoteNow = machines.some(m => !m.isLocal);
    if (hasRemoteNow || hadRemoteBefore) {
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
 * Start the background health monitoring loop
 */
export function startHealthMonitoring(): void {
  if (healthInterval) return;

  healthInterval = setInterval(async () => {
    if (machineCache.length <= 1) return; // Only local machine, no need to health-check

    // Capture the current cache reference — only mutate if it hasn't been swapped by discoverMachines()
    const cacheRef = machineCache;
    const remoteMachines = cacheRef.filter(m => !m.isLocal && m.tunnelUrl);

    await Promise.all(
      remoteMachines.map(async (machine) => {
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
