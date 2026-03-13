import { useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import './MachineSelector.css';

// Auto-poll interval for machine status
const MACHINE_POLL_INTERVAL_MS = 30_000;

export function MachineSelector() {
  const {
    machines,
    currentMachineId,
    machinesLoading,
    machinesDiscovered,
    setCurrentMachine,
    refreshMachinesAction,
    loadMachines,
  } = useApp();

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-poll machine status every 30s when multiple machines are present
  useEffect(() => {
    if (machines.length <= 1) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    pollIntervalRef.current = setInterval(() => {
      loadMachines();
    }, MACHINE_POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [machines.length, loadMachines]);

  // Check if the currently active machine has gone offline
  const currentMachine = machines.find(m => m.id === currentMachineId);
  const isCurrentMachineOffline = currentMachine && !currentMachine.isLocal && currentMachine.status === 'offline';

  const handleMachineClick = (machineId: string) => {
    if (machineId === currentMachineId) return;

    // Check if the machine is offline
    const machine = machines.find(m => m.id === machineId);
    if (machine && machine.status === 'offline') return;

    setCurrentMachine(machineId);
  };

  const getPlatformIcon = (platform?: string): string => {
    if (!platform) return '\uD83D\uDCBB'; // laptop emoji
    switch (platform) {
      case 'win32': return '\uD83E\uDE9F'; // window emoji
      case 'darwin': return '\uD83C\uDF4E'; // apple emoji
      case 'linux': return '\uD83D\uDC27'; // penguin emoji
      default: return '\uD83D\uDCBB';
    }
  };

  const getLastSeenText = (lastSeen: string): string => {
    const diff = Date.now() - new Date(lastSeen).getTime();
    if (diff < 0) return 'Just now'; // Handle clock skew
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div className="machine-selector">
      {isCurrentMachineOffline && (
        <div className="machine-offline-banner">
          Machine "{currentMachine.name}" is offline.
          <button className="machine-offline-switch" onClick={() => setCurrentMachine('local')}>
            Switch to local
          </button>
        </div>
      )}
      <div className="machine-tabs">
        {machines.map(machine => (
          <button
            key={machine.id}
            className={`machine-tab ${machine.id === currentMachineId ? 'active' : ''} ${machine.status === 'offline' ? 'offline' : ''}`}
            onClick={() => handleMachineClick(machine.id)}
            disabled={machine.status === 'offline'}
            title={machine.status === 'offline' ? `Offline - Last seen: ${getLastSeenText(machine.lastSeen)}` : machine.name}
          >
            <span className="machine-icon">{getPlatformIcon(machine.machineInfo?.platform)}</span>
            <span className="machine-name">{machine.name}</span>
            {machine.isLocal && <span className="machine-local-tag">(current)</span>}
            <span className={`machine-status-dot ${machine.status}`} />
          </button>
        ))}
        {!machinesDiscovered && machinesLoading && (
          <span className="machine-discovering" title="Discovering other machines...">
            Discovering...
          </span>
        )}
      </div>
      <button
        className={`machine-refresh-btn ${machinesLoading ? 'loading' : ''}`}
        onClick={refreshMachinesAction}
        disabled={machinesLoading}
        title="Refresh machines"
      >
        {machinesLoading ? '\u23F3' : '\uD83D\uDD04'}
      </button>
    </div>
  );
}
