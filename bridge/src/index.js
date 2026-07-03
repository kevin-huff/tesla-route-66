// index.js — boot only. Loads config + route + persisted state, picks a source
// (demo replay by default, live TeslaMate when mode=live, city ride simulation
// when mode=night-demo), wires it through the pipeline, and starts the hub.
// All processing lives in pipeline.js; ride-shift tracking in ride/tracker.js.

import path from 'node:path';
import { loadConfig } from './config.js';
import { loadRoute } from './legs.js';
import { createState } from './state.js';
import { createStore } from './persistence.js';
import { createHub } from './hub.js';
import { createPipeline } from './pipeline.js';
import { createReplaySource } from './sources/replay-source.js';
import { buildRoadPath, loadGeometry } from './road-path.js';

async function main() {
  const cfg = loadConfig();
  const route = loadRoute({ legsPath: cfg.paths.legs, landmarksPath: cfg.paths.landmarks });

  // real road geometry (committed; regen via scripts/fetch-route-geometry.mjs).
  // Powers the road-following demo replay + road-accurate dist-to-next on the map.
  const geo = loadGeometry(cfg.paths.routeGeometry);
  const roadPath = buildRoadPath(route.route, geo);
  route.attachRoadPath(roadPath);

  // demo modes persist to their own files so a demo run never contaminates real state
  const isDemoish = cfg.mode !== 'live';
  const stateFile = isDemoish
    ? path.join(path.dirname(cfg.paths.state), 'demo-state.json')
    : cfg.paths.state;

  const store = createStore(stateFile, route.totalLegs);
  const state = createState(cfg.mode, route.totalLegs);

  console.log(`[r66] mode=${cfg.mode}  config=${cfg._source}`);
  console.log(`[r66] state ${stateFile} ${store.wasCreated() ? '(created)' : '(loaded)'}`);

  // ---- Night Drive ride tracker (shifts / rides / tips; overlays + PWA + Streamerbot) ----
  let ride = null;
  let tracker = null;
  if (cfg.ride?.enabled !== false && cfg.ride) {
    const { createJsonRideStore } = await import('./ride/json-store.js');
    const { createRideTracker } = await import('./ride/tracker.js');
    const { createRideRoutes } = await import('./ride/routes.js');

    // night-demo: give the demo a visible privacy zone if none is configured
    if (cfg.mode === 'night-demo' && cfg.ride.privacy?.lat == null && cfg.ride.demo?.home) {
      cfg.ride.privacy = { ...cfg.ride.demo.home, radiusM: cfg.ride.privacy?.radiusM ?? 800 };
    }

    let rideStore = null;
    const wantPg = cfg.ride.storage === 'pg' || (cfg.ride.storage === 'auto' && cfg.mode === 'live');
    if (wantPg) {
      try {
        const { createPgRideStore } = await import('./ride/pg-store.js');
        rideStore = await createPgRideStore({ postgres: cfg.postgres, schema: cfg.ride.pgSchema });
        await rideStore.init();
        console.log(`[ride] store: postgres (schema ${cfg.ride.pgSchema})`);
      } catch (e) {
        if (cfg.ride.storage === 'pg') throw e; // explicitly requested — fail loud
        console.warn(`[ride] postgres unavailable (${e.message}) — falling back to JSON store`);
      }
    }
    if (!rideStore) {
      const rideFile = path.join(
        path.dirname(cfg.paths.state),
        isDemoish ? 'demo-ride-tracker.json' : 'ride-tracker.json',
      );
      rideStore = createJsonRideStore(rideFile);
      await rideStore.init();
      console.log(`[ride] store: json (${rideFile})`);
    }

    if (cfg.mode === 'night-demo') {
      const { seedDemoHistory } = await import('./ride/night-demo.js');
      if (await seedDemoHistory(rideStore, cfg.ride.demo)) {
        console.log('[ride] seeded 60 days of demo pickup history (HEAT view)');
      }
    }

    tracker = await createRideTracker({ cfg, store: rideStore });
    ride = { tracker, routes: createRideRoutes({ tracker, cfg }) };
    if (!ride.routes.authEnabled) {
      console.warn('[ride] REST auth DISABLED (set ride.authToken / R66_RIDE_TOKEN before exposing the PWA)');
    }
    if (tracker.zone.enabled) {
      console.log(`[ride] privacy zone active (r=${tracker.zone.radiusM}m) — in-zone coords never reach overlays`);
    } else if (cfg.mode === 'live') {
      console.warn('[ride] privacy zone NOT configured (ride.privacy) — stream map will show home area');
    }
  }

  console.log(`[r66] route: ${route.totalLegs} legs, ${route.route.length} landmarks`);
  console.log(
    geo
      ? `[r66] road geometry: real roads, ${geo.totalMi} mi (${roadPath.pts.length} pts)`
      : '[r66] road geometry: NOT FOUND — straight-line fallback (run scripts/fetch-route-geometry.mjs)',
  );

  let source;
  let hub;
  let pipeline = null;

  if (cfg.mode === 'live') {
    hub = createHub({ config: cfg, state, store, route, replay: null, ride });
    pipeline = createPipeline({ cfg, route, store, state, hub, privacyZone: tracker?.zone });
    const { startLiveSources } = await import('./sources/mqtt-source.js');
    const onTick = (snap) => {
      pipeline.processTick(snap);
      tracker?.onTelemetry(snap);
    };
    source = await startLiveSources({ cfg, route, store, hub, onTick });
  } else if (cfg.mode === 'night-demo') {
    // Night Drive city simulation — no Route 66 replay/pipeline; the demo drives
    // the tracker + telemetry channel directly
    hub = createHub({ config: cfg, state, store, route, replay: null, ride });
    const { createNightDemo } = await import('./ride/night-demo.js');
    source = createNightDemo({ cfg, tracker, hub, state });
  } else {
    source = createReplaySource({ route, store, config: cfg, roadPath });
    hub = createHub({ config: cfg, state, store, route, replay: source, ride });
    pipeline = createPipeline({ cfg, route, store, state, hub, privacyZone: tracker?.zone });
    source.on('telemetry', (snap) => {
      pipeline.processTick(snap);
      tracker?.onTelemetry(snap);
    });
    source.on('loop', pipeline.onLoopReset);
  }

  tracker?.setBroadcast(hub.broadcast);

  await hub.listen();
  console.log(
    `[r66] hub listening on http://${cfg.server.host}:${cfg.server.port}  (ws + rest + overlays)`,
  );
  if (cfg.mode === 'night-demo') {
    console.log(`[nd] Night Drive: http://localhost:${cfg.server.port}/night-drive/rail.html  (data.html · recap.html)`);
    console.log(`[nd] PWA dashboard: http://localhost:${cfg.server.port}/night-drive/dash/`);
  } else {
    console.log(`[r66] OBS sources: http://localhost:${cfg.server.port}/telemetry.html?embed  (etc.)`);
  }

  if (source.start) source.start();

  // LLM-driven Transmission Card — replaces the preset landmark transmissions when
  // transmissions.source includes "llm" (geofences still drive legs / logbook / events).
  const txSource = cfg.transmissions?.source || 'geofence';
  let txGen = null;
  if (pipeline && (txSource === 'llm' || txSource === 'both')) {
    const { createTransmissionGenerator } = await import('./transmission-gen.js');
    txGen = createTransmissionGenerator({ cfg, state, hub, route, emit: pipeline.emitTransmission });
    hub.setTransmissionGenerator(txGen); // enables POST /api/transmission/test
    txGen.start();
    console.log(
      `[r66] transmissions: LLM (${cfg.transmissions.llm?.baseUrl}) every ${cfg.transmissions.intervalSec || 300}s`,
    );
  }

  const shutdown = () => {
    try { txGen?.stop(); tracker?.stop(); source.stop?.(); store.flush(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[r66] fatal:', err);
  process.exit(1);
});
