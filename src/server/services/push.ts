import webPush from 'web-push';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, getConfigDir, updateConfig } from './config.js';
import { pathExists } from '../utils/fs.js';
import type { DeviceSubscription, DeviceInfo } from '../types.js';

const SUBSCRIPTIONS_PATH = join(getConfigDir(), 'push-subscriptions.json');

let subscriptions: DeviceSubscription[] = [];

// VAPID subject must be a valid mailto: or https: URL.
// Apple's push service (APNs) rejects localhost and fake domains in mailto: addresses.
// Using https: URL is more reliable across all push services.
const DEFAULT_VAPID_EMAIL = 'https://github.com/Josecisneros001/RemoteAgent';

export async function initPush(): Promise<void> {
  const config = getConfig();

  // Generate VAPID keys if not present
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.log('Generating VAPID keys...');
    const vapidKeys = webPush.generateVAPIDKeys();
    await updateConfig({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      vapidEmail: config.vapidEmail || DEFAULT_VAPID_EMAIL,
    });
    console.log('VAPID keys generated and saved to config');
  }

  // Fix legacy configs with VAPID subjects that Apple APNs rejects
  const vapidEmail = config.vapidEmail || DEFAULT_VAPID_EMAIL;
  if (vapidEmail.includes('@localhost') || vapidEmail.includes('@push.notifications') || vapidEmail === 'mailto:admin@localhost') {
    console.log('[Push] Replacing invalid VAPID subject (rejected by Apple APNs)');
    await updateConfig({ vapidEmail: DEFAULT_VAPID_EMAIL });
  }

  // Set VAPID details
  const updatedConfig = getConfig();
  webPush.setVapidDetails(
    updatedConfig.vapidEmail || DEFAULT_VAPID_EMAIL,
    updatedConfig.vapidPublicKey!,
    updatedConfig.vapidPrivateKey!
  );

  // Load existing subscriptions
  await loadSubscriptions();
}

async function loadSubscriptions(): Promise<void> {
  if (await pathExists(SUBSCRIPTIONS_PATH)) {
    try {
      const content = await readFile(SUBSCRIPTIONS_PATH, 'utf-8');
      const parsed = JSON.parse(content) as Record<string, unknown>[];
      let needsMigration = false;

      subscriptions = parsed.map((entry) => {
        if (!entry.id) {
          // Migrate old format (PushSubscription without id/name/subscribedAt)
          needsMigration = true;
          return {
            id: uuidv4(),
            name: 'Unknown Device',
            endpoint: entry.endpoint as string,
            keys: entry.keys as { p256dh: string; auth: string },
            subscribedAt: new Date().toISOString(),
          };
        }
        return entry as unknown as DeviceSubscription;
      });

      if (needsMigration) {
        await saveSubscriptions();
        console.log('Migrated push subscriptions to new device format');
      }
    } catch {
      subscriptions = [];
    }
  }
}

async function saveSubscriptions(): Promise<void> {
  await writeFile(SUBSCRIPTIONS_PATH, JSON.stringify(subscriptions, null, 2));
}

export async function addSubscription(endpoint: string, keys: { p256dh: string; auth: string }, name?: string): Promise<DeviceSubscription> {
  const existing = subscriptions.find(s => s.endpoint === endpoint);
  if (existing) {
    if (name) {
      existing.name = name;
      await saveSubscriptions();
    }
    return existing;
  }

  const device: DeviceSubscription = {
    id: uuidv4(),
    name: name || 'Unknown Device',
    endpoint,
    keys,
    subscribedAt: new Date().toISOString(),
  };
  subscriptions.push(device);
  await saveSubscriptions();
  console.log('Push subscription added');
  return device;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  await saveSubscriptions();
}

export async function removeDevice(id: string): Promise<boolean> {
  const index = subscriptions.findIndex(s => s.id === id);
  if (index === -1) return false;
  subscriptions.splice(index, 1);
  await saveSubscriptions();
  return true;
}

export function listDevices(): DeviceInfo[] {
  return subscriptions.map(({ id, name, subscribedAt }) => ({ id, name, subscribedAt }));
}

export async function renameDevice(id: string, name: string): Promise<boolean> {
  const device = subscriptions.find(s => s.id === id);
  if (!device) return false;
  device.name = name;
  await saveSubscriptions();
  return true;
}

export async function sendTestNotification(id: string): Promise<{ success: boolean; error?: string }> {
  const device = subscriptions.find(s => s.id === id);
  if (!device) return { success: false, error: 'Device not found' };

  const payload = JSON.stringify({
    title: '🔔 Test Notification',
    body: `Push notifications are working on "${device.name}"`,
    data: { test: true },
    timestamp: Date.now(),
  });

  try {
    const result = await webPush.sendNotification(device, payload);
    console.log(`[Push] Test notification sent to "${device.name}" (status: ${result.statusCode})`);
    return { success: true };
  } catch (error: unknown) {
    console.error('Test push notification failed:', error);
    let errorMessage = 'Push delivery failed';
    let statusCode: number | undefined;

    if (error && typeof error === 'object') {
      if ('statusCode' in error) {
        statusCode = (error as { statusCode: number }).statusCode;
      }
      if ('body' in error) {
        errorMessage = String((error as { body: unknown }).body) || errorMessage;
      }
      if ('message' in error) {
        errorMessage = (error as Error).message || errorMessage;
      }
    }

    // Remove subscription if push service says it's gone
    if (statusCode === 404 || statusCode === 410) {
      await removeDevice(id);
      errorMessage = 'Device subscription expired — device removed';
    }

    return { success: false, error: `${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}` };
  }
}

export async function sendNotification(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({
    title,
    body,
    data,
    timestamp: Date.now(),
  });

  const failedIds: string[] = [];

  for (const device of subscriptions) {
    try {
      await webPush.sendNotification(device, payload);
    } catch (error: unknown) {
      console.error('Push notification failed:', error);
      // If subscription is invalid, mark for removal
      if (error && typeof error === 'object' && 'statusCode' in error) {
        const statusCode = (error as { statusCode: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          failedIds.push(device.id);
        }
      }
    }
  }

  // Remove failed subscriptions
  for (const id of failedIds) {
    await removeDevice(id);
  }
}

export function getVapidPublicKey(): string {
  const config = getConfig();
  return config.vapidPublicKey || '';
}
