#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Allow emergency bypass via environment variable
if (process.env.AGY_BRIDGE_BYPASS === '1') {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

const CONFIG_PATH = path.join(os.homedir(), '.antigravity-bridge.json');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function outputAndExit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  if (!raw) {
    outputAndExit({ decision: 'ask' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    outputAndExit({ decision: 'ask' });
  }

  // If bridge config does not exist yet, fall back cleanly to IDE prompt
  if (!fs.existsSync(CONFIG_PATH)) {
    outputAndExit({ decision: 'ask' });
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    outputAndExit({ decision: 'ask' });
  }

  const baseUrl = config.url || 'http://127.0.0.1:4789';
  const hookSecret = config.hookSecret || '';

  // Quick health check (800ms) so IDE never hangs if bridge server is stopped
  try {
    const healthCtrl = new AbortController();
    const healthTimer = setTimeout(() => healthCtrl.abort(), 800);
    const healthRes = await fetch(`${baseUrl}/api/health`, { signal: healthCtrl.signal });
    clearTimeout(healthTimer);
    if (!healthRes.ok) {
      outputAndExit({ decision: 'ask' });
    }
  } catch {
    // Bridge server is offline -> transparently fall back to IDE confirmation
    outputAndExit({ decision: 'ask' });
  }

  // Forward event and wait for phone approval (up to 235s)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 235_000);

    const res = await fetch(`${baseUrl}/api/hooks/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Secret': hookSecret
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      outputAndExit({ decision: 'ask' });
    }

    const decision = await res.json();
    outputAndExit(decision);
  } catch {
    outputAndExit({
      decision: 'ask',
      reason: 'Sin respuesta desde el teléfono; confirmando en Antigravity IDE.'
    });
  }
}

main();
