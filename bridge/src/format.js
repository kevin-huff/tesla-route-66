// format.js — small display formatters shared by the geofence path and the LLM generator
// so every transmission is shaped identically for the Transmission Card overlay.

export const pad2 = (n) => String(n).padStart(2, '0');
export const fmtLat = (lat) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
export const fmtLng = (lng) => `${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;

export function fmtTime(tz) {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).formatToParts(d);
    const g = (ty) => parts.find((p) => p.type === ty)?.value || '';
    return `${g('month')}·${g('day')} · ${g('hour')}:${g('minute')} ${g('timeZoneName')}`;
  } catch {
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }
}
