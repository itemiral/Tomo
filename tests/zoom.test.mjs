import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, clampViewport, MIN_ZOOM, MAX_ZOOM } from '../src/components/muze/zoom.ts';
import { parseBoardFile } from '../src/components/muze/storage.ts';

test('caps control, wheel and pinch zoom inputs at 200%, keeping the 10% minimum', () => {
  assert.equal(MAX_ZOOM, 2); assert.equal(MIN_ZOOM, .1);
  for (const value of [2, 2 * 1.2, 2 * 1.25, 2 * Math.pow(.995, -500), 2 * 500 / 100, Infinity]) {
    assert.equal(clampZoom(value), 2);
  }
  for (const value of [0, .01, .1 / 1.2, -Infinity]) assert.equal(clampZoom(value), .1);
  for (const value of [.1, .5, 1, 1.5, 2]) assert.equal(clampZoom(value), value);
});

test('clamping a legacy view preserves the world point at the screen center', () => {
  const original = [8, 0, 0, 8, -800, 400];
  const viewport = clampViewport(original, 1280, 720);
  assert.deepEqual(viewport, [2, 0, 0, 2, 280, 370]);
  assert.equal((640 - viewport[4]) / viewport[0], (640 - original[4]) / original[0]);
  assert.equal((360 - viewport[5]) / viewport[3], (360 - original[5]) / original[3]);
  assert.deepEqual(original, [8, 0, 0, 8, -800, 400]);
});

test('ordinary views retain their zoom and pan', () => {
  for (const zoom of [.1, .5, 1, 2]) {
    const viewport = [zoom, 0, 0, zoom, -80.123, 125.7];
    assert.deepEqual(clampViewport(viewport, 393, 852), viewport);
  }
});

test('older board files above 200% still open without changing their drawing data', () => {
  const board = { name: 'Legacy board', activePage: 'page', pages: [{ id: 'page', name: 'Page 1', objects: [], viewport: [8, 0, 0, 8, 10, 20] }] };
  const imported = parseBoardFile(JSON.stringify({ format: 'muze', version: 1, board }));
  assert.deepEqual(imported.pages, board.pages);
  assert.equal(clampViewport(imported.pages[0].viewport, 1280, 720)[0], 2);
});
