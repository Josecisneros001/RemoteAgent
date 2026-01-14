import { spawn, type ChildProcess } from 'child_process';
import { getConfig } from './config.js';
import { 
  createSession, getSession, updateSessionCopilotId, updateSessionValidationId, updateSessionOutputId,
  createRun, updateRunPhase, appendLog, updateValidation, getRun, getIncompleteRuns, updateRunCommit 
} from './run-store.js';
import { startWatching, stopWatching, getRunOutputsDir } from './image-watcher.js';
import { sendNotification } from './push.js';
import { 
  isGitRepo, generateBranchName, checkoutMainAndPull, createAndCheckoutBranch, 
  checkoutBranch, branchExists, commitAndPush 
} from './git.js';
import type { Session, Run, RunPhase, LogEntry, WsEvent, ValidationResult, WorkspaceConfig } from '../types.js';

type EventCallback = (event: WsEvent) => void;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

let currentProcess: ChildProcess | null = null;
let currentRunId: string | null = null;
let currentSessionId: string | null = null;
let isRecovering = false;

function createLogEntry(phase: RunPhase, type: 'stdout' | 'stderr' | 'system', content: string): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    phase,
    type,
    content,
  };
}

// Extract session ID from copilot output
function extractSessionId(output: string): string | null {
  const patterns = [
    /session[:\s]+([a-zA-Z0-9_-]+)/i,
    /resuming\s+session\s+([a-zA-Z0-9_-]+)/i,
    /session\s+id[:\s]+([a-zA-Z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[1];
  }
  return null;
}

interface PhaseOptions {
  resumeSession?: string;        // Copilot session ID to resume
  model?: string;
  mcps?: string[];
}

// Resolve model for a specific phase using cascade: Run → Session → Workspace → Global
function resolveModelForPhase(
  phase: 'prompt' | 'validation' | 'output',
  run: Run,
  session: Session,
  workspaceConfig?: WorkspaceConfig
): string {
  const config = getConfig();
  
  if (phase === 'prompt') {
    return run.model || session.defaultModel || workspaceConfig?.defaultModel || config.defaultModel;
  } else if (phase === 'validation') {
    return run.validationModel || session.validationModel || workspaceConfig?.validationModel || config.defaultValidationModel;
  } else { // output
    return run.outputModel || session.outputModel || workspaceConfig?.outputModel || config.defaultOutputModel;
  }
}

async function runCopilotPhase(
  run: Run,
  session: Session,
  phase: RunPhase,
  prompt: string,
  onEvent: EventCallback,
  options: PhaseOptions = {},
  workspaceConfig?: WorkspaceConfig
): Promise<{ success: boolean; copilotSessionId?: string }> {
  const config = getConfig();
  // Determine which phase type for model resolution
  const phaseType: 'prompt' | 'validation' | 'output' = 
    phase === 'validation' ? 'validation' : 
    phase === 'output' ? 'output' : 'prompt';
  const model = options.model || resolveModelForPhase(phaseType, run, session, workspaceConfig);
  
  // Update phase
  await updateRunPhase(run.id, phase);
  onEvent({ type: 'phase', runId: run.id, sessionId: session.id, phase });

  const phaseLabel = options.resumeSession ? `${phase} (resuming session)` : phase;
  const systemLog = createLogEntry(phase, 'system', `Starting ${phaseLabel} phase with model: ${model}...`);
  await appendLog(run.id, systemLog);
  onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: systemLog });

  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--model', model,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-color',
    ];

    // Resume session if provided
    if (options.resumeSession) {
      args.push('--resume', options.resumeSession);
      const resumeLog = createLogEntry(phase, 'system', `Resuming Copilot session: ${options.resumeSession}`);
      appendLog(run.id, resumeLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: resumeLog });
    }

    currentProcess = spawn('copilot', args, {
      cwd: session.workspacePath,
      env: {
        ...process.env,
        COPILOT_ALLOW_ALL: 'true',
      },
    });

    let fullOutput = '';
    let capturedSessionId: string | null = null;

    currentProcess.stdout?.on('data', async (data: Buffer) => {
      const content = data.toString();
      fullOutput += content;
      if (!capturedSessionId) {
        capturedSessionId = extractSessionId(content);
      }
      const entry = createLogEntry(phase, 'stdout', content);
      await appendLog(run.id, entry);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry });
    });

    currentProcess.stderr?.on('data', async (data: Buffer) => {
      const content = data.toString();
      fullOutput += content;
      const entry = createLogEntry(phase, 'stderr', content);
      await appendLog(run.id, entry);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry });
    });

    currentProcess.on('close', async (code) => {
      currentProcess = null;
      const success = code === 0;
      
      const exitLog = createLogEntry(
        phase,
        'system',
        `Phase ${phase} ${success ? 'completed' : 'failed'} (exit code: ${code})`
      );
      await appendLog(run.id, exitLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: exitLog });

      resolve({ success, copilotSessionId: capturedSessionId || undefined });
    });

    currentProcess.on('error', async (error) => {
      currentProcess = null;
      const errorLog = createLogEntry(phase, 'system', `Error: ${error.message}`);
      await appendLog(run.id, errorLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: errorLog });
      resolve({ success: false });
    });
  });
}

// Retry wrapper for phase execution
async function runCopilotPhaseWithRetry(
  run: Run,
  session: Session,
  phase: RunPhase,
  prompt: string,
  onEvent: EventCallback,
  options: PhaseOptions = {},
  workspaceConfig?: WorkspaceConfig
): Promise<{ success: boolean; copilotSessionId?: string }> {
  let lastResult: { success: boolean; copilotSessionId?: string } = { success: false };
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const retryLog = createLogEntry(phase, 'system', 
        `⚠️ Retry attempt ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms delay...`);
      await appendLog(run.id, retryLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: retryLog });
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
    
    lastResult = await runCopilotPhase(run, session, phase, prompt, onEvent, options, workspaceConfig);
    
    if (lastResult.success) {
      if (attempt > 1) {
        const successLog = createLogEntry(phase, 'system', 
          `✅ Phase succeeded on attempt ${attempt}`);
        await appendLog(run.id, successLog);
        onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: successLog });
      }
      return lastResult;
    }
  }
  
  const failLog = createLogEntry(phase, 'system', 
    `❌ Phase failed after ${MAX_RETRIES} attempts`);
  await appendLog(run.id, failLog);
  onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: failLog });
  
  return lastResult;
}

// Create a new session and start first run
export async function startNewSession(
  workspaceId: string,
  prompt: string,
  options: {
    validationPrompt?: string;
    outputPrompt?: string;
    model?: string;
    validationModel?: string;
    outputModel?: string;
    enabledMcps?: string[];
  },
  onEvent: EventCallback
): Promise<{ session: Session; run: Run }> {
  const config = getConfig();
  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  // Git branch setup for new session
  const branchName = generateBranchName(prompt);
  const isRepo = await isGitRepo(workspace.path);
  
  if (isRepo) {
    try {
      // Checkout main and pull latest
      await checkoutMainAndPull(workspace.path);
      // Create new branch for this session
      await createAndCheckoutBranch(workspace.path, branchName);
    } catch (error) {
      console.error('Git branch setup failed:', error);
      // Continue without git, but log the error
    }
  }

  // Create session with branch name
  const session = await createSession(workspaceId, prompt, branchName, options);
  currentSessionId = session.id;
  
  // Create first run
  const run = await createRun(session.id, prompt, options);
  currentRunId = run.id;

  // Start image watcher
  await startWatching(session.workspacePath, run.id, session.id, onEvent);

  // Execute phases
  executePhases(session, run, onEvent);

  return { session, run };
}

// Continue existing session with new run
export async function continueSession(
  sessionId: string,
  prompt: string,
  options: {
    validationPrompt?: string;
    outputPrompt?: string;
    model?: string;
    validationModel?: string;
    outputModel?: string;
    enabledMcps?: string[];
  },
  onEvent: EventCallback
): Promise<Run> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  
  currentSessionId = session.id;
  
  // Git: checkout the session's branch
  const isRepo = await isGitRepo(session.workspacePath);
  if (isRepo && session.branchName) {
    try {
      const exists = await branchExists(session.workspacePath, session.branchName);
      if (exists) {
        await checkoutBranch(session.workspacePath, session.branchName);
      } else {
        console.warn(`Branch ${session.branchName} no longer exists`);
      }
    } catch (error) {
      console.error('Git branch checkout failed:', error);
    }
  }
  
  // Update session defaults if overrides provided
  if (options.validationPrompt) {
    session.defaultValidationPrompt = options.validationPrompt;
  }
  if (options.outputPrompt) {
    session.defaultOutputPrompt = options.outputPrompt;
  }
  
  // Create new run
  const run = await createRun(session.id, prompt, options);
  currentRunId = run.id;

  // Start image watcher
  await startWatching(session.workspacePath, run.id, session.id, onEvent);

  // Execute phases
  executePhases(session, run, onEvent);

  return run;
}

async function executePhases(session: Session, run: Run, onEvent: EventCallback, startFromPhase?: RunPhase): Promise<void> {
  const config = getConfig();
  const workspaceConfig = config.workspaces.find(w => w.id === session.workspaceId);
  
  try {
    const skipPrompt = startFromPhase && startFromPhase !== 'prompt' && startFromPhase !== 'pending';
    const skipValidation = startFromPhase && (startFromPhase === 'output');
    
    // Phase 1: User Prompt (reuses main session if exists)
    if (!skipPrompt) {
      const promptResult = await runCopilotPhaseWithRetry(run, session, 'prompt', run.prompt, onEvent, {
        resumeSession: session.copilotSessionId,
        model: run.model,
        mcps: run.enabledMcps,
      }, workspaceConfig);
      
      if (!promptResult.success) {
        await handleFailure(session, run, 'Prompt execution failed after retries', onEvent);
        return;
      }

      // Store/update copilot session ID
      if (promptResult.copilotSessionId) {
        await updateSessionCopilotId(session.id, promptResult.copilotSessionId);
        const sessionLog = createLogEntry('prompt', 'system', `Copilot Session ID: ${promptResult.copilotSessionId}`);
        await appendLog(run.id, sessionLog);
        onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: sessionLog });
      }

      // Git: Commit changes after prompt phase
      await commitRunChanges(session, run, onEvent);
    }

    // Phase 2: Validation (uses hidden validation session)
    const validationPrompt = run.validationPrompt || session.defaultValidationPrompt;
    if (!skipValidation && validationPrompt?.trim()) {
      const isolationNote = createLogEntry('validation', 'system', 
        '⚠️ Running validation in separate session (preserving main context)');
      await appendLog(run.id, isolationNote);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: isolationNote });
      
      const validationResult: ValidationResult = {
        status: 'running',
        output: '',
        timestamp: new Date().toISOString(),
      };
      await updateValidation(run.id, validationResult);
      onEvent({ type: 'validation', runId: run.id, sessionId: session.id, validation: validationResult });

      const validationPhase = await runCopilotPhaseWithRetry(run, session, 'validation', validationPrompt, onEvent, {
        resumeSession: session.validationSessionId,  // Reuse validation session
        mcps: run.enabledMcps,
      }, workspaceConfig);
      
      // Store validation session ID for reuse
      if (validationPhase.copilotSessionId) {
        await updateSessionValidationId(session.id, validationPhase.copilotSessionId);
      }
      
      // Get latest run to capture validation output from logs
      const latestRun = await getRun(run.id);
      const validationLogs = latestRun?.logs
        .filter(l => l.phase === 'validation' && l.type === 'stdout')
        .map(l => l.content)
        .join('') || '';

      const finalValidation: ValidationResult = {
        status: validationPhase.success ? 'passed' : 'failed',
        output: validationLogs,
        timestamp: new Date().toISOString(),
      };
      await updateValidation(run.id, finalValidation);
      onEvent({ type: 'validation', runId: run.id, sessionId: session.id, validation: finalValidation });

      if (!validationPhase.success) {
        await handleFailure(session, run, 'Validation failed after retries', onEvent);
        return;
      }
    } else if (!skipValidation) {
      // No validation prompt - mark as skipped
      const skippedValidation: ValidationResult = {
        status: 'skipped',
        output: 'No validation prompt configured',
        timestamp: new Date().toISOString(),
      };
      await updateValidation(run.id, skippedValidation);
      onEvent({ type: 'validation', runId: run.id, sessionId: session.id, validation: skippedValidation });
    }

    // Phase 3: Output Generation (uses hidden output session)
    const outputPrompt = run.outputPrompt || session.defaultOutputPrompt;
    if (outputPrompt?.trim()) {
      const isolationNote = createLogEntry('output', 'system', 
        '⚠️ Running output generation in separate session (preserving main context)');
      await appendLog(run.id, isolationNote);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: isolationNote });
      
      // Augment prompt with the output directory path
      const outputsDir = getRunOutputsDir(run.id);
      const augmentedOutputPrompt = `${outputPrompt}\n\nIMPORTANT: Save all generated images/screenshots to this directory: ${outputsDir}`;
      
      const outputPhase = await runCopilotPhaseWithRetry(run, session, 'output', augmentedOutputPrompt, onEvent, {
        resumeSession: session.outputSessionId,  // Reuse output session
        mcps: run.enabledMcps,
      }, workspaceConfig);
      
      // Store output session ID for reuse
      if (outputPhase.copilotSessionId) {
        await updateSessionOutputId(session.id, outputPhase.copilotSessionId);
      }
      
      if (!outputPhase.success) {
        await handleFailure(session, run, 'Output generation failed after retries', onEvent);
        return;
      }
    } else {
      // No output prompt - log that it was skipped
      const skippedNote = createLogEntry('output', 'system', 
        'Image generation skipped - no output prompt configured');
      await appendLog(run.id, skippedNote);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: skippedNote });
    }

    // Success
    await updateRunPhase(run.id, 'completed');
    onEvent({ type: 'phase', runId: run.id, sessionId: session.id, phase: 'completed' });
    onEvent({ type: 'complete', runId: run.id, sessionId: session.id, status: 'completed' });

    // Send push notification
    await sendNotification(
      '✅ Run Complete',
      `Prompt: ${run.prompt.slice(0, 50)}...`,
      { runId: run.id, sessionId: session.id }
    );

  } catch (error) {
    await handleFailure(session, run, error instanceof Error ? error.message : 'Unknown error', onEvent);
  } finally {
    await stopWatching();
    currentRunId = null;
    currentSessionId = null;
  }
}

// Commit all changes after prompt phase
async function commitRunChanges(session: Session, run: Run, onEvent: EventCallback): Promise<void> {
  const isRepo = await isGitRepo(session.workspacePath);
  if (!isRepo) {
    return;
  }

  try {
    // Generate commit message from prompt (first 50 chars)
    const promptSummary = run.prompt
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
    const commitMessage = `RemoteAgent: ${promptSummary}`;
    
    const commitLog = createLogEntry('prompt', 'system', '📦 Committing changes to git...');
    await appendLog(run.id, commitLog);
    onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: commitLog });

    const commitInfo = await commitAndPush(session.workspacePath, session.branchName, commitMessage);
    
    if (commitInfo) {
      // Store commit info on the run
      await updateRunCommit(run.id, commitInfo);
      
      const successLog = createLogEntry('prompt', 'system', 
        `✅ Committed: ${commitInfo.shortHash} - ${commitInfo.filesChanged} file(s) changed (+${commitInfo.insertions}/-${commitInfo.deletions})`);
      await appendLog(run.id, successLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: successLog });
      
      const pushLog = createLogEntry('prompt', 'system', 
        `🚀 Pushed to branch: ${commitInfo.branch}`);
      await appendLog(run.id, pushLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: pushLog });
    } else {
      const noChangesLog = createLogEntry('prompt', 'system', 'ℹ️ No changes to commit');
      await appendLog(run.id, noChangesLog);
      onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: noChangesLog });
    }
  } catch (error) {
    const errorLog = createLogEntry('prompt', 'system', 
      `⚠️ Git commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    await appendLog(run.id, errorLog);
    onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: errorLog });
  }
}

async function handleFailure(session: Session, run: Run, error: string, onEvent: EventCallback): Promise<void> {
  await updateRunPhase(run.id, 'failed', error);
  onEvent({ type: 'phase', runId: run.id, sessionId: session.id, phase: 'failed' });
  onEvent({ type: 'error', runId: run.id, sessionId: session.id, error });
  onEvent({ type: 'complete', runId: run.id, sessionId: session.id, status: 'failed' });

  // Send push notification
  await sendNotification(
    '❌ Run Failed',
    `Error: ${error}`,
    { runId: run.id, sessionId: session.id }
  );
}

export function abortCurrentRun(): boolean {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
    return true;
  }
  return false;
}

export function getCurrentRunId(): string | null {
  return currentRunId;
}

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

// Resume an incomplete run from where it left off
export async function resumeRun(
  runId: string,
  onEvent: EventCallback
): Promise<Run | null> {
  const run = await getRun(runId);
  if (!run) {
    console.error(`[Recovery] Run ${runId} not found`);
    return null;
  }
  
  if (run.status === 'completed' || run.status === 'failed') {
    console.log(`[Recovery] Run ${runId} already in terminal state: ${run.status}`);
    return run;
  }
  
  const session = await getSession(run.sessionId);
  if (!session) {
    console.error(`[Recovery] Session ${run.sessionId} not found for run ${runId}`);
    return null;
  }
  
  console.log(`[Recovery] Resuming run ${runId} from phase: ${run.status}`);
  currentRunId = run.id;
  currentSessionId = session.id;
  
  // Add recovery note to logs
  const recoveryLog = createLogEntry(run.status as RunPhase, 'system', 
    `🔄 Recovering run from ${run.status} phase...`);
  await appendLog(run.id, recoveryLog);
  onEvent({ type: 'log', runId: run.id, sessionId: session.id, entry: recoveryLog });
  
  // Start image watcher
  await startWatching(session.workspacePath, run.id, session.id, onEvent);
  
  // Resume from current phase
  await executePhases(session, run, onEvent, run.status as RunPhase);
  
  return run;
}

// Recover all incomplete runs on server startup
export async function recoverIncompleteRuns(
  onEvent: EventCallback
): Promise<void> {
  if (isRecovering) {
    console.log('[Recovery] Already recovering, skipping...');
    return;
  }
  
  isRecovering = true;
  
  try {
    const incompleteRuns = await getIncompleteRuns();
    
    if (incompleteRuns.length === 0) {
      console.log('[Recovery] No incomplete runs to recover');
      return;
    }
    
    console.log(`[Recovery] Found ${incompleteRuns.length} incomplete run(s)`);
    
    for (const run of incompleteRuns) {
      console.log(`[Recovery] Processing run ${run.id} (status: ${run.status})`);
      
      try {
        await resumeRun(run.id, onEvent);
        console.log(`[Recovery] Run ${run.id} recovery completed`);
      } catch (error) {
        console.error(`[Recovery] Failed to recover run ${run.id}:`, error);
        
        // Mark as failed if recovery fails
        await updateRunPhase(run.id, 'failed', `Recovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        const session = await getSession(run.sessionId);
        if (session) {
          onEvent({ type: 'phase', runId: run.id, sessionId: session.id, phase: 'failed' });
          onEvent({ type: 'error', runId: run.id, sessionId: session.id, error: 'Recovery failed' });
          onEvent({ type: 'complete', runId: run.id, sessionId: session.id, status: 'failed' });
        }
      }
    }
  } finally {
    isRecovering = false;
  }
}

export function isRecoveringRuns(): boolean {
  return isRecovering;
}
