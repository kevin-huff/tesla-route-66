// nd-config.js — Night Drive overlay settings. Loaded first by every ND page.
// Same-origin when served by the bridge (http://<host>:8787/night-drive/rail.html);
// falls back to localhost for a file:// standalone preview.
(function () {
  const httpOrigin = location.protocol === 'http:' || location.protocol === 'https:';
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  window.ND_CONFIG = {
    bridgeWsUrl: httpOrigin ? `${wsProto}://${location.host}` : 'ws://localhost:8787',
    apiBase: httpOrigin ? '' : 'http://localhost:8787',
    reconnectBaseMs: 500,
    reconnectMaxMs: 10000,
    demoFallbackMs: 2500,
    // >5s without telemetry = RECONNECTING · DATA HELD (quiet, not an error)
    staleMs: 5000,
    // map module
    map: {
      rotateMs: 8000, // NAV -> ROUTE -> HEAT crossfade cadence
      forcedHoldMs: 45000, // how long a map_mode override pins the view before rotation resumes
      tilesUrl: 'https://tiles.openfreemap.org/planet',
      glyphsUrl: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      navZoom: 13.2,
      refreshRouteMs: 60000, // re-pull today's path while ROUTE is up
      refreshHeatMs: 300000,
    },
    // event cards
    eventHoldMs: 6000,
  };
})();
