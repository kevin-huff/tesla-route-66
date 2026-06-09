// logbook.js — derive the five cumulative counters + punchrow from the persisted
// store + the route. All display-ready (miles / ft). Refreshed on a timer and on
// any counter-affecting event.

import { kmToMi, round } from './units.js';

export function deriveLogbook(route, store, cfg) {
  const s = store.get();
  const visited = new Set(s.visited);

  // states crossed — distinct US state codes among visited landmarks
  const states = new Set();
  for (const lm of route.route) {
    if (visited.has(lm.id)) for (const code of lm.states || []) states.add(code);
  }

  // miles logged — odometer delta from the trip-start baseline
  const miles =
    s.odometerBaselineKm != null && s.lastOdometerKm != null
      ? Math.max(0, round(kmToMi(s.lastOdometerKm - s.odometerBaselineKm)))
      : 0;

  // superchargers docked — count of visited supercharger landmarks
  const superchargers = route.route.filter(
    (lm) => visited.has(lm.id) && lm.type === 'supercharger',
  ).length;

  // gas stations bypassed — the EV flex. floor(miles / avg ICE tank range).
  const avgTank = cfg?.trip?.avgIceTankRangeMi || 29;
  const stationsBypassed = Math.floor(miles / avgTank);

  const elevationFt = round(s.elevationAccumFt || 0);
  const legsDone = route.legs.filter((l) => visited.has(l.end_landmark_id)).length;

  return {
    states: states.size,
    superchargers,
    miles,
    stationsBypassed,
    elevationFt,
    legsDone,
    totalLegs: route.totalLegs,
  };
}
