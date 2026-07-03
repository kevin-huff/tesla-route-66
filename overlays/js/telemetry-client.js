// telemetry-client.js — the shared WebSocket client every overlay uses.
// - connects to the bridge, auto-reconnects with backoff
// - sends {type:'hello'} on open to pull a fresh snapshot (late-join repaint)
// - dispatches typed channels: telemetry, map, transmission, transmission:clear,
//   logbook, alert, event:*, status
// - NEVER clears last-known data on disconnect (overlays keep their last frame — a drop
//   reads as intentional, never a blank)
// - falls back to canned demo data (js/demo-data.js) when no bridge is reachable, so a
//   single file opened standalone renders identically to the design showcase
//
// URL params: ?embed (hide dev controls) · ?demo (force canned) · ?live (never fall back)
//             ?state=warn (telemetry warn preview) · ?idle (transmission starts hidden)
(function () {
  const cfg = window.R66_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const handlers = new Map(); // type -> Set(fn)
  const last = {};
  let ws = null;
  let backoff = cfg.reconnectBaseMs || 500;
  let opened = false;
  let demoStop = null;
  let demoTimer = null;

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

  function handleMessage(msg) {
    if (msg.type === 'snapshot') {
      const d = msg.data || {};
      if (d.telemetry) dispatch('telemetry', d.telemetry);
      if (d.trail) dispatch('trail', d.trail); // before map: seed the breadcrumb first
      if (d.map) dispatch('map', d.map);
      if (d.logbook) dispatch('logbook', d.logbook);
      if (d.nowPlaying) dispatch('nowplaying', d.nowPlaying);
      // re-show the last transmission on (re)connect (OBS refresh / fire-then-open) only
      // while it would still be on screen — within transmissionDwellMs of when it fired.
      // Replaying a stale one would put a long-passed place back on stream, out of sync
      // with the chat post that went out when it actually fired.
      if (d.lastTransmission) {
        const tx = d.lastTransmission;
        const dwell = cfg.transmissionDwellMs || 90000;
        if (tx.at == null || Date.now() - tx.at < dwell) dispatch('transmission', tx);
        else last.transmission = tx; // stale: keep for the ▶ Receive preview, don't show
      }
      dispatch('status', { connected: true, mode: d.mode });
      return;
    }
    if (msg.type === 'ping') return;
    dispatch(msg.type, msg.data);
  }

  function armDemoFallback() {
    if (forceLive || demoTimer || opened) return;
    demoTimer = setTimeout(() => { if (!opened) startDemo(); }, cfg.demoFallbackMs || 2500);
  }

  function startDemo() {
    if (demoStop) return;
    if (window.R66_DEMO) {
      demoStop = window.R66_DEMO.start(api, {
        warn: params.get('state') === 'warn',
        charge: params.get('state') === 'charge',
        idle: params.has('idle'),
      });
    }
    dispatch('status', { connected: false, demo: true });
  }

  function stopDemo() {
    if (demoStop) { try { demoStop(); } catch (e) {} demoStop = null; }
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  function connect() {
    if (forceDemo) { startDemo(); return; }
    try {
      ws = new WebSocket(cfg.bridgeWsUrl);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      opened = true;
      backoff = cfg.reconnectBaseMs || 500;
      stopDemo();
      // the server already sends a snapshot on connect — don't request a second one
      // (a duplicate snapshot would re-fire the last transmission and type it twice)
      dispatch('status', { connected: true });
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handleMessage(m);
    };
    ws.onclose = () => {
      dispatch('status', { connected: false });
      scheduleReconnect();
    };
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

  const api = {
    on,
    dispatch, // used by demo-data to feed canned frames through the same channels
    last: (t) => last[t],
    params,
    config: cfg,
    isDemo: () => !!demoStop || forceDemo,
    connect,
  };
  window.R66 = api;

  function applyEmbed() {
    if (params.has('embed') && document.body) document.body.classList.add('embed');
  }

  applyEmbed(); // body exists when this script runs at the end of <body>
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { applyEmbed(); connect(); });
  } else {
    connect();
  }
})();
