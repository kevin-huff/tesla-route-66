// legs.js — the route model. Loads config/legs.json (nodes + leg metadata) and
// planning/landmarks.json (geofences + lore), and computes the `map` message:
// current leg, leg statuses, the vehicle's projected SVG position, distance to the
// next waypoint, ETA, and the Maricopa STANDBY state — all from live lat/lng + the
// persisted visited-landmark set.

import fs from 'node:fs';
import { haversine, projectFraction } from './geo.js';
import { kmToMi, round } from './units.js';

// US state/territory codes, used to validate 2-letter tokens parsed from a
// landmark header (e.g. "INCOMING TRANSMISSION // GLENRIO, TX/NM" -> [TX, NM]).
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

export function parseStates(header = '') {
  const out = [];
  for (const m of String(header).matchAll(/\b([A-Z]{2})\b/g)) {
    if (US_STATES.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// Split a landmark header on " // " into its signal kicker + place.
// "POWER CYCLE // TULSA, OK" -> { sig: "POWER CYCLE", place: "TULSA, OK" }
export function splitHeader(header = '', fallbackPlace = '') {
  const i = header.indexOf('//');
  if (i === -1) return { sig: 'INCOMING TRANSMISSION', place: (header || fallbackPlace).trim() };
  return { sig: header.slice(0, i).trim(), place: header.slice(i + 2).trim() };
}

export function loadRoute({ legsPath, landmarksPath }) {
  const legsDoc = JSON.parse(fs.readFileSync(legsPath, 'utf8'));
  const lmDoc = JSON.parse(fs.readFileSync(landmarksPath, 'utf8'));

  const byId = new Map();
  const route = []; // landmarks in trip order, with leg number + states attached
  for (const group of lmDoc.legs) {
    for (const lm of group.landmarks) {
      const entry = { ...lm, leg: group.leg, states: parseStates(lm.header) };
      byId.set(lm.id, entry);
      route.push(entry);
    }
  }

  const legs = legsDoc.legs.map((l) => ({
    ...l,
    waypoint_ids: (lmDoc.legs.find((g) => g.leg === l.leg)?.landmarks || []).map(
      (x) => x.id,
    ),
  }));

  return new Route({ nodes: legsDoc.nodes, legs, byId, route });
}

export class Route {
  constructor({ nodes, legs, byId, route }) {
    this.nodes = nodes;
    this.legs = legs;
    this.totalLegs = legs.length;
    this.byId = byId;
    this.route = route;
    this.standbyLeg = legs.find((l) => l.standby) || null;
    this.roadPath = null;
  }

  // optional real road geometry (road-path.js) — upgrades distToNextMi from
  // as-the-crow-flies to distance along the actual planned roads
  attachRoadPath(roadPath) {
    this.roadPath = roadPath;
  }

  landmark(id) {
    return this.byId.get(id) || null;
  }

  legByNum(n) {
    return this.legs.find((l) => l.leg === n) || null;
  }

  // 1 + (count of legs whose end landmark has been visited), capped at totalLegs.
  // Restart-proof: derived purely from the persisted visited set.
  currentLeg(visited) {
    const v = asSet(visited);
    const done = this.legs.filter((l) => v.has(l.end_landmark_id)).length;
    return Math.min(this.totalLegs, done + 1);
  }

  legStatus(visited) {
    const v = asSet(visited);
    const cur = this.currentLeg(v);
    return this.legs.map((l) => {
      if (v.has(l.end_landmark_id)) return 'done';
      if (l.leg === cur) return 'current';
      return 'future';
    });
  }

  // Build the full `map` message data object.
  computeMapState({ lat, lng, speedMph = 0, visited }) {
    const v = asSet(visited);
    const cur = this.currentLeg(v);
    const leg = this.legByNum(cur);
    const from = this.nodes[leg.from];
    const to = this.nodes[leg.to];

    const have = lat != null && lng != null;
    const progress = have
      ? projectFraction(lat, lng, from.lat, from.lng, to.lat, to.lng)
      : 0;
    const svgX = round(from.svg[0] + (to.svg[0] - from.svg[0]) * progress, 1);
    const svgY = round(from.svg[1] + (to.svg[1] - from.svg[1]) * progress, 1);

    let distToNextMi = have
      ? round(kmToMi(haversine(lat, lng, to.lat, to.lng) / 1000), 0)
      : 0;
    let routeDistM = null; // distance along the loop, only while actually near the plan
    if (have && this.roadPath) {
      // distance along the planned road, not the crow-flies chord. Restrict the match
      // to at/after this leg's stretch (start/home share coords) and only trust it
      // when the car is actually near the planned route.
      const fromM = cur > 1
        ? this.roadPath.distById.get(this.legByNum(cur - 1).end_landmark_id) ?? 0
        : 0;
      const endM = this.roadPath.distById.get(leg.end_landmark_id);
      const loc = this.roadPath.locate(lat, lng, { minM: fromM });
      if (endM != null && loc && loc.offM < 3000) {
        distToNextMi = round(kmToMi(Math.max(0, endM - loc.distM) / 1000), 0);
        routeDistM = Math.round(loc.distM);
      }
    }

    let etaText = '--:--';
    if (speedMph > 3 && distToNextMi >= 0) {
      const mins = Math.round((distToNextMi / speedMph) * 60);
      etaText = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    }

    // Maricopa STANDBY: reached the standby leg's end but not yet started the next leg.
    let standbyActive = false;
    if (this.standbyLeg) {
      const next = this.legByNum(this.standbyLeg.leg + 1);
      standbyActive =
        v.has(this.standbyLeg.end_landmark_id) &&
        !!next &&
        !v.has(next.start_landmark_id);
    }

    const tag = to.standby ? 'STANDBY' : cur === this.totalLegs ? 'HOME' : '';

    return {
      currentLeg: cur,
      totalLegs: this.totalLegs,
      legStatus: this.legStatus(v),
      vehicle: {
        svgX,
        svgY,
        lat: have ? lat : null,
        lng: have ? lng : null,
        onLeg: cur,
        progress: round(progress, 3),
      },
      nextWaypoint: { name: `${to.name}, ${to.state}`, tag },
      distToNextMi,
      etaText,
      routeDistM,
      routeTotalM: this.roadPath ? Math.round(this.roadPath.totalM) : null,
      standby: { active: standbyActive, node: this.standbyLeg ? this.standbyLeg.to : null },
    };
  }
}

function asSet(v) {
  return v instanceof Set ? v : new Set(v || []);
}
