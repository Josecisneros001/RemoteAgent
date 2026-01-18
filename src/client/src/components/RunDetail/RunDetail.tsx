import { useState } from 'react';
import type { Run, RunTabType, LogEntry } from '../../types';
import { escapeHtml, formatTime, simpleMarkdown } from '../../utils/helpers';
import { CommitsTab } from '../CommitsTab/CommitsTab';
import * as api from '../../api';
import './RunDetail.css';

interface RunDetailProps {
  run: Run;
  activeTab: RunTabType;
}

export function RunDetail({ run, activeTab }: RunDetailProps) {
  const [imageModalSrc, setImageModalSrc] = useState<string | null>(null);

  const handleAbort = async () => {
    if (!confirm('Are you sure you want to abort the current run?')) return;
    try {
      await api.abortRun();
    } catch (error) {
      console.error('Failed to abort:', error);
    }
  };

  const renderPhaseLogs = (logs: LogEntry[], phase: string) => {
    const phaseLogs = logs.filter(l => l.phase === phase);
    if (phaseLogs.length === 0) return null;
    
    const combined: LogEntry[] = [];
    let currentStdout = '';
    
    phaseLogs.forEach(entry => {
      if (entry.type === 'stdout') {
        currentStdout += entry.content;
      } else {
        if (currentStdout) {
          combined.push({ type: 'stdout', content: currentStdout, phase: entry.phase, timestamp: entry.timestamp });
          currentStdout = '';
        }
        combined.push(entry);
      }
    });
    if (currentStdout) {
      combined.push({ type: 'stdout', content: currentStdout, phase: phase as LogEntry['phase'], timestamp: '' });
    }
    
    return combined.map((entry, i) => {
      if (entry.type === 'stdout') {
        return (
          <div key={i} className={`log-entry ${entry.type} markdown-content`}
               dangerouslySetInnerHTML={{ __html: simpleMarkdown(entry.content) }} />
        );
      } else if (entry.type === 'system') {
        return (
          <div key={i} className={`log-entry ${entry.type}`}>
            <em>{escapeHtml(entry.content)}</em>
          </div>
        );
      } else {
        return (
          <div key={i} className={`log-entry ${entry.type}`}>
            {escapeHtml(entry.content)}
          </div>
        );
      }
    });
  };

  const getValidationIcon = (status: string) => {
    switch (status) {
      case 'passed': return '✅';
      case 'failed': return '❌';
      case 'running': return '⏳';
      case 'skipped': return '⏭️';
      default: return '⏸️';
    }
  };

  if (activeTab === 'commits') {
    return <CommitsTab />;
  }

  const promptLogs = renderPhaseLogs(run.logs, 'prompt');
  const validationLogs = renderPhaseLogs(run.logs, 'validation');
  const outputLogs = renderPhaseLogs(run.logs, 'output');

  return (
    <div className="run-detail">
      <div className="detail-header">
        <h2>{escapeHtml(run.prompt)}</h2>
        <div className="detail-meta">
          <span className={`run-status ${run.status}`}>{run.status}</span>
          <span>{formatTime(run.createdAt)}</span>
          {run.model && <span>Model: {escapeHtml(run.model)}</span>}
        </div>
      </div>

      <Section title="Prompt Output" defaultOpen>
        <div className="logs">
          {promptLogs || <p className="empty-state">No output yet</p>}
        </div>
      </Section>

      {run.commitInfo && (
        <Section title="📦 Git Commit">
          <div className="commit-detail">
            <div className="commit-detail-header">
              <span className="commit-hash-large">{escapeHtml(run.commitInfo.shortHash)}</span>
              <span className="commit-branch">{escapeHtml(run.commitInfo.branch)}</span>
            </div>
            <div className="commit-message-large">{escapeHtml(run.commitInfo.message)}</div>
            <div className="commit-stats-detail">
              <span>{run.commitInfo.filesChanged} file{run.commitInfo.filesChanged !== 1 ? 's' : ''} changed</span>
              <span className="insertions">+{run.commitInfo.insertions} insertions</span>
              <span className="deletions">-{run.commitInfo.deletions} deletions</span>
            </div>
            <div className="commit-date">{formatTime(run.commitInfo.timestamp)}</div>
          </div>
        </Section>
      )}

      <Section title="Validation">
        <div className={`validation-status ${run.validation.status}`}>
          {getValidationIcon(run.validation.status)}
          {run.validation.status.toUpperCase()}
        </div>
        {validationLogs && <div className="logs" style={{ marginTop: 12 }}>{validationLogs}</div>}
      </Section>

      <Section title="Output Generation">
        <div className="logs">
          {outputLogs || <p className="empty-state">No output logs</p>}
        </div>
      </Section>

      <Section title="Generated Images">
        {run.images.length ? (
          <div className="images-grid">
            {run.images.map(img => (
              <div 
                key={img.filename} 
                className="image-item"
                onClick={() => setImageModalSrc(`/api/images/${run.id}/${img.filename}`)}
              >
                <img 
                  src={`/api/images/${run.id}/${img.filename}`} 
                  alt={escapeHtml(img.filename)} 
                  loading="lazy" 
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No images generated</p>
        )}
      </Section>

      {run.status !== 'completed' && run.status !== 'failed' && (
        <button className="btn btn-secondary" onClick={handleAbort}>
          Abort Run
        </button>
      )}

      {imageModalSrc && (
        <div className="image-modal" onClick={() => setImageModalSrc(null)}>
          <button className="modal-close" onClick={() => setImageModalSrc(null)}>×</button>
          <img src={imageModalSrc} alt="Full size" />
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function Section({ title, children, defaultOpen = false }: SectionProps) {
  const [collapsed, setCollapsed] = useState(!defaultOpen);

  return (
    <div className={`section ${collapsed ? 'collapsed' : ''}`}>
      <div className="section-header" onClick={() => setCollapsed(!collapsed)}>
        {title}
        <span className="section-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed && <div className="section-content">{children}</div>}
    </div>
  );
}
