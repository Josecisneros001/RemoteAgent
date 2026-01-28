import { useApp } from '../../context/AppContext';
import { useNotifications } from '../../hooks/useNotifications';
import { SessionList } from '../SessionList/SessionList';
import './Sidebar.css';

interface SidebarProps {
  activeTerminalSessions?: Set<string>;
}

export function Sidebar({ activeTerminalSessions = new Set() }: SidebarProps) {
  const {
    sidebarOpen,
    setSidebarOpen,
    connectionStatus,
    setCurrentView,
    config,
    workspaceFilter,
    setWorkspaceFilter,
    loadSessions,
  } = useApp();

  const { notificationsEnabled, isSubscribing, toggleNotifications } = useNotifications();

  const handleNewSession = () => {
    setCurrentView('new-session');
  };

  const handleWorkspaceFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setWorkspaceFilter(value);
    loadSessions(value || undefined);
  };

  return (
    <>
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h1>🤖 Remote Agent</h1>
          <div className="header-status">
            <button
              className={`notification-toggle ${notificationsEnabled ? 'enabled' : ''} ${isSubscribing ? 'subscribing' : ''}`}
              onClick={toggleNotifications}
              disabled={isSubscribing || notificationsEnabled === null}
              aria-label={notificationsEnabled ? 'Disable notifications' : 'Enable notifications'}
              title={notificationsEnabled ? 'Notifications on' : 'Notifications off'}
            >
              {notificationsEnabled ? '🔔' : '🔕'}
            </button>
            <div className="connection-status">
              <span className={`status-dot ${connectionStatus}`}></span>
              <span className="status-text desktop-only">
                {connectionStatus === 'connected' ? 'Connected' :
                 connectionStatus === 'disconnected' ? 'Disconnected' : 'Connecting...'}
              </span>
            </div>
          </div>
        </div>

        <button className="new-session-btn" onClick={handleNewSession}>
          <span className="icon">➕</span>
          <span>New Session</span>
        </button>

        <div className="sessions-container">
          <div className="sessions-header">
            <span>Sessions</span>
            <select 
              className="workspace-filter" 
              value={workspaceFilter}
              onChange={handleWorkspaceFilterChange}
            >
              <option value="">All Workspaces</option>
              {config?.workspaces?.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
          <SessionList activeTerminalSessions={activeTerminalSessions} />
        </div>
      </aside>

      {sidebarOpen && (
        <div 
          className="sidebar-overlay active" 
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </>
  );
}
