import { access } from 'fs/promises';

/** Async check if a path exists */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
