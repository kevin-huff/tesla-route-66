// ride/night-demo.js — the Night Drive demo engine (`npm run demo:night`). Drives a
// virtual car around a city grid and runs endless simulated shifts through the REAL
// tracker (same code paths as chat/PWA), so every overlay + the PWA animate with no
// car, no Postgres, no Streamerbot. Also seeds ~60 days of historical pickups on
// first boot so the HEAT view has density to show.

import { haversine } from '../geo.js';

const M_PER_DEG_LAT = 111320;
const FOLLOW_NAMES = ['nightowl_42', 'kc_rides', 'moonroof_mo', 'txgrid', 'lowbeam_lu', 'ozark_ella', 'deadhead_dan', 'voltline'];

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const rndi = (lo, hi) => Math.round(rnd(lo, hi));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// scatter a point around a center, in meters
function scatter(center, spreadM) {
  const mLng = M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  return {
    lat: center.lat + (rnd(-spreadM, spreadM)) / M_PER_DEG_LAT,
    lng: center.lng + (rnd(-spreadM, spreadM)) / mLng,
  };
}

// ~60 days of past rides around a few hotspots (plus a handful inside the home
// zone, to prove the privacy filter visibly drops them from the stream HEAT view)
export async function seedDemoHistory(store, demoCfg) {
  const existing = await store.listRides();
  if (existing.length) return false;

  const c = demoCfg.center;
  const hotspots = [
    { center: c, spread: 500, weight: 5 }, // downtown core
    { center: scatter(c, 2600), spread: 420, weight: 3 }, // entertainment district
    { center: scatter(c, 3200), spread: 500, weight: 2 }, // campus
    { center: scatter(c, 2200), spread: 350, weight: 2 }, // airport-ish
  ];
  const bag = hotspots.flatMap((h) => Array(h.weight).fill(h));

  const now = Date.now();
  const seedShift = await store.createShift({
    startedAt: new Date(now - 61 * 86400_000).toISOString(),
    notes: 'demo history seed',
  });
  await store.endShift(seedShift.id, new Date(now - 60 * 86400_000).toISOString());

  const total = 140;
  for (let i = 0; i < total; i++) {
    const daysAgo = rnd(2, 60); // never closer than ~2 days, so seeds can't leak into "today"
    const start = now - daysAgo * 86400_000 + rndi(-3, 3) * 3600_000;
    const spot = i % 18 === 0 ? { center: demoCfg.home, spread: 120 } : pick(bag);
    const pickup = scatter(spot.center, spot.spread);
    const durSec = rndi(240, 1500);
    const ride = await store.createRide({
      shiftId: seedShift.id,
      startedAt: new Date(start).toISOString(),
      pickup,
      source: 'pwa',
    });
    await store.endRide(ride.id, {
      endedAt: new Date(start + durSec * 1000).toISOString(),
      dropoff: scatter(pick(bag).center, 600),
      fareCents: 500 + Math.round(durSec * 1.1) + rndi(0, 400),
    });
  }
  store.flush?.();
  return true;
}

export function createNightDemo({ cfg, tracker, hub, state }) {
  const d = {
    tickMs: 250,
    rideSecMin: 18, rideSecMax: 40,
    idleSecMin: 6, idleSecMax: 14,
    ridesPerShift: 8,
    center: { lat: 37.209, lng: -93.2923 },
    home: { lat: 37.1885, lng: -93.311 },
    ...(cfg.ride?.demo || {}),
  };

  const pos = { ...d.home }; // the car starts at home — the zone clamp is visible immediately
  let target = null;
  let speedMph = 0;
  let headingDeg = 0;
  let phase = 'boot'; // boot -> deadhead -> arriving -> ride -> (loop) -> recap
  let phaseUntil = Date.now() + 2500;
  let ridesThisShift = 0;
  let timer = null;
  let alertTimer = null;
  const tempF = rndi(48, 66);

  const mLng = () => M_PER_DEG_LAT * Math.cos((pos.lat * Math.PI) / 180);

  // targets stay close and phases carry deadlines — the demo should read like a
  // busy night (ride<->idle beats of tens of seconds), not a realistic commute
  function newTarget(minM = 500, maxM = 1400) {
    target = scatter(d.center, rnd(minM, maxM));
  }

  // L-shaped "street" movement: burn down the bigger axis first, so the car
  // tracks like it's following a grid instead of beelining
  function step(dtSec) {
    if (!target) return true;
    const dLatM = (target.lat - pos.lat) * M_PER_DEG_LAT;
    const dLngM = (target.lng - pos.lng) * mLng();
    const remaining = Math.hypot(dLatM, dLngM);
    if (remaining < 30) { speedMph = Math.max(0, speedMph - 40 * dtSec); return true; }

    const cruise = phase === 'ride' ? 46 : 34;
    const nearStop = remaining < 160 ? Math.max(10, (remaining / 160) * cruise) : cruise;
    speedMph += Math.max(-55 * dtSec, Math.min(30 * dtSec, nearStop - speedMph));
    const stepM = (speedMph * 0.44704) * dtSec;

    if (Math.abs(dLatM) > Math.abs(dLngM)) {
      const dir = Math.sign(dLatM);
      pos.lat += (dir * Math.min(stepM, Math.abs(dLatM))) / M_PER_DEG_LAT;
      headingDeg = dir > 0 ? 0 : 180;
    } else {
      const dir = Math.sign(dLngM);
      pos.lng += (dir * Math.min(stepM, Math.abs(dLngM))) / mLng();
      headingDeg = dir > 0 ? 90 : 270;
    }
    return false;
  }

  function emitTelemetry() {
    // clamp through the tracker's zone so the broadcast NEVER carries an in-zone coord
    tracker.onTelemetry({
      lat: pos.lat, lng: pos.lng, speedMph: Math.round(speedMph),
      state: 'driving', outsideF: tempF, headingDeg,
    });
    const pub = tracker.publicPosition();
    const t = state.telemetry;
    t.lat = pub?.lat ?? null;
    t.lng = pub?.lng ?? null;
    t.speedMph = Math.round(speedMph);
    t.headingDeg = headingDeg;
    t.heading = ['N', 'E', 'S', 'W'][Math.round(headingDeg / 90) % 4];
    t.outsideF = tempF;
    t.state = 'driving';
    hub.broadcast('telemetry', t);
  }

  async function tick() {
    const dtSec = d.tickMs / 1000;
    const arrived = step(dtSec);
    emitTelemetry();
    const nowMs = Date.now();

    try {
      switch (phase) {
        case 'boot':
          if (nowMs >= phaseUntil) {
            await tracker.startShift({ source: 'pwa', notes: 'night-demo' });
            ridesThisShift = 0;
            newTarget();
            phase = 'deadhead';
            phaseUntil = nowMs + 30000; // deadhead deadline — pick up en route if traffic gods say so
          }
          break;
        case 'deadhead': // heading somewhere to pick up
          if (arrived || nowMs >= phaseUntil) {
            phase = 'waiting';
            phaseUntil = nowMs + rnd(d.idleSecMin, d.idleSecMax) * 1000;
          }
          break;
        case 'waiting': // idling at the pickup spot
          if (nowMs >= phaseUntil) {
            await tracker.startRide({ source: 'pwa' });
            newTarget(900, 3200);
            phase = 'ride';
            phaseUntil = nowMs + rnd(d.rideSecMin, d.rideSecMax) * 1000;
          }
          break;
        case 'ride':
          if (arrived || nowMs >= phaseUntil + 20000) {
            const durSec = Math.max(1, (nowMs - new Date(tracker.stats().ride?.startedAt || nowMs)) / 1000);
            const fareCents = 500 + Math.round(durSec * 28) + rndi(0, 350);
            const res = await tracker.endRide({ source: 'pwa', fareCents });
            ridesThisShift++;
            if (res.ok && Math.random() < 0.4) {
              const rideId = res.ride.id;
              setTimeout(() => {
                tracker.addTip({ source: 'pwa', amountCents: rndi(100, 800), rideId }).catch(() => {});
              }, rnd(3000, 9000));
            }
            if (ridesThisShift >= d.ridesPerShift) {
              await tracker.endShift({ source: 'pwa' });
              phase = 'recap';
              phaseUntil = nowMs + 14000; // let the recap card breathe
            } else {
              newTarget();
              phase = 'deadhead';
              phaseUntil = nowMs + 30000;
            }
          }
          break;
        case 'recap':
          if (nowMs >= phaseUntil) {
            phase = 'boot';
            phaseUntil = nowMs + 3000;
          }
          break;
      }
    } catch (e) {
      console.error('[nd-demo]', e);
    }
  }

  function fireAlert() {
    const kind = Math.random() < 0.6 ? 'follow' : 'sub';
    hub.broadcast('alert', {
      kind,
      kicker: kind === 'follow' ? 'NEW FOLLOWER' : 'NEW SUB',
      name: `@${pick(FOLLOW_NAMES)}`,
      detail: kind === 'sub' ? 'TIER 1' : '',
    });
  }

  return {
    start() {
      timer = setInterval(tick, d.tickMs);
      alertTimer = setInterval(() => { if (Math.random() < 0.5) fireAlert(); }, 45000);
      if (timer.unref) timer.unref();
      if (alertTimer.unref) alertTimer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (alertTimer) clearInterval(alertTimer);
    },
  };
}
