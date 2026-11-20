import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  initDefaults,
  getSetting,
  setSetting,
  getSubscriptions,
  saveSubscription,
  removeSubscription,
  listRequests,
  getRequestById
} from './db.js';
import { configureWebPush, getVapidPublicKey, sendPushToAll } from './pushService.js';
import {
  registerWsClient,
  createAndAwaitApproval,
  createInfoNotification,
  resolveApproval
} from './approvalHub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');
const HOOK_CONFIG_PATH = path.join(os.homedir(), '.antigravity-bridge.json');

initDefaults();
configureWebPush();

const PORT = Number(process.env.PORT || 4789);
const API_TOKEN = getSetting('apiToken');
const HOOK_SECRET = getSetting('hookSecret');

// Persist local connection info for the hook script (owner-only permissions)
await fs.promises.writeFile(
  HOOK_CONFIG_PATH,
  JSON.stringify(
    {
      url: `http://127.0.0.1:${PORT}`,
      hookSecret: HOOK_SECRET
    },
    null,
    2
  ),
  { mode: 0o600 }
);

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.json({ limit: '1mb' }));

function isLocalhost(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireUserAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearer || req.headers['x-api-token'] || req.query.token || '';

  if (token && token === API_TOKEN) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Token inválido o faltante' });
}

function requireHookAuth(req, res, next) {
  const secret = req.headers['x-hook-secret'] || '';
  if (isLocalhost(req) && secret === HOOK_SECRET) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Hook no autorizado' });
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      subscriptions: getSubscriptions().length,
      port: PORT
    }
  });
});

// Localhost-only pairing endpoint so opening http://localhost:4789 on Mac shows pairing info
app.get('/api/pairing', (req, res) => {
  if (!isLocalhost(req)) {
    return res.status(403).json({ success: false, error: 'Solo disponible en localhost' });
  }
  res.json({
    success: true,
    data: {
      apiToken: API_TOKEN,
      port: PORT
    }
  });
});

// Auth verification
app.get('/api/auth/verify', requireUserAuth, (_req, res) => {
  res.json({ success: true, data: { authenticated: true } });
});

// VAPID public key
app.get('/api/push/vapid-public-key', requireUserAuth, (_req, res) => {
  res.json({ success: true, data: { publicKey: getVapidPublicKey() } });
});

// Save Web Push subscription
app.post('/api/push/subscribe', requireUserAuth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ success: false, error: 'Suscripción Web Push inválida' });
  }
  saveSubscription({
    endpoint: sub.endpoint,
    keys: sub.keys,
    userAgent: req.headers['user-agent'] || ''
  });
  res.json({ success: true, data: { totalSubscriptions: getSubscriptions().length } });
});

// Remove Web Push subscription
app.post('/api/push/unsubscribe', requireUserAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) removeSubscription(endpoint);
  res.json({ success: true, data: { totalSubscriptions: getSubscriptions().length } });
});

// Send test push notification
app.post('/api/push/test', requireUserAuth, async (_req, res) => {
  try {
    const result = await sendPushToAll({
      type: 'test',
      title: '✅ Antigravity Bridge conectado',
      body: 'Las notificaciones push están funcionando correctamente en tu teléfono.',
      tag: 'agy-test',
      url: '/'
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || 'Error enviando notificación' });
  }
});

// List requests (pending + history)
app.get('/api/requests', requireUserAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  res.json({ success: true, data: listRequests(limit) });
});

app.get('/api/requests/:id', requireUserAuth, (req, res) => {
  const item = getRequestById(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'No encontrado' });
  res.json({ success: true, data: item });
});

// Approve or reject a pending request (called from PWA UI or Service Worker notification button)
app.post('/api/requests/:id/decide', requireUserAuth, (req, res) => {
  const { decision, reason } = req.body || {};
  if (!['approved', 'rejected', 'allow', 'deny'].includes(decision)) {
    return res.status(400).json({ success: false, error: 'Decisión inválida' });
  }
  const result = resolveApproval(req.params.id, decision, reason || '');
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error, data: result.request });
  }
  res.json({ success: true, data: result.request });
});

// Settings
app.get('/api/settings', requireUserAuth, (_req, res) => {
  res.json({
    success: true,
    data: {
      rules: getSetting('rules'),
      subscriptionsCount: getSubscriptions().length
    }
  });
});

app.put('/api/settings', requireUserAuth, (req, res) => {
  const current = getSetting('rules', {});
  const next = {
    run_command: typeof req.body?.run_command === 'boolean' ? req.body.run_command : current.run_command,
    write_file: typeof req.body?.write_file === 'boolean' ? req.body.write_file : current.write_file,
    edit_file: typeof req.body?.edit_file === 'boolean' ? req.body.edit_file : current.edit_file,
    stop_notify: typeof req.body?.stop_notify === 'boolean' ? req.body.stop_notify : current.stop_notify,
    timeoutSeconds: Number(req.body?.timeoutSeconds) || current.timeoutSeconds || 180,
    fallbackDecision: req.body?.fallbackDecision === 'deny' ? 'deny' : 'ask'
  };
  setSetting('rules', next);
  res.json({ success: true, data: { rules: next } });
});

// Hook endpoint (called synchronously by hook/agy-notify-hook.mjs)
app.post('/api/hooks/event', requireHookAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const eventType = payload.hookEventName || 'PreToolUse';
    const rules = getSetting('rules', { run_command: true });

    const cwd = payload.cwd || payload.workspacePaths?.[0] || '';
    const projectName = cwd ? path.basename(cwd) : 'Antigravity IDE';
    const conversationId = payload.conversationId || '';

    if (eventType === 'PreToolUse') {
      const toolName = payload.toolCall?.name || 'unknown_tool';
      const args = payload.toolCall?.args || {};

      // Check if this tool is enabled for phone approval
      if (!rules[toolName]) {
        return res.json({ decision: 'allow' });
      }

      let question = `¿Aprobar acción "${toolName}"?`;
      let commandPreview = '';

      if (toolName === 'run_command') {
        commandPreview = args.CommandLine || '';
        const summary = args.toolSummary ? ` (${args.toolSummary})` : '';
        question = `¿Ejecutar comando en ${projectName}?${summary}`;
      } else if (toolName === 'write_file') {
        commandPreview = args.Path || '';
        question = `¿Crear/sobrescribir archivo en ${projectName}?`;
      } else if (toolName === 'edit_file') {
        commandPreview = args.Path || '';
        question = `¿Editar archivo en ${projectName}?`;
      }

      const result = await createAndAwaitApproval({
        eventType,
        toolName,
        projectName,
        cwd,
        conversationId,
        question,
        commandPreview,
        details: {
          args,
          lastUserInput: payload.lastUserInput || '',
          stepIdx: payload.stepIdx
        },
        apiToken: API_TOKEN
      });

      return res.json(result);
    }

    if (eventType === 'Stop') {
      if (rules.stop_notify) {
        const reason = payload.terminationReason || 'NO_TOOL_CALL';
        const question =
          reason === 'ERROR'
            ? `El agente se detuvo por un error: ${payload.error || 'Revisar IDE'}`
            : `El agente finalizó su turno en ${projectName} y espera tus instrucciones.`;

        await createInfoNotification({
          eventType,
          toolName: 'Stop',
          projectName,
          cwd,
          conversationId,
          question,
          commandPreview: payload.lastUserInput || '',
          details: { terminationReason: reason, error: payload.error || '' }
        });
      }
      return res.json({ decision: 'allow' });
    }

    return res.json({ decision: 'allow' });
  } catch (err) {
    console.error('[hook] Error processing event:', err);
    return res.json({ decision: 'ask', reason: 'Error en Antigravity Bridge, confirmando en IDE.' });
  }
});

// Serve built PWA static assets
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

const server = http.createServer(app);

// WebSocket server for instant UI sync
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (token !== API_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  registerWsClient(ws);
  ws.send(JSON.stringify({ type: 'connected', data: { ok: true } }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('==============================================================');
  console.log('  🚀 Antigravity Phone Bridge activo');
  console.log(`  📡 URL Local:    http://localhost:${PORT}`);
  console.log(`  🔑 Token de App: ${API_TOKEN}`);
  console.log('  🌐 Para usarlo desde 4G/5G (HTTPS requerido para Push):');
  console.log('     npm run tunnel');
  console.log('==============================================================');
  console.log('');
});
