import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { pathExists } from '../utils/fs.js';

/**
 * Auto-configure Claude CLI's Notification hook so it POSTs to RemoteAgent
 * when Claude needs user input (permission prompt, idle, elicitation).
 */
export async function ensureClaudeHookConfig(workspacePath: string, port: number): Promise<void> {
  const claudeDir = join(workspacePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  // Ensure .claude directory exists
  await mkdir(claudeDir, { recursive: true });

  // Build the hook command - a cross-platform Node.js one-liner that reads
  // JSON from stdin and POSTs it to our /api/hook/notification endpoint.
  // Wrapped in try/catch with req.on('error') to prevent uncaught exceptions
  // from disrupting Claude CLI sessions if the server is down or input is malformed.
  const hookCommand = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const http=require('http');const body=JSON.stringify({sessionId:j.session_id,notificationType:j.notification_type||'unknown'});const req=http.request({hostname:'localhost',port:${port},path:'/api/hook/notification',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},()=>{});req.on('error',()=>{});req.write(body);req.end()}catch(e){}})"`;

  const hookConfig = {
    hooks: {
      Notification: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command' as const,
              command: hookCommand,
            },
          ],
        },
      ],
    },
  };

  // Read existing settings or start fresh
  let existingConfig: Record<string, unknown> = {};
  if (await pathExists(settingsPath)) {
    try {
      const content = await readFile(settingsPath, 'utf-8');
      existingConfig = JSON.parse(content);
    } catch {
      // If file is corrupted or unreadable, start fresh
      console.warn('[Hooks] Could not parse existing settings.local.json, overwriting hooks config');
    }
  }

  // Deep-merge: preserve all existing settings, only update our Notification hook.
  // Guard against hooks being a non-object value (e.g., null, string).
  if (typeof existingConfig.hooks !== 'object' || existingConfig.hooks === null || Array.isArray(existingConfig.hooks)) {
    existingConfig.hooks = {};
  }
  const hooks = existingConfig.hooks as Record<string, unknown>;

  // Preserve user's existing Notification hooks — only replace our RemoteAgent hook
  const existingNotifications = (Array.isArray(hooks.Notification) ? hooks.Notification : []) as Array<Record<string, unknown>>;
  // Remove any previous RemoteAgent hook entries (identified by the API path in the command)
  const filtered = existingNotifications.filter((entry) => {
    const entryHooks = Array.isArray(entry?.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return !entryHooks.some((h) => typeof h.command === 'string' && h.command.includes('/api/hook/notification'));
  });
  // Append our hook
  filtered.push(hookConfig.hooks.Notification[0]);
  hooks.Notification = filtered;

  await writeFile(settingsPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf-8');
  console.log(`[Hooks] Configured Claude Notification hook in ${settingsPath}`);
}
