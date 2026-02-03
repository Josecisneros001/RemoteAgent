import chokidar, { type FSWatcher } from 'chokidar';
import { join, basename } from 'path';
import { mkdir, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { addImage } from './run-store.js';
import { pathExists } from '../utils/fs.js';
import type { ImageResult, WsImageEvent } from '../types.js';

type ImageCallback = (event: WsImageEvent) => void;

interface WatcherState {
  watcher: FSWatcher | null;
  runId: string | null;
  sessionId: string | null;
  callback: ImageCallback | null;
}

const state: WatcherState = {
  watcher: null,
  runId: null,
  sessionId: null,
  callback: null,
};

// Get the outputs directory for a specific run
export function getRunOutputsDir(runId: string): string {
  return join(homedir(), '.remote-agent', 'runs-outputs', runId);
}

export async function startWatching(
  workspacePath: string,
  runId: string,
  sessionId: string,
  onImage: ImageCallback
): Promise<void> {
  // Stop any existing watcher
  await stopWatching();

  const outputsDir = getRunOutputsDir(runId);
  
  // Ensure outputs directory exists
  if (!(await pathExists(outputsDir))) {
    await mkdir(outputsDir, { recursive: true });
  }

  state.runId = runId;
  state.sessionId = sessionId;
  state.callback = onImage;

  state.watcher = chokidar.watch(outputsDir, {
    ignored: /(^|[\/\\])\../, // Ignore dotfiles
    persistent: true,
    ignoreInitial: true, // Don't trigger for existing files
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  state.watcher.on('add', async (filePath: string) => {
    const filename = basename(filePath);
    const ext = filename.toLowerCase().split('.').pop();
    
    // Only process images
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
      return;
    }

    console.log(`New image detected: ${filename}`);

    const image: ImageResult = {
      filename,
      path: filePath,
      timestamp: new Date().toISOString(),
    };

    // Save to run store
    if (state.runId) {
      await addImage(state.runId, image);
    }

    // Notify via callback
    if (state.callback && state.runId && state.sessionId) {
      state.callback({
        type: 'image',
        runId: state.runId,
        sessionId: state.sessionId,
        image,
      });
    }
  });

  state.watcher.on('error', (error: unknown) => {
    console.error('File watcher error:', error);
  });

  console.log(`Watching for images in: ${outputsDir}`);
}

export async function stopWatching(): Promise<void> {
  if (state.watcher) {
    await state.watcher.close();
    state.watcher = null;
    state.runId = null;
    state.sessionId = null;
    state.callback = null;
  }
}

// Scan outputs folder and sync images to run store
export async function syncImagesForRun(
  workspacePath: string,
  runId: string
): Promise<ImageResult[]> {
  const outputsDir = getRunOutputsDir(runId);

  if (!(await pathExists(outputsDir))) {
    return [];
  }

  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const images: ImageResult[] = [];

  try {
    const files = await readdir(outputsDir);
    
    for (const filename of files) {
      const ext = filename.toLowerCase().split('.').pop();
      if (!imageExtensions.includes(ext || '')) continue;
      
      const filePath = join(outputsDir, filename);
      const fileStat = await stat(filePath);
      
      const image: ImageResult = {
        filename,
        path: filePath,
        timestamp: fileStat.mtime.toISOString(),
      };
      
      // Add to run store (addImage handles deduplication)
      await addImage(runId, image);
      images.push(image);
    }
    
    console.log(`Synced ${images.length} images for run ${runId.slice(0, 8)}...`);
  } catch (error) {
    console.error(`Error syncing images for run ${runId}:`, error);
  }

  return images;
}
