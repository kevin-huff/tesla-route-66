// nowplaying.test.js — the /api/nowplaying body normalizer must accept both our
// canonical payload and the raw Tawmae Spotify x Streamer.bot variable set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNowPlaying } from '../src/hub.js';

test('canonical payload passes through', () => {
  const np = parseNowPlaying({
    title: 'Kings of the Highway', artist: 'Chris Isaak', album: 'Heart Shaped World',
    artUrl: 'https://i.scdn.co/image/abc', durationSec: 245, progressSec: 12, playing: true,
  });
  assert.equal(np.title, 'Kings of the Highway');
  assert.equal(np.artist, 'Chris Isaak');
  assert.equal(np.artUrl, 'https://i.scdn.co/image/abc');
  assert.equal(np.durationSec, 245);
  assert.equal(np.progressSec, 12);
  assert.equal(np.playing, true);
});

test('Tawmae extension variables map: names, ms -> sec, C# bool strings', () => {
  const np = parseNowPlaying({
    trackName: 'Route 66', artists: 'Chuck Berry', albumName: 'New Juke Box Hits',
    coverImageURL: 'https://i.scdn.co/image/xyz',
    durationMs: '169000', progressMs: 47200, isPlaying: 'True',
  });
  assert.equal(np.title, 'Route 66');
  assert.equal(np.artist, 'Chuck Berry');
  assert.equal(np.album, 'New Juke Box Hits');
  assert.equal(np.artUrl, 'https://i.scdn.co/image/xyz');
  assert.equal(np.durationSec, 169);
  assert.equal(np.progressSec, 47);
  assert.equal(np.playing, true);

  assert.equal(parseNowPlaying({ trackName: 'x', isPlaying: 'False' }).playing, false);
  assert.equal(parseNowPlaying({ trackName: 'x', playing: false }).playing, false);
  assert.equal(parseNowPlaying({ trackName: 'x' }).playing, true); // omitted -> assume playing
});

test('viewer-visible fields are escaped and art URLs validated', () => {
  const np = parseNowPlaying({
    title: 'AC/DC <script>', artist: 'Tom & Jerry', coverImageURL: 'javascript:alert(1)',
  });
  assert.equal(np.title, 'AC/DC &lt;script&gt;');
  assert.equal(np.artist, 'Tom &amp; Jerry');
  assert.equal(np.artUrl, null);
});
