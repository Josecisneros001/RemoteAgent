import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Config, Session, Run, WsEvent, ViewType } from '../types';
import * as api from '../api';

interface AppState {
  // Connection
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  
  // Config
  config: Config | null;
  
  // Sessions
  sessions: Session[];
  currentSessionId: string | null;
  currentSession: Session | null;
  
  // Runs
  currentRuns: Run[];
  currentRunId: string | null;
  
  // View state
  currentView: ViewType;
  workspaceFilter: string;
  sidebarOpen: boolean;
}

interface AppContextType extends AppState {
  // Actions
  loadConfig: () => Promise<void>;
  loadSessions: (workspaceId?: string) => Promise<void>;
  loadSessionDetail: (sessionId: string) => Promise<void>;
  loadRunDetail: (runId: string) => Promise<void>;
  loadSessionRuns: (sessionId: string) => Promise<void>;
  setCurrentView: (view: ViewType) => void;
  setWorkspaceFilter: (filter: string) => void;
  setSidebarOpen: (open: boolean) => void;
  setCurrentRunId: (runId: string | null) => void;
  refreshSessions: () => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

const DEBOUNCE_DELAY = 500;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    connectionStatus: 'connecting',
    config: null,
    sessions: [],
    currentSessionId: null,
    currentSession: null,
    currentRuns: [],
    currentRunId: null,
    currentView: 'welcome',
    workspaceFilter: '',
    sidebarOpen: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const runDetailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRunsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Keep refs for current IDs to use in WebSocket handler
  const currentSessionIdRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    currentSessionIdRef.current = state.currentSessionId;
    currentRunIdRef.current = state.currentRunId;
  }, [state.currentSessionId, state.currentRunId]);

  const loadConfig = useCallback(async () => {
    try {
      const config = await api.fetchConfig();
      setState(s => ({ ...s, config }));
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }, []);

  const loadSessions = useCallback(async (workspaceId?: string) => {
    try {
      const data = await api.fetchSessions(workspaceId);
      setState(s => ({ ...s, sessions: data.sessions || [] }));
    } catch (error) {
      console.error('Failed to load sessions:', error);
      setState(s => ({ ...s, sessions: [] }));
    }
  }, []);

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    try {
      const data = await api.fetchSession(sessionId);
      if (data.session) {
        setState(s => ({
          ...s,
          currentSessionId: sessionId,
          currentSession: data.session,
          currentRuns: data.runs || [],
          currentView: 'session',
          sidebarOpen: false,
        }));
      }
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  }, []);

  const loadSessionRuns = useCallback(async (sessionId: string) => {
    try {
      const data = await api.fetchSession(sessionId);
      if (data.runs) {
        setState(s => ({ ...s, currentRuns: data.runs }));
      }
    } catch (error) {
      console.error('Failed to load runs:', error);
    }
  }, []);

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const data = await api.fetchRun(runId);
      if (data.run) {
        setState(s => ({
          ...s,
          currentRunId: runId,
          currentRuns: s.currentRuns.map(r => r.id === runId ? data.run : r),
        }));
      }
    } catch (error) {
      console.error('Failed to load run:', error);
    }
  }, []);

  const setCurrentView = useCallback((view: ViewType) => {
    setState(s => ({ ...s, currentView: view, sidebarOpen: false }));
  }, []);

  const setWorkspaceFilter = useCallback((filter: string) => {
    setState(s => ({ ...s, workspaceFilter: filter }));
  }, []);

  const setSidebarOpen = useCallback((open: boolean) => {
    setState(s => ({ ...s, sidebarOpen: open }));
  }, []);

  const setCurrentRunId = useCallback((runId: string | null) => {
    setState(s => ({ ...s, currentRunId: runId }));
  }, []);

  const refreshSessions = useCallback(async () => {
    await loadSessions(state.workspaceFilter || undefined);
  }, [loadSessions, state.workspaceFilter]);

  // WebSocket setup
  useEffect(() => {
    const setupWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setState(s => ({ ...s, connectionStatus: 'connected' }));
      };

      ws.onclose = () => {
        setState(s => ({ ...s, connectionStatus: 'disconnected' }));
        setTimeout(setupWebSocket, 3000);
      };

      ws.onerror = () => {
        setState(s => ({ ...s, connectionStatus: 'disconnected' }));
      };

      ws.onmessage = (event) => {
        const data: WsEvent = JSON.parse(event.data);
        handleWsEvent(data);
      };
    };

    const handleWsEvent = (event: WsEvent) => {
      // Update views if applicable (debounced)
      if (event.sessionId === currentSessionIdRef.current) {
        if (event.runId === currentRunIdRef.current) {
          if (runDetailDebounceRef.current) {
            clearTimeout(runDetailDebounceRef.current);
          }
          runDetailDebounceRef.current = setTimeout(() => {
            loadRunDetail(event.runId);
          }, DEBOUNCE_DELAY);
        } else {
          if (sessionRunsDebounceRef.current) {
            clearTimeout(sessionRunsDebounceRef.current);
          }
          sessionRunsDebounceRef.current = setTimeout(() => {
            loadSessionRuns(currentSessionIdRef.current!);
          }, DEBOUNCE_DELAY);
        }
      }

      if (event.type === 'complete') {
        refreshSessions();
      }
      
      if (event.type === 'phase' && event.phase === 'prompt' && !currentRunIdRef.current) {
        setState(s => ({
          ...s,
          currentRunId: event.runId,
          currentSessionId: event.sessionId,
        }));
        loadSessionDetail(event.sessionId);
      }
    };

    setupWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (runDetailDebounceRef.current) {
        clearTimeout(runDetailDebounceRef.current);
      }
      if (sessionRunsDebounceRef.current) {
        clearTimeout(sessionRunsDebounceRef.current);
      }
    };
  }, [loadRunDetail, loadSessionRuns, loadSessionDetail, refreshSessions]);

  // Initial data load
  useEffect(() => {
    loadConfig();
    loadSessions();
  }, [loadConfig, loadSessions]);

  const value: AppContextType = {
    ...state,
    loadConfig,
    loadSessions,
    loadSessionDetail,
    loadRunDetail,
    loadSessionRuns,
    setCurrentView,
    setWorkspaceFilter,
    setSidebarOpen,
    setCurrentRunId,
    refreshSessions,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
