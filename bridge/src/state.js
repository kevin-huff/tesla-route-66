// state.js — the single in-memory source of truth the hub serves as snapshots.
// The pipeline mutates these objects in place; the hub reads them for `snapshot`.

export function createState(mode, totalLegs = 6) {
  return {
    mode,
    telemetry: {
      batteryPct: 0,
      usableBatteryPct: 0,
      rangeMi: 0,
      speedMph: 0,
      heading: 'N',
      headingDeg: 0,
      cabinF: 0,
      outsideF: 0,
      lat: null,
      lng: null,
      state: 'offline',
      pluggedIn: false,
      chargerKw: 0,
      battSegments: 0,
      warn: false,
      statusText: 'ALL SYSTEMS NOMINAL',
    },
    map: {
      currentLeg: 1,
      totalLegs,
      legStatus: Array(totalLegs).fill('future'),
      vehicle: { svgX: 0, svgY: 0, lat: null, lng: null, onLeg: 1, progress: 0 },
      nextWaypoint: { name: '', tag: '' },
      distToNextMi: 0,
      etaText: '--:--',
      standby: { active: false, node: null },
    },
    logbook: {
      states: 0,
      superchargers: 0,
      miles: 0,
      stationsBypassed: 0,
      elevationFt: 0,
      legsDone: 0,
      totalLegs,
      routePct: 0,
      waypoints: 0,
      totalWaypoints: 0,
      days: 0,
      kwhCharged: 0,
      gasSaved: 0,
      driveHrs: 0,
      chargeHrs: 0,
    },
    lastTransmission: null,
    nowPlaying: null, // Spotify via Streamer.bot POST /api/nowplaying
  };
}
