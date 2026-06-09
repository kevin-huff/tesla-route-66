// units.js — THE ONLY place unit conversion happens.
// TeslaMate publishes metric; overlays read display-ready imperial (mi / mph / °F / ft).

export const kmToMi = (km) => km * 0.621371;
export const miToKm = (mi) => mi / 0.621371;
export const kmhToMph = (kmh) => kmh * 0.621371;
export const cToF = (c) => (c * 9) / 5 + 32;
export const mToFt = (m) => m * 3.28084;

const COMPASS16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

// 0..360 degrees -> 16-point compass string (e.g. 247.5 -> "WSW")
export function degToCompass(deg) {
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.round(norm / 22.5) % 16;
  return COMPASS16[idx];
}

export const round = (n, dp = 0) => {
  if (n == null || Number.isNaN(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
