// ride/heat.js — pickup-density binning for the HEAT view. The browser NEVER
// receives raw pickup points: pickups are aggregated into a square grid (~binM
// meters) server-side and shipped as bin centers + counts. The same function
// powers the PWA's personal analytics with from/to/day-of-week/hour filters.

const M_PER_DEG_LAT = 111320;

export function binPickups(pickups, { binM = 250, from, to, dow, hour, timezone } = {}) {
  const dowSet = parseSet(dow, 0, 6);
  const hourSet = parseSet(hour, 0, 23);
  const cells = new Map();
  let refLat = null;

  for (const p of pickups) {
    if (p.lat == null || p.lng == null) continue;
    if (from && p.startedAt < from) continue;
    if (to && p.startedAt >= to) continue;
    if (dowSet || hourSet) {
      const { d, h } = localDowHour(p.startedAt, timezone);
      if (dowSet && !dowSet.has(d)) continue;
      if (hourSet && !hourSet.has(h)) continue;
    }
    if (refLat == null) refLat = p.lat;
    const mLng = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
    const gy = Math.round((p.lat * M_PER_DEG_LAT) / binM);
    const gx = Math.round((p.lng * mLng) / binM);
    const key = `${gx}:${gy}`;
    let c = cells.get(key);
    if (!c) {
      c = { lat: (gy * binM) / M_PER_DEG_LAT, lng: (gx * binM) / mLng, n: 0 };
      cells.set(key, c);
    }
    c.n++;
  }

  const out = [...cells.values()];
  const max = out.reduce((m, c) => Math.max(m, c.n), 0);
  return {
    binM,
    max,
    total: out.reduce((s, c) => s + c.n, 0),
    cells: out.map((c) => ({ lat: round6(c.lat), lng: round6(c.lng), n: c.n })),
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function parseSet(v, lo, hi) {
  if (v == null || v === '') return null;
  const nums = String(v)
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x >= lo && x <= hi);
  return nums.length ? new Set(nums) : null;
}

// local day-of-week (0=Sun) and hour for an ISO timestamp in the configured tz
function localDowHour(isoTs, timezone) {
  const d = new Date(isoTs);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value;
    const hr = Number(parts.find((p) => p.type === 'hour')?.value);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { d: map[wd] ?? d.getUTCDay(), h: Number.isFinite(hr) ? hr % 24 : d.getUTCHours() };
  } catch {
    return { d: d.getUTCDay(), h: d.getUTCHours() };
  }
}
