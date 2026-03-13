import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { hostname, platform } from 'os';
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
 * Parse `devtunnel list` output to extract tunnel URLs
 * Output format varies but typically contains tunnel IDs and URLs
 */
export function parseDevtunnelList(output: string): string[] {
  const urls: string[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    // Match URLs that look like devtunnel URLs (e.g., https://xxx.devtunnels.ms/)
    const urlMatch = line.match(/(https?:\/\/[^\s]+\.devtunnels\.ms[^\s]*)/i);
    if (urlMatch) {
      // Clean the URL - remove trailing slashes
      const url = urlMatch[1].replace(/\/+$/, '');
      urls.push(url);
    }
  }

  return [...new Set(urls)]; // Deduplicate
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
  const localMachineId = getLocalMachineId();
  const machines: Machine[] = [localMachine];

  try {
    const devtunnelCmd = resolveDevtunnelCommand();

    // Run devtunnel list to get tunnel URLs
    let output: string;
    try {
      output = execFileSync(devtunnelCmd, ['list'], {
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env },
      });
    } catch (err: any) {
      // devtunnel might not be installed, or not authenticated
      if (err.stderr?.includes('not logged in') || err.stderr?.includes('not authenticated')) {
        console.log('[Discovery] DevTunnel not authenticated, skipping remote discovery');
      } else if (err.code === 'ENOENT') {
        console.log('[Discovery] DevTunnel CLI not found, skipping remote discovery');
      } else {
        console.warn('[Discovery] Failed to list tunnels:', err.message);
      }
      if (gen === discoveryGeneration) {
        machineCache = machines;
        cacheTimestamp = Date.now();
      }
      return machines;
    }

    const tunnelUrls = parseDevtunnelList(output);
    console.log(`[Discovery] Found ${tunnelUrls.length} tunnel URL(s)`);

    // Health-check each tunnel URL in parallel
    const identityChecks = tunnelUrls.map(async (url) => {
      const identity = await checkIdentity(url);
      if (!identity) return null;

      // Skip if this is the local machine
      if (identity.machineId === localMachineId) return null;

      const machine: Machine = {
        id: identity.machineId,
        name: identity.hostname,
        tunnelUrl: url,
        status: 'online',
        isLocal: false,
        lastSeen: new Date().toISOString(),
        machineInfo: {
          hostname: identity.hostname,
          platform: identity.platform,
          version: identity.version,
        },
      };
      return machine;
    });

    const results = await Promise.all(identityChecks);
    for (const machine of results) {
      if (machine) {
        // Merge with existing cache to preserve lastSeen for machines that went offline
        const cached = machineCache.find(m => m.id === machine.id);
        if (cached && cached.status === 'offline') {
          // Machine came back online
          machine.lastSeen = new Date().toISOString();
        }
        machines.push(machine);
      }
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
    machineCache = machines;
    cacheTimestamp = Date.now();
  }
  return machines;
}

/**
 * Get cached machines (returns cache if still valid, otherwise re-discovers with dedup lock)
 */
export async function getCachedMachines(): Promise<Machine[]> {
  if (machineCache.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return machineCache;
  }
  // Deduplicate concurrent discovery requests
  if (!discoveryInProgress) {
    const thisDiscovery = discoverMachines().finally(() => {
      // Only clear if this is still the current discovery (prevents race with refreshMachines)
      if (discoveryInProgress === thisDiscovery) {
        discoveryInProgress = null;
      }
    });
    discoveryInProgress = thisDiscovery;
  }
  return discoveryInProgress;
}

/**
 * Force refresh — invalidates cache and re-discovers (uses dedup lock)
 */
export async function refreshMachines(): Promise<Machine[]> {
  cacheTimestamp = 0;
  discoveryInProgress = null; // Discard any stale in-flight reference
  return getCachedMachines();
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
