import { useApp } from '../../context/AppContext';
import './WelcomeView.css';

export function WelcomeView() {
  const { setCurrentView } = useApp();

  return (
    <section className="view-welcome">
      <div className="welcome-content">
        <h2>👋 Welcome to Remote Agent</h2>
        <p>Select a session from the sidebar or create a new one to get started.</p>
        
        <div className="quick-start">
          <h3>Quick Start</h3>
          <button 
            className="btn btn-primary"
            onClick={() => setCurrentView('new-session')}
          >
            <span className="icon">🚀</span> Create New Session
          </button>
        </div>
      </div>
    </section>
  );
}
