// nd-demo.js — canned client-side simulation. When no bridge is reachable
// (file:// preview, OBS on a dead LAN) every Night Drive page still renders and
// animates like the design prototype: ride<->idle cycle ~20s, odometer rolls,
// ticker slides, event cards, rotating map with fake route + heat. Feeds the
// exact same channels nd-client dispatches, so page code has one code path.
(function () {
  const CENTER = { lat: 37.209, lng: -93.2923 };

  function start(ND, params) {
    const t0 = Date.now();
    let earnings = 8740;
    let rides = 12;
    let rideActive = false;
    let rideStart = null;
    let idleStart = new Date().toISOString();
    const shiftStart = new Date(t0 - 2 * 3600_000 - 14 * 60_000).toISOString();
    let rideSec = 4980;
    let idleSec = 2280;
    let n = rides;
    const ticker = [
      { n: 12, durSec: 1102, fareCents: 1247, tipCents: 300 },
      { n: 11, durSec: 754, fareCents: 940, tipCents: 0 },
      { n: 10, durSec: 1361, fareCents: 1785, tipCents: 500 },
    ];
    let pos = { ...CENTER };
    let heading = 45;
    const timers = [];

    const stats = () => ({
      serverNow: new Date().toISOString(),
      shift: { status: 'live', id: 1, startedAt: shiftStart },
      ride: rideActive ? { id: n, n, startedAt: rideStart } : null,
      idleStartedAt: rideActive ? null : idleStart,
      today: {
        earningsCents: earnings, faresCents: earnings - 800, tipsCents: 800,
        rides,
        rideSec: rideSec + (rideActive ? (Date.now() - Date.parse(rideStart)) / 1000 : 0),
        idleSec: idleSec + (rideActive ? 0 : (Date.now() - Date.parse(idleStart)) / 1000),
        paceCentsPerHr: Math.round(earnings / ((Date.now() - Date.parse(shiftStart)) / 3600_000)),
      },
      month: { earningsCents: 184275 + earnings, rides: 131 + rides, shiftSec: 90 * 3600 },
      bests: { hourCents: 5140, dayCents: 21830 },
      mapMode: 'nav',
    });

    ND.dispatch('ride', { stats: stats(), ticker: [...ticker], mapMode: 'nav', position: null });

    // telemetry drift
    timers.push(setInterval(() => {
      heading += (Math.random() - 0.5) * 24;
      const sp = rideActive ? 24 + Math.random() * 18 : 8 + Math.random() * 10;
      pos.lat += Math.cos((heading * Math.PI) / 180) * sp * 0.0000012;
      pos.lng += Math.sin((heading * Math.PI) / 180) * sp * 0.0000015;
      ND.dispatch('telemetry', {
        lat: pos.lat, lng: pos.lng, speedMph: Math.round(sp),
        headingDeg: ((heading % 360) + 360) % 360, outsideF: 54, state: 'driving',
      });
    }, 1000));

    timers.push(setInterval(() => ND.dispatch('stats_tick', { stats: stats(), ticker: [...ticker] }), 3000));

    // ride <-> idle cycle (~20s)
    function cycle() {
      if (!rideActive) {
        rideActive = true;
        n += 1;
        rideStart = new Date().toISOString();
        idleSec += (Date.now() - Date.parse(idleStart)) / 1000;
        ND.dispatch('ride_started', { ride: { id: n, n, startedAt: rideStart }, stats: stats(), ticker: [...ticker] });
        timers.push(setTimeout(cycle, 11000 + Math.random() * 7000));
      } else {
        rideActive = false;
        const durSec = Math.round((Date.now() - Date.parse(rideStart)) / 1000) + 720;
        const fareCents = 700 + Math.round(Math.random() * 1400);
        earnings += fareCents;
        rides += 1;
        rideSec += (Date.now() - Date.parse(rideStart)) / 1000;
        idleStart = new Date().toISOString();
        const ride = { id: n, n, durSec, fareCents, tipCents: 0 };
        ticker.unshift(ride);
        ticker.length = Math.min(ticker.length, 3);
        ND.dispatch('ride_ended', { ride, stats: stats(), ticker: [...ticker], chatText: '' });
        if (Math.random() < 0.4) {
          timers.push(setTimeout(() => {
            const tip = 100 + Math.round(Math.random() * 500);
            earnings += tip;
            ride.tipCents = tip;
            ND.dispatch('tip_added', { tip: { amountCents: tip, rideId: ride.id }, ride, stats: stats(), ticker: [...ticker] });
          }, 4000));
        }
        timers.push(setTimeout(cycle, 7000 + Math.random() * 5000));
      }
    }
    timers.push(setTimeout(cycle, 5000));

    // occasional twitch moments
    const names = ['nightowl_42', 'kc_rides', 'moonroof_mo', 'lowbeam_lu'];
    timers.push(setInterval(() => {
      const kind = Math.random() < 0.6 ? 'follow' : 'sub';
      ND.dispatch('alert', {
        kind, name: `@${names[Math.floor(Math.random() * names.length)]}`,
        kicker: kind === 'follow' ? 'NEW FOLLOWER' : 'NEW SUB', detail: kind === 'sub' ? 'TIER 1' : '',
      });
    }, 34000));

    // recap preview on demand (?recap shows it immediately on the recap page)
    if (params && params.has('recap')) {
      setTimeout(() => ND.dispatch('shift_ended', {
        summary: {
          startedAt: shiftStart, endedAt: new Date().toISOString(),
          shiftSec: 4 * 3600 + 32 * 60 + 10, earningsCents: 18750, rides: 12,
          rideSec: 2 * 3600 + 58 * 60, idleSec: 3600 + 34 * 60,
          paceCentsPerHr: 4130, bests: { hourCents: 5140, dayCents: 21830 },
          dateText: 'FRI, JUL 3',
        },
        stats: stats(),
      }), 800);
    }

    return () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  }

  // fake map data for nd-map when there's no bridge to fetch from
  function mapData() {
    const seg = (kind, pts, extra = {}) => ({ kind, pts, ...extra });
    const P = (dLat, dLng) => [CENTER.lng + dLng, CENTER.lat + dLat];
    return {
      route: {
        segments: [
          seg('deadhead', [P(-0.018, -0.016), P(-0.012, -0.016), P(-0.012, -0.004), P(-0.002, -0.004)], { fadeStart: true }),
          seg('ride', [P(-0.002, -0.004), P(0.004, -0.004), P(0.004, 0.008), P(0.012, 0.008)]),
          seg('deadhead', [P(0.012, 0.008), P(0.012, 0.001), P(0.006, 0.001)]),
          seg('ride', [P(0.006, 0.001), P(0.006, 0.014), P(-0.003, 0.014), P(-0.003, 0.021)]),
        ],
        privacy: true,
      },
      heat: {
        binM: 250, max: 9, total: 60,
        cells: [
          { lat: CENTER.lat, lng: CENTER.lng, n: 9 },
          { lat: CENTER.lat + 0.004, lng: CENTER.lng + 0.006, n: 6 },
          { lat: CENTER.lat + 0.016, lng: CENTER.lng + 0.011, n: 7 },
          { lat: CENTER.lat - 0.011, lng: CENTER.lng + 0.014, n: 4 },
          { lat: CENTER.lat + 0.009, lng: CENTER.lng - 0.012, n: 5 },
          { lat: CENTER.lat - 0.005, lng: CENTER.lng - 0.007, n: 3 },
        ],
      },
    };
  }

  window.ND_DEMO = { start, mapData };
})();
