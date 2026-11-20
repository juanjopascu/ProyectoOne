# Antigravity Phone Bridge (AGY Bridge)

Aplicación PWA con **Notificaciones Push nativas** para aprobar o rechazar acciones de **Antigravity IDE** desde tu teléfono (iOS y Android) desde cualquier lugar.

## Arquitectura

1. **Hook global de Antigravity IDE** (`~/.gemini/config/hooks.json` → `hook/agy-notify-hook.mjs`):
   - Intercepta `PreToolUse` (`run_command`, `write_file`, `edit_file`) y `Stop`.
   - Por defecto pide aprobación para `run_command` (puedes activar/desactivar el resto desde la app en tu teléfono).
   - Si el servidor local no está corriendo, hace *fallback* instantáneo (< 1s) a `"ask"` para que Antigravity IDE siga funcionando normal sin trabarse.
2. **Backend (`backend/`)**:
   - Express 5 + WebSockets (`ws`) + Web Push (`web-push` con claves VAPID autogeneradas) + SQLite (`node:sqlite`).
   - Sirve el frontend compilado y la API en el mismo puerto (`4789`).
3. **Frontend PWA (`frontend/`)**:
   - Instalable en iPhone (Safari → Compartir → Agregar a pantalla de inicio) y Android (Chrome → Instalar app).
   - Recibe notificaciones push con botones **✅ Aprobar** / **❌ Rechazar** y sincronización en vivo por WebSocket.

## Uso rápido

```bash
# 1. Instalar dependencias y compilar PWA (ya ejecutado)
npm run install:all
npm run build

# 2. Iniciar el servidor puente
npm start

# 3. En otra terminal, abrir túnel HTTPS (requerido para Web Push y uso desde 4G/5G)
npm run tunnel
```

Al abrir el enlace HTTPS del túnel en tu teléfono agregando `/?token=<TU_TOKEN>`, se vinculará automáticamente.

## Probar sin esperar al IDE

```bash
npm run test:hook
```
