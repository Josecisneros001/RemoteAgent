import { useState, useEffect, useCallback } from 'react';
import * as api from '../../api';
import type { DeviceInfo } from '../../types';
import './NotificationSettingsModal.css';

interface Props {
  onClose: () => void;
  notificationsEnabled: boolean | null;
  isSubscribing: boolean;
  subscribeError: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  currentDeviceId: string | null;
}

export function NotificationSettingsModal({
  onClose,
  notificationsEnabled,
  isSubscribing,
  subscribeError,
  subscribe,
  unsubscribe,
  currentDeviceId,
}: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { devices } = await api.fetchDevices();
      setDevices(devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices, notificationsEnabled]);

  const handleSubscribe = async () => {
    await subscribe();
    await loadDevices();
  };

  const handleUnsubscribe = async () => {
    await unsubscribe();
    await loadDevices();
  };

  const handleDelete = async (device: DeviceInfo) => {
    try {
      await api.deleteDevice(device.id);
      if (device.id === currentDeviceId) {
        await unsubscribe();
      }
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete device');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestSuccess(null);
    setError(null);
    try {
      await api.testDevice(id);
      setTestSuccess(id);
      setTimeout(() => setTestSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send test notification');
      await loadDevices(); // Refresh in case device was removed as expired
    } finally {
      setTestingId(null);
    }
  };

  const handleStartRename = (device: DeviceInfo) => {
    setEditingId(device.id);
    setEditName(device.name);
  };

  const handleCancelRename = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleSaveRename = async (id: string) => {
    if (!editName.trim()) return;
    try {
      await api.renameDevice(id, editName.trim());
      setEditingId(null);
      setEditName('');
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename device');
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      handleSaveRename(id);
    } else if (e.key === 'Escape') {
      handleCancelRename();
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="notif-modal-overlay" onClick={onClose}>
      <div className="notif-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notif-modal-header">
          <h2>🔔 Notifications</h2>
          <button className="notif-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="notif-modal-content">
          {/* This Device Section */}
          <div className="notif-section-title">This Device</div>
          {subscribeError && (
            <div className="notif-error">{subscribeError}</div>
          )}
          <div className="notif-this-device">
            <div className="notif-device-status">
              {notificationsEnabled ? (
                <>
                  <span className="notif-status-badge enabled">Subscribed</span>
                  <button
                    className="btn-sm"
                    onClick={handleUnsubscribe}
                    disabled={isSubscribing}
                  >
                    Unsubscribe
                  </button>
                </>
              ) : (
                <>
                  <span className="notif-status-badge disabled">Not subscribed</span>
                  <button
                    className="btn-sm btn-accent"
                    onClick={handleSubscribe}
                    disabled={isSubscribing}
                  >
                    {isSubscribing ? 'Subscribing...' : 'Subscribe'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Subscribed Devices Section */}
          <div className="notif-section-title">Subscribed Devices</div>

          {error && <div className="notif-error">{error}</div>}

          {loading ? (
            <div className="notif-loading">Loading devices...</div>
          ) : devices.length === 0 ? (
            <div className="notif-empty">No devices subscribed</div>
          ) : (
            <div className="notif-device-list">
              {devices.map((device) => (
                <div
                  key={device.id}
                  className={`notif-device-item ${device.id === currentDeviceId ? 'current' : ''}`}
                >
                  {editingId === device.id ? (
                    <div className="notif-device-edit">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => handleRenameKeyDown(e, device.id)}
                        autoFocus
                      />
                      <button className="btn-sm" onClick={() => handleSaveRename(device.id)}>
                        Save
                      </button>
                      <button className="btn-sm" onClick={handleCancelRename}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="notif-device-info">
                        <div className="notif-device-name">
                          {device.name}
                          {device.id === currentDeviceId && (
                            <span className="notif-current-badge">this device</span>
                          )}
                        </div>
                        <div className="notif-device-date">
                          Subscribed {formatDate(device.subscribedAt)}
                        </div>
                      </div>
                      <div className="notif-device-actions">
                        <button
                          className={`notif-action-btn ${testSuccess === device.id ? 'test-success' : ''}`}
                          onClick={() => handleTest(device.id)}
                          disabled={testingId === device.id}
                          title="Send test notification"
                        >
                          {testingId === device.id ? '⏳' : testSuccess === device.id ? '✅' : '🔔'}
                        </button>
                        <button
                          className="notif-action-btn"
                          onClick={() => handleStartRename(device)}
                          title="Rename device"
                        >
                          ✏️
                        </button>
                        <button
                          className="notif-action-btn"
                          onClick={() => handleDelete(device)}
                          title="Delete device"
                        >
                          🗑️
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
