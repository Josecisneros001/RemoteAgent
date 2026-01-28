import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Config, WorkspaceConfig } from '../types.js';

const CONFIG_DIR = join(homedir(), '.remote-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  workspaces: [],
  port: 3000,
};

let cachedConfig: Config | null = null;

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }

  const sessionsDir = join(CONFIG_DIR, 'sessions');
  if (!existsSync(sessionsDir)) {
    await mkdir(sessionsDir, { recursive: true });
  }

  const runsDir = join(CONFIG_DIR, 'runs');
  if (!existsSync(runsDir)) {
    await mkdir(runsDir, { recursive: true });
  }
}

export async function loadConfig(): Promise<Config> {
  await ensureConfigDir();

  if (!existsSync(CONFIG_PATH)) {
    // Create default config
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`Created default config at ${CONFIG_PATH}`);
    cachedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }

  try {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    const loaded = JSON.parse(content);

    const mergedConfig = { ...DEFAULT_CONFIG, ...loaded };
    cachedConfig = mergedConfig;
    return mergedConfig;
  } catch (error) {
    console.error('Error loading config, using defaults:', error);
    cachedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
}

export function getConfig(): Config {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

export async function updateConfig(updates: Partial<Config>): Promise<Config> {
  const current = getConfig();
  const updated = { ...current, ...updates };
  await writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2));
  cachedConfig = updated;
  return updated;
}

export function getWorkspace(id: string): WorkspaceConfig | undefined {
  const config = getConfig();
  return config.workspaces.find(w => w.id === id);
}

export async function addWorkspace(workspace: WorkspaceConfig): Promise<void> {
  const config = getConfig();

  // Check if workspace with same ID exists
  const existing = config.workspaces.findIndex(w => w.id === workspace.id);
  if (existing >= 0) {
    config.workspaces[existing] = workspace;
  } else {
    config.workspaces.push(workspace);
  }

  await updateConfig({ workspaces: config.workspaces });
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
