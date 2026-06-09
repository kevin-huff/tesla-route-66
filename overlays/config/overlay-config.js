// overlay-config.js — per-deployment overlay settings. Loaded first by every component.
// Defaults to same-origin when the overlays are served by the bridge (recommended:
// http://<bridge-host>:8787/telemetry.html), and to ws://localhost:8787 when a file is
// opened directly (file://) for a quick standalone preview.
(function () {
  const httpOrigin = location.protocol === 'http:' || location.protocol === 'https:';
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  window.R66_CONFIG = {
    // Where the bridge WebSocket lives. Override here if the bridge runs on another host.
    bridgeWsUrl: httpOrigin ? `${wsProto}://${location.host}` : 'ws://localhost:8787',
    reconnectBaseMs: 500,
    reconnectMaxMs: 10000,
    // If no live bridge connection opens within this window, fall back to canned demo
    // data so a standalone file still renders (matches the design showcase state).
    demoFallbackMs: 2500,
    // Smooth jumpy speed in the readout (the bridge also smooths upstream).
    speedDebounceMs: 600,
  };
})();
