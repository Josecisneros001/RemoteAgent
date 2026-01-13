import { spawn, type ChildProcess } from 'child_process';
import { getConfig } from './config.js';
import { createRun, updateRunPhase, appendLog, updateValidation, getRun, updateSessionId, getIncompleteRuns } from './run-store.js';
import { startWatching, stopWatching } from './image-watcher.js';
import { sendNotification } from './push.js';
import type { Run, RunPhase, LogEntry, WsEvent, ValidationResult } from '../types.js';

type EventCallback = (event: WsEvent) => void;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

let currentProcess: ChildProcess | null = null;
let currentRunId: string | null = null;
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
  continueSession?: string;
  isolatedSession?: boolean;
}

async function runCopilotPhase(
  run: Run,
  phase: RunPhase,
  prompt: string,
  onEvent: EventCallback,
  options: PhaseOptions = {}
): Promise<{ success: boolean; sessionId?: string }> {
  const config = getConfig();
  
  // Update phase
  await updateRunPhase(run.id, phase);
  onEvent({ type: 'phase', runId: run.id, phase });

  const phaseLabel = options.isolatedSession ? `${phase} (isolated session)` : phase;
  const systemLog = createLogEntry(phase, 'system', `Starting ${phaseLabel} phase...`);
  await appendLog(run.id, systemLog);
  onEvent({ type: 'log', runId: run.id, entry: systemLog });

  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--model', config.model,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-color',
    ];

    // Handle session continuation for main prompt phase
    if (options.continueSession && !options.isolatedSession) {
      args.push('--resume', options.continueSession);
      const resumeLog = createLogEntry(phase, 'system', `Resuming session: ${options.continueSession}`);
      appendLog(run.id, resumeLog);
      onEvent({ type: 'log', runId: run.id, entry: resumeLog });
    }

    currentProcess = spawn('copilot', args, {
      cwd: run.workspacePath,
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
      onEvent({ type: 'log', runId: run.id, entry });
    });

    currentProcess.stderr?.on('data', async (data: Buffer) => {
      const content = data.toString();
      fullOutput += content;
      const entry = createLogEntry(phase, 'stderr', content);
      await appendLog(run.id, entry);
      onEvent({ type: 'log', runId: run.id, entry });
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
      onEvent({ type: 'log', runId: run.id, entry: exitLog });

      resolve({ success, sessionId: capturedSessionId || undefined });
    });

    currentProcess.on('error', async (error) => {
      currentProcess = null;
      const errorLog = createLogEntry(phase, 'system', `Error: ${error.message}`);
      await appendLog(run.id, errorLog);
      onEvent({ type: 'log', runId: run.id, entry: errorLog });
      resolve({ success: false });
    });
  });
}

// Retry wrapper for phase execution
async function runCopilotPhaseWithRetry(
  run: Run,
  phase: RunPhase,
  prompt: string,
  onEvent: EventCallback,
  options: PhaseOptions = {}
): Promise<{ success: boolean; sessionId?: string }> {
  let lastResult: { success: boolean; sessionId?: string } = { success: false };
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      const retryLog = createLogEntry(phase, 'system', 
        `⚠️ Retry attempt ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms delay...`);
      await appendLog(run.id, retryLog);
      onEvent({ type: 'log', runId: run.id, entry: retryLog });
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
    
    lastResult = await runCopilotPhase(run, phase, prompt, onEvent, options);
    
    if (lastResult.success) {
      if (attempt > 1) {
        const successLog = createLogEntry(phase, 'system', 
          `✅ Phase succeeded on attempt ${attempt}`);
        await appendLog(run.id, successLog);
        onEvent({ type: 'log', runId: run.id, entry: successLog });
      }
      return lastResult;
    }
  }
  
  const failLog = createLogEntry(phase, 'system', 
    `❌ Phase failed after ${MAX_RETRIES} attempts`);
  await appendLog(run.id, failLog);
  onEvent({ type: 'log', runId: run.id, entry: failLog });
  
  return lastResult;
}

export async function startRun(
  workspaceId: string,
  prompt: string,
  validationInstructions: string,
  imageInstructions: string,
  onEvent: EventCallback,
  continueSession?: string
): Promise<Run> {
  // Create run record
  const run = await createRun(workspaceId, prompt, validationInstructions, imageInstructions, continueSession);
  currentRunId = run.id;

  // Start image watcher
  await startWatching(run.workspacePath, run.id, onEvent);

  // Execute phases
  executePhases(run, onEvent, continueSession);

  return run;
}

async function executePhases(run: Run, onEvent: EventCallback, continueSession?: string, startFromPhase?: RunPhase): Promise<void> {
  try {
    const skipPrompt = startFromPhase && startFromPhase !== 'prompt' && startFromPhase !== 'pending';
    const skipValidation = startFromPhase && (startFromPhase === 'output');
    
    // Phase 1: User Prompt (can continue existing session)
    if (!skipPrompt) {
      const promptResult = await runCopilotPhaseWithRetry(run, 'prompt', run.prompt, onEvent, {
        continueSession,
      });
      
      if (!promptResult.success) {
        await handleFailure(run, 'Prompt execution failed after retries', onEvent);
        return;
      }

      // Store session ID if captured
      if (promptResult.sessionId) {
        await updateSessionId(run.id, promptResult.sessionId);
        const sessionLog = createLogEntry('prompt', 'system', `Session ID: ${promptResult.sessionId}`);
        await appendLog(run.id, sessionLog);
        onEvent({ type: 'log', runId: run.id, entry: sessionLog });
      }
    }

    // Phase 2: Validation (ISOLATED SESSION)
    // Run if validation instructions were provided (from UI, pre-filled from workspace defaults)
    if (!skipValidation && run.validationInstructions.trim()) {
      const validationPrompt = run.validationInstructions;
      
      const isolationNote = createLogEntry('validation', 'system', 
        '⚠️ Running in isolated session to preserve main context');
      await appendLog(run.id, isolationNote);
      onEvent({ type: 'log', runId: run.id, entry: isolationNote });
      
      const validationResult: ValidationResult = {
        status: 'running',
        output: '',
        timestamp: new Date().toISOString(),
      };
      await updateValidation(run.id, validationResult);
      onEvent({ type: 'validation', runId: run.id, validation: validationResult });

      const validationPhase = await runCopilotPhaseWithRetry(run, 'validation', validationPrompt, onEvent, {
        isolatedSession: true,
      });
      
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
      onEvent({ type: 'validation', runId: run.id, validation: finalValidation });

      if (!validationPhase.success) {
        await handleFailure(run, 'Validation failed after retries', onEvent);
        return;
      }
    } else if (!skipValidation) {
      // No validation instructions - mark as skipped
      const skippedValidation: ValidationResult = {
        status: 'skipped',
        output: 'No validation prompt configured',
        timestamp: new Date().toISOString(),
      };
      await updateValidation(run.id, skippedValidation);
      onEvent({ type: 'validation', runId: run.id, validation: skippedValidation });
    }

    // Phase 3: Output Generation (ISOLATED SESSION)
    // Run if image instructions were provided (from UI, pre-filled from workspace defaults)
    if (run.imageInstructions.trim()) {
      const outputPrompt = run.imageInstructions;
      
      const isolationNote = createLogEntry('output', 'system', 
        '⚠️ Running in isolated session to preserve main context');
      await appendLog(run.id, isolationNote);
      onEvent({ type: 'log', runId: run.id, entry: isolationNote });
      
      const outputPhase = await runCopilotPhaseWithRetry(run, 'output', outputPrompt, onEvent, {
        isolatedSession: true,
      });
      
      if (!outputPhase.success) {
        await handleFailure(run, 'Output generation failed after retries', onEvent);
        return;
      }
    } else {
      // No image instructions - log that it was skipped
      const skippedNote = createLogEntry('output', 'system', 
        'Image generation skipped - no instructions provided');
      await appendLog(run.id, skippedNote);
      onEvent({ type: 'log', runId: run.id, entry: skippedNote });
    }

    // Success
    await updateRunPhase(run.id, 'completed');
    onEvent({ type: 'phase', runId: run.id, phase: 'completed' });
    onEvent({ type: 'complete', runId: run.id, status: 'completed' });

    // Send push notification
    await sendNotification(
      '✅ Run Complete',
      `Prompt: ${run.prompt.slice(0, 50)}...`,
      { runId: run.id }
    );

  } catch (error) {
    await handleFailure(run, error instanceof Error ? error.message : 'Unknown error', onEvent);
  } finally {
    await stopWatching();
    currentRunId = null;
  }
}

async function handleFailure(run: Run, error: string, onEvent: EventCallback): Promise<void> {
  await updateRunPhase(run.id, 'failed', error);
  onEvent({ type: 'phase', runId: run.id, phase: 'failed' });
  onEvent({ type: 'error', runId: run.id, error });
  onEvent({ type: 'complete', runId: run.id, status: 'failed' });

  // Send push notification
  await sendNotification(
    '❌ Run Failed',
    `Error: ${error}`,
    { runId: run.id }
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
  
  console.log(`[Recovery] Resuming run ${runId} from phase: ${run.status}`);
  currentRunId = run.id;
  
  // Add recovery note to logs
  const recoveryLog = createLogEntry(run.status as RunPhase, 'system', 
    `🔄 Recovering run from ${run.status} phase...`);
  await appendLog(run.id, recoveryLog);
  onEvent({ type: 'log', runId: run.id, entry: recoveryLog });
  
  // Start image watcher
  await startWatching(run.workspacePath, run.id, onEvent);
  
  // Resume from current phase
  await executePhases(run, onEvent, run.sessionId || undefined, run.status as RunPhase);
  
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
        onEvent({ type: 'phase', runId: run.id, phase: 'failed' });
        onEvent({ type: 'error', runId: run.id, error: 'Recovery failed' });
        onEvent({ type: 'complete', runId: run.id, status: 'failed' });
      }
    }
  } finally {
    isRecovering = false;
  }
}

export function isRecoveringRuns(): boolean {
  return isRecovering;
}
