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
    // >25s without ANY hub traffic = RECONNECTING · DATA HELD. The hub pings
    // every 10s, so this means two missed heartbeats — a genuinely dead socket,
    // not just a parked car whose MQTT has nothing new to say.
    staleMs: 25000,
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
    // recap card auto-hides after this dwell (also the freshness window for
    // re-showing it to a late-joining/reloaded source). ?hold pins it until the
    // next shift starts — use that when recap.html is its own OBS scene.
    recapDwellMs: 180000,
  };
})();
