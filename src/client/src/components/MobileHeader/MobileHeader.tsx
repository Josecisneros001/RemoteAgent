import { useApp } from '../../context/AppContext';
import './MobileHeader.css';

export function MobileHeader() {
  const { sidebarOpen, setSidebarOpen, connectionStatus } = useApp();

  return (
    <header className="mobile-header">
      <button
        className={`menu-toggle ${sidebarOpen ? 'active' : ''}`}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle menu"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      <h1>🤖 Remote Agent</h1>
      <div className="connection-status">
        <span className={`status-dot ${connectionStatus}`}></span>
      </div>
    </header>
  );
}
