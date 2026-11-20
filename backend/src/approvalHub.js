import crypto from 'node:crypto';
import { insertRequest, updateRequestStatus, getRequestById, getSetting } from './db.js';
import { sendPushToAll } from './pushService.js';

const pendingResolvers = new Map();
const wsClients = new Set();

export function registerWsClient(ws) {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
}

export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of wsClients) {
    if (client.readyState === 1) {
      try {
        client.send(msg);
      } catch {
        // Ignore broken sockets
      }
    }
  }
}

export async function createAndAwaitApproval({
  eventType,
  toolName,
  projectName,
  cwd,
  conversationId,
  question,
  commandPreview,
  details,
  apiToken
}) {
  const rules = getSetting('rules', {
    timeoutSeconds: 180,
    fallbackDecision: 'ask'
  });
  const timeoutSeconds = Math.max(15, Math.min(230, Number(rules.timeoutSeconds) || 180));
  const fallbackDecision = rules.fallbackDecision === 'deny' ? 'deny' : 'ask';

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000).toISOString();

  const record = {
    id,
    eventType,
    toolName,
    projectName,
    cwd,
    conversationId,
    question,
    commandPreview,
    details,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt
  };

  insertRequest(record);
  const saved = getRequestById(id);
  broadcast('request_created', saved);

  // Send Web Push notification to all subscribed phones
  const pushBody = commandPreview
    ? `${question}\n$ ${commandPreview.slice(0, 140)}`
    : question;

  await sendPushToAll({
    type: 'approval_request',
    requestId: id,
    title: `⚡ ${projectName}: Aprobación requerida`,
    body: pushBody,
    tag: `agy-${id}`,
    apiToken,
    requireInteraction: true,
    actions: [
      { action: 'approve', title: '✅ Aprobar' },
      { action: 'reject', title: '❌ Rechazar' }
    ],
    url: `/?request=${id}`
  });

  // Wait for user decision or timeout
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingResolvers.has(id)) {
        pendingResolvers.delete(id);
        const updated = updateRequestStatus(
          id,
          'timeout',
          `Sin respuesta en ${timeoutSeconds}s (fallback: ${fallbackDecision})`
        );
        broadcast('request_updated', updated);
        resolve({
          decision: fallbackDecision,
          reason: `Tiempo de espera agotado (${timeoutSeconds}s) en el teléfono.`
        });
      }
    }, timeoutSeconds * 1000);

    pendingResolvers.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        pendingResolvers.delete(id);
        resolve(result);
      }
    });
  });
}

export async function createInfoNotification({
  eventType,
  toolName,
  projectName,
  cwd,
  conversationId,
  question,
  commandPreview,
  details
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  insertRequest({
    id,
    eventType,
    toolName,
    projectName,
    cwd,
    conversationId,
    question,
    commandPreview,
    details,
    status: 'info',
    createdAt: now,
    expiresAt: null
  });

  const saved = getRequestById(id);
  broadcast('request_created', saved);

  await sendPushToAll({
    type: 'info',
    requestId: id,
    title: `🔔 ${projectName}: Antigravity IDE`,
    body: question,
    tag: `agy-info-${id}`,
    requireInteraction: false,
    url: `/?request=${id}`
  });

  return saved;
}

export function resolveApproval(id, decision, reason = '') {
  const existing = getRequestById(id);
  if (!existing) {
    return { ok: false, status: 404, error: 'Solicitud no encontrada' };
  }
  if (existing.status !== 'pending') {
    return { ok: false, status: 409, error: `La solicitud ya fue resuelta (${existing.status})`, request: existing };
  }

  const normalized = decision === 'approved' || decision === 'allow' ? 'approved' : 'rejected';
  const finalReason =
    reason?.trim() ||
    (normalized === 'approved' ? 'Aprobado desde el teléfono' : 'Rechazado desde el teléfono');

  const updated = updateRequestStatus(id, normalized, finalReason);
  broadcast('request_updated', updated);

  const pending = pendingResolvers.get(id);
  if (pending) {
    pending.resolve({
      decision: normalized === 'approved' ? 'allow' : 'deny',
      reason: finalReason
    });
  }

  return { ok: true, request: updated };
}
