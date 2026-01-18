import { useApp } from '../../context/AppContext';
import { escapeHtml, formatTime } from '../../utils/helpers';
import './RunsList.css';

interface RunsListProps {
  onSelectRun: (runId: string) => void;
}

export function RunsList({ onSelectRun }: RunsListProps) {
  const { currentRuns, currentRunId, loadRunDetail } = useApp();

  if (!currentRuns.length) {
    return <p className="empty-state">No runs yet. Create your first run!</p>;
  }

  const handleClick = (runId: string) => {
    loadRunDetail(runId);
    onSelectRun(runId);
  };

  return (
    <div className="runs-list">
      {currentRuns.map((run, index) => {
        const runNumber = currentRuns.length - index;
        
        return (
          <div
            key={run.id}
            className={`run-item ${run.id === currentRunId ? 'active' : ''}`}
            onClick={() => handleClick(run.id)}
          >
            <div className="run-item-prompt">
              <span className="run-item-number">#{runNumber}</span>
              {escapeHtml(run.prompt)}
            </div>
            {run.commitInfo && (
              <div className="run-item-commit">
                <span className="commit-hash">{escapeHtml(run.commitInfo.shortHash)}</span>
                <span>+{run.commitInfo.insertions}/-{run.commitInfo.deletions}</span>
              </div>
            )}
            <div className="run-item-meta">
              <span className={`run-status ${run.status}`}>{run.status}</span>
              <span>{formatTime(run.createdAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
