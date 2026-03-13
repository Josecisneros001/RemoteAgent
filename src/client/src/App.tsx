import { useApp } from './context/AppContext';
import { MobileHeader } from './components/MobileHeader/MobileHeader';
import { Sidebar } from './components/Sidebar/Sidebar';
import { MachineSelector } from './components/MachineSelector/MachineSelector';
import { WelcomeView } from './components/WelcomeView/WelcomeView';
import { NewSessionForm } from './components/NewSessionForm/NewSessionForm';
import { SessionView } from './components/SessionView/SessionView';
import { InteractiveTerminal } from './components/InteractiveTerminal/InteractiveTerminal';
import { useState, useCallback, useRef } from 'react';
import './App.css';

function App() {
  const { currentView, currentSession, currentMachineId } = useApp();

  // Track which terminal sessions are active (PTY running on server)
  // Map<sessionId, machineId> — keeps terminals alive across machine switches
  const activeTerminalSessionsRef = useRef<Map<string, string>>(new Map());
  const [, setTerminalSessionsVersion] = useState(0);

  // Handle terminal becoming active
  const handleTerminalActive = useCallback((sessionId: string) => {
    if (!activeTerminalSessionsRef.current.has(sessionId)) {
      activeTerminalSessionsRef.current.set(sessionId, currentMachineId);
      setTerminalSessionsVersion(v => v + 1); // Trigger re-render only when needed
    }
  }, [currentMachineId]);

  // Handle terminal exit
  const handleTerminalExit = useCallback((sessionId: string) => {
    if (activeTerminalSessionsRef.current.has(sessionId)) {
      activeTerminalSessionsRef.current.delete(sessionId);
      setTerminalSessionsVersion(v => v + 1);
    }
  }, []);

  // Determine which terminals belong to the current machine
  const currentMachineTerminals = Array.from(activeTerminalSessionsRef.current.entries())
    .filter(([, machineId]) => machineId === currentMachineId)
    .map(([sessionId]) => sessionId);

  const hasCurrentMachineTerminals = currentMachineTerminals.length > 0;
  const isCurrentSessionTerminalActive = currentSession
    ? activeTerminalSessionsRef.current.has(currentSession.id)
    : false;

  return (
    <div id="app">
      <MobileHeader />
      <MachineSelector />

      <div className="app-container">
        <Sidebar />

        <main className="main-content">
          {currentView === 'welcome' && <WelcomeView />}
          {currentView === 'new-session' && <NewSessionForm />}
          {currentView === 'session' && (
            <SessionView
              onTerminalActive={handleTerminalActive}
              onTerminalExit={handleTerminalExit}
              isTerminalActive={isCurrentSessionTerminalActive}
            />
          )}

          {/* Render ALL terminals at App level - completely outside SessionView to prevent unmounting.
              Terminals from other machines are hidden but stay alive (WebSocket stays connected). */}
          {activeTerminalSessionsRef.current.size > 0 && (
            <div className={`app-terminals-container ${currentView === 'session' && currentSession?.interactive && hasCurrentMachineTerminals && isCurrentSessionTerminalActive ? 'visible' : 'hidden'}`}>
              {Array.from(activeTerminalSessionsRef.current.entries()).map(([sessionId, machineId]) => (
                <div
                  key={sessionId}
                  className={`app-terminal-instance ${currentSession?.id === sessionId && machineId === currentMachineId ? 'visible' : 'hidden'}`}
                >
                  <InteractiveTerminal
                    sessionId={sessionId}
                    isVisible={currentSession?.id === sessionId && machineId === currentMachineId && currentView === 'session'}
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
