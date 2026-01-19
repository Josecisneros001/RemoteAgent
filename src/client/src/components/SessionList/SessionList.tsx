import { useApp } from '../../context/AppContext';
import { escapeHtml } from '../../utils/helpers';
import './SessionList.css';

const agentIcons: Record<string, string> = {
  copilot: '🤖',
  claude: '🧠',
};

interface SessionListProps {
  activeTerminalSessions?: Set<string>;
}

export function SessionList({ activeTerminalSessions = new Set() }: SessionListProps) {
  const { sessions, currentSessionId, loadSessionDetail, config } = useApp();

  // Build workspace lookup map
  const workspaceNames = new Map<string, string>();
  config?.workspaces?.forEach(ws => workspaceNames.set(ws.id, ws.name));

  if (!sessions.length) {
    return <div className="sessions-list"><p className="empty-state">No sessions yet</p></div>;
  }

  return (
    <div className="sessions-list">
      {sessions.map(session => {
        const isTerminalRunning = activeTerminalSessions.has(session.id);
        const workspaceName = workspaceNames.get(session.workspaceId) || session.workspaceId;
        
        return (
          <div
            key={session.id}
            className={`session-item ${session.id === currentSessionId ? 'active' : ''} ${session.interactive ? 'interactive' : ''} ${isTerminalRunning ? 'terminal-running' : ''}`}
            onClick={() => loadSessionDetail(session.id)}
          >
            <div className="session-item-header">
              <span className="session-item-agent" title={session.agent || 'copilot'}>
                {agentIcons[session.agent] || agentIcons.copilot}
              </span>
              <span className="session-item-name">{escapeHtml(session.friendlyName)}</span>
              {session.interactive && isTerminalRunning && (
                <span className="session-item-running" title="Terminal Running">▶️</span>
              )}
              {session.interactive && !isTerminalRunning && (
                <span className="session-item-interactive" title="Interactive Terminal">🖥️</span>
              )}
            </div>
            <div className="session-item-workspace">📁 {escapeHtml(workspaceName)}</div>
            <div className="session-item-branch">🌿 {escapeHtml(session.branchName || 'no branch')}</div>
            <div className="session-item-meta">
              {!session.interactive && (
                <>
                  <span>{session.runCount} run{session.runCount !== 1 ? 's' : ''}</span>
                  {session.lastRunStatus && (
                    <span className={`session-item-status ${session.lastRunStatus}`}>
                      {session.lastRunStatus}
                    </span>
                  )}
                </>
              )}
              {session.interactive && (
                <span className="session-item-mode">{isTerminalRunning ? 'Running' : 'Interactive'}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
