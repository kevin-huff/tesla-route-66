// demo-data.js — canned fallback feed. When no bridge is reachable, this drives every
// overlay through the SAME client channels so a standalone file renders identically to
// the design showcase (leg 3 / 72% / Cadillac Ranch / cumulative logbook), and the warn
// preview (?state=warn) shows the klaxon telemetry. Only used as a fallback — when a live
// bridge connects, the client stops this feed and live data takes over.
(function () {
  const CADILLAC = {
    id: 'cadillac_ranch', sig: 'INCOMING TRANSMISSION', place: 'CADILLAC RANCH, TX',
    header: 'INCOMING TRANSMISSION // CADILLAC RANCH, TX',
    body:
      'Ten Cadillacs nose-down in a Texas wheat field, tail fins to the sky. ' +
      'Planted in 1974 by the art collective Ant Farm, half-buried at the angle ' +
      'of the Great Pyramid. Visitors are handed a spray can and told: leave your mark. ' +
      'The colors change by the week. Bring your own paint.',
    type_: 'attraction', lat: 35.1872366, lng: -101.9870486,
    latText: '35.1872°N', lngText: '101.9871°W',
    leg: 2, legLabel: 'LEG 02 · CADILLAC RANCH TX', timeText: '06·03 · 14:22 CDT',
    signal: 5, radiusM: 500,
  };

  const ALERTS = {
    follow: { kind: 'follow', kicker: 'INCOMING SIGNAL · NEW FOLLOWER', name: '@dustdevil_dan', detail: 'WELCOME TO THE CONVOY' },
    sub: { kind: 'sub', kicker: 'TRANSMISSION LOCKED · SUBSCRIBER', name: '@route_runner', detail: '<b>12</b> MONTHS · TIER <b>2</b> · MOTHER ROAD CREW' },
    redeem: { kind: 'redeem', kicker: 'CHANNEL POINTS REDEEMED', name: '@neon_nomad', detail: 'REWARD · <b>HONK THE HORN</b> · 5,000 PTS' },
  };

  // real on-route fixes (leg 3, I-17 south near New River AZ; warn = Continental Divide NM)
  // so the live-map overlay renders the canned car ON the drawn route
  const FIX = { lat: 33.92068, lng: -112.14488, headingDeg: 186, heading: 'S' };
  const FIX_WARN = { lat: 35.4320653, lng: -108.3311462, headingDeg: 247, heading: 'WSW' };
  const TRAIL = [
    [-112.03643, 34.44638], [-112.04907, 34.42706], [-112.06957, 34.4121], [-112.08831, 34.38695],
    [-112.11552, 34.36517], [-112.12552, 34.31136], [-112.12281, 34.28669], [-112.11685, 34.26427],
    [-112.11383, 34.25144], [-112.11723, 34.23322], [-112.11141, 34.21848], [-112.13371, 34.18762],
    [-112.13465, 34.18296], [-112.14104, 34.1712], [-112.14598, 34.15991], [-112.14973, 34.14388],
    [-112.15083, 34.12703], [-112.14683, 34.11545], [-112.14443, 34.10716], [-112.14454, 34.08684],
    [-112.14729, 34.05267], [-112.14624, 34.03128], [-112.13839, 33.99988], [-112.13648, 33.98412],
    [-112.12807, 33.96846], [-112.14488, 33.92068],
  ];

  function start(client, opts) {
    const timers = [];
    const warn = !!opts.warn;
    const charge = !!opts.charge;

    // margin story: normal = comfortable cushion to Phoenix SC; warn = underwater to Holbrook
    const tele = warn
      ? { batteryPct: 11, usableBatteryPct: 10, rangeMi: 28, speedMph: 58, heading: FIX_WARN.heading, headingDeg: FIX_WARN.headingDeg, cabinF: 74, outsideF: 99, lat: FIX_WARN.lat, lng: FIX_WARN.lng, state: 'driving', pluggedIn: false, chargerKw: 0, battSegments: 2, warn: true, statusText: 'CHARGE CRITICAL', nextSc: { id: 'sc_holbrook', place: 'HOLBROOK, AZ', mi: 118 }, marginMi: -90, marginWarn: true, timeToFullMin: null, chargeLimitPct: 90 }
      : charge
      ? { batteryPct: 64, usableBatteryPct: 63, rangeMi: 190, speedMph: 0, heading: FIX.heading, headingDeg: FIX.headingDeg, cabinF: 71, outsideF: 96, lat: FIX.lat, lng: FIX.lng, state: 'charging', pluggedIn: true, chargerKw: 150, battSegments: 9, warn: false, statusText: 'ALL SYSTEMS NOMINAL', nextSc: { id: 'sc_phoenix', place: 'PHOENIX, AZ', mi: 0 }, marginMi: 190, marginWarn: false, timeToFullMin: 26, chargeLimitPct: 90 }
      : { batteryPct: 72, usableBatteryPct: 71, rangeMi: 214, speedMph: 63, heading: FIX.heading, headingDeg: FIX.headingDeg, cabinF: 70, outsideF: 94, lat: FIX.lat, lng: FIX.lng, state: 'driving', pluggedIn: false, chargerKw: 0, battSegments: 10, warn: false, statusText: 'ALL SYSTEMS NOMINAL', nextSc: { id: 'sc_phoenix', place: 'PHOENIX, AZ', mi: 31 }, marginMi: 183, marginWarn: false, timeToFullMin: null, chargeLimitPct: 90 };
    client.dispatch('telemetry', { ...tele });
    timers.push(setInterval(() => {
      client.dispatch('telemetry', { ...tele, speedMph: Math.max(0, tele.speedMph + (tele.speedMph ? Math.round((Math.random() - 0.5) * 4) : 0)) });
    }, 1400));

    // canned now-playing (the obvious choice)
    client.dispatch('nowplaying', {
      title: '(Get Your Kicks On) Route 66', artist: 'Chuck Berry', album: 'New Juke Box Hits',
      artUrl: null, durationSec: 169, progressSec: 47, playing: true, receivedAt: Date.now(),
    });

    const fix = warn ? FIX_WARN : FIX;
    let dist = 71;
    let etaMin = 68;
    const baseMap = {
      currentLeg: warn ? 2 : 3, totalLegs: 6,
      legStatus: warn
        ? ['done', 'current', 'future', 'future', 'future', 'future']
        : ['done', 'done', 'current', 'future', 'future', 'future'],
      vehicle: { svgX: 126, svgY: 342, lat: fix.lat, lng: fix.lng, onLeg: warn ? 2 : 3, progress: 0.61 },
      nextWaypoint: warn
        ? { name: 'FLAGSTAFF, AZ', tag: '' }
        : { name: 'MARICOPA, AZ', tag: 'STANDBY' },
      distToNextMi: dist, etaText: '1:08', standby: { active: false, node: 'MCP' },
    };
    if (!warn) client.dispatch('trail', TRAIL);
    client.dispatch('map', { ...baseMap });
    timers.push(setInterval(() => {
      dist = Math.max(0, dist - 1);
      etaMin = Math.max(0, etaMin - 1);
      client.dispatch('map', { ...baseMap, distToNextMi: dist, etaText: `${Math.floor(etaMin / 60)}:${String(etaMin % 60).padStart(2, '0')}` });
    }, 6000));

    // internally consistent with the leg-3 / 61% canned position (waypoint 31 = Sunset Point):
    // 1322 route-mi + side trips = 1486 logged; 8 of 20 SC docked; all 6 states by Flagstaff
    client.dispatch('logbook', {
      states: 6, superchargers: 8, miles: 1486, stationsBypassed: 51, elevationFt: 11200,
      legsDone: 2, totalLegs: 6,
      routePct: 42, waypoints: 31, totalWaypoints: 58, days: 8,
      kwhCharged: 388, gasSaved: 190, driveHrs: 23.2, chargeHrs: 3.4,
    });

    if (opts.idle) {
      client.dispatch('transmission:clear', { id: 'idle' });
    } else {
      timers.push(setTimeout(() => client.dispatch('transmission', CADILLAC), 600));
    }

    const order = ['follow', 'sub', 'redeem'];
    let ai = 0;
    const fireAlert = () => { client.dispatch('alert', ALERTS[order[ai % order.length]]); ai += 1; };
    timers.push(setTimeout(fireAlert, 1200));
    timers.push(setInterval(fireAlert, 6200));

    return () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  }

  window.R66_DEMO = { start };
})();
