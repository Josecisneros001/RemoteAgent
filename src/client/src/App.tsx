import { useApp } from './context/AppContext';
import { MobileHeader } from './components/MobileHeader/MobileHeader';
import { Sidebar } from './components/Sidebar/Sidebar';
import { WelcomeView } from './components/WelcomeView/WelcomeView';
import { NewSessionForm } from './components/NewSessionForm/NewSessionForm';
import { SessionView } from './components/SessionView/SessionView';
import { InteractiveTerminal } from './components/InteractiveTerminal/InteractiveTerminal';
import { useState, useCallback } from 'react';
import './App.css';

function App() {
  const { currentView, currentSession } = useApp();
  
  // Track which terminal sessions are active (PTY running on server)
  const [activeTerminalSessions, setActiveTerminalSessions] = useState<Set<string>>(new Set());

  // Handle terminal becoming active
  const handleTerminalActive = useCallback((sessionId: string) => {
    setActiveTerminalSessions(prev => new Set(prev).add(sessionId));
  }, []);

  // Handle terminal exit
  const handleTerminalExit = useCallback((sessionId: string) => {
    setActiveTerminalSessions(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return (
    <div id="app">
      <MobileHeader />
      
      <div className="app-container">
        <Sidebar activeTerminalSessions={activeTerminalSessions} />
        
        <main className="main-content">
          {currentView === 'welcome' && <WelcomeView />}
          {currentView === 'new-session' && <NewSessionForm />}
          {currentView === 'session' && (
            <SessionView 
              onTerminalActive={handleTerminalActive}
              onTerminalExit={handleTerminalExit}
              isTerminalActive={currentSession ? activeTerminalSessions.has(currentSession.id) : false}
            />
          )}
          
          {/* Render ALL terminals at App level - completely outside SessionView to prevent unmounting */}
          {activeTerminalSessions.size > 0 && (
            <div className={`app-terminals-container ${currentView === 'session' && currentSession?.interactive && activeTerminalSessions.has(currentSession.id) ? 'visible' : 'hidden'}`}>
              {Array.from(activeTerminalSessions).map(sessionId => (
                <div 
                  key={sessionId}
                  className={`app-terminal-instance ${currentSession?.id === sessionId ? 'visible' : 'hidden'}`}
                >
                  <InteractiveTerminal
                    sessionId={sessionId}
                    isVisible={currentSession?.id === sessionId && currentView === 'session'}
                    onExit={() => handleTerminalExit(sessionId)}
                  />
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
