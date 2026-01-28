import { useState } from 'react';
import type { FormEvent } from 'react';
import { useApp } from '../../context/AppContext';
import type { AgentType } from '../../types';
import * as api from '../../api';
import './NewSessionForm.css';

export function NewSessionForm() {
  const { config, setCurrentView, loadSessionDetail, refreshSessions, loadConfig } = useApp();
  
  const [workspaceId, setWorkspaceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<AgentType>('claude');
  const [loading, setLoading] = useState(false);
  
  // File browser state
  const [showBrowser, setShowBrowser] = useState(false);
  const [browseData, setBrowseData] = useState<api.BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);

  // Load directory contents
  const loadDirectory = async (path?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const data = await api.browseDirectory(path);
      setBrowseData(data);
      setManualPath(data.current);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'Failed to browse');
    } finally {
      setBrowseLoading(false);
    }
  };

  // Open browser
  const openBrowser = () => {
    setShowBrowser(true);
    loadDirectory();
  };

  // Select directory as workspace
  const selectDirectory = async () => {
    if (!browseData || !newWorkspaceName.trim()) {
      alert('Please enter a name for this workspace');
      return;
    }
    
    setBrowseLoading(true);
    try {
      const result = await api.addWorkspace({
        name: newWorkspaceName.trim(),
        path: browseData.current,
      });
      
      // Refresh config to get new workspace
      await loadConfig();
      
      // Select the new workspace
      setWorkspaceId(result.workspace.id);
      setShowBrowser(false);
      setNewWorkspaceName('');
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'Failed to add workspace');
    } finally {
      setBrowseLoading(false);
    }
  };

  // Navigate to path from manual input
  const navigateToPath = () => {
    if (manualPath.trim()) {
      loadDirectory(manualPath.trim());
    }
  };

  // Create new folder
  const handleCreateFolder = async () => {
    if (!browseData || !newFolderName.trim()) return;
    
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await api.createFolder(browseData.current, newFolderName.trim());
      // Navigate to the newly created folder
      await loadDirectory(result.path);
      setNewFolderName('');
      setShowNewFolderInput(false);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'Failed to create folder');
    } finally {
      setBrowseLoading(false);
    }
  };

  const handleWorkspaceChange = (wsId: string) => {
    setWorkspaceId(wsId);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!workspaceId) {
      alert('Please select a workspace');
      return;
    }

    setLoading(true);

    // For interactive sessions without a name, generate a default
    const sessionPrompt = prompt.trim() || 'Interactive Session';

    try {
      const result = await api.createSession({
        workspaceId,
        prompt: sessionPrompt,
        agent,
      });

      setPrompt('');
      loadSessionDetail(result.sessionId);
      refreshSessions();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to start session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="view-new-session">
      <div className="view-header">
        <h2>New Session</h2>
      </div>
      
      <form className="session-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="workspace">Workspace</label>
          <div className="workspace-selector">
            <select 
              id="workspace"
              className="input" 
              required
              value={workspaceId}
              onChange={(e) => handleWorkspaceChange(e.target.value)}
            >
              <option value="">Select a workspace...</option>
              {config?.workspaces?.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
            <button 
              type="button" 
              className="btn btn-secondary browse-btn"
              onClick={openBrowser}
              title="Browse filesystem"
            >
              📂 Browse
            </button>
          </div>
        </div>

        <div className="form-group">
          <label>Agent</label>
          <div className="agent-selector">
            <label className={`agent-option ${agent === 'copilot' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="agent"
                value="copilot"
                checked={agent === 'copilot'}
                onChange={(e) => setAgent(e.target.value as AgentType)}
              />
              <span className="agent-icon">🤖</span>
              <span className="agent-name">Copilot</span>
            </label>
            <label className={`agent-option ${agent === 'claude' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="agent"
                value="claude"
                checked={agent === 'claude'}
                onChange={(e) => setAgent(e.target.value as AgentType)}
              />
              <span className="agent-icon">🧠</span>
              <span className="agent-name">Claude</span>
            </label>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="prompt">
            Session Name
            <span className="optional-label">(optional)</span>
          </label>
          <textarea
            id="prompt"
            className="input textarea"
            rows={2}
            placeholder="Name for this session (optional)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="form-actions">
          <button 
            type="button" 
            className="btn btn-secondary"
            onClick={() => setCurrentView('welcome')}
          >
            Cancel
          </button>
          <button 
            type="submit" 
            className={`btn btn-primary ${loading ? 'loading' : ''}`}
            disabled={loading}
          >
            <span className="btn-text">Start Session</span>
            {loading && <span className="btn-loading">Starting...</span>}
          </button>
        </div>
      </form>

      {/* File Browser Modal */}
      {showBrowser && (
        <div className="browser-modal-overlay" onClick={() => setShowBrowser(false)}>
          <div className="browser-modal" onClick={e => e.stopPropagation()}>
            <div className="browser-header">
              <h3>📂 Select Workspace Directory</h3>
              <button className="browser-close" onClick={() => setShowBrowser(false)}>×</button>
            </div>
            
            <div className="browser-path-bar">
              <input
                type="text"
                className="input browser-path-input"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && navigateToPath()}
                placeholder="/path/to/directory"
              />
              <button 
                type="button"
                className="btn btn-secondary"
                onClick={navigateToPath}
                disabled={browseLoading}
              >
                Go
              </button>
            </div>

            {browseError && (
              <div className="browser-error">{browseError}</div>
            )}

            <div className="browser-content">
              {browseLoading && <div className="browser-loading">Loading...</div>}
              
              {browseData && !browseLoading && (
                <div className="browser-list">
                  {browseData.parent && (
                    <div 
                      className="browser-item browser-item-parent"
                      onClick={() => loadDirectory(browseData.parent!)}
                    >
                      📁 ..
                    </div>
                  )}
                  {browseData.directories.map(dir => (
                    <div 
                      key={dir.path}
                      className="browser-item"
                      onClick={() => loadDirectory(dir.path)}
                    >
                      📁 {dir.name}
                    </div>
                  ))}
                  {browseData.directories.length === 0 && (
                    <div className="browser-empty">No subdirectories</div>
                  )}
                </div>
              )}
            </div>

            <div className="browser-footer">
              <div className="browser-current">
                <span className="browser-current-label">Current:</span>
                <code className="browser-current-path">{browseData?.current || '...'}</code>
                {browseData?.isGitRepo && <span className="browser-git-badge">🌿 Git</span>}
                <button
                  type="button"
                  className="btn btn-secondary browser-new-folder-btn"
                  onClick={() => setShowNewFolderInput(!showNewFolderInput)}
                  title="Create new folder"
                >
                  📁+
                </button>
              </div>
              
              {showNewFolderInput && (
                <div className="browser-new-folder">
                  <input
                    type="text"
                    className="input"
                    placeholder="New folder name..."
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleCreateFolder}
                    disabled={browseLoading || !newFolderName.trim()}
                  >
                    Create
                  </button>
                </div>
              )}
              
              <div className="browser-name-input">
                <input
                  type="text"
                  className="input"
                  placeholder="Workspace name..."
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={selectDirectory}
                  disabled={browseLoading || !newWorkspaceName.trim()}
                >
                  Add Workspace
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
