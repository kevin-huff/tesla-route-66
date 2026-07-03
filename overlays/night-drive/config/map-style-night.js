// map-style-night.js — the Night Drive basemap. MapLibre style over OpenFreeMap
// vector tiles (OpenMapTiles schema), tuned to the token palette: well #14171C
// ground, roads in the #232830–#262C34 band, water near-black, sparse labels no
// brighter than #8B929A. Muted on purpose — the volt data layers are the subject.
(function () {
  const WELL = '#14171C';
  const DEEP = '#0E1013';
  const GRID = '#232830';
  const AVENUE = '#262C34';
  const LABEL = '#8B929A';

  window.ND_MAP_STYLE = function buildStyle({ tilesUrl, glyphsUrl }) {
    const ezoom = (stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
    const FONT = ['Noto Sans Regular'];
    return {
      version: 8,
      name: 'nd-night-drive',
      glyphs: glyphsUrl,
      sources: { ofm: { type: 'vector', url: tilesUrl } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': WELL } },
        {
          id: 'landuse-park', type: 'fill', source: 'ofm', 'source-layer': 'park',
          paint: { 'fill-color': 'rgba(200,245,66,0.016)', 'fill-antialias': false },
        },
        {
          id: 'landuse-urban', type: 'fill', source: 'ofm', 'source-layer': 'landuse',
          filter: ['in', ['get', 'class'],
            ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail']]],
          paint: { 'fill-color': 'rgba(255,255,255,0.014)', 'fill-antialias': false },
        },
        {
          id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water',
          paint: { 'fill-color': DEEP },
        },
        {
          id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway',
          paint: { 'line-color': DEEP, 'line-width': ezoom([8, 0.6, 14, 2]) },
        },
        {
          id: 'aeroway', type: 'line', source: 'ofm', 'source-layer': 'aeroway',
          minzoom: 10,
          paint: { 'line-color': GRID, 'line-width': ezoom([10, 1, 14, 4]) },
        },
        {
          id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 11, filter: ['==', ['get', 'class'], 'rail'],
          paint: {
            'line-color': 'rgba(42,46,51,0.7)',
            'line-width': ezoom([11, 0.5, 14, 1.2]),
            'line-dasharray': [3, 3],
          },
        },
        // roads — the quiet grid
        {
          id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 11,
          filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'street', 'tertiary']]],
          paint: { 'line-color': GRID, 'line-width': ezoom([11, 0.6, 14, 2.4, 16, 5]) },
        },
        {
          id: 'road-secondary', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          minzoom: 9,
          filter: ['in', ['get', 'class'], ['literal', ['secondary', 'primary']]],
          paint: { 'line-color': AVENUE, 'line-width': ezoom([9, 0.8, 12, 2.4, 15, 6]) },
        },
        {
          id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation',
          filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
          paint: { 'line-color': '#2C333C', 'line-width': ezoom([6, 0.8, 10, 2.6, 14, 7]) },
        },
        // labels — sparse, tracked, never brighter than text-secondary
        {
          id: 'place-town', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 8,
          filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
          layout: {
            'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name']]],
            'text-font': FONT,
            'text-size': ezoom([8, 9.5, 12, 12]),
            'text-letter-spacing': 0.18,
            'text-padding': 14,
          },
          paint: { 'text-color': LABEL, 'text-halo-color': WELL, 'text-halo-width': 1.4 },
        },
        {
          id: 'place-hood', type: 'symbol', source: 'ofm', 'source-layer': 'place',
          minzoom: 12,
          filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter']]],
          layout: {
            'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name']]],
            'text-font': FONT,
            'text-size': 10,
            'text-letter-spacing': 0.22,
            'text-padding': 18,
          },
          paint: { 'text-color': 'rgba(139,146,154,0.65)', 'text-halo-color': WELL, 'text-halo-width': 1.2 },
        },
      ],
    };
  };
})();
