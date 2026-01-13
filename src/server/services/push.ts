import webPush from 'web-push';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getConfig, getConfigDir, updateConfig } from './config.js';
import type { PushSubscription } from '../types.js';

const SUBSCRIPTIONS_PATH = join(getConfigDir(), 'push-subscriptions.json');

let subscriptions: PushSubscription[] = [];

export async function initPush(): Promise<void> {
  const config = getConfig();
  
  // Generate VAPID keys if not present
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.log('Generating VAPID keys...');
    const vapidKeys = webPush.generateVAPIDKeys();
    await updateConfig({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      vapidEmail: config.vapidEmail || 'mailto:admin@localhost',
    });
    console.log('VAPID keys generated and saved to config');
  }
  
  // Set VAPID details
  const updatedConfig = getConfig();
  webPush.setVapidDetails(
    updatedConfig.vapidEmail || 'mailto:admin@localhost',
    updatedConfig.vapidPublicKey!,
    updatedConfig.vapidPrivateKey!
  );
  
  // Load existing subscriptions
  await loadSubscriptions();
}

async function loadSubscriptions(): Promise<void> {
  if (existsSync(SUBSCRIPTIONS_PATH)) {
    try {
      const content = await readFile(SUBSCRIPTIONS_PATH, 'utf-8');
      subscriptions = JSON.parse(content);
    } catch {
      subscriptions = [];
    }
  }
}

async function saveSubscriptions(): Promise<void> {
  await writeFile(SUBSCRIPTIONS_PATH, JSON.stringify(subscriptions, null, 2));
}

export async function addSubscription(subscription: PushSubscription): Promise<void> {
  // Avoid duplicates
  const exists = subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    await saveSubscriptions();
    console.log('Push subscription added');
  }
}

export async function removeSubscription(endpoint: string): Promise<void> {
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  await saveSubscriptions();
}

export async function sendNotification(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({
    title,
    body,
    data,
    timestamp: Date.now(),
  });

  const failedEndpoints: string[] = [];

  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(subscription, payload);
    } catch (error: unknown) {
      console.error('Push notification failed:', error);
      // If subscription is invalid, mark for removal
      if (error && typeof error === 'object' && 'statusCode' in error) {
        const statusCode = (error as { statusCode: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          failedEndpoints.push(subscription.endpoint);
        }
      }
    }
  }

  // Remove failed subscriptions
  for (const endpoint of failedEndpoints) {
    await removeSubscription(endpoint);
  }
}

export function getVapidPublicKey(): string {
  const config = getConfig();
  return config.vapidPublicKey || '';
}
