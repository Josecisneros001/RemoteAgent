import { useState, useEffect, useCallback } from 'react';
import { fetchVapidKey, subscribePush } from '../api';

export function useNotifications() {
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);

  // Check initial notification state from localStorage and service worker
  useEffect(() => {
    const checkNotificationState = async () => {
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

  const toggleNotifications = useCallback(async () => {
    if (isSubscribing || notificationsEnabled === null) return;

    if (notificationsEnabled) {
      // Unsubscribe
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
        }
        localStorage.setItem('notifications-enabled', 'false');
        setNotificationsEnabled(false);
      } catch (error) {
        console.error('Failed to unsubscribe:', error);
      }
    } else {
      // Subscribe
      setIsSubscribing(true);
      try {
        // Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setIsSubscribing(false);
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
            const timeout = setTimeout(() => reject(new Error('Service worker activation timeout')), 10000);
            
            sw.addEventListener('statechange', () => {
              if (sw.state === 'activated') {
                clearTimeout(timeout);
                resolve(reg);
              } else if (sw.state === 'redundant') {
                clearTimeout(timeout);
                reject(new Error('Service worker became redundant'));
              }
            });
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

        // Send subscription to server
        await subscribePush(subscription.toJSON());

        localStorage.setItem('notifications-enabled', 'true');
        setNotificationsEnabled(true);
      } catch (error) {
        console.error('Failed to subscribe:', error);
      } finally {
        setIsSubscribing(false);
      }
    }
  }, [notificationsEnabled, isSubscribing]);

  return {
    notificationsEnabled,
    isSubscribing,
    toggleNotifications,
  };
}
