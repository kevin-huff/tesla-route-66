// nd-client.js — the shared WebSocket client for every Night Drive page.
// - connects to the bridge hub, auto-reconnects with backoff
// - dispatches typed channels: ride (snapshot), stats_tick, shift_started,
//   ride_started, ride_ended, tip_added, shift_ended, personal_best, map_mode,
//   telemetry, alert, status, stale
// - keeps a server-clock offset (payloads carry serverNow) so timers derived
//   from timestamps never drift with the OBS machine's clock
// - staleness: >staleMs without telemetry -> dispatch {stale:true} (quiet state)
// - NEVER blanks on disconnect; falls back to a canned client-side sim
//   (js/nd-demo.js) when no bridge is reachable so a file opened standalone
//   renders like the design prototype.
//
// URL params: ?embed (hide dev controls) · ?demo (force canned) · ?live (never fall back)
(function () {
  const cfg = window.ND_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const handlers = new Map();
  const last = {};
  let ws = null;
  let backoff = cfg.reconnectBaseMs || 500;
  let opened = false;
  let demoStop = null;
  let demoTimer = null;
  let serverOffsetMs = 0;
  let lastTelemetryAt = 0;
  let staleFlag = false;

  const forceDemo = params.has('demo');
  const forceLive = params.has('live');

  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    if (last[type] !== undefined) { try { fn(last[type]); } catch (e) { console.error(e); } }
    return () => handlers.get(type)?.delete(fn);
  }

  function dispatch(type, data) {
    last[type] = data;
    const hs = handlers.get(type);
    if (hs) for (const fn of hs) { try { fn(data); } catch (e) { console.error(e); } }
  }

  function syncClock(iso) {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) serverOffsetMs = t - Date.now();
  }
  const serverNow = () => Date.now() + serverOffsetMs;

  function markTelemetry() {
    lastTelemetryAt = Date.now();
    if (staleFlag) { staleFlag = false; dispatch('stale', { stale: false }); }
  }
  setInterval(() => {
    if (!lastTelemetryAt || demoStop) return;
    const stale = Date.now() - lastTelemetryAt > (cfg.staleMs || 5000);
    if (stale !== staleFlag) { staleFlag = stale; dispatch('stale', { stale }); }
  }, 1000);

  const RIDE_EVENTS = new Set([
    'stats_tick', 'shift_started', 'ride_started', 'ride_ended',
    'tip_added', 'shift_ended', 'personal_best', 'map_mode',
  ]);

  function handleMessage(msg) {
    if (msg.type === 'snapshot') {
      const d = msg.data || {};
      if (d.ride) {
        syncClock(d.ride.stats?.serverNow);
        dispatch('ride', d.ride);
      }
      if (d.telemetry && d.telemetry.state !== 'offline') {
        markTelemetry();
        dispatch('telemetry', d.telemetry);
      }
      dispatch('status', { connected: true, mode: d.mode });
      return;
    }
    if (msg.type === 'ping') return;
    if (msg.type === 'telemetry') markTelemetry();
    if (RIDE_EVENTS.has(msg.type)) syncClock(msg.data?.stats?.serverNow || msg.data?.serverNow);
    dispatch(msg.type, msg.data);
  }

  function armDemoFallback() {
    if (forceLive || demoTimer || opened) return;
    demoTimer = setTimeout(() => { if (!opened) startDemo(); }, cfg.demoFallbackMs || 2500);
  }
  function startDemo() {
    if (demoStop) return;
    if (window.ND_DEMO) demoStop = window.ND_DEMO.start(api, params);
    dispatch('status', { connected: false, demo: true });
  }
  function stopDemo() {
    if (demoStop) { try { demoStop(); } catch (e) {} demoStop = null; }
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  function connect() {
    if (forceDemo) { startDemo(); return; }
    try { ws = new WebSocket(cfg.bridgeWsUrl); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      opened = true;
      backoff = cfg.reconnectBaseMs || 500;
      stopDemo();
      dispatch('status', { connected: true });
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handleMessage(m);
    };
    ws.onclose = () => { dispatch('status', { connected: false }); scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    armDemoFallback();
  }
  function scheduleReconnect() {
    ws = null;
    if (forceDemo) return;
    setTimeout(connect, backoff + Math.random() * 250);
    backoff = Math.min(cfg.reconnectMaxMs || 10000, backoff * 2);
    armDemoFallback();
  }

  // fire-and-forget GET against the bridge REST (route/heat pulls)
  async function api_(path) {
    const r = await fetch(`${cfg.apiBase || ''}${path}`);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  const api = {
    on,
    dispatch, // nd-demo feeds canned frames through the same channels
    last: (t) => last[t],
    params,
    config: cfg,
    serverNow,
    isDemo: () => !!demoStop || forceDemo,
    fetchJson: api_,
    connect,
  };
  window.ND = api;

  function applyEmbed() {
    if (params.has('embed') && document.body) document.body.classList.add('embed');
  }
  applyEmbed();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { applyEmbed(); connect(); });
  } else {
    connect();
  }
})();
