import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { RunsList } from '../RunsList/RunsList';
import { NewRunForm } from '../NewRunForm/NewRunForm';
import { RunDetail } from '../RunDetail/RunDetail';
import type { RunTabType } from '../../types';
import './SessionView.css';

export function SessionView() {
  const { currentSession, currentRuns, currentRunId, config, setCurrentRunId, loadRunDetail } = useApp();
  const [runView, setRunView] = useState<'new-run' | 'run-detail' | 'empty'>('empty');
  const [activeTab, setActiveTab] = useState<RunTabType>('run');

  // Auto-select most recent run when session loads
  useEffect(() => {
    if (currentRuns.length > 0 && !currentRunId) {
      loadRunDetail(currentRuns[0].id);
      setRunView('run-detail');
    } else if (currentRuns.length === 0) {
      setRunView('new-run');
    }
  }, [currentRuns.length, currentRunId, loadRunDetail]);

  // Update view when currentRunId changes
  useEffect(() => {
    if (currentRunId) {
      setRunView('run-detail');
    }
  }, [currentRunId]);

  if (!currentSession) return null;

  const workspace = config?.workspaces?.find(w => w.id === currentSession.workspaceId);

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
              <span>🌿 {currentSession.branchName || 'no branch'}</span>
              <span>{currentRuns.length} run{currentRuns.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <button className="new-run-btn" onClick={handleNewRun}>
            <span className="icon">➕</span>
            <span>New Run</span>
          </button>

          <div className="runs-list-container">
            <RunsList onSelectRun={handleSelectRun} />
          </div>
        </aside>

        {/* Main Run Content */}
        <div className="run-main-content">
          {runView === 'new-run' && (
            <NewRunForm onRunStarted={handleSelectRun} />
          )}
          
          {runView === 'run-detail' && currentRun && (
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
          
          {runView === 'empty' && currentRuns.length > 0 && !currentRunId && (
            <div className="empty-run-content">
              <h3>👈 Select a run or create a new one</h3>
              <p>Click on a run from the sidebar to view details, or click "New Run" to start.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
