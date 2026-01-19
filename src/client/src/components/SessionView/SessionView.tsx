import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { RunsList } from '../RunsList/RunsList';
import { NewRunForm } from '../NewRunForm/NewRunForm';
import { RunDetail } from '../RunDetail/RunDetail';
import { resumeSession, getSessionStatus, stopSession } from '../../api';
import type { RunTabType } from '../../types';
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
  const { currentSession, currentRuns, currentRunId, config, setCurrentRunId, loadRunDetail } = useApp();
  const [runView, setRunView] = useState<'new-run' | 'run-detail' | 'empty' | 'terminal'>('empty');
  const [activeTab, setActiveTab] = useState<RunTabType>('run');
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  // Sync with parent's terminal active state
  useEffect(() => {
    setIsSessionActive(isTerminalActive);
    if (isTerminalActive && currentSession?.interactive) {
      setRunView('terminal');
    }
  }, [isTerminalActive, currentSession?.interactive]);

  // Check session status on load and auto-activate terminal if running
  useEffect(() => {
    if (currentSession?.interactive) {
      getSessionStatus(currentSession.id).then(status => {
        setIsSessionActive(status.active);
        if (status.active) {
          setRunView('terminal');
          // Notify parent that terminal is active so it renders the terminal component
          onTerminalActive?.(currentSession.id);
        }
      }).catch(console.error);
    }
  }, [currentSession?.id, currentSession?.interactive, onTerminalActive]);

  // Auto-select most recent run when session loads (non-interactive)
  useEffect(() => {
    if (currentSession?.interactive) {
      // For interactive sessions, show terminal if active, otherwise show empty
      if (!isSessionActive) {
        setRunView('empty');
      }
      return;
    }
    
    if (currentRuns.length > 0 && !currentRunId) {
      loadRunDetail(currentRuns[0].id);
      setRunView('run-detail');
    } else if (currentRuns.length === 0) {
      setRunView('new-run');
    }
  }, [currentRuns.length, currentRunId, loadRunDetail, currentSession?.interactive, isSessionActive]);

  // Update view when currentRunId changes
  useEffect(() => {
    if (currentRunId && !currentSession?.interactive) {
      setRunView('run-detail');
    }
  }, [currentRunId, currentSession?.interactive]);

  const handleResume = useCallback(async () => {
    if (!currentSession) return;
    
    setIsResuming(true);
    try {
      await resumeSession(currentSession.id);
      setIsSessionActive(true);
      setRunView('terminal');
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
      setRunView('empty');
      onTerminalExit?.(currentSession.id);
    } catch (error) {
      console.error('Failed to stop session:', error);
    }
  }, [currentSession, onTerminalExit]);

  if (!currentSession) return null;

  const workspace = config?.workspaces?.find(w => w.id === currentSession.workspaceId);
  const agent = agentLabels[currentSession.agent] || agentLabels.copilot;

  const handleNewRun = () => {
    setCurrentRunId(null);
    setRunView('new-run');
  };

  const handleSelectRun = (_runId: string) => {
    setRunView('run-detail');
    setActiveTab('run');
  };

  const currentRun = currentRuns.find(r => r.id === currentRunId);

  return (
    <section className="view-session">
      <div className="session-layout">
        {/* Runs Sidebar */}
        <aside className="runs-sidebar">
          <div className="runs-sidebar-header">
            <div className="session-info">
              <h3>{currentSession.friendlyName}</h3>
              <span className="session-workspace">{workspace?.name || currentSession.workspaceId}</span>
            </div>
            <div className="session-meta-compact">
              <span className="session-agent" title={agent.name}>{agent.icon} {agent.name}</span>
              <span>🌿 {currentSession.branchName || 'no branch'}</span>
              {!currentSession.interactive && (
                <span>{currentRuns.length} run{currentRuns.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          </div>

          {/* New Run button - only for non-interactive sessions */}
          {!currentSession.interactive && (
            <button className="new-run-btn" onClick={handleNewRun}>
              <span className="icon">➕</span>
              <span>New Run</span>
            </button>
          )}

          {/* Resume/Stop buttons for interactive sessions */}
          {currentSession.interactive && (
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
          )}

          {/* Runs list - only for non-interactive sessions */}
          {!currentSession.interactive && (
            <div className="runs-list-container">
              <RunsList onSelectRun={handleSelectRun} />
            </div>
          )}
        </aside>

        {/* Main Run Content - terminals are rendered at App level to persist across session switches */}
        <div className="run-main-content">
          {runView === 'new-run' && !currentSession.interactive && (
            <NewRunForm onRunStarted={handleSelectRun} />
          )}
          
          {runView === 'run-detail' && currentRun && !currentSession.interactive && (
            <div className="run-view-detail">
              <div className="run-tabs">
                <button 
                  className={`run-tab-btn ${activeTab === 'run' ? 'active' : ''}`}
                  onClick={() => setActiveTab('run')}
                >
                  Run
                </button>
                <button 
                  className={`run-tab-btn ${activeTab === 'commits' ? 'active' : ''}`}
                  onClick={() => setActiveTab('commits')}
                >
                  Commits
                </button>
              </div>
              
              <RunDetail run={currentRun} activeTab={activeTab} />
            </div>
          )}
          
          {runView === 'empty' && currentRuns.length > 0 && !currentRunId && !currentSession.interactive && (
            <div className="empty-run-content">
              <h3>👈 Select a run or create a new one</h3>
              <p>Click on a run from the sidebar to view details, or click "New Run" to start.</p>
            </div>
          )}

          {/* Empty state for interactive sessions */}
          {runView === 'empty' && currentSession.interactive && !isSessionActive && (
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
