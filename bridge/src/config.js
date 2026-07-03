// config.js — load + validate + merge defaults <- config.json <- env.
// Demo runs out of the box: if config.json is absent we use config.example.json,
// so `npm run demo` works with zero setup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.join(SRC_DIR, '..');

function loadEnvFile() {
  const envPath = path.join(BRIDGE_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function loadConfig() {
  loadEnvFile();

  const examplePath = path.join(BRIDGE_ROOT, 'config.example.json');
  const userPath = path.join(BRIDGE_ROOT, 'config.json');

  const base = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  let cfg = base;
  let source = 'config.example.json (built-in defaults)';
  if (fs.existsSync(userPath)) {
    cfg = deepMerge(base, JSON.parse(fs.readFileSync(userPath, 'utf8')));
    source = 'config.json';
  }

  // env overrides (env always wins; keeps creds out of the committed file)
  const env = process.env;
  if (env.R66_MODE) cfg.mode = env.R66_MODE;
  if (env.R66_PORT) cfg.server.port = Number(env.R66_PORT);
  if (env.R66_PG_PASSWORD) cfg.postgres.password = env.R66_PG_PASSWORD;
  if (env.R66_MQTT_USERNAME) cfg.mqtt.username = env.R66_MQTT_USERNAME;
  if (env.R66_MQTT_PASSWORD) cfg.mqtt.password = env.R66_MQTT_PASSWORD;
  if (cfg.transmissions?.llm) {
    if (env.R66_LLM_BASE_URL) cfg.transmissions.llm.baseUrl = env.R66_LLM_BASE_URL;
    if (env.R66_LLM_API_KEY) cfg.transmissions.llm.apiKey = env.R66_LLM_API_KEY;
    if (env.R66_LLM_MODEL) cfg.transmissions.llm.model = env.R66_LLM_MODEL;
  }
  if (cfg.ride && env.R66_RIDE_TOKEN) cfg.ride.authToken = env.R66_RIDE_TOKEN;

  // night-demo: ride-tracker city simulation (Night Drive suite) instead of the Route 66 replay
  if (cfg.mode !== 'demo' && cfg.mode !== 'live' && cfg.mode !== 'night-demo') {
    throw new Error(`config.mode must be "demo", "live", or "night-demo" (got "${cfg.mode}")`);
  }

  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(BRIDGE_ROOT, p));
  cfg.paths = {
    landmarks: resolve(cfg.trip.landmarksPath),
    legs: resolve(cfg.trip.legsPath),
    routeGeometry: resolve(cfg.trip.routeGeometryPath || '../config/route-geometry.json'),
    overlays: resolve(cfg.server.overlaysDir),
    state: path.join(BRIDGE_ROOT, 'data', 'state.json'),
  };
  cfg._source = source;
  return cfg;
}
