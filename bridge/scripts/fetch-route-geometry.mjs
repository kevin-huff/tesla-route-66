// fetch-route-geometry.mjs — ONE-TIME build step (re-run only if landmarks/legs change).
// Fetches the real driving geometry for the six-leg loop from the public OSRM demo
// server, threading through every landmark in trip order so the drawn route passes
// every geofence. Output is committed to the repo — zero runtime routing dependency:
//   config/route-geometry.json     <- bridge (demo replay follows real roads)
//   overlays/config/route-geometry.js  <- overlays (<script> wrapper, works on file://)
//
// Usage: node scripts/fetch-route-geometry.mjs [--tolerance-m 12]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoute } from '../src/legs.js';
import { haversine } from '../src/geo.js';

const BRIDGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.join(BRIDGE_ROOT, '..');
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

const toleranceM = Number(
  process.argv.includes('--tolerance-m')
    ? process.argv[process.argv.indexOf('--tolerance-m') + 1]
    : 12,
);

// --- Douglas-Peucker on [lng,lat] with a meters-scale perpendicular distance ---
function perpDistM(p, a, b) {
  const latRef = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(latRef); // meters per deg lng
  const ky = 110540; // meters per deg lat
  const ax = a[0] * kx, ay = a[1] * ky;
  const bx = b[0] * kx, by = b[1] * ky;
  const px = p[0] * kx, py = p[1] * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(coords, tolM) {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistM(coords[i], coords[s], coords[e]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolM) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function round5(coords) {
  return coords.map(([lng, lat]) => [Number(lng.toFixed(5)), Number(lat.toFixed(5))]);
}

async function osrmLeg(waypoints, legNum) {
  const coordStr = waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
  const url = `${OSRM}/${coordStr}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'route66-overlays/0.1 (one-time route build)' },
  });
  if (!res.ok) throw new Error(`OSRM ${res.status} for leg ${legNum}: ${await res.text()}`);
  const body = await res.json();
  if (body.code !== 'Ok' || !body.routes?.length) {
    throw new Error(`OSRM code=${body.code} for leg ${legNum}`);
  }
  const route = body.routes[0];
  return { coords: route.geometry.coordinates, distanceM: route.distance };
}

function distToPolylineM(lat, lng, coords) {
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = perpDistM([lng, lat], coords[i], coords[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

async function main() {
  const route = loadRoute({
    legsPath: path.join(REPO_ROOT, 'config', 'legs.json'),
    landmarksPath: path.join(REPO_ROOT, 'planning', 'landmarks.json'),
  });

  const byLeg = new Map(route.legs.map((l) => [l.leg, route.route.filter((lm) => lm.leg === l.leg)]));
  const legsOut = [];
  let prevEnd = null; // each leg's polyline starts where the previous leg ended

  for (const leg of route.legs) {
    const lms = byLeg.get(leg.leg);
    const lastId = lms[lms.length - 1]?.id;
    if (lastId !== leg.end_landmark_id) {
      console.warn(`! leg ${leg.leg}: last landmark ${lastId} != end_landmark_id ${leg.end_landmark_id}`);
    }
    const waypoints = prevEnd ? [prevEnd, ...lms] : [...lms];
    process.stdout.write(`leg ${leg.leg} (${leg.title}) — ${waypoints.length} waypoints ... `);
    const { coords, distanceM } = await osrmLeg(waypoints, leg.leg);
    const slim = round5(simplify(coords, toleranceM));
    const distanceMi = Math.round((distanceM / 1609.344) * 10) / 10;
    console.log(`${coords.length} pts -> ${slim.length} pts, ${distanceMi} mi`);

    // any landmark farther from the road than its geofence radius would never fire
    // for the road-following demo car — surface it now, not on stream day
    for (const lm of lms) {
      const d = distToPolylineM(lm.lat, lm.lng, slim);
      if (d > lm.radius_m) {
        console.warn(`  ! ${lm.id} is ${Math.round(d)}m from route (radius ${lm.radius_m}m)`);
      }
    }

    legsOut.push({ leg: leg.leg, title: leg.title, from: leg.from, to: leg.to, distanceMi, coords: slim });
    prevEnd = lms[lms.length - 1];
    await new Promise((r) => setTimeout(r, 600)); // be polite to the demo server
  }

  const totalMi = Math.round(legsOut.reduce((s, l) => s + l.distanceMi, 0));
  const doc = {
    _note: 'Generated by bridge/scripts/fetch-route-geometry.mjs (OSRM demo server, OpenStreetMap data, ODbL). Re-run only if landmarks/legs change. coords are [lng,lat].',
    generatedAt: new Date().toISOString(),
    totalMi,
    nodes: route.nodes,
    legs: legsOut,
  };

  const jsonPath = path.join(REPO_ROOT, 'config', 'route-geometry.json');
  fs.writeFileSync(jsonPath, JSON.stringify(doc));
  console.log(`wrote ${jsonPath} (${(fs.statSync(jsonPath).size / 1024).toFixed(0)} KB)`);

  const jsPath = path.join(REPO_ROOT, 'overlays', 'config', 'route-geometry.js');
  const js =
    '// GENERATED by bridge/scripts/fetch-route-geometry.mjs — do not edit by hand.\n' +
    '// Real driving geometry for the six-leg loop (OSRM / OpenStreetMap, ODbL). [lng,lat].\n' +
    `window.R66_ROUTE = ${JSON.stringify(doc)};\n`;
  fs.writeFileSync(jsPath, js);
  console.log(`wrote ${jsPath} (${(fs.statSync(jsPath).size / 1024).toFixed(0)} KB)`);
  console.log(`total route: ${totalMi} mi`);
}

main().catch((e) => {
  console.error('fatal:', e.message || e);
  process.exit(1);
});
