import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { resumeSession, getSessionStatus, stopSession } from '../../api';
import './SessionView.css';

const agentLabels: Record<string, { icon: string; name: string }> = {
  copilot: { icon: '🤖', name: 'Copilot' },
  claude: { icon: '🧠', name: 'Claude' },
};

interface SessionViewProps {
  onTerminalActive?: (sessionId: string) => void;
  onTerminalExit?: (sessionId: string) => void;
  isTerminalActive?: boolean;
}

export function SessionView({
  onTerminalActive,
  onTerminalExit,
  isTerminalActive = false,
}: SessionViewProps) {
  const { currentSession, config } = useApp();
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  // Sync with parent's terminal active state
  useEffect(() => {
    setIsSessionActive(isTerminalActive);
  }, [isTerminalActive]);

  // Check session status on load and auto-activate terminal if running
  useEffect(() => {
    if (currentSession) {
      getSessionStatus(currentSession.id).then(status => {
        setIsSessionActive(status.active);
        if (status.active) {
          onTerminalActive?.(currentSession.id);
        }
      }).catch(console.error);
    }
  }, [currentSession?.id, onTerminalActive]);

  const handleResume = useCallback(async () => {
    if (!currentSession) return;

    setIsResuming(true);
    try {
      await resumeSession(currentSession.id);
      setIsSessionActive(true);
      onTerminalActive?.(currentSession.id);
    } catch (error) {
      console.error('Failed to resume session:', error);
      alert('Failed to resume session. Please try again.');
    } finally {
      setIsResuming(false);
    }
  }, [currentSession, onTerminalActive]);

  const handleStop = useCallback(async () => {
    if (!currentSession) return;

    try {
      await stopSession(currentSession.id);
      setIsSessionActive(false);
      onTerminalExit?.(currentSession.id);
    } catch (error) {
      console.error('Failed to stop session:', error);
    }
  }, [currentSession, onTerminalExit]);

  if (!currentSession) return null;

  const workspace = config?.workspaces?.find(w => w.id === currentSession.workspaceId);
  const agent = agentLabels[currentSession.agent] || agentLabels.copilot;

  return (
    <section className="view-session">
      <div className="session-layout">
        {/* Session Sidebar */}
        <aside className="runs-sidebar">
          <div className="runs-sidebar-header">
            <div className="session-info">
              <h3>{currentSession.friendlyName}</h3>
              <span className="session-workspace">{workspace?.name || currentSession.workspaceId}</span>
            </div>
            <div className="session-meta-compact">
              <span className="session-agent" title={agent.name}>{agent.icon} {agent.name}</span>
              <span>🌿 {currentSession.branchName || 'no branch'}</span>
            </div>
          </div>

          {/* Resume/Stop buttons */}
          <div className="interactive-controls">
            {!isSessionActive ? (
              <button
                className="resume-btn"
                onClick={handleResume}
                disabled={isResuming}
              >
                <span className="icon">▶️</span>
                <span>{isResuming ? 'Starting...' : 'Resume'}</span>
              </button>
            ) : (
              <button className="stop-btn" onClick={handleStop}>
                <span className="icon">⏹️</span>
                <span>Stop</span>
              </button>
            )}
          </div>
        </aside>

        {/* Main Content - terminals are rendered at App level to persist across session switches */}
        <div className="run-main-content">
          {/* Empty state when terminal is not active */}
          {!isSessionActive && (
            <div className="empty-run-content interactive-empty">
              <h3>🖥️ Interactive Session</h3>
              <p>This is an interactive terminal session. Click <strong>Resume</strong> to connect to the terminal.</p>
              <button
                className="resume-btn large"
                onClick={handleResume}
                disabled={isResuming}
              >
                <span className="icon">▶️</span>
                <span>{isResuming ? 'Starting...' : 'Resume Session'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
