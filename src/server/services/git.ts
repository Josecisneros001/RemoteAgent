import { spawn } from 'child_process';
import { dirname } from 'path';
import type { GitChanges, GitFileChange, FileDiff, CommitInfo } from '../types.js';

// Execute a git command and return output
async function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `git command failed with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}

// Check if directory is a git repository
export async function isGitRepo(workspacePath: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], workspacePath);
    return true;
  } catch {
    return false;
  }
}

// Check if path is inside a git repository (checks parent directories)
export async function isInsideGitRepo(path: string): Promise<boolean> {
  try {
    // git rev-parse --is-inside-work-tree returns 'true' if inside a git repo
    const result = await execGit(['rev-parse', '--is-inside-work-tree'], path);
    return result === 'true';
  } catch {
    return false;
  }
}

// Initialize a new git repository
export async function initGitRepo(workspacePath: string): Promise<void> {
  await execGit(['init'], workspacePath);
  // Create initial commit so git branch management works
  await execGit(['commit', '--allow-empty', '-m', 'Initial commit'], workspacePath);
}

// Get current branch name
export async function getCurrentBranch(workspacePath: string): Promise<string> {
  try {
    return await execGit(['branch', '--show-current'], workspacePath);
  } catch {
    return 'unknown';
  }
}

// ==================== BRANCH MANAGEMENT ====================

// Generate a branch name from a prompt (sanitized)
export function generateBranchName(prompt: string): string {
  const timestamp = Date.now();
  // Take first 30 chars of prompt, sanitize for branch name
  const sanitized = prompt
    .toLowerCase()
    .slice(0, 30)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 25);
  return `remote-agent/${sanitized}-${timestamp}`;
}

// Checkout main branch and pull latest
export async function checkoutMainAndPull(workspacePath: string): Promise<void> {
  const isRepo = await isGitRepo(workspacePath);
  if (!isRepo) {
    throw new Error('Not a git repository');
  }
  
  // Checkout main (or master as fallback)
  try {
    await execGit(['checkout', 'main'], workspacePath);
  } catch {
    try {
      await execGit(['checkout', 'master'], workspacePath);
    } catch (e) {
      throw new Error('Could not checkout main or master branch');
    }
  }
  
  // Pull latest
  try {
    await execGit(['pull', 'origin', 'HEAD'], workspacePath);
  } catch (e) {
    // Pull might fail if no remote, that's okay
    console.log('Pull failed (may not have remote):', e);
  }
}

// Create and checkout a new branch
export async function createAndCheckoutBranch(workspacePath: string, branchName: string): Promise<void> {
  await execGit(['checkout', '-b', branchName], workspacePath);
}

// Checkout an existing branch
export async function checkoutBranch(workspacePath: string, branchName: string): Promise<void> {
  await execGit(['checkout', branchName], workspacePath);
}

// Check if a branch exists locally
export async function branchExists(workspacePath: string, branchName: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', branchName], workspacePath);
    return true;
  } catch {
    return false;
  }
}

// Stage all changes
export async function stageAll(workspacePath: string): Promise<void> {
  await execGit(['add', '.'], workspacePath);
}

// Commit with a message
export async function commit(workspacePath: string, message: string): Promise<string> {
  await execGit(['commit', '-m', message], workspacePath);
  // Return the commit hash
  return await execGit(['rev-parse', 'HEAD'], workspacePath);
}

// Push to remote
export async function push(workspacePath: string, branchName: string): Promise<void> {
  try {
    await execGit(['push', '-u', 'origin', branchName], workspacePath);
  } catch (e) {
    // Push might fail if no remote configured
    console.log('Push failed (may not have remote):', e);
    throw e;
  }
}

// Get commit info for a commit hash
export async function getCommitInfo(workspacePath: string, commitHash: string): Promise<CommitInfo> {
  const branch = await getCurrentBranch(workspacePath);
  
  // Get commit details
  const logFormat = '%H|%h|%s|%ci';
  const logOutput = await execGit(['log', '-1', '--format=' + logFormat, commitHash], workspacePath);
  const [hash, shortHash, message, timestamp] = logOutput.split('|');
  
  // Get stats
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  
  try {
    const statsOutput = await execGit(['diff', '--stat', '--numstat', commitHash + '^', commitHash], workspacePath);
    const lines = statsOutput.split('\n').filter(l => l.trim());
    filesChanged = lines.length;
    
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const ins = parseInt(parts[0]) || 0;
        const del = parseInt(parts[1]) || 0;
        insertions += ins;
        deletions += del;
      }
    }
  } catch {
    // Stats might fail for first commit
  }
  
  return {
    hash,
    shortHash,
    message,
    branch,
    timestamp,
    filesChanged,
    insertions,
    deletions,
  };
}

// Check if there are uncommitted changes
export async function hasUncommittedChanges(workspacePath: string): Promise<boolean> {
  try {
    const status = await execGit(['status', '--porcelain'], workspacePath);
    return status.length > 0;
  } catch {
    return false;
  }
}

// Commit all changes and push, return commit info
export async function commitAndPush(
  workspacePath: string, 
  branchName: string, 
  commitMessage: string
): Promise<CommitInfo | null> {
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (!hasChanges) {
    return null;
  }
  
  await stageAll(workspacePath);
  const commitHash = await commit(workspacePath, commitMessage);
  
  try {
    await push(workspacePath, branchName);
  } catch {
    // Push failure is not critical, we still have the local commit
  }
  
  return await getCommitInfo(workspacePath, commitHash);
}

// Get ahead/behind counts
async function getAheadBehind(workspacePath: string): Promise<{ ahead: number; behind: number }> {
  try {
    const output = await execGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], workspacePath);
    const [behind, ahead] = output.split('\t').map(n => parseInt(n) || 0);
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

// Parse git status porcelain output
function parseStatusLine(line: string): GitFileChange | null {
  if (!line || line.length < 3) return null;
  
  const index = line[0];
  const worktree = line[1];
  const path = line.slice(3);
  
  // Determine status
  let status: GitFileChange['status'];
  
  if (index === '?' && worktree === '?') {
    status = 'untracked';
  } else if (index === 'A' || worktree === 'A') {
    status = 'added';
  } else if (index === 'D' || worktree === 'D') {
    status = 'deleted';
  } else if (index === 'R' || worktree === 'R') {
    status = 'renamed';
  } else if (index === 'M' || worktree === 'M') {
    status = 'modified';
  } else {
    status = 'modified';
  }
  
  return { path, status };
}

// Get git changes summary
export async function getGitChanges(workspacePath: string): Promise<GitChanges> {
  const isRepo = await isGitRepo(workspacePath);
  if (!isRepo) {
    return {
      branch: 'not a git repo',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
    };
  }
  
  const branch = await getCurrentBranch(workspacePath);
  const { ahead, behind } = await getAheadBehind(workspacePath);
  
  // Get status with porcelain format
  let statusOutput: string;
  try {
    statusOutput = await execGit(['status', '--porcelain=v1'], workspacePath);
  } catch {
    statusOutput = '';
  }
  
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  
  for (const line of statusOutput.split('\n')) {
    if (!line) continue;
    
    const index = line[0];
    const worktree = line[1];
    const path = line.slice(3);
    
    // Untracked
    if (index === '?' && worktree === '?') {
      untracked.push({ path, status: 'untracked' });
      continue;
    }
    
    // Staged changes (index has a status)
    if (index !== ' ' && index !== '?') {
      let status: GitFileChange['status'] = 'modified';
      if (index === 'A') status = 'added';
      else if (index === 'D') status = 'deleted';
      else if (index === 'R') status = 'renamed';
      else if (index === 'M') status = 'modified';
      
      staged.push({ path, status });
    }
    
    // Unstaged changes (worktree has a status)
    if (worktree !== ' ' && worktree !== '?') {
      let status: GitFileChange['status'] = 'modified';
      if (worktree === 'D') status = 'deleted';
      else if (worktree === 'M') status = 'modified';
      
      unstaged.push({ path, status });
    }
  }
  
  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
  };
}

// Get diff for a specific file
export async function getFileDiff(workspacePath: string, filePath: string, staged = false): Promise<FileDiff> {
  try {
    const args = staged 
      ? ['diff', '--cached', '--', filePath]
      : ['diff', '--', filePath];
    
    const diff = await execGit(args, workspacePath);
    return { path: filePath, diff };
  } catch (error) {
    return { path: filePath, diff: '' };
  }
}

// Get diff for all changes
export async function getAllDiffs(workspacePath: string): Promise<FileDiff[]> {
  const changes = await getGitChanges(workspacePath);
  const diffs: FileDiff[] = [];
  
  // Staged diffs
  for (const file of changes.staged) {
    const diff = await getFileDiff(workspacePath, file.path, true);
    if (diff.diff) diffs.push(diff);
  }
  
  // Unstaged diffs
  for (const file of changes.unstaged) {
    const diff = await getFileDiff(workspacePath, file.path, false);
    if (diff.diff) diffs.push(diff);
  }
  
  return diffs;
}

// Get full diff summary (for showing all changes at once)
export async function getFullDiff(workspacePath: string): Promise<string> {
  try {
    // Get staged diff
    let stagedDiff = '';
    try {
      stagedDiff = await execGit(['diff', '--cached'], workspacePath);
    } catch { /* ignore */ }
    
    // Get unstaged diff
    let unstagedDiff = '';
    try {
      unstagedDiff = await execGit(['diff'], workspacePath);
    } catch { /* ignore */ }
    
    const parts: string[] = [];
    if (stagedDiff) {
      parts.push('=== STAGED CHANGES ===\n' + stagedDiff);
    }
    if (unstagedDiff) {
      parts.push('=== UNSTAGED CHANGES ===\n' + unstagedDiff);
    }
    
    return parts.join('\n\n') || 'No changes';
  } catch (error) {
    return 'Error getting diff';
  }
}

// Clone a repository
export async function cloneRepo(gitUrl: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['clone', gitUrl, targetPath]);
    let stderr = '';
    
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Clone failed with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}
