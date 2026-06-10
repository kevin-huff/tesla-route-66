// hub.js — the ONE network surface. A single http.Server provides:
//   - WebSocket  : envelope {type, ts, seq, data}; snapshot-on-connect; heartbeat ping
//   - REST       : /api/state, /api/logbook, /api/legs, /api/transmission/current,
//                  /healthz, POST /api/alert (Streamerbot/Twitch ingress), demo replay control
//   - static     : serves the overlays/ dir so OBS can load http://host:port/telemetry.html
// Overlays AND Streamerbot connect to the same ws://host:port and filter by `type`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// escape, then re-allow only <b>/</b> (alert kicker/detail carry intentional bold)
const allowBold = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>');

export function createHub({ config, state, store, route, replay }) {
  const startedAt = Date.now();
  let seq = 0;
  let txGen = null; // set by index.js when the LLM generator is enabled
  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });
  const health = { mqtt: 'n/a', pg: 'n/a', llm: 'n/a' };

  function envelope(type, data) {
    return JSON.stringify({ type, ts: new Date().toISOString(), seq: ++seq, data });
  }

  function snapshotData() {
    return {
      mode: state.mode,
      telemetry: state.telemetry,
      map: state.map,
      logbook: state.logbook,
      lastTransmission: state.lastTransmission,
      trail: store.get().trail || [], // breadcrumb seed for the map overlay
    };
  }

  function broadcast(type, data) {
    const msg = envelope(type, data);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  // ---- WebSocket ----
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (buf) => {
        // overlays send {type:'hello'} to request a fresh snapshot
        let m;
        try { m = JSON.parse(String(buf)); } catch { return; }
        if (m && m.type === 'hello') ws.send(envelope('snapshot', snapshotData()));
      });
      ws.send(envelope('snapshot', snapshotData())); // immediate late-join state
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
    broadcast('ping', { t: Date.now() });
  }, config.server.heartbeatMs || 10000);
  if (hb.unref) hb.unref();

  // ---- HTTP ----
  function send(res, code, type, body) {
    res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(body);
  }
  function json(res, code, obj) {
    send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    // ---- REST ----
    if (p === '/healthz') {
      return json(res, 200, {
        ok: true,
        mode: state.mode,
        mqtt: health.mqtt,
        pg: health.pg,
        llm: health.llm,
        clients: wss.clients.size,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }
    if (p === '/api/state') return json(res, 200, snapshotData());
    if (p === '/api/logbook') return json(res, 200, state.logbook);
    if (p === '/api/legs') {
      return json(res, 200, { nodes: route.nodes, legs: route.legs, totalLegs: route.totalLegs });
    }
    if (p === '/api/transmission/current') {
      return json(res, 200, state.lastTransmission || { idle: true });
    }
    if (p === '/api/transmission/show') {
      // re-show the last transmission (wire to a Twitch chat command / OBS hotkey). GET or POST.
      const tx = state.lastTransmission;
      if (!tx) return json(res, 404, { ok: false, error: 'no transmission yet' });
      broadcast('transmission', tx);
      return json(res, 200, { ok: true, tx });
    }
    if (p === '/api/transmission/generate' || p === '/api/transmission/test') {
      // force-generate a NEW LLM transmission now (ignores the driving/move gates). GET or POST.
      if (!txGen) {
        return json(res, 409, { ok: false, error: 'LLM transmissions disabled (set transmissions.source to include "llm")' });
      }
      return txGen
        .generateNow()
        .then((r) => json(res, r.ok ? 200 : 502, r))
        .catch((e) => json(res, 500, { ok: false, error: String((e && e.message) || e) }));
    }
    if (p === '/api/alert' && req.method === 'POST') {
      return readBody(req).then((b) => {
        const kind = ['follow', 'sub', 'redeem'].includes(b.kind) ? b.kind : 'follow';
        const data = {
          kind,
          kicker: allowBold(b.kicker || 'INCOMING SIGNAL'),
          name: esc(b.name || ''), // viewer-supplied -> fully escaped
          detail: allowBold(b.detail || ''),
        };
        broadcast('alert', data);
        json(res, 200, { ok: true, sent: data });
      });
    }
    // demo-only replay control
    if (p.startsWith('/api/replay/') && req.method === 'POST') {
      if (!replay) return json(res, 409, { ok: false, error: 'not in demo mode' });
      return readBody(req).then((b) => {
        if (p === '/api/replay/seek' && Number.isFinite(b.leg)) replay.seek(b.leg);
        else if (p === '/api/replay/pause') replay.pause();
        else if (p === '/api/replay/resume') replay.resume();
        else return json(res, 400, { ok: false });
        json(res, 200, { ok: true });
      });
    }

    // ---- static overlays ----
    if (req.method === 'GET') return serveStatic(p, res);
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(p, res) {
    const root = config.paths.overlays;
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(path.normalize(root))) return json(res, 403, { error: 'forbidden' });
    fs.readFile(full, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found', path: rel });
      // no-store so OBS / browsers never serve a stale overlay after an edit
      res.writeHead(200, {
        'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      res.end(buf);
    });
  }

  function listen() {
    return new Promise((resolve) => {
      server.listen(config.server.port, config.server.host, () => resolve());
    });
  }

  return {
    listen,
    broadcast,
    setHealth: (patch) => Object.assign(health, patch),
    setTransmissionGenerator: (g) => { txGen = g; },
    clientCount: () => wss.clients.size,
    close: () => { clearInterval(hb); wss.close(); server.close(); },
  };
}
