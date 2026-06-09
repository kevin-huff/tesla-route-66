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

  function start(client, opts) {
    const timers = [];
    const warn = !!opts.warn;

    const tele = warn
      ? { batteryPct: 11, usableBatteryPct: 10, rangeMi: 28, speedMph: 58, heading: 'SSW', headingDeg: 202, cabinF: 74, outsideF: 99, lat: 35.43, lng: -108.33, state: 'driving', pluggedIn: false, chargerKw: 0, battSegments: 2, warn: true, statusText: 'CHARGE CRITICAL' }
      : { batteryPct: 72, usableBatteryPct: 71, rangeMi: 214, speedMph: 63, heading: 'WSW', headingDeg: 247, cabinF: 70, outsideF: 94, lat: 34.90, lng: -112.10, state: 'driving', pluggedIn: false, chargerKw: 0, battSegments: 10, warn: false, statusText: 'ALL SYSTEMS NOMINAL' };
    client.dispatch('telemetry', { ...tele });
    timers.push(setInterval(() => {
      client.dispatch('telemetry', { ...tele, speedMph: Math.max(0, tele.speedMph + Math.round((Math.random() - 0.5) * 4)) });
    }, 1400));

    let dist = 84;
    let etaMin = 92;
    const baseMap = {
      currentLeg: 3, totalLegs: 6,
      legStatus: ['done', 'done', 'current', 'future', 'future', 'future'],
      vehicle: { svgX: 126, svgY: 342, lat: 34.90, lng: -112.10, onLeg: 3, progress: 0.61 },
      nextWaypoint: { name: 'MARICOPA, AZ', tag: 'STANDBY' },
      distToNextMi: dist, etaText: '1:32', standby: { active: false, node: 'MCP' },
    };
    client.dispatch('map', { ...baseMap });
    timers.push(setInterval(() => {
      dist = Math.max(0, dist - 1);
      etaMin = Math.max(0, etaMin - 1);
      client.dispatch('map', { ...baseMap, distToNextMi: dist, etaText: `${Math.floor(etaMin / 60)}:${String(etaMin % 60).padStart(2, '0')}` });
    }, 6000));

    client.dispatch('logbook', { states: 5, superchargers: 18, miles: 1847, stationsBypassed: 63, elevationFt: 11200, legsDone: 3, totalLegs: 6 });

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
