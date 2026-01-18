import { useApp } from '../../context/AppContext';
import { escapeHtml } from '../../utils/helpers';
import './SessionList.css';

const agentIcons: Record<string, string> = {
  copilot: '🤖',
  claude: '🧠',
};

export function SessionList() {
  const { sessions, currentSessionId, loadSessionDetail } = useApp();

  if (!sessions.length) {
    return <div className="sessions-list"><p className="empty-state">No sessions yet</p></div>;
  }

  return (
    <div className="sessions-list">
      {sessions.map(session => (
        <div
          key={session.id}
          className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
          onClick={() => loadSessionDetail(session.id)}
        >
          <div className="session-item-header">
            <span className="session-item-agent" title={session.agent || 'copilot'}>
              {agentIcons[session.agent] || agentIcons.copilot}
            </span>
            <span className="session-item-name">{escapeHtml(session.friendlyName)}</span>
          </div>
          <div className="session-item-branch">🌿 {escapeHtml(session.branchName || 'no branch')}</div>
          <div className="session-item-meta">
            <span>{session.runCount} run{session.runCount !== 1 ? 's' : ''}</span>
            {session.lastRunStatus && (
              <span className={`session-item-status ${session.lastRunStatus}`}>
                {session.lastRunStatus}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
