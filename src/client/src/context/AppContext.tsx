import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Config, Session, Run, WsEvent, ViewType, CliSession, Machine } from '../types';
import * as api from '../api';

interface AppState {
  // Connection
  connectionStatus: 'connecting' | 'connected' | 'disconnected';

  // Config
  config: Config | null;

  // Sessions (RA sessions - kept for session detail views)
  sessions: Session[];
  currentSessionId: string | null;
  currentSession: Session | null;

  // CLI Sessions (discovered from Claude/Copilot CLI storage)
  cliSessions: CliSession[];
  cliSessionsTotal: number;
  cliSessionsLoading: boolean;

  // Runs
  currentRuns: Run[];
  currentRunId: string | null;

  // View state
  currentView: ViewType;
  workspaceFilter: string;
  sidebarOpen: boolean;

  // Multi-Machine Management
  machines: Machine[];
  currentMachineId: string;
  machinesLoading: boolean;
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
  // CLI Sessions actions
  loadCliSessions: () => Promise<void>;
  refreshCliSessions: () => Promise<void>;
  // Machine actions
  loadMachines: () => Promise<void>;
  refreshMachinesAction: () => Promise<void>;
  setCurrentMachine: (machineId: string) => void;
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
    cliSessions: [],
    cliSessionsTotal: 0,
    cliSessionsLoading: false,
    currentRuns: [],
    currentRunId: null,
    currentView: 'welcome',
    workspaceFilter: '',
    sidebarOpen: false,
    machines: [],
    currentMachineId: 'local',
    machinesLoading: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const runDetailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRunsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs for current IDs to use in WebSocket handler
  const currentSessionIdRef = useRef<string | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const currentMachineIdRef = useRef<string>('local');

  // Generation counter to discard stale responses after machine switch
  const machineGenerationRef = useRef(0);

  useEffect(() => {
    currentSessionIdRef.current = state.currentSessionId;
    currentRunIdRef.current = state.currentRunId;
    currentMachineIdRef.current = state.currentMachineId;
  }, [state.currentSessionId, state.currentRunId, state.currentMachineId]);

  const loadConfig = useCallback(async () => {
    const gen = machineGenerationRef.current;
    try {
      const config = await api.fetchConfig();
      if (gen !== machineGenerationRef.current) return; // Stale response
      setState(s => ({ ...s, config }));
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }, []);

  const loadSessions = useCallback(async (workspaceId?: string) => {
    const gen = machineGenerationRef.current;
    try {
      const data = await api.fetchSessions(workspaceId);
      if (gen !== machineGenerationRef.current) return; // Stale response
      setState(s => ({ ...s, sessions: data.sessions || [] }));
    } catch (error) {
      console.error('Failed to load sessions:', error);
      setState(s => ({ ...s, sessions: [] }));
    }
  }, []);

  // CLI Sessions: load all sessions
  const loadCliSessions = useCallback(async () => {
    const gen = machineGenerationRef.current;
    setState(s => ({ ...s, cliSessionsLoading: true }));
    try {
      const data = await api.fetchCliSessions(0, 0); // limit=0 means all
      if (gen !== machineGenerationRef.current) return; // Stale response
      setState(s => ({
        ...s,
        cliSessions: data.sessions,
        cliSessionsTotal: data.total,
        cliSessionsLoading: false,
      }));
    } catch (error) {
      console.error('Failed to load CLI sessions:', error);
      if (gen === machineGenerationRef.current) {
        setState(s => ({ ...s, cliSessionsLoading: false }));
      }
    }
  }, []);

  // CLI Sessions: force refresh
  const refreshCliSessionsFn = useCallback(async () => {
    const gen = machineGenerationRef.current;
    setState(s => ({ ...s, cliSessionsLoading: true }));
    try {
      const data = await api.refreshCliSessions();
      if (gen !== machineGenerationRef.current) return; // Stale response
      setState(s => ({
        ...s,
        cliSessions: data.sessions,
        cliSessionsTotal: data.total,
        cliSessionsLoading: false,
      }));
    } catch (error) {
      console.error('Failed to refresh CLI sessions:', error);
      if (gen === machineGenerationRef.current) {
        setState(s => ({ ...s, cliSessionsLoading: false }));
      }
    }
  }, []);

  // ==================== Machine Management ====================

  const loadMachines = useCallback(async () => {
    setState(s => ({ ...s, machinesLoading: true }));
    try {
      const data = await api.fetchMachines();
      setState(s => ({
        ...s,
        machines: data.machines,
        machinesLoading: false,
      }));
    } catch (error) {
      console.error('Failed to load machines:', error);
      setState(s => ({ ...s, machinesLoading: false }));
    }
  }, []);

  const refreshMachinesAction = useCallback(async () => {
    setState(s => ({ ...s, machinesLoading: true }));
    try {
      const data = await api.refreshMachinesApi();
      setState(s => ({
        ...s,
        machines: data.machines,
        machinesLoading: false,
      }));
    } catch (error) {
      console.error('Failed to refresh machines:', error);
      setState(s => ({ ...s, machinesLoading: false }));
    }
  }, []);

  const setCurrentMachine = useCallback((machineId: string) => {
    // Increment generation counter to discard in-flight responses from previous machine
    machineGenerationRef.current++;

    // Update the API layer's current machine
    api.setCurrentMachineId(machineId);

    // Clear current session/view state when switching machines
    setState(s => ({
      ...s,
      currentMachineId: machineId,
      config: null,
      currentSessionId: null,
      currentSession: null,
      currentRuns: [],
      currentRunId: null,
      currentView: 'welcome',
      cliSessions: [],
      cliSessionsTotal: 0,
      sessions: [],
    }));

    // Reload data for the new machine
    // (loadConfig and loadCliSessions will use the new API base via getApiBase())
  }, []);

  // When machine changes, reload data for that machine
  useEffect(() => {
    loadConfig();
    loadCliSessions();
    loadSessions();
  }, [state.currentMachineId, loadConfig, loadCliSessions, loadSessions]);

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const gen = machineGenerationRef.current;
    try {
      const data = await api.fetchSession(sessionId);
      if (gen !== machineGenerationRef.current) return; // Stale response
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
    const gen = machineGenerationRef.current;
    try {
      const data = await api.fetchSession(sessionId);
      if (gen !== machineGenerationRef.current) return; // Stale response
      if (data.runs) {
        setState(s => ({ ...s, currentRuns: data.runs }));
      }
    } catch (error) {
      console.error('Failed to load runs:', error);
    }
  }, []);

  const loadRunDetail = useCallback(async (runId: string) => {
    const gen = machineGenerationRef.current;
    try {
      const data = await api.fetchRun(runId);
      if (gen !== machineGenerationRef.current) return; // Stale response
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

  // WebSocket setup — connects to the current machine's /ws endpoint
  // Resilient: exponential backoff reconnect + ping/pong keepalive
  useEffect(() => {
    let cancelled = false;
    let reconnectDelay = 1000; // Start at 1s, backs off to 30s max
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    const setupWebSocket = () => {
      if (cancelled) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsBase = api.getWsBase();
      const ws = new WebSocket(`${protocol}//${window.location.host}${wsBase}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        setState(s => ({ ...s, connectionStatus: 'connected' }));
        reconnectDelay = 1000; // Reset backoff on successful connect

        // Keepalive: send ping every 25s to prevent tunnel/proxy idle timeout
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
          }
        }, 25_000);
      };

      ws.onclose = () => {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (cancelled) return;
        setState(s => ({ ...s, connectionStatus: 'disconnected' }));
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        setTimeout(setupWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      };

      ws.onerror = () => {
        if (cancelled) return;
        // Don't set disconnected here — onclose will fire right after
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        const data: WsEvent = JSON.parse(event.data);
        handleWsEvent(data);
      };
    };

    const handleWsEvent = (event: WsEvent) => {
      // Skip PTY events in main handler - they're handled separately in the terminal component
      if (event.type === 'pty-data' || event.type === 'interaction-needed' || event.type === 'pty-exit') {
        return;
      }

      // Machine discovery completed — refresh machine list
      if (event.type === 'machines-updated') {
        loadMachines();
        return;
      }

      // Update views if applicable (debounced)
      if (event.sessionId === currentSessionIdRef.current) {
        if (event.runId && event.runId === currentRunIdRef.current) {
          if (runDetailDebounceRef.current) {
            clearTimeout(runDetailDebounceRef.current);
          }
          runDetailDebounceRef.current = setTimeout(() => {
            if (event.runId) {
              loadRunDetail(event.runId);
            }
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

      if (event.type === 'phase' && event.phase === 'prompt' && !currentRunIdRef.current && event.runId && event.sessionId) {
        setState(s => ({
          ...s,
          currentRunId: event.runId ?? null,
          currentSessionId: event.sessionId!,
        }));
        loadSessionDetail(event.sessionId!);
      }
    };

    setupWebSocket();

    return () => {
      cancelled = true;
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
  }, [state.currentMachineId, loadRunDetail, loadSessionRuns, loadSessionDetail, refreshSessions, loadMachines]);

  // Initial data load — machines update automatically via WebSocket 'machines-updated' event
  useEffect(() => {
    loadMachines();
  }, [loadMachines]);

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
    loadCliSessions,
    refreshCliSessions: refreshCliSessionsFn,
    loadMachines,
    refreshMachinesAction,
    setCurrentMachine,
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
