import { useApp } from '../../context/AppContext';
import { useNotifications } from '../../hooks/useNotifications';
import { SessionList } from '../SessionList/SessionList';
import './Sidebar.css';

export function Sidebar() {
  const {
    sidebarOpen,
    setSidebarOpen,
    connectionStatus,
    setCurrentView,
    refreshCliSessions,
    cliSessionsLoading,
  } = useApp();

  const { notificationsEnabled, isSubscribing, toggleNotifications } = useNotifications();

  const handleNewSession = () => {
    setCurrentView('new-session');
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
            <button
              className="refresh-btn"
              onClick={refreshCliSessions}
              disabled={cliSessionsLoading}
              title="Refresh sessions"
            >
              🔄
            </button>
          </div>
          <SessionList />
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
