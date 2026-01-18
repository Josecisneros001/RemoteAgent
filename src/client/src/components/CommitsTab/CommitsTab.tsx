import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import * as api from '../../api';
import type { GitChanges, CommitFile, Run } from '../../types';
import { escapeHtml, formatTime } from '../../utils/helpers';
import './CommitsTab.css';

export function CommitsTab() {
  const { currentSessionId, currentSession, currentRuns } = useApp();
  const [gitChanges, setGitChanges] = useState<GitChanges | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Record<string, CommitFile[]>>({});
  const [expandedFile, setExpandedFile] = useState<{ runId: string; path: string } | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);

  useEffect(() => {
    if (currentSessionId) {
      loadGitChanges();
    }
  }, [currentSessionId]);

  const loadGitChanges = async () => {
    if (!currentSessionId) return;
    try {
      const data = await api.fetchGitChanges(currentSessionId);
      setGitChanges(data.changes);
    } catch (error) {
      console.error('Failed to load git changes:', error);
    }
  };

  const loadCommitFiles = async (runId: string) => {
    if (commitFiles[runId]) return;
    try {
      const data = await api.fetchCommitFiles(runId);
      setCommitFiles(prev => ({ ...prev, [runId]: data.files || [] }));
    } catch (error) {
      console.error('Failed to load commit files:', error);
      setCommitFiles(prev => ({ ...prev, [runId]: [] }));
    }
  };

  const loadFileDiff = async (runId: string, path: string) => {
    try {
      const data = await api.fetchCommitDiff(runId, path);
      setFileDiff(data.diff);
    } catch (error) {
      console.error('Failed to load diff:', error);
      setFileDiff(null);
    }
  };

  const handleCommitClick = async (run: Run) => {
    if (expandedCommit === run.id) {
      setExpandedCommit(null);
    } else {
      setExpandedCommit(run.id);
      await loadCommitFiles(run.id);
    }
  };

  const handleFileClick = async (runId: string, path: string) => {
    if (expandedFile?.runId === runId && expandedFile?.path === path) {
      setExpandedFile(null);
      setFileDiff(null);
    } else {
      setExpandedFile({ runId, path });
      await loadFileDiff(runId, path);
    }
  };

  const runsWithCommits = currentRuns.filter(r => r.commitInfo);
  const branchName = currentSession?.branchName || gitChanges?.branch || 'unknown';

  if (runsWithCommits.length === 0) {
    return (
      <div className="commits-tab">
        <div className="git-branch">
          Branch: <span className="git-branch-name">{escapeHtml(branchName)}</span>
        </div>
        <p className="empty-state">No commits yet - run a prompt to make changes</p>
      </div>
    );
  }

  // Sort oldest first
  const sortedRuns = [...runsWithCommits].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <div className="commits-tab">
      <div className="git-branch">
        Branch: <span className="git-branch-name">{escapeHtml(branchName)}</span>
        <span className="commits-count">
          {runsWithCommits.length} commit{runsWithCommits.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="commits-list">
        {sortedRuns.map(run => (
          <div key={run.id} className={`commit-item ${expandedCommit === run.id ? 'expanded' : ''}`}>
            <div className="commit-header-row" onClick={() => handleCommitClick(run)}>
              <div className="commit-header">
                <span className="commit-hash">{escapeHtml(run.commitInfo!.shortHash)}</span>
                <span className="commit-date">{formatTime(run.commitInfo!.timestamp)}</span>
              </div>
              <div className="commit-message">{escapeHtml(run.commitInfo!.message)}</div>
              <div className="commit-stats">
                <span className="files-changed">
                  {run.commitInfo!.filesChanged} file{run.commitInfo!.filesChanged !== 1 ? 's' : ''}
                </span>
                <span className="insertions">+{run.commitInfo!.insertions}</span>
                <span className="deletions">-{run.commitInfo!.deletions}</span>
              </div>
            </div>

            {expandedCommit === run.id && (
              <div className="commit-files">
                <div className="commit-files-header">Files Changed</div>
                <div className="commit-files-list">
                  {commitFiles[run.id]?.length ? (
                    commitFiles[run.id].map(file => (
                      <div key={file.path}>
                        <div 
                          className="commit-file-item"
                          onClick={() => handleFileClick(run.id, file.path)}
                        >
                          <span className="commit-file-path">{escapeHtml(file.path)}</span>
                          <div className="commit-file-stats">
                            <span className="insertions">+{file.insertions}</span>
                            <span className="deletions">-{file.deletions}</span>
                          </div>
                          <span className={`commit-file-status ${file.status}`}>{file.status}</span>
                        </div>
                        {expandedFile?.runId === run.id && expandedFile?.path === file.path && (
                          <div className="file-diff-container">
                            <div className="file-diff-header">
                              <span>{escapeHtml(file.path)}</span>
                              <button 
                                className="file-diff-close"
                                onClick={(e) => { e.stopPropagation(); setExpandedFile(null); setFileDiff(null); }}
                              >
                                ×
                              </button>
                            </div>
                            <div className="file-diff-content">
                              {fileDiff ? renderDiff(fileDiff) : <p className="empty-state">Loading diff...</p>}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="empty-state">No file details available</p>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderDiff(diff: string) {
  const lines = diff.split('\n');
  
  return (
    <div className="diff-lines">
      {lines.map((line, i) => {
        let className = 'context';
        
        if (line.startsWith('+++') || line.startsWith('---')) {
          return null; // Skip file headers
        } else if (line.startsWith('@@')) {
          className = 'hunk-header';
        } else if (line.startsWith('+')) {
          className = 'addition';
        } else if (line.startsWith('-')) {
          className = 'deletion';
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          return null; // Skip diff metadata
        }
        
        return (
          <div key={i} className={`diff-line ${className}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
