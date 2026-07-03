// Night Drive PWA — the write side. Optimistic UI with a persistent retry queue:
// every mutation carries an idempotency key, so flaky cellular / double-taps can
// never double-log a ride. State truth is the bridge; the phone re-syncs on every
// event, reconnect, and visibility change.
(function () {
  const $ = (id) => document.getElementById(id);
  const API = ''; // same origin as the bridge

  // ---- token (single shared bearer; stored on-device) ----
  const token = () => localStorage.getItem('nd_token') || '';
  function askToken() {
    const t = prompt('Bridge access token (ride.authToken):', token());
    if (t != null) { localStorage.setItem('nd_token', t.trim()); sync(); }
  }
  document.querySelectorAll('.tokenBtn').forEach((b) => b.addEventListener('click', askToken));

  // ---- formatters ----
  const usd = (c) => {
    const n = Math.abs(Math.round(c || 0));
    return `${c < 0 ? '-' : ''}$${Math.floor(n / 100).toLocaleString('en-US')}.${String(n % 100).padStart(2, '0')}`;
  };
  const mss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const hmm = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
  const hmmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  // ---- toast ----
  let toastTimer = null;
  function toast(msg, err = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', err);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---- retry queue (localStorage; survives app kills) ----
  const Q_KEY = 'nd_queue';
  const loadQ = () => { try { return JSON.parse(localStorage.getItem(Q_KEY)) || []; } catch { return []; } };
  const saveQ = (q) => localStorage.setItem(Q_KEY, JSON.stringify(q));
  let flushing = false;

  function enqueue(path, body) {
    const q = loadQ();
    q.push({ path, body: { ...body, idempotencyKey: crypto.randomUUID(), source: 'pwa' }, at: Date.now() });
    saveQ(q);
    updateQBadge();
    flush();
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let q = loadQ();
      while (q.length) {
        const item = q[0];
        let res;
        try {
          res = await fetch(`${API}${item.path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
            body: JSON.stringify(item.body),
          });
        } catch {
          break; // offline — retry later, order preserved
        }
        const payload = await res.json().catch(() => ({}));
        q.shift(); // delivered (even a 4xx is a final answer — idempotency key spent)
        saveQ(q);
        if (res.status === 401) { toast('UNAUTHORIZED — SET TOKEN', true); askToken(); break; }
        if (!res.ok) toast((payload.error || `ERROR ${res.status}`).toUpperCase(), true);
        q = loadQ();
      }
    } finally {
      flushing = false;
      updateQBadge();
      sync();
    }
  }
  setInterval(flush, 5000);
  addEventListener('online', flush);
  function updateQBadge() {
    const n = loadQ().length;
    $('qbadge').textContent = n ? `QUEUED ×${n}` : '';
    $('qbadge').classList.toggle('on', n > 0);
  }

  // ---- state + rendering ----
  let stats = null;
  let rides = [];
  let lastSummary = null;
  let pendingRide = false; // optimistic: a ride action is queued but unconfirmed

  function screen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  }
  function currentScreen() {
    return document.querySelector('.screen.on')?.id;
  }

  function render() {
    if (!stats) return;
    const live = stats.shift.status === 'live';
    // don't yank the user off an entry screen mid-typing
    const cur = currentScreen();
    if (!['s-fare', 's-tip', 's-summary'].includes(cur)) screen(live ? 's-home' : 's-pre');

    // P5
    $('preNow').textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('preMonth').textContent = `${usd(stats.month.earningsCents)} · ${stats.month.rides} RIDES · ${hmm(stats.month.shiftSec)}H`;
    $('preLast').textContent = lastSummary
      ? `${usd(lastSummary.earningsCents)} · ${lastSummary.rides} RIDES · ${hmm(lastSummary.shiftSec)}`
      : '—';

    // P1
    const riding = !!stats.ride;
    $('homeStateLabel').textContent = riding ? `RIDE #${stats.ride.n} · TRIP TIME` : 'IDLE';
    $('homeStateLabel').classList.toggle('volt', riding);
    $('homeStateClock').classList.toggle('idle', !riding);
    $('homeEarn').textContent = usd(stats.today.earningsCents);
    $('homeRides').textContent = stats.today.rides;
    $('homePace').textContent = usd(stats.today.paceCentsPerHr);
    const btn = $('btnRide');
    btn.textContent = riding ? 'END RIDE' : 'START RIDE';
    btn.className = `btn ${riding ? 'primary' : 'outline'}`;
    btn.disabled = pendingRide;
    $('capCount').textContent = rides.length ? `${rides.length} TODAY` : '';

    const list = $('homeRideList');
    list.textContent = '';
    for (const r of [...rides].filter((x) => x.endedAt).reverse().slice(0, 4)) {
      const el = document.createElement('div');
      el.className = 'ride-item';
      el.innerHTML =
        `<span class="n">#${r.n}</span>` +
        `<span class="mid"><span class="dur">${mss(r.durSec)}</span>` +
        `<div class="loc">${loc(r)}</div></span>` +
        `<span class="fare">${usd(r.fareCents)}</span>` +
        `<span class="tip">${r.tipCents ? `+${usd(r.tipCents)}` : ''}</span>`;
      list.appendChild(el);
    }
    tickTimers();
  }
  // private surface: coordinates are allowed here (never on stream)
  const loc = (r) => {
    const f = (p) => (p ? `${p.lat.toFixed(3)},${p.lng.toFixed(3)}` : '?');
    return r.pickup || r.dropoff ? `${f(r.pickup)} → ${f(r.dropoff)}` : '';
  };

  function tickTimers() {
    if (!stats) return;
    if (stats.shift.status === 'live') {
      $('homeShiftClock').textContent = hmmss((Date.now() - Date.parse(stats.shift.startedAt)) / 1000);
      const start = stats.ride?.startedAt || stats.idleStartedAt;
      $('homeStateClock').textContent = start ? mss((Date.now() - Date.parse(start)) / 1000) : '0:00';
    }
  }
  setInterval(tickTimers, 1000);

  async function sync() {
    try {
      const [s, r] = await Promise.all([
        fetch(`${API}/api/ride/stats/today`).then((x) => x.json()),
        fetch(`${API}/api/ride/rides/today?private=1`, {
          headers: { authorization: `Bearer ${token()}` },
        }).then((x) => (x.ok ? x.json() : { rides: [] })),
      ]);
      if (s.ok) { stats = s.stats; pendingRide = false; }
      if (r.rides) rides = r.rides;
      $('homeDot').classList.remove('amber');
      render();
    } catch {
      $('homeDot').classList.add('amber'); // offline — keep last data
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

  // ---- live updates over WS ----
  function connectWs() {
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); }
    catch { setTimeout(connectWs, 3000); return; }
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'snapshot' && m.data?.ride) { stats = m.data.ride.stats; render(); }
      if (['stats_tick', 'shift_started', 'ride_started', 'ride_ended', 'tip_added'].includes(m.type)) {
        stats = m.data.stats; pendingRide = false;
        if (m.type === 'ride_started' || m.type === 'ride_ended') { pulse(); sync(); }
        else render();
      }
      if (m.type === 'shift_ended') { stats = m.data.stats; lastSummary = m.data.summary; showSummary(m.data.summary); }
    };
    ws.onclose = () => setTimeout(connectWs, 2500);
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function pulse() {
    const p = $('homePulse');
    p.classList.remove('fire'); void p.offsetWidth; p.classList.add('fire');
  }

  // ---- keypads (exact cents: typing 1 2 4 7 -> $12.47; '00' appends two zeros) ----
  function keypad(container, display, onChange) {
    let cents = 0;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];
    for (const k of keys) {
      const b = document.createElement('button');
      b.textContent = k;
      b.addEventListener('click', () => {
        if (k === '⌫') cents = Math.floor(cents / 10);
        else if (k === '00') cents = cents * 100;
        else cents = cents * 10 + Number(k);
        cents = Math.min(cents, 99999);
        display.textContent = usd(cents);
        onChange(cents);
      });
      container.appendChild(b);
    }
    return { reset() { cents = 0; display.textContent = usd(0); onChange(0); } };
  }
  let fareCents = 0;
  const farePad = keypad($('fareKeypad'), $('fareDisplay'), (c) => {
    fareCents = c;
    $('btnSaveRide').disabled = c <= 0; // no-op at $0.00
  });
  let tipCents = 0;
  const tipPad = keypad($('tipKeypad'), $('tipDisplay'), (c) => {
    tipCents = c;
    $('btnApplyTip').disabled = c <= 0 || selRide == null;
  });

  // ---- actions ----
  $('btnStartShift').addEventListener('click', () => {
    enqueue('/api/ride/shift/start', {});
    toast('SHIFT STARTED');
    stats = { ...stats, shift: { status: 'live', startedAt: new Date().toISOString() }, ride: null, idleStartedAt: new Date().toISOString() };
    render();
  });

  $('btnRide').addEventListener('click', () => {
    if (!stats) return;
    if (stats.ride) {
      // end -> fare entry
      $('fareMeta').textContent = `RIDE #${stats.ride.n} · ${mss((Date.now() - Date.parse(stats.ride.startedAt)) / 1000)}`;
      farePad.reset();
      screen('s-fare');
    } else {
      pendingRide = true;
      enqueue('/api/ride/start', {});
      toast('RIDE STARTED');
      stats.ride = { n: (rides.length || 0) + 1, startedAt: new Date().toISOString() };
      stats.idleStartedAt = null;
      render();
    }
  });

  $('btnSaveRide').addEventListener('click', () => {
    enqueue('/api/ride/end', { fareCents });
    toast(`RIDE SAVED · ${usd(fareCents)}`);
    if (stats) { stats.ride = null; stats.idleStartedAt = new Date().toISOString(); }
    screen('s-home');
    render();
  });
  $('btnFareCancel').addEventListener('click', () => { screen('s-home'); });

  // tip flow
  let selRide = null;
  $('btnTip').addEventListener('click', () => {
    const done = rides.filter((r) => r.endedAt);
    if (!done.length) { toast('NO RIDES YET', true); return; }
    const cards = $('tipCards');
    cards.textContent = '';
    selRide = done[done.length - 1].id; // most recent selected by default
    for (const r of [...done].reverse().slice(0, 5)) {
      const c = document.createElement('div');
      c.className = `tip-card${r.id === selRide ? ' sel' : ''}`;
      c.innerHTML =
        `<div class="row1"><span class="n">RIDE #${r.n}</span><span class="num" style="color:var(--text2);font-size:13px">${mss(r.durSec)}</span><span class="fare">${usd(r.fareCents)}</span></div>` +
        `<div class="loc">${loc(r)}</div>`;
      c.addEventListener('click', () => {
        selRide = r.id;
        cards.querySelectorAll('.tip-card').forEach((x) => x.classList.remove('sel'));
        c.classList.add('sel');
        $('btnApplyTip').disabled = tipCents <= 0;
      });
      cards.appendChild(c);
    }
    tipPad.reset();
    screen('s-tip');
  });
  $('btnApplyTip').addEventListener('click', () => {
    enqueue('/api/ride/tip', { amountCents: tipCents, rideId: selRide });
    toast(`TIP ${usd(tipCents)} APPLIED`);
    screen('s-home');
  });
  $('btnTipCancel').addEventListener('click', () => screen('s-home'));

  $('btnEndShift').addEventListener('click', () => {
    if (stats?.ride) { toast('END THE RIDE FIRST', true); return; }
    if (!confirm('End shift?')) return;
    enqueue('/api/ride/shift/end', {});
  });

  function showSummary(sum) {
    $('sumDate').textContent = sum.dateText || '';
    $('sumEarn').textContent = usd(sum.earningsCents);
    $('sumRides').textContent = sum.rides;
    $('sumHours').textContent = hmm(sum.shiftSec);
    $('sumPace').textContent = usd(sum.paceCentsPerHr);
    const tot = sum.rideSec + sum.idleSec;
    $('sumSplit').style.width = tot ? `${(sum.rideSec / tot) * 100}%` : '0%';
    $('sumRideT').textContent = `RIDE ${hmm(sum.rideSec)}`;
    $('sumIdleT').textContent = `IDLE ${hmm(sum.idleSec)}`;
    $('sumBests').innerHTML = sum.bests
      ? `BESTS — <b>${usd(sum.bests.hourCents)}/HR · ${usd(sum.bests.dayCents)} DAY</b>` : '';
    screen('s-summary');
  }
  $('btnShare').addEventListener('click', async () => {
    const r = await fetch(`${API}/api/ride/summary/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: '{}',
    }).then((x) => x.json()).catch(() => null);
    toast(r?.ok ? 'RECAP SENT TO CHAT' : 'RESEND FAILED', !r?.ok);
  });
  $('btnCloseShift').addEventListener('click', () => { screen('s-pre'); sync(); });

  // map mode override + resend
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await fetch(`${API}/api/ride/map/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
        body: JSON.stringify({ mode: b.dataset.mode }),
      }).then((x) => x.json()).catch(() => null);
      if (r?.ok) {
        document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === b.dataset.mode));
        toast(`MAP → ${b.dataset.mode.toUpperCase()}`);
      } else toast('MAP MODE FAILED', true);
    });
  });
  $('btnResend').addEventListener('click', () => $('btnShare').click());

  // ---- boot ----
  screen('s-pre');
  updateQBadge();
  sync();
  connectWs();
  flush();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
