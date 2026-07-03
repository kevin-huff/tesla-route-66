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
    // How long a transmission stays on screen before it auto-hides (ms). Sized to the
    // ~3 min generation cadence so the card is up most of the drive but still clears
    // when the car parks and the feed goes quiet.
    transmissionDwellMs: 150000,
    // Mission Map (map.html) — live basemap + follow-cam tuning.
    map: {
      // OpenFreeMap: free vector tiles + glyphs, no API key. Swap both for a
      // self-hosted tile server if it ever goes away; the amber style adapts.
      tilesUrl: 'https://tiles.openfreemap.org/planet',
      glyphsUrl: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      // Speed-adaptive follow zoom: parked reads street-level, cruise reads regional.
      // [maxMph, zoom] pairs, first match wins; last entry is the highway default.
      zoomBySpeed: [[3, 13.0], [25, 12.2], [45, 11.4], [999, 10.6]],
      // Don't chase tiny zoom changes — re-zoom only past this delta (prevents breathing).
      zoomDeadband: 0.35,
      // Append a breadcrumb point once the car has moved this far (meters).
      trailMinMoveM: 120,
      // Cap the live trail polyline (oldest points drop off; ~250 mi at 120 m spacing).
      trailMaxPoints: 3500,
    },
  };
})();
