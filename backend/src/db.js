import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'bridge.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys_json TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    project_name TEXT NOT NULL,
    cwd TEXT,
    conversation_id TEXT,
    question TEXT NOT NULL,
    command_preview TEXT,
    details_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decision_reason TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_requests_status_created
    ON requests (status, created_at DESC);
`);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  setSettingStmt.run(key, serialized);
}

export function initDefaults() {
  if (!getSetting('vapidPublicKey') || !getSetting('vapidPrivateKey')) {
    const vapidKeys = webpush.generateVAPIDKeys();
    setSetting('vapidPublicKey', vapidKeys.publicKey);
    setSetting('vapidPrivateKey', vapidKeys.privateKey);
  }

  if (!getSetting('apiToken')) {
    setSetting('apiToken', crypto.randomBytes(24).toString('hex'));
  }

  if (!getSetting('hookSecret')) {
    setSetting('hookSecret', crypto.randomBytes(24).toString('hex'));
  }

  if (!getSetting('rules')) {
    setSetting('rules', {
      run_command: true,
      write_file: false,
      edit_file: false,
      stop_notify: false,
      timeoutSeconds: 180,
      fallbackDecision: 'ask'
    });
  }

  // Mark any stale pending requests from a previous server crash as timed out
  db.prepare(`
    UPDATE requests
    SET status = 'timeout',
        decision_reason = 'Servidor reiniciado',
        resolved_at = ?
    WHERE status = 'pending'
  `).run(new Date().toISOString());
}

export function getSubscriptions() {
  return db
    .prepare('SELECT endpoint, keys_json, user_agent, created_at FROM subscriptions')
    .all()
    .map((row) => ({
      endpoint: row.endpoint,
      keys: JSON.parse(row.keys_json),
      userAgent: row.user_agent,
      createdAt: row.created_at
    }));
}

export function saveSubscription({ endpoint, keys, userAgent = '' }) {
  db.prepare(`
    INSERT INTO subscriptions (endpoint, keys_json, user_agent, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      keys_json = excluded.keys_json,
      user_agent = excluded.user_agent
  `).run(endpoint, JSON.stringify(keys), userAgent, new Date().toISOString());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
}

export function insertRequest(req) {
  db.prepare(`
    INSERT INTO requests (
      id, event_type, tool_name, project_name, cwd, conversation_id,
      question, command_preview, details_json, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.id,
    req.eventType,
    req.toolName,
    req.projectName,
    req.cwd || '',
    req.conversationId || '',
    req.question,
    req.commandPreview || '',
    JSON.stringify(req.details || {}),
    req.status || 'pending',
    req.createdAt,
    req.expiresAt || null
  );
}

export function updateRequestStatus(id, status, decisionReason = '') {
  const resolvedAt = new Date().toISOString();
  db.prepare(`
    UPDATE requests
    SET status = ?, decision_reason = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, decisionReason, resolvedAt, id);
  return getRequestById(id);
}

export function getRequestById(id) {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  return row ? deserializeRequest(row) : null;
}

export function listRequests(limit = 50) {
  const rows = db
    .prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  return rows.map(deserializeRequest);
}

function deserializeRequest(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    toolName: row.tool_name,
    projectName: row.project_name,
    cwd: row.cwd,
    conversationId: row.conversation_id,
    question: row.question,
    commandPreview: row.command_preview,
    details: row.details_json ? JSON.parse(row.details_json) : {},
    status: row.status,
    decisionReason: row.decision_reason || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at
  };
}
