// ride/privacy.js — the home-zone filter. Enforced SERVER-SIDE, at the payload
// boundary: no overlay-facing endpoint or WS event may carry a raw coordinate
// inside the configured zone. Path points inside the zone are DROPPED (the path
// simply ends near the edge; the overlay fades the tail), single points (ride
// endpoints, NAV position) are CLAMPED to the zone boundary. The PWA is a private
// surface and reads unfiltered data via authed endpoints.

import { haversine } from '../geo.js';

const M_PER_DEG_LAT = 111320;

export function createPrivacyZone(privacy) {
  const enabled =
    privacy && privacy.lat != null && privacy.lng != null && (privacy.radiusM || 0) > 0;
  const cLat = enabled ? privacy.lat : 0;
  const cLng = enabled ? privacy.lng : 0;
  const radiusM = enabled ? privacy.radiusM : 0;

  function inside(lat, lng) {
    if (!enabled || lat == null || lng == null) return false;
    return haversine(lat, lng, cLat, cLng) < radiusM;
  }

  // project an in-zone point radially onto the zone boundary (equirectangular is
  // plenty at sub-km scale). A point exactly at the center is pushed due north.
  function clamp(lat, lng) {
    if (!inside(lat, lng)) return { lat, lng };
    const mLng = M_PER_DEG_LAT * Math.cos((cLat * Math.PI) / 180);
    let dx = (lng - cLng) * mLng;
    let dy = (lat - cLat) * M_PER_DEG_LAT;
    let d = Math.hypot(dx, dy);
    if (d < 1) { dx = 0; dy = 1; d = 1; }
    const f = radiusM / d;
    return { lat: cLat + (dy * f) / M_PER_DEG_LAT, lng: cLng + (dx * f) / mLng };
  }

  // filter a path ([[t,lat,lng],...]) by dropping in-zone points. Returns runs so
  // a drive that passes through the zone splits instead of drawing a chord across it.
  function filterPath(pts) {
    const runs = [];
    let cur = null;
    for (const p of pts) {
      if (inside(p[1], p[2])) {
        cur = null;
        continue;
      }
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(p);
    }
    return runs;
  }

  return { enabled, inside, clamp, filterPath, center: { lat: cLat, lng: cLng }, radiusM };
}
