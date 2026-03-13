import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { resumeCliSession } from '../../api';
import { formatTime } from '../../utils/helpers';
import type { CliSession } from '../../types';
import './SessionList.css';

const agentIcons: Record<string, string> = {
  copilot: '🔵',
  claude: '🧠',
};

const INITIAL_VISIBLE = 5;
const LOAD_MORE_INCREMENT = 10;

interface SessionGroup {
  directory: string;
  directoryName: string;
  sessions: CliSession[];
}

export function SessionList() {
  const {
    cliSessions,
    cliSessionsLoading,
    currentSessionId,
    loadSessionDetail,
    loadCliSessions,
  } = useApp();

  const [resumingId, setResumingId] = useState<string | null>(null);
  // Track collapsed state per directory (collapsed = true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Track how many sessions are visible per directory
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  // Track which session has its full prompt expanded (mobile)
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);

  // Reset local UI state when cliSessions changes (e.g. after refresh)
  const prevSessionsRef = useRef(cliSessions);
  useEffect(() => {
    if (prevSessionsRef.current !== cliSessions) {
      prevSessionsRef.current = cliSessions;
      setCollapsed({});
      setVisibleCounts({});
      setExpandedPromptId(null);
    }
  }, [cliSessions]);

  // Group sessions by directory, preserving recency order
  const groups = useMemo((): SessionGroup[] => {
    const groupMap = new Map<string, SessionGroup>();
    const groupOrder: string[] = [];

    for (const session of cliSessions) {
      const key = session.directory;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          directory: session.directory,
          directoryName: session.directoryName,
          sessions: [],
        });
        groupOrder.push(key);
      }
      groupMap.get(key)!.sessions.push(session);
    }

    return groupOrder.map(key => groupMap.get(key)!);
  }, [cliSessions]);

  const toggleCollapse = useCallback((directory: string) => {
    setCollapsed(prev => ({ ...prev, [directory]: !prev[directory] }));
  }, []);

  const showMore = useCallback((directory: string) => {
    setVisibleCounts(prev => ({
      ...prev,
      [directory]: (prev[directory] || INITIAL_VISIBLE) + LOAD_MORE_INCREMENT,
    }));
  }, []);

  const handleSessionClick = async (session: CliSession) => {
    if (resumingId) return;

    if (session.raSessionId) {
      loadSessionDetail(session.raSessionId);
    } else {
      setResumingId(session.id);
      try {
        const result = await resumeCliSession({
          id: session.id,
          source: session.source,
          directory: session.directory,
        });
        await loadCliSessions();
        loadSessionDetail(result.sessionId);
      } catch (error) {
        console.error('Failed to resume CLI session:', error);
        const msg = error instanceof Error ? error.message : 'Failed to resume session';
        alert(msg);
      } finally {
        setResumingId(null);
      }
    }
  };

  if (!cliSessions.length && !cliSessionsLoading) {
    return <div className="sessions-list"><p className="empty-state">No sessions found</p></div>;
  }

  return (
    <div className="sessions-list">
      {groups.map(group => {
        const isCollapsed = collapsed[group.directory] || false;
        const visibleCount = visibleCounts[group.directory] || INITIAL_VISIBLE;
        const visibleSessions = group.sessions.slice(0, visibleCount);
        const hasMore = group.sessions.length > visibleCount;

        return (
          <div key={group.directory} className="session-group">
            <div
              className="session-group-header"
              onClick={() => toggleCollapse(group.directory)}
            >
              <span className={`session-group-chevron ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
              <span className="session-group-name">{group.directoryName}</span>
              <span className="session-group-count">{group.sessions.length}</span>
            </div>
            {!isCollapsed && (
              <>
                {visibleSessions.map(session => {
                  const isSelected = session.raSessionId != null && session.raSessionId === currentSessionId;
                  const isResuming = resumingId === session.id;

                  return (
                    <div
                      key={`${session.source}-${session.id}`}
                      className={`session-item ${isSelected ? 'active' : ''} ${session.isActive ? 'terminal-running' : ''} ${isResuming ? 'resuming' : ''}`}
                      onClick={() => handleSessionClick(session)}
                    >
                      <div className="session-item-header">
                        <span className="session-item-agent" title={session.source}>
                          {agentIcons[session.source] || agentIcons.claude}
                        </span>
                        <span
                          className={`session-item-name ${expandedPromptId === session.id ? 'expanded' : ''}`}
                          title={session.fullPrompt}
                          onClick={(e) => {
                            if (session.fullPrompt !== session.prettyName) {
                              e.stopPropagation();
                              setExpandedPromptId(prev => prev === session.id ? null : session.id);
                            }
                          }}
                        >
                          {isResuming ? 'Opening...' : (
                            expandedPromptId === session.id ? session.fullPrompt : session.prettyName
                          )}
                        </span>
                        {session.isActive && (
                          <span className="session-item-running" title="Terminal Running">▶️</span>
                        )}
                      </div>
                      <div className="session-item-meta">
                        <span className="session-item-time">{formatTime(session.lastActive)}</span>
                      </div>
                    </div>
                  );
                })}
                {hasMore && (
                  <button
                    className="load-more-btn"
                    onClick={() => showMore(group.directory)}
                  >
                    Show more ({group.sessions.length - visibleCount} remaining)
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}

      {cliSessionsLoading && !cliSessions.length && (
        <div className="sessions-loading">Loading sessions...</div>
      )}
    </div>
  );
}
