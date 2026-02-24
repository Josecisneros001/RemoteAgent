import { useState, useEffect, useCallback } from 'react';
import { fetchVapidKey, subscribePush, unsubscribePush } from '../api';

function detectDeviceName(): string {
  const ua = navigator.userAgent;

  // Detect browser
  let browser = 'Browser';
  if (ua.includes('Firefox')) {
    browser = 'Firefox';
  } else if (ua.includes('Edg')) {
    browser = 'Edge';
  } else if (ua.includes('Chrome')) {
    browser = 'Chrome';
  } else if (ua.includes('Safari')) {
    browser = 'Safari';
  }

  // Detect OS
  let os = 'Unknown';
  if (/iPad|iPhone|iPod/.test(ua)) {
    os = 'iOS';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('Windows')) {
    os = 'Windows';
  } else if (ua.includes('Mac OS')) {
    os = 'macOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  return `${browser} on ${os}`;
}

export function useNotifications() {
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Check initial notification state from localStorage and service worker
  useEffect(() => {
    const checkNotificationState = async () => {
      // Read stored device ID
      const storedDeviceId = localStorage.getItem('notification-device-id');
      if (storedDeviceId) {
        setCurrentDeviceId(storedDeviceId);
      }

      // First, check if push notifications are supported
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setNotificationsEnabled(false);
        return;
      }

      const stored = localStorage.getItem('notifications-enabled');
      if (stored === 'true') {
        // Verify we still have an active subscription
        try {
          // Check if service worker is registered, with a timeout
          const registrations = await navigator.serviceWorker.getRegistrations();
          if (registrations.length === 0) {
            // No service worker registered, reset state
            localStorage.setItem('notifications-enabled', 'false');
            setNotificationsEnabled(false);
            return;
          }

          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          setNotificationsEnabled(!!subscription);
          if (!subscription) {
            localStorage.setItem('notifications-enabled', 'false');
          }
        } catch {
          localStorage.setItem('notifications-enabled', 'false');
          setNotificationsEnabled(false);
        }
      } else {
        setNotificationsEnabled(false);
      }
    };
    checkNotificationState();
  }, []);

  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  const subscribe = useCallback(async () => {
    if (isSubscribing) return;

    setIsSubscribing(true);
    setSubscribeError(null);
    try {
      // Check if push is supported
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) {
          setSubscribeError('On iOS, push notifications require adding this app to your Home Screen first. Tap the Share button → "Add to Home Screen", then try again.');
        } else {
          setSubscribeError('Push notifications are not supported on this browser. Try Chrome, Edge, or Firefox.');
        }
        return;
      }

      // Check if Notification API exists
      if (typeof Notification === 'undefined') {
        setSubscribeError('Notifications API is not available in this browser.');
        return;
      }

      // Check if permission was previously denied (browser won't show prompt again)
      if (Notification.permission === 'denied') {
        setSubscribeError('Notifications are blocked for this site. To fix: click the lock/site icon in your address bar → find Notifications → change to Allow, then reload the page.');
        return;
      }

      // Request permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setSubscribeError('Notification permission is required. If you dismissed the prompt, reload the page and try again.');
        return;
      }

      // Register service worker and wait for it to be active
      const registration = await navigator.serviceWorker.register('/sw.js');

      // Wait for the service worker to be active
      const waitForActive = async (reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> => {
        if (reg.active) return reg;

        const sw = reg.installing || reg.waiting;
        if (!sw) throw new Error('No service worker found');

        return new Promise((resolve, reject) => {
          const handleStateChange = () => {
            if (sw.state === 'activated') {
              clearTimeout(timeout);
              sw.removeEventListener('statechange', handleStateChange);
              resolve(reg);
            } else if (sw.state === 'redundant') {
              clearTimeout(timeout);
              sw.removeEventListener('statechange', handleStateChange);
              reject(new Error('Service worker became redundant'));
            }
          };

          const timeout = setTimeout(() => {
            sw.removeEventListener('statechange', handleStateChange);
            reject(new Error('Service worker activation timeout'));
          }, 10000);

          sw.addEventListener('statechange', handleStateChange);
        });
      };

      await waitForActive(registration);

      // Get VAPID key from server
      const { publicKey } = await fetchVapidKey();

      // Convert base64 VAPID key to Uint8Array
      const urlBase64ToUint8Array = (base64String: string) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
      };

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Detect device name and send subscription to server
      const deviceName = detectDeviceName();
      const result = await subscribePush(subscription.toJSON(), deviceName);

      // Store device ID
      localStorage.setItem('notification-device-id', result.device.id);
      setCurrentDeviceId(result.device.id);

      localStorage.setItem('notifications-enabled', 'true');
      setNotificationsEnabled(true);
    } catch (error) {
      console.error('Failed to subscribe:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      setSubscribeError(`Failed to subscribe: ${message}`);
    } finally {
      setIsSubscribing(false);
    }
  }, [isSubscribing]);

  const unsubscribe = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Notify server first
        await unsubscribePush(subscription.endpoint);
        // Then unsubscribe locally
        await subscription.unsubscribe();
      }
      localStorage.setItem('notifications-enabled', 'false');
      localStorage.removeItem('notification-device-id');
      setCurrentDeviceId(null);
      setNotificationsEnabled(false);
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
    }
  }, []);

  const toggleNotifications = useCallback(async () => {
    if (isSubscribing || notificationsEnabled === null) return;

    if (notificationsEnabled) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  }, [notificationsEnabled, isSubscribing, subscribe, unsubscribe]);

  return {
    notificationsEnabled,
    isSubscribing,
    subscribeError,
    toggleNotifications,
    subscribe,
    unsubscribe,
    currentDeviceId,
    showModal,
    setShowModal,
  };
}
