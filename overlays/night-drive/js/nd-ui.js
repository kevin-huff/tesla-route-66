// nd-ui.js — shared Night Drive UI primitives: formatters, server-synced timers,
// the earnings odometer, panel pulses, ticker rows, and the one-at-a-time event
// card queue. Pure DOM, no framework — OBS-CEF friendly.
(function () {
  const fmt = {
    usd(cents) {
      const n = Math.abs(Math.round(cents || 0));
      return `${cents < 0 ? '-' : ''}$${Math.floor(n / 100).toLocaleString('en-US')}.${String(n % 100).padStart(2, '0')}`;
    },
    mss(sec) {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },
    hmm(sec) {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
    },
    hmmss(sec) {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    },
  };

  // ---- odometer: one vertical 0-9 strip per digit, translateY roll ----
  function createOdometer(el) {
    let shape = null; // current char layout, rebuilt when the string shape changes
    function build(str) {
      el.textContent = '';
      shape = [];
      for (const ch of str) {
        if (/\d/.test(ch)) {
          const cell = document.createElement('span');
          cell.className = 'odo-digit';
          const strip = document.createElement('span');
          strip.className = 'odo-strip';
          for (let i = 0; i <= 9; i++) {
            const d = document.createElement('span');
            d.textContent = String(i);
            strip.appendChild(d);
          }
          cell.appendChild(strip);
          el.appendChild(cell);
          shape.push({ digit: true, strip });
        } else {
          const s = document.createElement('span');
          s.className = 'odo-static';
          s.textContent = ch;
          el.appendChild(s);
          shape.push({ digit: false, ch });
        }
      }
    }
    function set(str) {
      const skeleton = str.replace(/\d/g, '0');
      const current = shape && shape.map((p) => (p.digit ? '0' : p.ch)).join('');
      if (!shape || skeleton !== current) build(str);
      let i = 0;
      const cellH = el.querySelector('.odo-strip span')?.offsetHeight || 52;
      for (const ch of str) {
        const part = shape[i++];
        if (part.digit) part.strip.style.transform = `translateY(${-Number(ch) * cellH}px)`;
      }
    }
    return { set, setCents: (c) => set(fmt.usd(c)) };
  }

  // ---- pulse: re-trigger the volt underline / glow ----
  function pulse(el) {
    if (!el) return;
    el.classList.remove('fire');
    void el.offsetWidth; // restart the animation
    el.classList.add('fire');
  }

  // ---- server-synced 1s timers ----
  // register(el, () => startedAtIso|null, fmtFn) — renders '' when inactive
  function createTimers(serverNow) {
    const regs = [];
    function register(el, getStart, format, fallback = '0:00') {
      regs.push({ el, getStart, format, fallback });
    }
    function tick() {
      for (const r of regs) {
        const start = r.getStart();
        if (!start) { r.el.textContent = r.fallback; continue; }
        r.el.textContent = r.format((serverNow() - Date.parse(start)) / 1000);
      }
    }
    setInterval(tick, 1000);
    return { register, tick };
  }

  // ---- ride ticker chips / rows ----
  function renderTicker(container, rides, { max = 3, animateNewest = false } = {}) {
    container.textContent = '';
    for (const r of rides.slice(0, max)) {
      const chip = document.createElement('div');
      chip.className = 'nd-ticker-chip';
      chip.innerHTML =
        `<span class="tk-n">#${r.n}</span>` +
        `<span class="tk-dur">${fmt.mss(r.durSec)}</span>` +
        `<span class="tk-fare">${fmt.usd(r.fareCents)}</span>` +
        (r.tipCents ? `<span class="tk-tip">+${fmt.usd(r.tipCents)} tip</span>` : '');
      container.appendChild(chip);
    }
    if (animateNewest && container.firstChild) container.firstChild.classList.add('nd-enter');
  }

  // ---- event card queue: one card at a time, collapse follow bursts ----
  function createEventCard(el, { holdMs = 6000 } = {}) {
    const labelEl = el.querySelector('.ev-label');
    const valueEl = el.querySelector('.ev-value');
    const subEl = el.querySelector('.ev-sub');
    let queue = [];
    let showing = false;
    let hideTimer = null;

    function push(card) {
      // collapse bursts of the same kind (e.g. "+3 FOLLOWERS")
      const lastQ = queue[queue.length - 1];
      if (lastQ && lastQ.kind === card.kind && card.kind === 'follow') {
        lastQ.count = (lastQ.count || 1) + 1;
        lastQ.value = `+${lastQ.count} FOLLOWERS`;
        lastQ.sub = '';
        return;
      }
      queue.push(card);
      if (queue.length > 3) queue = queue.slice(-3);
      if (!showing) next();
    }
    function next() {
      const card = queue.shift();
      if (!card) { showing = false; return; }
      showing = true;
      labelEl.textContent = card.label;
      labelEl.classList.toggle('gray', !!card.grayLabel);
      valueEl.textContent = card.value;
      valueEl.classList.toggle('white', !!card.whiteValue);
      subEl.textContent = card.sub || '';
      el.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(next, 260); // let the fade finish
      }, holdMs);
    }
    return { push };
  }

  window.ND_UI = { fmt, createOdometer, pulse, createTimers, renderTicker, createEventCard };
})();
