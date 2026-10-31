import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_STEP, gridPattern } from '../src/components/muze/grid.ts';

test('grid stays sparse enough to avoid moire throughout the supported zoom range', () => {
  for (const zoom of [.1, .125, .2, .39, .5, .79, 1, 1.2, 2, 4, 8]) {
    const grid = gridPattern(zoom, 0, 0);
    assert.ok(grid.spacing >= 16);
    assert.equal((grid.spacing / zoom) % GRID_STEP, 0);
  }
});

test('grid dots remain anchored to the snapping origin through fractional and negative pan', () => {
  for (const zoom of [.1, .6, 1, 1.2, 3.7, 8]) {
    for (const pan of [-10000.25, -30, 0, 100.7, 10000]) {
      const { spacing, x, y } = gridPattern(zoom, pan, -pan);
      const distance = (position, translate) => (position + spacing / 2 - translate) / spacing;
      assert.ok(Math.abs(distance(x, pan) - Math.round(distance(x, pan))) < 1e-8);
      assert.ok(Math.abs(distance(y, -pan) - Math.round(distance(y, -pan))) < 1e-8);
    }
  }
});
