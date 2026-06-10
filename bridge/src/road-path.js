// road-path.js — distance-parameterized real road geometry for the whole loop.
// Loads config/route-geometry.json (generated once by scripts/fetch-route-geometry.mjs),
// concatenates the per-leg polylines, and splices each landmark's nearest on-road point
// in as an explicit vertex — so the demo replay can land EXACTLY on every geofence, and
// distances can be measured along the road instead of as the crow flies.
// Degrades cleanly: with no geometry file the "polyline" is just the landmark chain,
// which reproduces the old straight-line behavior through the same code path.

import fs from 'node:fs';
import { haversine, bearing, lerp, projectFraction } from './geo.js';

export function loadGeometry(filePath) {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(doc.legs) || !doc.legs.every((l) => Array.isArray(l.coords))) return null;
    return doc;
  } catch {
    return null;
  }
}

// landmarks: route.route (trip-ordered, with .lat/.lng/.id). geo: loadGeometry() doc or null.
export function buildRoadPath(landmarks, geo) {
  let pts = []; // [lat, lng]
  if (geo) {
    for (const leg of geo.legs) {
      for (const [lng, lat] of leg.coords) {
        const prev = pts[pts.length - 1];
        if (!prev || prev[0] !== lat || prev[1] !== lng) pts.push([lat, lng]);
      }
    }
  }
  if (pts.length < 2) pts = landmarks.map((lm) => [lm.lat, lm.lng]);

  // splice each landmark's on-road projection in as a vertex, searching forward only.
  // The polyline visits landmarks in trip order by construction, but the same spot can
  // appear twice (Springfield is both start and home, legs pass towns coming and going),
  // so ties go to the EARLIEST segment within tolerance of the true minimum — never the
  // global argmin, which can jump to a later pass that is centimeters closer.
  const lmIdx = [];
  let startSeg = 0;
  for (const lm of landmarks) {
    const cand = [];
    for (let j = startSeg; j < pts.length - 1; j++) {
      const t = projectFraction(lm.lat, lm.lng, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
      const la = lerp(pts[j][0], pts[j + 1][0], t);
      const ln = lerp(pts[j][1], pts[j + 1][1], t);
      cand.push({ d: haversine(lm.lat, lm.lng, la, ln), j, t, la, ln });
    }
    let idx;
    if (!cand.length) {
      idx = pts.length - 1; // window exhausted (landmark at the very end of the loop)
    } else {
      const minD = Math.min(...cand.map((c) => c.d));
      const best = cand.find((c) => c.d <= minD + Math.max(10, minD * 0.25));
      if (best.t < 1e-6) idx = best.j;
      else if (best.t > 1 - 1e-6) idx = best.j + 1;
      else { pts.splice(best.j + 1, 0, [best.la, best.ln]); idx = best.j + 1; }
    }
    lmIdx.push(idx);
    startSeg = idx;
  }

  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  const totalM = cum[pts.length - 1];
  const lmDistM = lmIdx.map((i) => cum[i]);
  const distById = new Map(landmarks.map((lm, k) => [lm.id, lmDistM[k]]));

  // vertex index for a distance: greatest j with cum[j] <= d
  function segAt(d) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, pts.length - 2);
  }

  // position + true road heading at a distance along the loop
  function posAt(d) {
    const dd = Math.max(0, Math.min(totalM, d));
    const j = segAt(dd);
    const len = cum[j + 1] - cum[j];
    const r = len > 0 ? (dd - cum[j]) / len : 0;
    return {
      lat: lerp(pts[j][0], pts[j + 1][0], r),
      lng: lerp(pts[j][1], pts[j + 1][1], r),
      headingDeg: bearing(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]),
    };
  }

  // project an arbitrary fix onto the road: distance along the loop + how far off-road.
  // minM restricts the search to at/after a known trip position (disambiguates the
  // shared start/home coordinates); the last match seeds a window for the next call.
  let lastJ = null;
  function locate(lat, lng, { minM = 0 } = {}) {
    const floor = Math.max(0, minM - 2000);
    const proj = (j) => {
      const t = projectFraction(lat, lng, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
      const la = lerp(pts[j][0], pts[j + 1][0], t);
      const ln = lerp(pts[j][1], pts[j + 1][1], t);
      return { offM: haversine(lat, lng, la, ln), j, distM: cum[j] + (cum[j + 1] - cum[j]) * t };
    };
    // earliest segment within tolerance of the minimum — same tie-break as the splice
    // above, so a fix at shared start/home coords resolves to the in-progress pass
    const scan = (from, to) => {
      const lo = Math.max(0, from);
      const hi = Math.min(pts.length - 1, to);
      let minOff = Infinity;
      for (let j = lo; j < hi; j++) {
        if (cum[j + 1] < floor) continue;
        const d = proj(j).offM;
        if (d < minOff) minOff = d;
      }
      if (minOff === Infinity) return null;
      const tol = Math.max(10, minOff * 0.25);
      for (let j = lo; j < hi; j++) {
        if (cum[j + 1] < floor) continue;
        const p = proj(j);
        if (p.offM <= minOff + tol) return p;
      }
      return null;
    };
    let best = lastJ != null ? scan(lastJ - 200, lastJ + 600) : null;
    if (!best || best.offM > 5000) best = scan(0, pts.length - 1);
    if (best) lastJ = best.j;
    return best;
  }

  return { pts, cum, totalM, lmIdx, lmDistM, distById, posAt, locate, segAt };
}
