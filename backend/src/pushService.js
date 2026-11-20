import webpush from 'web-push';
import { getSetting, getSubscriptions, removeSubscription } from './db.js';

let configured = false;

export function configureWebPush() {
  const publicKey = getSetting('vapidPublicKey');
  const privateKey = getSetting('vapidPrivateKey');
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@antigravity-bridge.local';

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export function getVapidPublicKey() {
  return getSetting('vapidPublicKey');
}

export async function sendPushToAll(payload) {
  if (!configured) configureWebPush();

  const subs = getSubscriptions();
  if (subs.length === 0) {
    return { sent: 0, failed: 0, total: 0 };
  }

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 180, urgency: 'high' }
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          removeSubscription(sub.endpoint);
        } else {
          console.error('[pushService] Error sending push:', statusCode || err?.message);
        }
      }
    })
  );

  return { sent, failed, total: subs.length };
}
