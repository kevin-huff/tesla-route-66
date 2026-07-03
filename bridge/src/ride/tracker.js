// ride/tracker.js — the ride-shift state machine. Owns shifts / rides / tips /
// idle intervals; Streamerbot and the PWA are thin clients. Everything time-like
// is DERIVED from stored timestamps (never in-memory counters) so a bridge restart
// mid-ride loses nothing. All money is integer cents.
//
// A "day" rolls over at dayRolloverHour local (default 4 AM) so a 9 PM - 3 AM
// shift never splits across days; months follow the same shifted clock.
//
// WS events (broadcast through the shared hub): shift_started, ride_started,
// ride_ended, tip_added, shift_ended, stats_tick, map_mode, personal_best.
// Every payload carries serverNow so overlays tick timers locally without drift.

import { kmhToMph, cToF, round, clamp } from '../units.js';
import { haversine } from '../geo.js';
import { createPrivacyZone } from './privacy.js';
import { binPickups } from './heat.js';

const MAP_MODES = ['nav', 'route', 'heat'];
const PB_MIN_SHIFT_SEC = 30 * 60; // pace is noise before the shift has any length

export const fmtUsd = (cents) => {
  const n = Math.abs(Math.round(cents));
  const s = `${Math.floor(n / 100).toLocaleString('en-US')}.${String(n % 100).padStart(2, '0')}`;
  return `${cents < 0 ? '-' : ''}$${s}`;
};
export const fmtMSS = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtHMM = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};
export const fmtHMMSS = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export async function createRideTracker({ cfg, store, now = () => Date.now() }) {
  const rideCfg = cfg.ride || {};
  const tz = rideCfg.timezone || 'America/Chicago';
  const rolloverHour = rideCfg.dayRolloverHour ?? 4;
  const pathCfg = { minMoveM: 40, maxPoints: 4000, ...(rideCfg.path || {}) };
  const zone = createPrivacyZone(rideCfg.privacy);

  let broadcast = () => {}; // wired to the hub after construction (hub needs us for snapshots)
  let statsTimer = null;

  // ---- local calendar (shifted by rolloverHour so night shifts don't split) ----
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dayKey = (ts) => dayFmt.format(new Date(new Date(ts).getTime() - rolloverHour * 3600_000));
  const monthKey = (ts) => dayKey(ts).slice(0, 7);
  const nowIso = () => new Date(now()).toISOString();

  // ---- in-memory mirrors, rebuilt from the store at boot / rollover ----
  let openShift = null;
  let openRide = null;
  let openIdleStartedAt = null;
  let todayKey = dayKey(now());
  let ridesToday = []; // completed + open, this (shifted) day, in start order
  let tipsToday = [];
  let idleToday = []; // completed intervals only; the open one is openIdleStartedAt
  let monthAgg = { key: monthKey(now()), earningsCents: 0, rides: 0, shiftSec: 0 }; // completed only, incl. seed
  let bests = { hourCents: 0, dayCents: 0 };
  let pbState = { hourFiredShiftId: null, dayFiredOn: null };
  let mapMode = 'nav';
  let lastSummary = null; // last ride_ended / shift_ended payload, for resend
  let lastFix = null; // {at, lat, lng, speedMph, tempF, headingDeg, state}
  let lastPathPt = null;

  async function rebuildCaches() {
    todayKey = dayKey(now());
    const mKey = monthKey(now());
    openShift = await store.getOpenShift();
    openRide = await store.getOpenRide();
    if (openRide && !openShift) {
      // a ride can't outlive its shift; repair a store left inconsistent by a crash
      openRide = await store.endRide(openRide.id, { endedAt: nowIso(), dropoff: null, fareCents: 0 });
      openRide = null;
    }

    const allRides = await store.listRides();
    const allTips = await store.listTips();
    const allShifts = await store.listShifts();
    ridesToday = allRides.filter((r) => dayKey(r.startedAt) === todayKey);
    tipsToday = allTips.filter((t) => dayKey(t.createdAt) === todayKey);
    const idles = openShift ? await store.listIdle({ shiftId: openShift.id }) : [];
    idleToday = idles.filter((iv) => iv.endedAt);
    const openIv = idles.find((iv) => !iv.endedAt);
    openIdleStartedAt = openIv ? openIv.startedAt : null;
    if (openShift && !openRide && !openIdleStartedAt) {
      // repair: an open shift with no ride must be idling
      const iv = await store.openIdle({ shiftId: openShift.id, startedAt: nowIso() });
      openIdleStartedAt = iv.startedAt;
    }

    // monthAgg = seed + COMMITTED history only. The open shift's rides/tips are
    // excluded here and added live in monthStats(), then committed at endShift —
    // one or the other, never both (a restart mid-shift must not double count).
    const seed = (await store.getMonthlySeed(mKey)) || { earningsCents: 0, rides: 0, shiftSeconds: 0 };
    const openId = openShift?.id;
    const ridesMonth = allRides.filter(
      (r) => r.endedAt && r.shiftId !== openId && monthKey(r.startedAt) === mKey,
    );
    const tipsMonth = allTips.filter(
      (t) => t.shiftId !== openId && monthKey(t.createdAt) === mKey,
    );
    const shiftSecMonth = allShifts
      .filter((s) => s.endedAt && monthKey(s.startedAt) === mKey)
      .reduce((a, s) => a + (new Date(s.endedAt) - new Date(s.startedAt)) / 1000, 0);
    monthAgg = {
      key: mKey,
      earningsCents:
        seed.earningsCents +
        ridesMonth.reduce((a, r) => a + r.fareCents, 0) +
        tipsMonth.reduce((a, t) => a + t.amountCents, 0),
      rides: seed.rides + ridesMonth.length,
      shiftSec: seed.shiftSeconds + Math.round(shiftSecMonth),
    };

    bests = (await store.getMeta('bests')) || { hourCents: 0, dayCents: 0 };
    pbState = (await store.getMeta('pbState')) || { hourFiredShiftId: null, dayFiredOn: null };
    mapMode = (await store.getMeta('mapMode')) || 'nav';
    lastSummary = (await store.getMeta('lastSummary')) || null;
  }

  function rolloverIfNeeded() {
    if (dayKey(now()) !== todayKey || monthKey(now()) !== monthAgg.key) {
      return rebuildCaches();
    }
    return null;
  }

  // ---- derived stats (pure reads; safe for stream + chat) ----
  const secSince = (iso) => Math.max(0, (now() - new Date(iso).getTime()) / 1000);
  const rideDurSec = (r) =>
    r.endedAt ? (new Date(r.endedAt) - new Date(r.startedAt)) / 1000 : secSince(r.startedAt);

  function tipsForRide(rideId) {
    return tipsToday.filter((t) => t.rideId === rideId).reduce((a, t) => a + t.amountCents, 0);
  }
  function rideN(ride) {
    return ridesToday.findIndex((r) => r.id === ride.id) + 1 || ridesToday.length + 1;
  }

  function todayStats() {
    const completed = ridesToday.filter((r) => r.endedAt);
    const fares = completed.reduce((a, r) => a + r.fareCents, 0);
    const tips = tipsToday.reduce((a, t) => a + t.amountCents, 0);
    const rideSec =
      completed.reduce((a, r) => a + rideDurSec(r), 0) + (openRide ? secSince(openRide.startedAt) : 0);
    const idleSec =
      idleToday.reduce((a, iv) => a + (new Date(iv.endedAt) - new Date(iv.startedAt)) / 1000, 0) +
      (openIdleStartedAt ? secSince(openIdleStartedAt) : 0);
    const shiftSec = openShift ? secSince(openShift.startedAt) : 0;
    const earningsCents = fares + tips;
    return {
      earningsCents, faresCents: fares, tipsCents: tips,
      rides: completed.length,
      rideSec: Math.round(rideSec), idleSec: Math.round(idleSec),
      paceCentsPerHr: shiftSec > 60 ? Math.round(earningsCents / (shiftSec / 3600)) : 0,
    };
  }

  function monthStats() {
    // monthAgg holds seed + committed history; add the open shift's uncommitted live contributions
    const shiftSec = monthAgg.shiftSec + (openShift ? Math.round(secSince(openShift.startedAt)) : 0);
    const liveShiftRides = openShift
      ? ridesToday.filter((r) => r.endedAt && r.shiftId === openShift.id)
      : [];
    const liveCents = openShift
      ? liveShiftRides.reduce((a, r) => a + r.fareCents, 0) +
        tipsToday.filter((x) => x.shiftId === openShift.id).reduce((a, x) => a + x.amountCents, 0)
      : 0;
    return {
      earningsCents: monthAgg.earningsCents + liveCents,
      rides: monthAgg.rides + liveShiftRides.length,
      shiftSec,
    };
  }

  function stats() {
    return {
      serverNow: nowIso(),
      shift: openShift
        ? { status: 'live', id: openShift.id, startedAt: openShift.startedAt }
        : { status: 'off', startsAt: rideCfg.shiftStartsAt || null },
      ride: openRide ? { id: openRide.id, n: rideN(openRide), startedAt: openRide.startedAt } : null,
      idleStartedAt: openIdleStartedAt,
      today: todayStats(),
      month: monthStats(),
      bests: { hourCents: bests.hourCents, dayCents: bests.dayCents },
      mapMode,
    };
  }

  function ticker(limit = 3) {
    return ridesToday
      .filter((r) => r.endedAt)
      .slice(-limit)
      .map((r) => ({
        id: r.id, n: rideN(r),
        durSec: Math.round(rideDurSec(r)),
        fareCents: r.fareCents,
        tipCents: tipsForRide(r.id),
      }))
      .reverse(); // newest first
  }

  // full-day list. privateView adds pickup/dropoff coords — PWA only, NEVER on stream.
  function ridesTodayList(privateView = false) {
    return ridesToday.map((r) => ({
      id: r.id, n: rideN(r), startedAt: r.startedAt, endedAt: r.endedAt,
      durSec: Math.round(rideDurSec(r)),
      fareCents: r.fareCents, tipCents: tipsForRide(r.id),
      source: r.source,
      ...(privateView
        ? {
            pickup: r.pickupLat != null ? { lat: r.pickupLat, lng: r.pickupLng } : null,
            dropoff: r.dropoffLat != null ? { lat: r.dropoffLat, lng: r.dropoffLng } : null,
          }
        : {}),
    }));
  }

  // ---- chat lines (Streamerbot posts these verbatim; keep <500 chars for IRC) ----
  function chatRideEnded(ride, s) {
    return (
      `RIDE #${ride.n} COMPLETE · ${fmtMSS(ride.durSec)} · ${fmtUsd(ride.fareCents)} | ` +
      `TODAY: ${fmtUsd(s.today.earningsCents)} · ${s.today.rides} rides · ${fmtHMM(secSince(openShift?.startedAt ?? ride.startedAt))} on shift | ` +
      `MONTH: ${fmtUsd(s.month.earningsCents)} · ${s.month.rides} rides`
    ).slice(0, 490);
  }
  function chatTip(tip, ride, s) {
    return (
      `TIP +${fmtUsd(tip.amountCents)}${ride ? ` → RIDE #${ride.n}` : ''} | ` +
      `TODAY: ${fmtUsd(s.today.earningsCents)} · ${s.today.rides} rides`
    ).slice(0, 490);
  }
  function chatShiftEnded(sum) {
    return (
      `SHIFT COMPLETE · ${fmtHMMSS(sum.shiftSec)} · ${fmtUsd(sum.earningsCents)} · ${sum.rides} rides · ` +
      `ride ${fmtHMM(sum.rideSec)} / idle ${fmtHMM(sum.idleSec)} · pace ${fmtUsd(sum.paceCentsPerHr)}/hr`
    ).slice(0, 490);
  }
  function chatStats() {
    const s = stats();
    const shiftBit = openShift ? ` · ${fmtHMMSS(secSince(openShift.startedAt))} on shift` : '';
    return (
      `TODAY: ${fmtUsd(s.today.earningsCents)} · ${s.today.rides} rides${shiftBit} | ` +
      `MONTH: ${fmtUsd(s.month.earningsCents)} · ${s.month.rides} rides · ${fmtHMM(s.month.shiftSec)}`
    ).slice(0, 490);
  }

  // ---- personal bests ----
  async function checkPersonalBests() {
    if (!openShift) return;
    const s = todayStats();
    const shiftSec = secSince(openShift.startedAt);
    let changed = false;

    if (shiftSec >= PB_MIN_SHIFT_SEC && s.paceCentsPerHr > bests.hourCents) {
      const isFirstThisShift = pbState.hourFiredShiftId !== openShift.id;
      bests.hourCents = s.paceCentsPerHr;
      changed = true;
      if (bests.hourCents > 0 && isFirstThisShift) {
        pbState.hourFiredShiftId = openShift.id;
        broadcast('personal_best', {
          kind: 'hour', valueCents: bests.hourCents, serverNow: nowIso(),
          label: `${fmtUsd(bests.hourCents)}/HR`, sub: 'BEST HOUR PACE',
          chatText: `◆ PERSONAL BEST · ${fmtUsd(bests.hourCents)}/hr pace`,
        });
      }
    }
    if (s.earningsCents > bests.dayCents) {
      const firedToday = pbState.dayFiredOn === todayKey;
      const hadPrior = bests.dayCents > 0;
      bests.dayCents = s.earningsCents;
      changed = true;
      if (hadPrior && !firedToday) {
        pbState.dayFiredOn = todayKey;
        broadcast('personal_best', {
          kind: 'day', valueCents: bests.dayCents, serverNow: nowIso(),
          label: fmtUsd(bests.dayCents), sub: 'BEST DAY',
          chatText: `◆ PERSONAL BEST · ${fmtUsd(bests.dayCents)} day`,
        });
      }
    }
    if (changed) {
      await store.setMeta('bests', bests);
      await store.setMeta('pbState', pbState);
    }
  }

  // ---- idempotency wrapper ----
  async function idempotent(key, fn) {
    if (key) {
      const prior = await store.getIdempotent(String(key));
      if (prior) return { ...prior, replayed: true };
    }
    const result = await fn();
    if (key && result?.ok) await store.putIdempotent(String(key), result);
    return result;
  }

  function emitStats(type = 'stats_tick', extra = {}) {
    broadcast(type, { ...extra, stats: stats(), ticker: ticker() });
  }

  // ---- mutations ----
  async function startShift({ idempotencyKey, source = 'pwa', notes = null } = {}) {
    await rolloverIfNeeded();
    return idempotent(idempotencyKey, async () => {
      if (openShift) return { ok: true, already: true, shift: openShift, stats: stats() };
      openShift = await store.createShift({ startedAt: nowIso(), notes });
      const iv = await store.openIdle({ shiftId: openShift.id, startedAt: openShift.startedAt });
      openIdleStartedAt = iv.startedAt;
      idleToday = [];
      startStatsTicker();
      emitStats('shift_started', { shift: openShift, source });
      return { ok: true, shift: openShift, stats: stats() };
    });
  }

  async function startRide({ idempotencyKey, source = 'pwa' } = {}) {
    await rolloverIfNeeded();
    return idempotent(idempotencyKey, async () => {
      if (!openShift) return { ok: false, code: 'no_shift', error: 'no open shift — !start_shift first' };
      if (openRide) return { ok: false, code: 'ride_open', error: `ride #${rideN(openRide)} already in progress`, ride: { id: openRide.id, n: rideN(openRide), startedAt: openRide.startedAt } };
      const warning =
        lastFix && lastFix.state === 'asleep'
          ? 'car is asleep — pickup GPS may be stale'
          : lastFix == null
            ? 'no telemetry yet — pickup GPS not captured'
            : null;
      const pickup = lastFix && lastFix.lat != null ? { lat: lastFix.lat, lng: lastFix.lng } : null;
      openRide = await store.createRide({ shiftId: openShift.id, startedAt: nowIso(), pickup, source });
      ridesToday.push(openRide);
      if (openIdleStartedAt) {
        const iv = await store.closeIdle(openRide.startedAt);
        if (iv) idleToday.push(iv);
        openIdleStartedAt = null;
      }
      const n = rideN(openRide);
      broadcast('ride_started', {
        ride: { id: openRide.id, n, startedAt: openRide.startedAt },
        stats: stats(), ticker: ticker(), source, serverNow: nowIso(),
      });
      return { ok: true, ride: { id: openRide.id, n, startedAt: openRide.startedAt }, warning, stats: stats() };
    });
  }

  async function endRide({ idempotencyKey, source = 'pwa', fareCents, earnings } = {}) {
    await rolloverIfNeeded();
    return idempotent(idempotencyKey, async () => {
      if (!openRide) return { ok: false, code: 'no_ride', error: 'no ride in progress' };
      const cents = normalizeCents(fareCents, earnings);
      if (cents == null || cents < 0 || cents > 99999) {
        return { ok: false, code: 'bad_fare', error: 'fare must be 0.00 - 999.99' };
      }
      const dropoff = lastFix && lastFix.lat != null ? { lat: lastFix.lat, lng: lastFix.lng } : null;
      const ended = await store.endRide(openRide.id, { endedAt: nowIso(), dropoff, fareCents: cents });
      const idx = ridesToday.findIndex((r) => r.id === ended.id);
      if (idx >= 0) ridesToday[idx] = ended;
      openRide = null;
      const iv = await store.openIdle({ shiftId: openShift.id, startedAt: ended.endedAt });
      openIdleStartedAt = iv.startedAt;

      const s = stats();
      const rideOut = {
        id: ended.id, n: idx >= 0 ? idx + 1 : ridesToday.length,
        durSec: Math.round((new Date(ended.endedAt) - new Date(ended.startedAt)) / 1000),
        fareCents: cents, tipCents: tipsForRide(ended.id),
      };
      const payload = {
        ride: rideOut, stats: s, ticker: ticker(), source, serverNow: nowIso(),
        chatText: chatRideEnded(rideOut, s),
      };
      lastSummary = { type: 'ride_ended', payload };
      await store.setMeta('lastSummary', lastSummary);
      broadcast('ride_ended', payload);
      await checkPersonalBests();
      return { ok: true, ride: rideOut, stats: s, chatText: payload.chatText };
    });
  }

  async function addTip({ idempotencyKey, source = 'pwa', amountCents, amount, rideId } = {}) {
    await rolloverIfNeeded();
    return idempotent(idempotencyKey, async () => {
      const cents = normalizeCents(amountCents, amount);
      if (cents == null || cents <= 0 || cents > 99999) {
        return { ok: false, code: 'bad_amount', error: 'tip must be 0.01 - 999.99' };
      }
      let ride = null;
      if (rideId != null) {
        ride = ridesToday.find((r) => r.id === Number(rideId)) || (await store.getRide(Number(rideId)));
        if (!ride) return { ok: false, code: 'no_ride', error: `ride ${rideId} not found` };
      } else {
        // chat default: most recently completed ride today
        ride = ridesToday.filter((r) => r.endedAt).at(-1) || null;
      }
      const shiftId = ride?.shiftId ?? openShift?.id;
      if (shiftId == null) return { ok: false, code: 'no_shift', error: 'no ride or open shift to attach the tip to' };
      const tip = await store.addTip({ rideId: ride?.id ?? null, shiftId, amountCents: cents, createdAt: nowIso() });
      if (dayKey(tip.createdAt) === todayKey) tipsToday.push(tip);
      // month accounting: open-shift tips flow through monthStats() live and are
      // committed at endShift; a tip landing on an already-committed shift goes
      // straight into the aggregate
      if (shiftId !== openShift?.id) monthAgg.earningsCents += cents;

      const s = stats();
      const rideOut = ride
        ? { id: ride.id, n: rideN(ride), durSec: Math.round(rideDurSec(ride)), fareCents: ride.fareCents, tipCents: tipsForRide(ride.id) }
        : null;
      const payload = {
        tip: { id: tip.id, amountCents: cents, rideId: ride?.id ?? null },
        ride: rideOut, stats: s, ticker: ticker(), source, serverNow: nowIso(),
        chatText: chatTip(tip, rideOut, s),
      };
      broadcast('tip_added', payload);
      await checkPersonalBests();
      return { ok: true, tip: payload.tip, ride: rideOut, stats: s, chatText: payload.chatText };
    });
  }

  async function endShift({ idempotencyKey, source = 'pwa' } = {}) {
    await rolloverIfNeeded();
    return idempotent(idempotencyKey, async () => {
      if (!openShift) return { ok: false, code: 'no_shift', error: 'no open shift' };
      if (openRide) return { ok: false, code: 'ride_open', error: 'end the ride first (!end_ride x.xx)' };
      const endedAt = nowIso();
      if (openIdleStartedAt) {
        const iv = await store.closeIdle(endedAt);
        if (iv) idleToday.push(iv);
        openIdleStartedAt = null;
      }
      const shift = await store.endShift(openShift.id, endedAt);
      const shiftSec = Math.round((new Date(endedAt) - new Date(shift.startedAt)) / 1000);
      // summarize from the store by shiftId (not the day caches) so a shift that
      // crossed the day rollover still reports every ride
      const shiftRides = (await store.listRides({ shiftId: shift.id })).filter((r) => r.endedAt);
      const shiftTips = await store.listTips({ shiftId: shift.id });
      const shiftIdles = (await store.listIdle({ shiftId: shift.id })).filter((iv) => iv.endedAt);
      const earningsCents =
        shiftRides.reduce((a, r) => a + r.fareCents, 0) +
        shiftTips.reduce((a, x) => a + x.amountCents, 0);
      const rideSec = Math.round(
        shiftRides.reduce((a, r) => a + (new Date(r.endedAt) - new Date(r.startedAt)) / 1000, 0),
      );
      const summary = {
        shiftId: shift.id, startedAt: shift.startedAt, endedAt,
        shiftSec,
        earningsCents,
        rides: shiftRides.length,
        rideSec,
        idleSec: Math.round(
          shiftIdles.reduce((a, iv) => a + (new Date(iv.endedAt) - new Date(iv.startedAt)) / 1000, 0),
        ),
        paceCentsPerHr: shiftSec > 60 ? Math.round(earningsCents / (shiftSec / 3600)) : 0,
        bests: { hourCents: bests.hourCents, dayCents: bests.dayCents },
        dateText: new Intl.DateTimeFormat('en-US', {
          timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
        }).format(new Date(shift.startedAt)).toUpperCase(),
      };
      // commit the shift into the month aggregate
      monthAgg.earningsCents += summary.earningsCents;
      monthAgg.rides += summary.rides;
      monthAgg.shiftSec += shiftSec;
      openShift = null;
      stopStatsTicker();

      const payload = { summary, stats: stats(), serverNow: nowIso(), source, chatText: chatShiftEnded(summary) };
      lastSummary = { type: 'shift_ended', payload };
      await store.setMeta('lastSummary', lastSummary);
      broadcast('shift_ended', payload);
      return { ok: true, summary, stats: stats(), chatText: payload.chatText };
    });
  }

  async function setMapMode(mode) {
    if (!MAP_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MAP_MODES.join('|')}` };
    mapMode = mode;
    await store.setMeta('mapMode', mode);
    broadcast('map_mode', { mode, serverNow: nowIso() });
    return { ok: true, mode };
  }

  async function resendSummary() {
    if (!lastSummary) return { ok: false, error: 'nothing to resend yet' };
    broadcast(lastSummary.type, { ...lastSummary.payload, resent: true, serverNow: nowIso() });
    return { ok: true, type: lastSummary.type, chatText: lastSummary.payload.chatText };
  }

  async function seedMonth({ month, earningsCents, earnings, rides = 0, shiftSeconds = 0 } = {}) {
    const m = month || monthKey(now());
    if (!/^\d{4}-\d{2}$/.test(m)) return { ok: false, error: 'month must be YYYY-MM' };
    const cents = normalizeCents(earningsCents, earnings) ?? 0;
    await store.setMonthlySeed({ month: m, earningsCents: cents, rides: Number(rides) || 0, shiftSeconds: Number(shiftSeconds) || 0 });
    await rebuildCaches();
    emitStats();
    return { ok: true, seed: { month: m, earningsCents: cents, rides: Number(rides) || 0, shiftSeconds: Number(shiftSeconds) || 0 }, stats: stats() };
  }

  // ---- telemetry ingestion (shared MQTT/replay feed; positions logged while a shift is open) ----
  function onTelemetry(snap) {
    const speedMph =
      snap.speedMph != null
        ? snap.speedMph
        : snap.speedKmh != null
          ? clamp(round(kmhToMph(snap.speedKmh)), 0, 140)
          : 0;
    lastFix = {
      at: now(),
      lat: snap.lat ?? null,
      lng: snap.lng ?? null,
      speedMph: snap.state === 'driving' || snap.speedMph != null ? speedMph : 0,
      tempF: snap.outsideF != null ? snap.outsideF : snap.outsideTempC != null ? round(cToF(snap.outsideTempC)) : null,
      headingDeg: snap.headingDeg ?? null,
      state: snap.state ?? 'unknown',
    };
    if (openShift && lastFix.lat != null) {
      const pt = [now(), round(lastFix.lat, 6), round(lastFix.lng, 6)];
      if (
        !lastPathPt ||
        haversine(pt[1], pt[2], lastPathPt[1], lastPathPt[2]) >= pathCfg.minMoveM
      ) {
        lastPathPt = pt;
        store.appendPath(openShift.id, pt, pathCfg.maxPoints);
      }
    }
  }

  // ---- overlay-facing map data (privacy-enforced HERE, at the boundary) ----
  async function routeToday({ privateView = false } = {}) {
    await rolloverIfNeeded();
    const shift =
      openShift ||
      (await store.listShifts()).filter((s) => dayKey(s.startedAt) === todayKey).at(-1) ||
      null;
    if (!shift) return { segments: [], shiftId: null };
    const raw = await store.getPath(shift.id);
    const rideWindows = ridesToday
      .filter((r) => r.shiftId === shift.id)
      .map((r) => ({
        from: new Date(r.startedAt).getTime(),
        to: r.endedAt ? new Date(r.endedAt).getTime() : Infinity,
      }));
    const inRide = (t) => rideWindows.some((w) => t >= w.from && t <= w.to);

    // split the timeline into ride / deadhead spans, then privacy-filter each span
    const spans = [];
    let cur = null;
    for (const p of raw) {
      const kind = inRide(p[0]) ? 'ride' : 'deadhead';
      if (!cur || cur.kind !== kind) {
        const prev = cur?.pts.at(-1);
        cur = { kind, pts: prev ? [prev] : [] }; // share the joint point so spans connect
        spans.push(cur);
      }
      cur.pts.push(p);
    }

    const segments = [];
    for (const span of spans) {
      if (span.pts.length < 2) continue;
      if (privateView || !zone.enabled) {
        segments.push({ kind: span.kind, pts: span.pts.map((p) => [p[2], p[1]]) });
        continue;
      }
      const runs = zone.filterPath(span.pts);
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.length < 2) continue;
        segments.push({
          kind: span.kind,
          pts: run.map((p) => [p[2], p[1]]),
          // a break against the zone means the path ended at the fade — overlay fades that tip
          fadeStart: run[0] !== span.pts[0],
          fadeEnd: run.at(-1) !== span.pts.at(-1) || (openShift && zone.inside(lastFix?.lat, lastFix?.lng)),
        });
      }
    }
    return { segments, shiftId: shift.id, privacy: zone.enabled };
  }

  async function heat(params = {}) {
    const pickups = await store.listPickups();
    const filtered = params.privateView
      ? pickups
      : pickups.filter((p) => !zone.inside(p.lat, p.lng));
    return binPickups(filtered, {
      binM: params.binM ?? rideCfg.heat?.binM ?? 250,
      from: params.from, to: params.to, dow: params.dow, hour: params.hour,
      timezone: tz,
    });
  }

  // NAV position for the stream map — clamped to the zone boundary when home
  function publicPosition() {
    if (!lastFix || lastFix.lat == null) return null;
    const { lat, lng } = zone.clamp(lastFix.lat, lastFix.lng);
    return {
      lat: round(lat, 6), lng: round(lng, 6),
      speedMph: lastFix.speedMph, headingDeg: lastFix.headingDeg,
      tempF: lastFix.tempF, state: lastFix.state,
      clamped: zone.inside(lastFix.lat, lastFix.lng),
      at: lastFix.at,
    };
  }

  function publicSnapshot() {
    return {
      stats: stats(),
      ticker: ticker(),
      mapMode,
      position: publicPosition(),
      lastSummary: lastSummary?.type === 'shift_ended' ? lastSummary.payload.summary : null,
    };
  }

  // ---- periodic stats tick (only while a shift is live) ----
  function startStatsTicker() {
    if (statsTimer) return;
    const ms = (rideCfg.statsTickSec || 5) * 1000;
    statsTimer = setInterval(() => {
      rolloverIfNeeded();
      emitStats();
    }, ms);
    if (statsTimer.unref) statsTimer.unref();
  }
  function stopStatsTicker() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  await rebuildCaches();
  if (openShift) startStatsTicker();

  return {
    setBroadcast: (fn) => { broadcast = fn; },
    onTelemetry,
    startShift, endShift, startRide, endRide, addTip,
    setMapMode, resendSummary, seedMonth,
    stats, chatStats, ticker, ridesTodayList, routeToday, heat,
    publicSnapshot, publicPosition,
    zone,
    stop: () => { stopStatsTicker(); store.flush?.(); },
    _rebuild: rebuildCaches, // tests: simulate a restart
  };
}

// accept integer cents (preferred) or a dollars value ("14.75", 14.75) from chat
export function normalizeCents(cents, dollars) {
  if (cents != null && cents !== '') {
    const n = Number(cents);
    return Number.isInteger(n) ? n : null;
  }
  if (dollars != null && dollars !== '') {
    const n = Number(String(dollars).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  return null;
}
