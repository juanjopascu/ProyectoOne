import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  Clock,
  Copy,
  History,
  KeyRound,
  Send,
  Settings,
  ShieldAlert,
  Terminal,
  X,
  Zap
} from 'lucide-react';

const TOKEN_STORAGE_KEY = 'agy_bridge_api_token';
const SERVER_STORAGE_KEY = 'agy_bridge_server_url';

function normalizeServerUrl(raw) {
  return (raw || '').trim().replace(/\/+$/, '');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function Countdown({ expiresAt }) {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)) : 0
  );

  useEffect(() => {
    if (!expiresAt) return undefined;
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return <span className="countdown">⏱ {remaining}s</span>;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const urlServer = params.get('server');
    if (urlServer) {
      const cleaned = normalizeServerUrl(urlServer);
      localStorage.setItem(SERVER_STORAGE_KEY, cleaned);
      return cleaned;
    }
    return normalizeServerUrl(localStorage.getItem(SERVER_STORAGE_KEY) || '');
  });

  const [token, setToken] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken || params.get('server')) {
      if (urlToken) localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
      params.delete('token');
      params.delete('server');
      const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
      window.history.replaceState({}, '', cleanUrl);
      if (urlToken) return urlToken;
    }
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  });

  const [serverInput, setServerInput] = useState(serverUrl);
  const [tokenInput, setTokenInput] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [tab, setTab] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [reasons, setReasons] = useState({});
  const [busyIds, setBusyIds] = useState({});
  const [rules, setRules] = useState({
    run_command: true,
    write_file: false,
    edit_file: false,
    stop_notify: false,
    timeoutSeconds: 180,
    fallbackDecision: 'ask'
  });
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported] = useState(() => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window);
  const [toast, setToast] = useState('');
  const [localPairing, setLocalPairing] = useState(null);
  const wsRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3200);
  };

  const apiFetch = async (url, options = {}, overrideToken) => {
    const activeToken = overrideToken ?? token;
    const base = normalizeServerUrl(serverUrl);
    const res = await fetch(`${base}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeToken}`,
        ...(options.headers || {})
      }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  };

  // If opened on localhost (Mac), auto-fetch pairing token for convenience
  useEffect(() => {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      fetch('/api/pairing')
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (res?.data?.apiToken) {
            setLocalPairing(res.data);
            if (!token) {
              localStorage.setItem(TOKEN_STORAGE_KEY, res.data.apiToken);
              setToken(res.data.apiToken);
            }
          }
        })
        .catch(() => {});
    }
  }, [token]);

  // Verify token and load initial state
  useEffect(() => {
    if (!token) {
      setAuthenticated(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await apiFetch('/api/auth/verify');
        if (cancelled) return;
        setAuthenticated(true);
        setAuthError('');

        const [reqRes, setRes] = await Promise.all([
          apiFetch('/api/requests'),
          apiFetch('/api/settings')
        ]);
        if (cancelled) return;
        setRequests(reqRes.data || []);
        if (setRes.data?.rules) setRules(setRes.data.rules);

        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          const existingSub = await reg.pushManager.getSubscription();
          if (!cancelled) setPushEnabled(Boolean(existingSub));
        }
      } catch (err) {
        if (!cancelled) {
          setAuthenticated(false);
          setAuthError(err.message || 'Token inválido');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, serverUrl]);

  // WebSocket live updates
  useEffect(() => {
    if (!authenticated || !token) return undefined;

    let reconnectTimer;
    let closed = false;

    const connect = () => {
      const target = normalizeServerUrl(serverUrl) || window.location.origin;
      const wsBase = target.replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) {
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'request_created' && msg.data) {
            setRequests((prev) => [msg.data, ...prev.filter((r) => r.id !== msg.data.id)]);
            if (msg.data.status === 'pending') {
              setTab('pending');
            }
          } else if (msg.type === 'request_updated' && msg.data) {
            setRequests((prev) => prev.map((r) => (r.id === msg.data.id ? msg.data : r)));
          }
        } catch {
          // ignore
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [authenticated, token, serverUrl]);

  const pendingRequests = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);
  const historyRequests = useMemo(() => requests.filter((r) => r.status !== 'pending'), [requests]);

  const handleDecide = async (id, decision) => {
    setBusyIds((prev) => ({ ...prev, [id]: true }));
    try {
      const reason = reasons[id] || '';
      const res = await apiFetch(`/api/requests/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason })
      });
      if (res.data) {
        setRequests((prev) => prev.map((r) => (r.id === id ? res.data : r)));
      }
      showToast(decision === 'approved' ? '✅ Aprobado en Antigravity IDE' : '❌ Rechazado en Antigravity IDE');
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      setBusyIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleEnablePush = async () => {
    if (!pushSupported) {
      showToast('En iPhone: instala primero la app (Compartir → Agregar a inicio).');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('Permiso de notificaciones denegado.');
        return;
      }

      const { data } = await apiFetch('/api/push/vapid-public-key');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey)
        });
      }

      await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON() })
      });

      setPushEnabled(true);
      showToast('🔔 Notificaciones Push activadas');
    } catch (err) {
      showToast(`No se pudo activar Push: ${err.message}`);
    }
  };

  const handleDisablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await apiFetch('/api/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
        await sub.unsubscribe();
      }
      setPushEnabled(false);
      showToast('Notificaciones desactivadas');
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  };

  const handleTestPush = async () => {
    try {
      const res = await apiFetch('/api/push/test', { method: 'POST' });
      if (res.data?.sent > 0) {
        showToast('📨 Notificación de prueba enviada');
      } else {
        showToast('Primero activa las notificaciones push en tu teléfono.');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  };

  const updateRule = async (patch) => {
    const next = { ...rules, ...patch };
    setRules(next);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(next)
      });
      if (res.data?.rules) setRules(res.data.rules);
      showToast('Configuración guardada');
    } catch (err) {
      showToast(`Error guardando: ${err.message}`);
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    const cleanedToken = tokenInput.trim();
    const cleanedServer = normalizeServerUrl(serverInput);
    if (!cleanedToken) return;
    localStorage.setItem(SERVER_STORAGE_KEY, cleanedServer);
    localStorage.setItem(TOKEN_STORAGE_KEY, cleanedToken);
    setServerUrl(cleanedServer);
    setToken(cleanedToken);
  };

  const handleLogout = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken('');
    setAuthenticated(false);
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copiado`);
    } catch {
      showToast('No se pudo copiar');
    }
  };

  if (!authenticated) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-icon">
              <Zap size={20} />
            </div>
            <div>
              <h1>Antigravity Bridge</h1>
              <p>Aprobaciones remotas del IDE</p>
            </div>
          </div>
        </header>

        <main className="content">
          <form className="card" onSubmit={handleLogin}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <KeyRound size={20} color="#38bdf8" />
              <h2 style={{ margin: 0, fontSize: 17 }}>Vincular dispositivo</h2>
            </div>
            <p className="context-note">
              Ingresa la URL de tu túnel HTTPS (si abriste la app desde Vercel) y el token que aparece en tu Mac al
              iniciar el servidor.
            </p>
            <input
              className="reason-input"
              type="url"
              placeholder="URL del Bridge (ej: https://xxx.trycloudflare.com) — opcional en local"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
            />
            <input
              className="reason-input"
              type="password"
              placeholder="Token de acceso..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            {authError && (
              <div style={{ color: '#fca5a5', fontSize: 13 }}>{authError}</div>
            )}
            <button type="submit" className="btn btn-primary">
              Conectar con Antigravity IDE
            </button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Zap size={20} />
          </div>
          <div>
            <h1>Antigravity Bridge</h1>
            <p>{pendingRequests.length > 0 ? `${pendingRequests.length} pendiente(s)` : 'Esperando eventos del IDE'}</p>
          </div>
        </div>
        <div className="status-pill">
          <span className={`dot ${wsConnected ? 'online' : 'offline'}`} />
          {wsConnected ? 'En vivo' : 'Reconectando'}
        </div>
      </header>

      <main className="content">
        {!pushEnabled && (
          <div className="banner warn">
            <strong>Activa las notificaciones push</strong>
            <span>
              Para recibir alertas cuando el teléfono esté bloqueado, activa las notificaciones. En iPhone (iOS), primero
              abre esta URL HTTPS en Safari → <b>Compartir</b> → <b>Agregar a pantalla de inicio</b> y ábrela desde ahí.
            </span>
            <button className="btn btn-primary" onClick={handleEnablePush} style={{ padding: '10px 12px', fontSize: 14 }}>
              <Bell size={16} /> Activar notificaciones Push
            </button>
          </div>
        )}

        {localPairing && (
          <div className="banner info">
            <strong>Modo Mac (localhost)</strong>
            <span>
              Inicia el túnel HTTPS con <code>npm run tunnel</code> y abre en tu teléfono:{' '}
              <code>https://TU-TUNEL.trycloudflare.com/?token={localPairing.apiToken}</code>
            </span>
            <button
              className="btn btn-secondary"
              style={{ padding: '8px 12px', fontSize: 13 }}
              onClick={() => copyText(`/?token=${localPairing.apiToken}`, 'Parámetro de token')}
            >
              <Copy size={14} /> Copiar ?token=...
            </button>
          </div>
        )}

        {tab === 'pending' && (
          <>
            {pendingRequests.length === 0 ? (
              <div className="empty-state">
                <ShieldAlert size={42} color="#38bdf8" strokeWidth={1.6} />
                <h3>Todo tranquilo por ahora</h3>
                <p>
                  Cuando Antigravity IDE quiera ejecutar un comando en cualquiera de tus proyectos, llegará una
                  notificación push aquí para que apruebes o rechaces.
                </p>
              </div>
            ) : (
              pendingRequests.map((req) => (
                <article key={req.id} className="card pending-card">
                  <div className="card-header">
                    <div className="badges">
                      <span className="badge">{req.projectName}</span>
                      <span className="badge tool">
                        <Terminal size={12} /> {req.toolName}
                      </span>
                    </div>
                    <Countdown expiresAt={req.expiresAt} />
                  </div>

                  <h2 className="question">{req.question}</h2>

                  {req.commandPreview && <pre className="code-block">{req.commandPreview}</pre>}

                  {req.details?.lastUserInput && (
                    <p className="context-note">
                      <strong>Tu pedido:</strong> {req.details.lastUserInput}
                    </p>
                  )}

                  <input
                    className="reason-input"
                    type="text"
                    placeholder="Motivo opcional (ej: mejor usa npm test...)"
                    value={reasons[req.id] || ''}
                    onChange={(e) => setReasons((prev) => ({ ...prev, [req.id]: e.target.value }))}
                  />

                  <div className="actions-row">
                    <button
                      className="btn btn-reject"
                      disabled={busyIds[req.id]}
                      onClick={() => handleDecide(req.id, 'rejected')}
                    >
                      <X size={18} /> Rechazar
                    </button>
                    <button
                      className="btn btn-approve"
                      disabled={busyIds[req.id]}
                      onClick={() => handleDecide(req.id, 'approved')}
                    >
                      <Check size={18} /> Aprobar
                    </button>
                  </div>
                </article>
              ))
            )}
          </>
        )}

        {tab === 'history' && (
          <>
            {historyRequests.length === 0 ? (
              <div className="empty-state">
                <History size={40} color="#64748b" />
                <h3>Sin historial todavía</h3>
                <p>Aquí verás todas las aprobaciones, rechazos y alertas recibidas desde Antigravity IDE.</p>
              </div>
            ) : (
              historyRequests.map((req) => (
                <article key={req.id} className="card">
                  <div className="card-header">
                    <div className="badges">
                      <span className="badge">{req.projectName}</span>
                      <span className={`badge ${req.status}`}>
                        {req.status === 'approved'
                          ? 'Aprobado'
                          : req.status === 'rejected'
                            ? 'Rechazado'
                            : req.status === 'timeout'
                              ? 'Expirado'
                              : 'Aviso'}
                      </span>
                    </div>
                    <span className="context-note">{formatTime(req.createdAt)}</span>
                  </div>
                  <p className="question" style={{ fontSize: 14 }}>
                    {req.question}
                  </p>
                  {req.commandPreview && <pre className="code-block">{req.commandPreview}</pre>}
                  {req.decisionReason && <p className="context-note">{req.decisionReason}</p>}
                </article>
              ))
            )}
          </>
        )}

        {tab === 'settings' && (
          <>
            <section className="card">
              <h3 style={{ margin: 0, fontSize: 15 }}>Notificaciones Push</h3>
              <div className="actions-row">
                {pushEnabled ? (
                  <button className="btn btn-secondary" onClick={handleDisablePush}>
                    <BellOff size={16} /> Desactivar
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={handleEnablePush}>
                    <Bell size={16} /> Activar Push
                  </button>
                )}
                <button className="btn btn-secondary" onClick={handleTestPush}>
                  <Send size={16} /> Probar Push
                </button>
              </div>
            </section>

            <section className="card">
              <h3 style={{ margin: 0, fontSize: 15 }}>Qué eventos piden aprobación</h3>

              <div className="setting-row">
                <div>
                  <div className="setting-title">Comandos de terminal (run_command)</div>
                  <div className="setting-desc">Pide Aprobar/Rechazar antes de ejecutar comandos.</div>
                </div>
                <button
                  className={`toggle ${rules.run_command ? 'on' : ''}`}
                  onClick={() => updateRule({ run_command: !rules.run_command })}
                  aria-label="Toggle run_command"
                />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-title">Crear archivos (write_file)</div>
                  <div className="setting-desc">Pide confirmación antes de crear o sobrescribir archivos.</div>
                </div>
                <button
                  className={`toggle ${rules.write_file ? 'on' : ''}`}
                  onClick={() => updateRule({ write_file: !rules.write_file })}
                  aria-label="Toggle write_file"
                />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-title">Editar archivos (edit_file)</div>
                  <div className="setting-desc">Pide confirmación antes de modificar código existente.</div>
                </div>
                <button
                  className={`toggle ${rules.edit_file ? 'on' : ''}`}
                  onClick={() => updateRule({ edit_file: !rules.edit_file })}
                  aria-label="Toggle edit_file"
                />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-title">Aviso al finalizar turno (Stop)</div>
                  <div className="setting-desc">Te avisa cuando el agente termina o ocurre un error.</div>
                </div>
                <button
                  className={`toggle ${rules.stop_notify ? 'on' : ''}`}
                  onClick={() => updateRule({ stop_notify: !rules.stop_notify })}
                  aria-label="Toggle stop_notify"
                />
              </div>
            </section>

            <section className="card">
              <h3 style={{ margin: 0, fontSize: 15 }}>Sesión</h3>
              <button className="btn btn-secondary" onClick={handleLogout}>
                Desvincular este dispositivo
              </button>
            </section>
          </>
        )}
      </main>

      <nav className="bottom-nav">
        <div className="bottom-nav-inner">
          <button className={`nav-btn ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
            <Clock size={20} />
            Pendientes
            {pendingRequests.length > 0 && <span className="nav-count">{pendingRequests.length}</span>}
          </button>
          <button className={`nav-btn ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            <History size={20} />
            Historial
          </button>
          <button className={`nav-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <Settings size={20} />
            Ajustes
          </button>
        </div>
      </nav>
    </div>
  );
}
