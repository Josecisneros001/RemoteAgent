import { useApp } from './context/AppContext';
import { MobileHeader } from './components/MobileHeader/MobileHeader';
import { Sidebar } from './components/Sidebar/Sidebar';
import { WelcomeView } from './components/WelcomeView/WelcomeView';
import { NewSessionForm } from './components/NewSessionForm/NewSessionForm';
import { SessionView } from './components/SessionView/SessionView';
import { InteractiveTerminal } from './components/InteractiveTerminal/InteractiveTerminal';
import { useState, useCallback, useRef } from 'react';
import './App.css';

function App() {
  const { currentView, currentSession } = useApp();
  
  // Track which terminal sessions are active (PTY running on server)
  // Using useRef to avoid excessive re-renders when sessions are added/removed
  const activeTerminalSessionsRef = useRef<Set<string>>(new Set());
  const [, setTerminalSessionsVersion] = useState(0);

  // Handle terminal becoming active
  const handleTerminalActive = useCallback((sessionId: string) => {
    if (!activeTerminalSessionsRef.current.has(sessionId)) {
      activeTerminalSessionsRef.current.add(sessionId);
      setTerminalSessionsVersion(v => v + 1); // Trigger re-render only when needed
    }
  }, []);

  // Handle terminal exit
  const handleTerminalExit = useCallback((sessionId: string) => {
    if (activeTerminalSessionsRef.current.has(sessionId)) {
      activeTerminalSessionsRef.current.delete(sessionId);
      setTerminalSessionsVersion(v => v + 1);
    }
  }, []);

  return (
    <div id="app">
      <MobileHeader />
      
      <div className="app-container">
        <Sidebar activeTerminalSessions={activeTerminalSessionsRef.current} />
        
        <main className="main-content">
          {currentView === 'welcome' && <WelcomeView />}
          {currentView === 'new-session' && <NewSessionForm />}
          {currentView === 'session' && (
            <SessionView 
              onTerminalActive={handleTerminalActive}
              onTerminalExit={handleTerminalExit}
              isTerminalActive={currentSession ? activeTerminalSessionsRef.current.has(currentSession.id) : false}
            />
          )}
          
          {/* Render ALL terminals at App level - completely outside SessionView to prevent unmounting */}
          {activeTerminalSessionsRef.current.size > 0 && (
            <div className={`app-terminals-container ${currentView === 'session' && currentSession?.interactive && activeTerminalSessionsRef.current.has(currentSession.id) ? 'visible' : 'hidden'}`}>
              {Array.from(activeTerminalSessionsRef.current).map(sessionId => (
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
