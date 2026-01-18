import { useApp } from './context/AppContext';
import { MobileHeader } from './components/MobileHeader/MobileHeader';
import { Sidebar } from './components/Sidebar/Sidebar';
import { WelcomeView } from './components/WelcomeView/WelcomeView';
import { NewSessionForm } from './components/NewSessionForm/NewSessionForm';
import { SessionView } from './components/SessionView/SessionView';
import './App.css';

function App() {
  const { currentView } = useApp();

  return (
    <div id="app">
      <MobileHeader />
      
      <div className="app-container">
        <Sidebar />
        
        <main className="main-content">
          {currentView === 'welcome' && <WelcomeView />}
          {currentView === 'new-session' && <NewSessionForm />}
          {currentView === 'session' && <SessionView />}
        </main>
      </div>
    </div>
  );
}

export default App;
