// ride/routes.js — the /api/ride/* REST surface. Mounted by the hub; Streamerbot
// chat commands and the PWA both land here. Auth is a single shared bearer token
// (LAN + Tailscale exposure model): required for every mutation and for any
// private view (?private=1 — coordinates, unfiltered heat). Public GETs return
// privacy-filtered data only.
//
//   POST /api/ride/shift/start          {idempotencyKey?, notes?}
//   POST /api/ride/shift/end            {idempotencyKey?}
//   POST /api/ride/start                {idempotencyKey?}
//   POST /api/ride/end                  {idempotencyKey?, fareCents | earnings}
//   POST /api/ride/tip                  {idempotencyKey?, amountCents | amount, rideId?}
//   POST /api/ride/map/mode             {mode: nav|route|heat}
//   POST /api/ride/summary/resend
//   POST /api/ride/seed                 {month, earningsCents|earnings, rides, shiftSeconds}
//   GET  /api/ride/stats/today | /stats/month | /stats/chat
//   GET  /api/ride/rides/today          (?private=1 -> pickup/dropoff coords)
//   GET  /api/ride/map/route/today      (?private=1 -> unfiltered path)
//   GET  /api/ride/map/heat             (?binM&from&to&dow&hour; ?private=1 -> in-zone included)

const ERROR_STATUS = {
  no_shift: 409,
  no_ride: 409,
  ride_open: 409,
  bad_fare: 400,
  bad_amount: 400,
};

export function createRideRoutes({ tracker, cfg }) {
  const token = cfg.ride?.authToken;
  const authEnabled = !!token && token !== 'CHANGE_ME';

  function authed(req, url) {
    if (!authEnabled) return true;
    const h = req.headers['authorization'] || '';
    if (h === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  }

  function result(json, res, r) {
    if (r?.ok === false) return json(res, ERROR_STATUS[r.code] || 400, r);
    return json(res, 200, r);
  }

  // returns true when the request was handled
  async function handle(req, res, url, { json, readBody }) {
    const p = url.pathname;
    if (!p.startsWith('/api/ride/')) return false;

    const isPost = req.method === 'POST';
    const wantsPrivate = url.searchParams.get('private') === '1';
    if ((isPost || wantsPrivate) && !authed(req, url)) {
      json(res, 401, { ok: false, error: 'unauthorized (bearer token or ?token=)' });
      return true;
    }

    const body = isPost ? await readBody(req) : {};
    const source = body.source === 'chat' ? 'chat' : 'pwa';
    const base = { idempotencyKey: body.idempotencyKey, source };

    switch (`${req.method} ${p}`) {
      case 'POST /api/ride/shift/start':
        result(json, res, await tracker.startShift({ ...base, notes: body.notes ?? null }));
        return true;
      case 'POST /api/ride/shift/end':
        result(json, res, await tracker.endShift(base));
        return true;
      case 'POST /api/ride/start':
        result(json, res, await tracker.startRide(base));
        return true;
      case 'POST /api/ride/end':
        result(json, res, await tracker.endRide({ ...base, fareCents: body.fareCents, earnings: body.earnings }));
        return true;
      case 'POST /api/ride/tip':
        result(json, res, await tracker.addTip({
          ...base, amountCents: body.amountCents, amount: body.amount, rideId: body.rideId,
        }));
        return true;
      case 'POST /api/ride/map/mode':
        result(json, res, await tracker.setMapMode(String(body.mode || '').toLowerCase()));
        return true;
      case 'POST /api/ride/summary/resend':
        result(json, res, await tracker.resendSummary());
        return true;
      case 'POST /api/ride/seed':
        result(json, res, await tracker.seedMonth(body));
        return true;

      case 'GET /api/ride/stats/today': {
        const s = tracker.stats();
        json(res, 200, { ok: true, stats: s, ticker: tracker.ticker(), chatText: tracker.chatStats() });
        return true;
      }
      case 'GET /api/ride/stats/month':
        json(res, 200, { ok: true, month: tracker.stats().month });
        return true;
      case 'GET /api/ride/stats/chat':
        json(res, 200, { ok: true, chatText: tracker.chatStats() });
        return true;
      case 'GET /api/ride/rides/today':
        json(res, 200, { ok: true, rides: tracker.ridesTodayList(wantsPrivate) });
        return true;
      case 'GET /api/ride/map/route/today':
        json(res, 200, { ok: true, ...(await tracker.routeToday({ privateView: wantsPrivate })) });
        return true;
      case 'GET /api/ride/map/heat': {
        const sp = url.searchParams;
        json(res, 200, {
          ok: true,
          ...(await tracker.heat({
            privateView: wantsPrivate,
            binM: sp.get('binM') ? Number(sp.get('binM')) : undefined,
            from: sp.get('from') || undefined,
            to: sp.get('to') || undefined,
            dow: sp.get('dow') || undefined,
            hour: sp.get('hour') || undefined,
          })),
        });
        return true;
      }
      default:
        json(res, 404, { ok: false, error: 'unknown ride endpoint' });
        return true;
    }
  }

  return { handle, authEnabled };
}
