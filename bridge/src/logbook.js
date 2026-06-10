// logbook.js — derive the cumulative counters + punchrow from the persisted store +
// the route. All display-ready (miles / ft / $ / hrs). Two overlay pages:
//   THE TRIP    — miles, route %, waypoints x/58, states, days on road
//   POWERTRAIN  — kWh charged, superchargers, gas money saved, drive hrs, charge hrs
// (legacy stationsBypassed/elevationFt stay in the message for older consumers)

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

  // waypoints logged — visited landmarks that exist on the route (x of 58)
  const waypoints = route.route.filter((lm) => visited.has(lm.id)).length;

  // days on road — calendar days since the trip started (the Maricopa week counts)
  const days = s.tripStartedAt
    ? Math.max(1, Math.ceil((Date.now() - Date.parse(s.tripStartedAt)) / 86400000))
    : 0;

  // route complete — % of the loop covered, measured along the real road geometry
  const totalM = route.roadPath ? route.roadPath.totalM : 0;
  const routePct = totalM && s.routeDistM
    ? Math.max(0, Math.min(100, round((s.routeDistM / totalM) * 100)))
    : 0;

  // gas money saved — what an ICE car would have burned over the same miles
  const iceMpg = cfg?.trip?.iceMpg || 25;
  const gasPrice = cfg?.trip?.gasPriceUsdPerGal || 3.2;
  const gasSaved = Math.round((miles / iceMpg) * gasPrice);

  return {
    states: states.size,
    superchargers,
    miles,
    stationsBypassed,
    elevationFt,
    legsDone,
    totalLegs: route.totalLegs,
    routePct,
    waypoints,
    totalWaypoints: route.route.length,
    days,
    kwhCharged: round(s.kwhCharged || 0),
    gasSaved,
    driveHrs: round((s.driveSecs || 0) / 3600, 1),
    chargeHrs: round((s.chargeSecs || 0) / 3600, 1),
  };
}
