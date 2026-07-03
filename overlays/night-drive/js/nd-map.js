// nd-map.js — the shared Night Drive map module: one panel, three rotating
// contexts (NAV / ROUTE / HEAT), 450ms crossfade every 8s, honoring map_mode
// overrides from chat/PWA. Renders on MapLibre GL + OpenFreeMap night style when
// tiles are reachable; falls back to an abstract canvas street grid (the
// prototype look) so the module still renders standalone or tile-less in OBS.
//
// Privacy: the bridge never sends in-zone coordinates. Segments that were cut at
// the home zone arrive flagged (fadeStart/fadeEnd) and get a ~170px radial fade
// + PRIVACY label at the cut tip — never a hard clip.
(function () {
  const VOLT = '#C8F542';
  const GRAY = '#8B929A';
  const WELL = '#14171C';

  const MODES = ['nav', 'route', 'heat'];

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function attach(container, ND, opts = {}) {
    const cfg = (ND.config && ND.config.map) || {};
    const modes = opts.modes || MODES;
    const rotate = opts.rotate !== false && modes.length > 1;
    const staticMode = opts.staticMode || null; // e.g. recap thumb pins 'route'

    container.classList.add('nd-map');
    const well = el('div', 'ndm-well', container);
    const fade = el('div', 'ndm-fade', container);
    const tag = el('div', 'nd-chip ndm-tag', container);
    const dots = el('div', 'ndm-dots', container);
    for (let i = 0; i < modes.length; i++) el('span', 'ndm-dot', dots);
    const speedChip = el('div', 'nd-chip ndm-speed', container);
    const caption = el('div', 'nd-chip ndm-caption', container);
    caption.textContent = 'ALL-TIME PICKUPS';
    const privacyPatch = el('div', 'ndm-privacy', container);
    privacyPatch.innerHTML = '<span>PRIVACY</span>';
    const navMarker = el('div', 'ndm-nav', container);
    navMarker.innerHTML = '<div class="ping"></div><div class="dot"></div>';
    if (modes.length < 2) dots.style.display = 'none';

    let mode = staticMode || modes[0];
    let map = null; // maplibre instance (null => canvas fallback)
    let canvas = null;
    let ctx = null;
    let pos = null; // {lat,lng,speedMph,heading}
    let segments = [];
    let heat = null;
    let forcedUntil = 0;
    let drawAnim = null;
    let destroyed = false;

    // ---------- geometry helpers (canvas fallback + fade patch placement) ----------
    function bounds() {
      let pts = segments.flatMap((s) => s.pts);
      if (mode === 'heat' && heat?.cells?.length) pts = heat.cells.map((c) => [c.lng, c.lat]);
      if (!pts.length && pos) pts = [[pos.lng, pos.lat]];
      if (!pts.length) return null;
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const [x, y] of pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const padX = (maxX - minX || 0.01) * 0.15;
      const padY = (maxY - minY || 0.01) * 0.15;
      return [[minX - padX, minY - padY], [maxX + padX, maxY + padY]];
    }
    function projFactory(b) {
      const w = container.clientWidth, h = container.clientHeight;
      const [[minX, minY], [maxX, maxY]] = b;
      const kx = w / (maxX - minX), ky = h / (maxY - minY);
      const k = Math.min(kx, ky);
      const ox = (w - (maxX - minX) * k) / 2, oy = (h - (maxY - minY) * k) / 2;
      return ([lng, lat]) => [ox + (lng - minX) * k, h - (oy + (lat - minY) * k)];
    }

    // ---------- MapLibre renderer ----------
    function tryMaplibre() {
      if (!window.maplibregl || !window.ND_MAP_STYLE || opts.forceCanvas) return false;
      try {
        map = new maplibregl.Map({
          container: well,
          style: window.ND_MAP_STYLE({ tilesUrl: cfg.tilesUrl, glyphsUrl: cfg.glyphsUrl }),
          center: [-93.2923, 37.209],
          zoom: cfg.navZoom || 13,
          attributionControl: false,
          interactive: false,
          fadeDuration: 0,
        });
        map.on('error', () => {}); // tile hiccups: keep data layers alive
        map.on('load', () => {
          map.addSource('nd-ride', { type: 'geojson', lineMetrics: true, data: fc([]) });
          map.addSource('nd-dead', { type: 'geojson', lineMetrics: true, data: fc([]) });
          map.addSource('nd-heat', { type: 'geojson', data: fc([]) });
          map.addLayer({
            id: 'nd-dead', type: 'line', source: 'nd-dead',
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
            paint: { 'line-color': GRAY, 'line-width': 3.5, 'line-opacity': 0.75 },
          });
          map.addLayer({
            id: 'nd-ride', type: 'line', source: 'nd-ride',
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
            paint: { 'line-color': VOLT, 'line-width': 4 },
          });
          map.addLayer({
            id: 'nd-heat', type: 'heatmap', source: 'nd-heat',
            layout: { visibility: 'none' },
            paint: {
              // soft volt density blobs, no hard dots (weight floored so lone
              // pickups still read at city zoom)
              'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0.35, 1, 1],
              'heatmap-intensity': 1.6,
              'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 38, 13, 70],
              'heatmap-opacity': 0.9,
              'heatmap-color': [
                'interpolate', ['linear'], ['heatmap-density'],
                0, 'rgba(200,245,66,0)',
                0.2, 'rgba(200,245,66,0.10)',
                0.5, 'rgba(200,245,66,0.19)',
                1, 'rgba(200,245,66,0.30)',
              ],
            },
          });
          pushDataToMap(); // route/heat pulls usually finish before 'load' — replay them
          applyMode(true);
        });
        // keep the privacy patch pinned while the camera moves
        map.on('move', placePrivacyPatch);
        return true;
      } catch (e) {
        map = null;
        return false;
      }
    }
    const fc = (features) => ({ type: 'FeatureCollection', features });
    const lineFeatures = (kind) =>
      segments
        .filter((s) => s.kind === kind && s.pts.length > 1)
        .map((s) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.pts } }));

    function pushDataToMap() {
      if (!map || !map.getSource('nd-ride')) return;
      map.getSource('nd-ride').setData(fc(lineFeatures('ride')));
      map.getSource('nd-dead').setData(fc(lineFeatures('deadhead')));
      if (heat) {
        map.getSource('nd-heat').setData(fc(
          heat.cells.map((c) => ({
            type: 'Feature',
            properties: { w: heat.max ? c.n / heat.max : 0 },
            geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          })),
        ));
      }
    }

    // true draw-in: reveal line-progress 0 -> 1 over 800ms (deadhead +550ms)
    function animateDraw() {
      if (!map || !map.getLayer('nd-ride')) return;
      cancelAnimationFrame(drawAnim);
      const t0 = performance.now();
      const D = 800, DEAD_DELAY = 550;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      function frame(now) {
        const pRide = Math.min(1, (now - t0) / D);
        const pDead = Math.min(1, Math.max(0, now - t0 - DEAD_DELAY) / D);
        setReveal('nd-ride', VOLT, ease(pRide));
        setReveal('nd-dead', GRAY, ease(pDead));
        if (pRide < 1 || pDead < 1) drawAnim = requestAnimationFrame(frame);
      }
      drawAnim = requestAnimationFrame(frame);
    }
    function setReveal(layer, color, p) {
      if (!map.getLayer(layer)) return;
      const stop = Math.max(0.0001, Math.min(0.9999, p));
      map.setPaintProperty(layer, 'line-gradient', [
        'step', ['line-progress'], color, stop, 'rgba(0,0,0,0)',
      ]);
    }

    // ---------- canvas fallback renderer (abstract grid, prototype look) ----------
    function initCanvas() {
      canvas = el('canvas', 'ndm-canvas', well);
      ctx = canvas.getContext('2d');
      const fit = () => {
        canvas.width = container.clientWidth * devicePixelRatio;
        canvas.height = container.clientHeight * devicePixelRatio;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        drawCanvas(1);
      };
      fit();
      new ResizeObserver(fit).observe(container);
    }
    function drawGrid() {
      const w = container.clientWidth, h = container.clientHeight;
      ctx.fillStyle = WELL;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#232830';
      ctx.lineWidth = 1;
      for (let x = 8; x < w; x += 46) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 12; y < h; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#262C34';
      ctx.lineWidth = 4;
      for (const fx of [0.28, 0.66]) { ctx.beginPath(); ctx.moveTo(w * fx, 0); ctx.lineTo(w * fx, h); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(0, h * 0.42); ctx.lineTo(w, h * 0.42); ctx.stroke();
    }
    function drawCanvas(progress = 1) {
      if (!ctx) return;
      drawGrid();
      const b = bounds();
      if (!b) return;
      const proj = projFactory(b);
      if (mode === 'route') {
        for (const s of segments) {
          if (s.pts.length < 2) continue;
          const upto = Math.max(2, Math.ceil(s.pts.length * progress));
          ctx.beginPath();
          s.pts.slice(0, upto).forEach(([lng, lat], i) => {
            const [x, y] = proj([lng, lat]);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.lineCap = ctx.lineJoin = 'round';
          if (s.kind === 'ride') { ctx.strokeStyle = VOLT; ctx.lineWidth = 4; ctx.globalAlpha = 1; }
          else { ctx.strokeStyle = GRAY; ctx.lineWidth = 3.5; ctx.globalAlpha = 0.75; }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const lastSeg = segments[segments.length - 1];
        if (lastSeg && progress >= 1) {
          const [x, y] = proj(lastSeg.pts[lastSeg.pts.length - 1]);
          ctx.fillStyle = VOLT;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        }
      } else if (mode === 'heat' && heat) {
        for (const c of heat.cells) {
          const [x, y] = proj([c.lng, c.lat]);
          const t = heat.max ? c.n / heat.max : 0;
          const r = 40 + t * 60;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(200,245,66,${0.10 + t * 0.18})`);
          g.addColorStop(1, 'rgba(200,245,66,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    function canvasDrawIn() {
      const t0 = performance.now();
      const D = 800;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      cancelAnimationFrame(drawAnim);
      function frame(now) {
        const p = Math.min(1, (now - t0) / D);
        drawCanvas(ease(p));
        if (p < 1) drawAnim = requestAnimationFrame(frame);
      }
      drawAnim = requestAnimationFrame(frame);
    }

    // ---------- shared view logic ----------
    function headingCardinal(deg) {
      if (deg == null) return '';
      return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
    }

    function placeNavMarker() {
      if (mode !== 'nav' || !pos) { navMarker.style.display = 'none'; return; }
      navMarker.style.display = 'block';
      if (map) {
        const p = map.project([pos.lng, pos.lat]);
        navMarker.style.transform = `translate(${p.x}px, ${p.y}px)`;
      } else {
        navMarker.style.transform = `translate(${container.clientWidth / 2}px, ${container.clientHeight / 2}px)`;
      }
    }

    function placePrivacyPatch() {
      const seg = mode === 'route'
        ? segments.find((s) => s.fadeEnd) || segments.find((s) => s.fadeStart)
        : null;
      if (!seg) { privacyPatch.style.display = 'none'; return; }
      const tip = seg.fadeEnd ? seg.pts[seg.pts.length - 1] : seg.pts[0];
      let x, y;
      if (map) {
        const p = map.project(tip);
        x = p.x; y = p.y;
      } else {
        const b = bounds();
        if (!b) { privacyPatch.style.display = 'none'; return; }
        [x, y] = projFactory(b)(tip);
      }
      privacyPatch.style.display = 'block';
      privacyPatch.style.transform = `translate(${x}px, ${y}px)`;
    }

    function applyMode(initial = false) {
      tag.textContent = mode.toUpperCase();
      [...dots.children].forEach((d, i) => d.classList.toggle('on', modes[i] === mode));
      speedChip.style.display = mode === 'nav' ? '' : 'none';
      caption.style.display = mode === 'heat' ? '' : 'none';

      if (map && map.getLayer && map.getLayer('nd-ride')) {
        map.setLayoutProperty('nd-ride', 'visibility', mode === 'route' ? 'visible' : 'none');
        map.setLayoutProperty('nd-dead', 'visibility', mode === 'route' ? 'visible' : 'none');
        map.setLayoutProperty('nd-heat', 'visibility', mode === 'heat' ? 'visible' : 'none');
        const b = bounds();
        if (mode === 'nav' && pos) {
          map.jumpTo({ center: [pos.lng, pos.lat], zoom: cfg.navZoom || 13 });
        } else if (b) {
          map.fitBounds(b, { padding: 28, duration: 0 });
        }
        if (mode === 'route') animateDraw();
      } else if (ctx) {
        if (mode === 'route') canvasDrawIn();
        else drawCanvas(1);
      }
      placeNavMarker();
      placePrivacyPatch();
      if (initial) fade.style.opacity = '0';
    }

    function switchMode(next) {
      if (next === mode) return;
      fade.style.opacity = '1';
      setTimeout(() => {
        mode = next;
        applyMode();
        setTimeout(() => { fade.style.opacity = '0'; }, 60);
      }, 230);
    }

    // rotation + forced override
    let rotIdx = 0;
    if (rotate && !staticMode) {
      setInterval(() => {
        if (destroyed || Date.now() < forcedUntil) return;
        rotIdx = (modes.indexOf(mode) + 1) % modes.length;
        switchMode(modes[rotIdx]);
      }, cfg.rotateMs || 8000);
    }

    // ---------- data wiring ----------
    ND.on('telemetry', (t) => {
      if (t.lat == null) return;
      const first = !pos;
      pos = { lat: t.lat, lng: t.lng, speedMph: t.speedMph, headingDeg: t.headingDeg };
      speedChip.textContent = `${Math.round(t.speedMph || 0)} MPH · ${headingCardinal(t.headingDeg)}`;
      if (mode === 'nav' && map) {
        if (first) map.jumpTo({ center: [pos.lng, pos.lat], zoom: cfg.navZoom || 13 });
        else map.easeTo({ center: [pos.lng, pos.lat], duration: 1600, easing: (x) => x });
      }
      placeNavMarker();
    });
    if (!staticMode) {
      ND.on('map_mode', (m) => {
        if (!modes.includes(m.mode)) return;
        forcedUntil = Date.now() + (cfg.forcedHoldMs || 45000);
        switchMode(m.mode);
      });
      // late join: the snapshot carries the last forced mode (a page that loads
      // after a chat/PWA override should come up in that view)
      ND.on('ride', (d) => {
        if (d.mapMode && modes.includes(d.mapMode) && d.mapMode !== mode) switchMode(d.mapMode);
      });
    }

    async function pullRoute() {
      try {
        const demo = ND.isDemo() && window.ND_DEMO?.mapData;
        const data = demo ? window.ND_DEMO.mapData().route : await ND.fetchJson('/api/ride/map/route/today');
        segments = data.segments || [];
        pushDataToMap();
        if (mode === 'route') applyMode();
      } catch (e) { /* keep last */ }
    }
    async function pullHeat() {
      try {
        const demo = ND.isDemo() && window.ND_DEMO?.mapData;
        heat = demo ? window.ND_DEMO.mapData().heat : await ND.fetchJson('/api/ride/map/heat');
        pushDataToMap();
        if (mode === 'heat') applyMode();
      } catch (e) { /* keep last */ }
    }
    // refresh cadence + on the events that change the picture
    pullRoute(); pullHeat();
    setInterval(pullRoute, cfg.refreshRouteMs || 60000);
    setInterval(pullHeat, cfg.refreshHeatMs || 300000);
    for (const t of ['ride_started', 'ride_ended', 'shift_started']) ND.on(t, () => setTimeout(pullRoute, 800));
    ND.on('ride_ended', () => setTimeout(pullHeat, 1200));

    // ---------- boot ----------
    if (!tryMaplibre()) initCanvas();
    applyMode(true);

    return {
      setMode: (m) => switchMode(m),
      refresh: () => { pullRoute(); pullHeat(); },
      destroy: () => { destroyed = true; if (map) map.remove(); },
    };
  }

  window.ND_MAP = { attach };
})();
