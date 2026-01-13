import chokidar from 'chokidar';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { mkdir, readdir, stat } from 'fs/promises';
import { addImage } from './run-store.js';
import type { ImageResult, WsImageEvent } from '../types.js';

type ImageCallback = (event: WsImageEvent) => void;

interface WatcherState {
  watcher: chokidar.FSWatcher | null;
  runId: string | null;
  callback: ImageCallback | null;
}

const state: WatcherState = {
  watcher: null,
  runId: null,
  callback: null,
};

export async function startWatching(
  workspacePath: string,
  runId: string,
  onImage: ImageCallback
): Promise<void> {
  // Stop any existing watcher
  await stopWatching();

  const outputsDir = join(workspacePath, 'outputs');
  
  // Ensure outputs directory exists
  if (!existsSync(outputsDir)) {
    await mkdir(outputsDir, { recursive: true });
  }

  state.runId = runId;
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
    if (state.callback && state.runId) {
      state.callback({
        type: 'image',
        runId: state.runId,
        image,
      });
    }
  });

  state.watcher.on('error', (error) => {
    console.error('File watcher error:', error);
  });

  console.log(`Watching for images in: ${outputsDir}`);
}

export async function stopWatching(): Promise<void> {
  if (state.watcher) {
    await state.watcher.close();
    state.watcher = null;
    state.runId = null;
    state.callback = null;
  }
}

// Scan outputs folder and sync images to run store
export async function syncImagesForRun(
  workspacePath: string,
  runId: string
): Promise<ImageResult[]> {
  const outputsDir = join(workspacePath, 'outputs');
  
  if (!existsSync(outputsDir)) {
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
