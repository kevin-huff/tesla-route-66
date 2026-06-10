// transmission-gen.js — LLM-driven Transmission Card. On a timer, takes the car's current
// GPS and asks a local OpenAI-compatible endpoint (e.g. clewdr) to write a transmission log
// about wherever the car is, in the show's cyberdeck / Route 66 voice. Replaces the preset
// landmark transmissions; the result is emitted through the same path the card already reads.
//
// Coordinates are sent straight to the model — works well with a capable backend that knows
// geography. Failures are logged and skipped (the card just holds its last frame).

import { haversine } from './geo.js';
import { kmToMi } from './units.js';
import { pad2, fmtLat, fmtLng, fmtTime } from './format.js';

const SYSTEM = `You are the onboard transmission computer for "The Kevin Show", a livestreamed Tesla road trip down Route 66 and the American Southwest. You write short "INCOMING TRANSMISSION" log entries about wherever the car currently is — the voice is retro-futurist cyberdeck crossed with Apollo-era mission control and Route 66 roadside Americana: warm, a little worn, optimistic, analog-future not clinical sci-fi.

Given the car's GPS coordinates, identify the most interesting real place, town, road, river, mountain, or roadside landmark at or very near that location, and write a transmission about it.

Rules:
- 2 to 3 short sentences, about 35-55 words total. Concrete local detail, history, or roadside lore. Terse and evocative. Do not exceed 3 sentences.
- No emojis, no markdown, no hashtags, no surrounding quotation marks.
- Do not mention "coordinates", "GPS", latitude/longitude, or that you are an AI.
- If it's just open highway, write about the road itself, the landscape, or the nearest town.

Respond with ONLY a JSON object, no prose around it:
{"place": "<short UPPERCASE place name, e.g. SHAMROCK, TX>", "body": "<the transmission>"}`;

export function createTransmissionGenerator({ cfg, state, hub, emit }) {
  const tcfg = cfg.transmissions || {};
  const llm = tcfg.llm || {};
  const intervalSec = tcfg.intervalSec || 300;
  const minMoveMi = tcfg.minMoveMi ?? 3;
  let timer = null;
  let kickoff = null;
  let last = null; // {lat,lng} of the last successful transmission
  let busy = false;

  function moveMi(a, b) {
    return kmToMi(haversine(a.lat, a.lng, b.lat, b.lng) / 1000);
  }

  async function generate(t) {
    const url = `${(llm.baseUrl || 'http://localhost:8484/v1').replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: llm.model || 'gpt-3.5-turbo',
      max_tokens: llm.maxTokens ?? 400,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `Car position: latitude ${t.lat.toFixed(5)}, longitude ${t.lng.toFixed(5)}. ` +
            `Heading ${t.heading}, speed ${Math.round(t.speedMph)} mph, vehicle ${t.state}. ` +
            `Write the transmission.`,
        },
      ],
    };
    // Some models (newer Claude) reject `temperature` ("deprecated for this model").
    // Only send it when explicitly set to a number; otherwise let the model default.
    if (typeof llm.temperature === 'number') payload.temperature = llm.temperature;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), llm.timeoutMs || 30000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status} ${text}`.slice(0, 200));
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    hub.setHealth?.({ llm: 'ok' });
    return parseTransmission(content);
  }

  function buildTx(out, t) {
    const place = String(out.place || 'INCOMING TRANSMISSION').toUpperCase().slice(0, 48);
    const leg = state.map?.currentLeg || 1;
    return {
      id: `llm-${Date.now()}`,
      sig: 'INCOMING TRANSMISSION',
      place,
      header: `INCOMING TRANSMISSION // ${place}`,
      body: capBody(out.body),
      type_: 'llm',
      lat: t.lat,
      lng: t.lng,
      latText: fmtLat(t.lat),
      lngText: fmtLng(t.lng),
      leg,
      legLabel: `LEG ${pad2(leg)} · ${place}`,
      timeText: fmtTime(cfg.trip.timezone),
      signal: 5,
      radiusM: 0,
    };
  }

  // force=true bypasses the driving/move gates (manual test trigger). Returns a result
  // object describing what happened, so the test endpoint can report it.
  async function run({ force = false } = {}) {
    const t = state.telemetry;
    if (t.lat == null || t.lng == null) return { ok: false, reason: 'no-position' };
    if (!force) {
      if (tcfg.drivingOnly && t.state !== 'driving') return { ok: false, reason: 'not-driving' };
      if (last && moveMi(last, t) < minMoveMi) return { ok: false, reason: 'not-moved' };
    }
    if (busy) return { ok: false, reason: 'busy' };

    busy = true;
    try {
      const out = await generate(t);
      if (!out || !out.body) return { ok: false, reason: 'empty-response' };
      const tx = buildTx(out, t);
      emit(tx);
      last = { lat: t.lat, lng: t.lng };
      console.log(`[r66] transmission (llm): ${tx.place}`);
      return { ok: true, tx };
    } catch (e) {
      hub.setHealth?.({ llm: 'error' });
      console.error('[r66] transmission llm failed:', e.message);
      return { ok: false, error: e.message };
    } finally {
      busy = false;
    }
  }

  const tick = () => run({ force: false });

  return {
    start() {
      const kickoffSec = tcfg.kickoffSec ?? 20; // one shortly after boot, then on interval
      kickoff = setTimeout(tick, kickoffSec * 1000);
      timer = setInterval(tick, intervalSec * 1000);
      if (kickoff.unref) kickoff.unref();
      if (timer.unref) timer.unref();
    },
    stop() {
      clearTimeout(kickoff);
      clearInterval(timer);
    },
    tick, // scheduled path (respects gates) — also used by tests
    generateNow: () => run({ force: true }), // manual test trigger (ignores gates)
    _setLast: (v) => { last = v; },
  };
}

// Safety net: keep a transmission body short enough to fit the card even if the model runs
// long. Trim to the last full sentence before `max`, else the last word, with no mid-word cut.
export function capBody(s, max = 360) {
  const str = String(s).trim();
  if (str.length <= max) return str;
  const slice = str.slice(0, max);
  const end = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (end > max * 0.5) return slice.slice(0, end + 1).trim();
  const space = slice.lastIndexOf(' ');
  return `${(space > 0 ? slice.slice(0, space) : slice).trim()}…`;
}

// Pull {place, body} out of the model's reply. Tolerates code fences and stray prose by
// extracting the first JSON object; falls back to using the whole reply as the body.
export function parseTransmission(content) {
  const s = String(content).trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && (obj.body || obj.place)) return { place: obj.place || null, body: obj.body || '' };
    } catch {
      /* fall through */
    }
  }
  const cleaned = s.replace(/^```[a-z]*\n?|```$/g, '').trim();
  return { place: null, body: cleaned };
}
