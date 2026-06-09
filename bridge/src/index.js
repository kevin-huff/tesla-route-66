// index.js — boot only. Loads config + route + persisted state, picks a source
// (demo replay by default, live TeslaMate when mode=live), wires it through the
// pipeline, and starts the hub. All processing lives in pipeline.js.

import path from 'node:path';
import { loadConfig } from './config.js';
import { loadRoute } from './legs.js';
import { createState } from './state.js';
import { createStore } from './persistence.js';
import { createHub } from './hub.js';
import { createPipeline } from './pipeline.js';
import { createReplaySource } from './sources/replay-source.js';

async function main() {
  const cfg = loadConfig();
  const route = loadRoute({ legsPath: cfg.paths.legs, landmarksPath: cfg.paths.landmarks });

  // demo persists to its own file so a demo run never contaminates real trip state
  const stateFile =
    cfg.mode === 'demo'
      ? path.join(path.dirname(cfg.paths.state), 'demo-state.json')
      : cfg.paths.state;

  const store = createStore(stateFile, route.totalLegs);
  const state = createState(cfg.mode, route.totalLegs);

  console.log(`[r66] mode=${cfg.mode}  config=${cfg._source}`);
  console.log(`[r66] state ${stateFile} ${store.wasCreated() ? '(created)' : '(loaded)'}`);
  console.log(`[r66] route: ${route.totalLegs} legs, ${route.route.length} landmarks`);

  let source;
  let hub;
  let pipeline;

  if (cfg.mode === 'live') {
    hub = createHub({ config: cfg, state, store, route, replay: null });
    pipeline = createPipeline({ cfg, route, store, state, hub });
    const { startLiveSources } = await import('./sources/mqtt-source.js');
    source = await startLiveSources({ cfg, route, store, hub, onTick: pipeline.processTick });
  } else {
    source = createReplaySource({ route, store, config: cfg });
    hub = createHub({ config: cfg, state, store, route, replay: source });
    pipeline = createPipeline({ cfg, route, store, state, hub });
    source.on('telemetry', pipeline.processTick);
    source.on('loop', pipeline.onLoopReset);
  }

  await hub.listen();
  console.log(
    `[r66] hub listening on http://${cfg.server.host}:${cfg.server.port}  (ws + rest + overlays)`,
  );
  console.log(`[r66] OBS sources: http://localhost:${cfg.server.port}/telemetry.html?embed  (etc.)`);

  if (source.start) source.start();

  const shutdown = () => { try { store.flush(); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[r66] fatal:', err);
  process.exit(1);
});
