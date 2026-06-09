// geo.js — spherical geometry. Distances in METERS.

const R = 6371000; // mean Earth radius, meters
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance between two lat/lng points, in meters.
export function haversine(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const la1 = toRad(aLat);
  const la2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing a->b, degrees 0..360 (0 = N, 90 = E).
export function bearing(aLat, aLng, bLat, bLng) {
  const la1 = toRad(aLat);
  const la2 = toRad(bLat);
  const dLng = toRad(bLng - aLng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) -
    Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export const withinRadius = (aLat, aLng, bLat, bLng, radiusM) =>
  haversine(aLat, aLng, bLat, bLng) <= radiusM;

export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpPt = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];

// Scalar projection of point P onto segment A->B in an equirectangular
// approximation around the segment. Returns t clamped to [0,1].
export function projectFraction(lat, lng, aLat, aLng, bLat, bLng) {
  const latRef = toRad((aLat + bLat) / 2);
  const cos = Math.cos(latRef);
  const ax = aLng * cos, ay = aLat;
  const bx = bLng * cos, by = bLat;
  const px = lng * cos, py = lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}
