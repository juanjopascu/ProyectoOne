#!/usr/bin/env bash
set -euo pipefail

TUNNEL_URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' ~/Library/Logs/antigravity-tunnel.err.log ~/Library/Logs/antigravity-tunnel.log 2>/dev/null | tail -n 1 || true)
TOKEN=$(/Users/juanjopascuzzi/.local/bin/node -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/Users/juanjopascuzzi/apps/ProyectoOne/backend/data/bridge.db');
const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiToken');
console.log(row ? row.value : '');
" 2>/dev/null || true)

echo "=== Antigravity Phone Bridge (macOS LaunchAgents) ==="
launchctl list | grep -E "com\.antigravity\.(bridge|tunnel)" || echo "Servicios no cargados"
echo ""
echo "Health local: $(curl -s http://127.0.0.1:4789/api/health || echo 'OFFLINE')"
echo "Túnel HTTPS:  ${TUNNEL_URL:-'(iniciando...)'}"
echo "Token:        ${TOKEN}"
if [[ -n "${TUNNEL_URL}" && -n "${TOKEN}" ]]; then
  echo ""
  echo "Enlace directo PWA (1 toque):"
  echo "https://proyecto-one-three.vercel.app/?server=${TUNNEL_URL}&token=${TOKEN}"
fi
