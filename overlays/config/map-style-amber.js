// map-style-amber.js — the cyberdeck basemap. A hand-rolled MapLibre style over
// OpenFreeMap vector tiles (OpenMapTiles schema): warm near-black ground, amber
// phosphor roads with a bloom underlay, towns as faint light-pollution blocks,
// dashed state lines, uppercase tracking on every label. "Real data, retro housing."
// Returns a style object; tile/glyph URLs come from overlay-config so they can be
// swapped for a self-hosted server without touching this file.
(function () {
  const AMBER = '#FFB000';
  const AMBER_BRIGHT = '#FFCC44';
  const AMBER_DIM = '#C08A2E';
  const BG = '#0A0806';

  window.R66_MAP_STYLE = function buildStyle({ tilesUrl, glyphsUrl }) {
    const ezoom = (stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
    const FONT = ['Noto Sans Regular'];
    return {
      version: 8,
      name: 'r66-amber-crt',
      glyphs: glyphsUrl,
      sources: { ofm: { type: 'vector', url: tilesUrl } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': BG } },

        // faint terrain texture: forests barely lift off the ground plane
        {
          id: 'landcover-wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover',
          filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
          paint: { 'fill-color': 'rgba(255,176,0,0.022)', 'fill-antialias': false },
        },
        {
          id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park',
          paint: { 'fill-color': 'rgba(255,176,0,0.025)', 'fill-antialias': false },
        },
        // settlements read as light pollution on a night flight
        {
          id: 'urban', type: 'fill', source: 'ofm', 'source-layer': 'landuse',
          filter: ['in', ['get', 'class'],
            ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail']]],
          paint: { 'fill-color': 'rgba(255,176,0,0.05)', 'fill-antialias': false },
        },

        {
          id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water',
          paint: { 'fill-color': '#040302', 'fill-outline-color': 'rgba(255,176,0,0.20)' },
        },
        {
          id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway',
          paint: { 'line-color': 'rgba(255,176,0,0.10)', 'line-width': ezoom([8, 0.5, 14, 1.6]) },
        },

        {
          id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 9, filter: ['==', ['get', 'class'], 'rail'],
          paint: {
            'line-color': 'rgba(255,176,0,0.13)',
            'line-width': ezoom([9, 0.5, 14, 1.4]),
            'line-dasharray': [3, 3],
          },
        },

        // roads: amber phosphor with a wide soft bloom under the majors
        {
          id: 'road-bloom', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
          paint: {
            'line-color': AMBER,
            'line-opacity': 0.10,
            'line-width': ezoom([5, 2.5, 10, 8, 14, 20]),
            'line-blur': 4,
          },
        },
        {
          id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 11,
          filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'street', 'tertiary']]],
          paint: {
            'line-color': AMBER,
            'line-opacity': 0.16,
            'line-width': ezoom([11, 0.5, 14, 2.2]),
          },
        },
        {
          id: 'road-mid', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 8,
          filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
          paint: {
            'line-color': AMBER,
            'line-opacity': 0.34,
            'line-width': ezoom([8, 0.5, 10, 1.4, 14, 4]),
          },
        },
        {
          id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
          paint: {
            'line-color': AMBER,
            'line-opacity': 0.58,
            'line-width': ezoom([5, 0.8, 10, 2.4, 14, 6]),
          },
        },

        // state lines dashed; the international border solid + brighter (El Paso!)
        {
          id: 'boundary-state', type: 'line', source: 'ofm', 'source-layer': 'boundary',
          filter: ['all', ['==', ['get', 'admin_level'], 4], ['==', ['get', 'maritime'], 0]],
          paint: {
            'line-color': 'rgba(255,176,0,0.30)',
            'line-width': ezoom([4, 0.8, 10, 1.8]),
            'line-dasharray': [4, 3],
          },
        },
        {
          id: 'boundary-country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
          filter: ['all', ['==', ['get', 'admin_level'], 2], ['==', ['get', 'maritime'], 0]],
          paint: {
            'line-color': 'rgba(255,196,68,0.45)',
            'line-width': ezoom([4, 1.2, 10, 2.6]),
          },
        },

        // labels — uppercase, tracked out, equipment-tag amber
        {
          id: 'place-village', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 11, filter: ['==', ['get', 'class'], 'village'],
          layout: {
            'text-font': FONT, 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
            'text-size': 10.5, 'text-transform': 'uppercase', 'text-letter-spacing': 0.18,
          },
          paint: { 'text-color': 'rgba(192,138,46,0.7)', 'text-halo-color': BG, 'text-halo-width': 1.4 },
        },
        {
          id: 'place-town', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 8.5, filter: ['==', ['get', 'class'], 'town'],
          layout: {
            'text-font': FONT, 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
            'text-size': ezoom([9, 11, 13, 13]), 'text-transform': 'uppercase', 'text-letter-spacing': 0.2,
          },
          paint: { 'text-color': AMBER_DIM, 'text-halo-color': BG, 'text-halo-width': 1.4 },
        },
        {
          id: 'place-city', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 5, filter: ['==', ['get', 'class'], 'city'],
          layout: {
            'text-font': FONT, 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
            'text-size': ezoom([5, 11, 10, 16]), 'text-transform': 'uppercase', 'text-letter-spacing': 0.22,
          },
          paint: { 'text-color': AMBER_DIM, 'text-halo-color': BG, 'text-halo-width': 1.6 },
        },
        {
          id: 'place-state', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 3, maxzoom: 7.5, filter: ['==', ['get', 'class'], 'state'],
          layout: {
            'text-font': FONT, 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
            'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.5,
          },
          paint: { 'text-color': 'rgba(192,138,46,0.5)', 'text-halo-color': BG, 'text-halo-width': 1.2 },
        },
      ],
    };
  };

  // expose the palette for the overlay's own layers (route legs, trail, marker)
  window.R66_MAP_COLORS = { AMBER, AMBER_BRIGHT, AMBER_DIM, BG };
})();
