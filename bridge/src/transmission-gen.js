// transmission-gen.js — LLM-driven Transmission Card. On a timer, takes the car's current
// GPS and asks a local OpenAI-compatible endpoint (e.g. clewdr) to write a transmission log
// about wherever the car is, in the show's cyberdeck / Route 66 voice. Replaces the preset
// landmark transmissions; the result is emitted through the same path the card already reads.
//
// Variety comes from two mechanisms: each call draws an ANGLE (history / lore / geology /
// music / food / ...) from a shuffle bag so every lens appears before any repeats, and the
// prompt carries the last few places covered so the model doesn't circle the same subject.
//
// Coordinates are sent straight to the model — works well with a capable backend that knows
// geography. Failures are logged and skipped (the card just holds its last frame).

import { haversine } from './geo.js';
import { kmToMi } from './units.js';
import { pad2, fmtLat, fmtLng, fmtTime } from './format.js';
import { splitHeader } from './legs.js';

const SYSTEM = `You are the onboard transmission computer for "The Kevin Show", a livestreamed Tesla road trip down Route 66 and across Texas and the American Southwest. On a timer you post a short "INCOMING TRANSMISSION" note about wherever the car currently is. Picture a friend riding shotgun who knows the area and points stuff out the window — casual, plain-spoken, a little dry, actually curious. Not a tour brochure, not a poet.

Given the car's GPS coordinates, find the most interesting real place, town, road, river, mountain, or roadside thing at or very near that location, and tell us about it through the ANGLE you are given.

Rules:
- 2 to 3 short sentences, about 30-45 words total. Lead with the concrete thing — what it is and why it's worth a look — not with a mood. Do not exceed 3 sentences.
- Talk like a person, not a brochure. Plain words. No purple prose, no grand sweeping statements, no "big sky" / "swagger" / "the road giveth" register. "There's a weird cool thing over here and here's the deal" beats "behold this legendary monument." A little dry humor is fine; don't oversell.
- Stay truthful — real places, real history. If the angle doesn't fit this location, pick the nearest angle that does rather than inventing facts.
- Local color is welcome but keep it low-key and specific. In Texas you can nod to barbecue, oil, football, or a dance hall if it actually fits the spot — just don't lay on the Lone Star pride. Outside Texas, treat the actual local state the same way; never claim a place is in Texas when it isn't.
- Stay LOCAL: the subject must be at the car's position or within about 10 miles ahead along its road. Never write about a place the car has already passed, and never about a city or landmark more than about 15 miles away — if nothing notable is that close, write about the road and the land right here instead.
- No emojis, no markdown, no hashtags, no surrounding quotation marks.
- Do not mention "coordinates", "GPS", latitude/longitude, or that you are an AI.
- If it's just open highway, write about the road itself, the landscape, or the nearest town.

Respond with ONLY a JSON object, no prose around it:
{"place": "<short UPPERCASE place name, e.g. SHAMROCK, TX>", "body": "<the transmission>"}`;

// the lens pool — drawn via shuffle bag so all angles appear before any repeats
export const ANGLES = [
  ['history', 'Point out one real piece of local history — a founding, a boom, a bust, a disaster, a famous resident, a thing that happened right here. Just the fact, told plainly.'],
  ['lore', 'Mention a local legend, ghost story, or odd bit of roadside myth tied to this stretch — note that it is a tale, do not dress it up.'],
  ['route66', 'Note something specific from Route 66 / old-road history here: a neon motel, a filling station, an old alignment, somebody who worked the Mother Road.'],
  ['land', 'Say what the land is actually doing out the window right now — the geology, a landform, a river, the weather — in concrete terms.'],
  ['culture', 'Drop a real music/film/book/art connection — a song that names this place, a movie shot here, a writer or musician who came through.'],
  ['town', 'Give a quick, grounded read on the nearest town: what it is known for, what main street is like, who actually stops here.'],
  ['food', 'Name the roadside food this area is actually known for — the diner, the dish, the pie, the barbecue, the Tex-Mex or curb-service joint.'],
  ['texana', 'Mention one concrete bit of local Texas character that fits this exact spot — a cattle or oil story, a rodeo, a dance hall, a Friday-night-lights town. Keep it specific and low-key, not boastful. Outside Texas, do the same for whatever state this actually is.'],
  ['mission', 'Give a short, matter-of-fact status read on the road ahead — terrain, conditions, the leg under way — pinned to one real local detail.'],
];

export function createTransmissionGenerator({ cfg, state, hub, route = null, emit }) {
  const tcfg = cfg.transmissions || {};
  const llm = tcfg.llm || {};
  const intervalSec = tcfg.intervalSec || 300;
  const minMoveMi = tcfg.minMoveMi ?? 3;
  const recentMax = tcfg.recentPlaces ?? 6;
  let timer = null;
  let kickoff = null;
  let last = null; // {lat,lng} of the last successful transmission
  let busy = false;
  let bag = []; // angle shuffle bag — refilled (shuffled) when empty
  const recent = []; // last few places covered, oldest first

  function moveMi(a, b) {
    return kmToMi(haversine(a.lat, a.lng, b.lat, b.lng) / 1000);
  }

  function drawAngle() {
    if (bag.length === 0) {
      bag = [...ANGLES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  }

  // Pin the model to the route corridor: the waypoint just passed and the next couple
  // ahead, with road-mile offsets from the road-path projection. Without this anchor the
  // model drifts — it writes about a town it knows 40 miles away, or one already behind
  // the car. Off the planned line (or with no geometry) it falls back to the nearest
  // waypoint as a loose anchor, and stays silent if even that is far.
  function routeContext(t) {
    if (!route) return null;
    const rp = route.roadPath;
    const distM = state.map?.routeDistM;
    const place = (lm) => splitHeader(lm.header, lm.name).place;
    if (rp && distM != null) {
      let behind = null;
      const ahead = [];
      for (const lm of route.route) {
        const d = rp.distById.get(lm.id);
        if (d == null) continue;
        const mi = kmToMi((d - distM) / 1000);
        if (mi <= 0) {
          if (!behind || mi > behind.mi) behind = { name: place(lm), mi };
        } else if (ahead.length < 2) {
          ahead.push({ name: place(lm), mi });
        }
      }
      const parts = [];
      if (behind) {
        parts.push(`the car already passed ${behind.name} (${Math.round(-behind.mi)} mi back — do not write about it or anything before it)`);
      }
      if (ahead.length) {
        parts.push(`ahead on the planned road: ${ahead.map((a) => `${a.name} in ${Math.round(a.mi)} mi`).join(', then ')}`);
      }
      if (!parts.length) return null;
      return `Route fix: ${parts.join('; ')}. Write about where the car is right now or the next few miles of road — nothing farther ahead than that, nothing behind.`;
    }
    // off-plan fallback: nearest planned waypoint by straight line, if reasonably close
    let best = null;
    for (const lm of route.route) {
      const mi = kmToMi(haversine(t.lat, t.lng, lm.lat, lm.lng) / 1000);
      if (!best || mi < best.mi) best = { name: place(lm), mi };
    }
    if (!best || best.mi > 30) return null;
    return `Route fix: the nearest planned waypoint is ${best.name}, about ${Math.round(best.mi)} mi away. Write about the car's immediate surroundings, not anywhere farther.`;
  }

  function buildUserMessage(t, angle) {
    const lines = [
      `Car position: latitude ${t.lat.toFixed(5)}, longitude ${t.lng.toFixed(5)}. ` +
        `Heading ${t.heading}, speed ${Math.round(t.speedMph)} mph, vehicle ${t.state}.`,
    ];
    const ctx = [];
    ctx.push(`Local time ${fmtTime(cfg.trip.timezone)}.`);
    const leg = state.map?.currentLeg;
    if (leg) ctx.push(`Leg ${leg} of the trip.`);
    if (t.batteryPct) ctx.push(`Battery ${t.batteryPct}%.`);
    if (t.state !== 'charging' && t.nextSc?.name && t.nextSc.mi != null) {
      ctx.push(`Next planned supercharger: ${t.nextSc.name}, ${t.nextSc.mi} mi ahead.`);
    }
    if (t.state === 'charging') {
      ctx.push('The car is docked at a charger — this place is where the crew is stretching their legs.');
    }
    lines.push(ctx.join(' '));
    const rc = routeContext(t);
    if (rc) lines.push(rc);
    lines.push(`ANGLE for this transmission: ${angle[1]}`);
    if (recent.length) {
      lines.push(
        `Recent transmissions already covered: ${recent.join('; ')}. ` +
          'Pick a different subject — do not repeat those places or topics.',
      );
    }
    lines.push('Write the transmission.');
    return lines.join('\n');
  }

  async function generate(t, angle) {
    const url = `${(llm.baseUrl || 'http://localhost:8484/v1').replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: llm.model || 'gpt-3.5-turbo',
      max_tokens: llm.maxTokens ?? 400,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserMessage(t, angle) },
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

  function buildTx(out, t, angle) {
    const place = String(out.place || 'INCOMING TRANSMISSION').toUpperCase().slice(0, 48);
    const leg = state.map?.currentLeg || 1;
    return {
      id: `llm-${Date.now()}`,
      sig: 'INCOMING TRANSMISSION',
      place,
      header: `INCOMING TRANSMISSION // ${place}`,
      body: capBody(out.body),
      type_: 'llm',
      angle: angle[0],
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
      // drivingOnly = "only while on the road": driving, or docked at a charger
      // (charging stops are content too — the arrival fires once, then the move gate holds)
      if (tcfg.drivingOnly && t.state !== 'driving' && t.state !== 'charging') {
        return { ok: false, reason: 'not-driving' };
      }
      if (last && moveMi(last, t) < minMoveMi) return { ok: false, reason: 'not-moved' };
    }
    if (busy) return { ok: false, reason: 'busy' };

    busy = true;
    try {
      const angle = drawAngle();
      const out = await generate(t, angle);
      if (!out || !out.body) return { ok: false, reason: 'empty-response' };
      const tx = buildTx(out, t, angle);
      emit(tx);
      last = { lat: t.lat, lng: t.lng };
      recent.push(tx.place);
      if (recent.length > recentMax) recent.splice(0, recent.length - recentMax);
      console.log(`[r66] transmission (llm/${angle[0]}): ${tx.place}`);
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
    _recent: () => [...recent],
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
