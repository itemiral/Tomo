import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableCanvasArea, frameCanvasBoxes } from '../src/components/muze/canvas-framing.ts';
import { parseObjects } from '../src/components/muze/storage.ts';

const project = (box, viewport) => ({ left: box.left * viewport[0] + viewport[4], top: box.top * viewport[3] + viewport[5], width: box.width * viewport[0], height: box.height * viewport[3] });
const inside = (box, area) => {
  assert.ok(box.left >= area.left - .001);
  assert.ok(box.top >= area.top - .001);
  assert.ok(box.left + box.width <= area.left + area.width + .001);
  assert.ok(box.top + box.height <= area.top + area.height + .001);
};

test('canvas framing respects the actual header, composer and toolbar boundaries', () => {
  const area = usableCanvasArea(390, 844, { headerBottom: 72, composerTop: 570, toolbarTop: 780 });
  assert.deepEqual(area, { left: 18, top: 112, width: 354, height: 442 });
  const tallToolbar = usableCanvasArea(390, 844, { headerBottom: 72, composerTop: 700, toolbarTop: 640 });
  assert.equal(tallToolbar.top + tallToolbar.height, 624);
  const initial = usableCanvasArea(390, 844);
  assert.equal(initial.top, 112);
  assert.equal(usableCanvasArea(1440, 900).top, 84, 'desktop framing keeps its existing header clearance');
  assert.ok(initial.top + initial.height <= 844 - 180, 'reserve composer space before its first mount');
});

test('a short plan fits above the composer without changing its world positions', () => {
  const area = usableCanvasArea(1440, 900, { headerBottom: 56, composerTop: 680, toolbarTop: 820 });
  const boxes = [{ left: 600, top: -200, width: 360, height: 240 }, { left: 1008, top: -200, width: 360, height: 240 }];
  const before = structuredClone(boxes), viewport = frameCanvasBoxes(boxes, area, true);
  assert.equal(viewport[0], 1);
  boxes.forEach(box => inside(project(box, viewport), area));
  assert.deepEqual(boxes, before);
});

test('a long plan opens on the readable first row instead of shrinking all its notes', () => {
  const area = usableCanvasArea(1440, 900, { composerTop: 560 });
  const boxes = Array.from({ length: 6 }, (_, index) => ({ left: index % 2 * 408, top: Math.floor(index / 2) * 900, width: 360, height: 750 }));
  const viewport = frameCanvasBoxes(boxes, area, true);
  assert.ok(viewport[0] >= .85);
  assert.equal(project(boxes[0], viewport).top, area.top);
  assert.ok(project(boxes[4], viewport).top > area.top + area.height);
  const fitAll = frameCanvasBoxes(boxes, area);
  assert.ok(fitAll[0] < viewport[0]);
  boxes.forEach(box => inside(project(box, fitAll), area));
});

test('mobile framing shows one complete note width when a saved plan has desktop columns', () => {
  const area = usableCanvasArea(390, 844, { composerTop: 590 });
  const boxes = [{ left: -1200, top: 600, width: 360, height: 260 }, { left: -792, top: 600, width: 360, height: 260 }];
  const viewport = frameCanvasBoxes(boxes, area, true);
  inside(project(boxes[0], viewport), area);
  assert.ok(viewport[0] > .9);
  assert.ok(project(boxes[1], viewport).left > area.left + area.width);
});

test('wide first sections remain horizontally visible on mobile even when taller than the available area', () => {
  const area = usableCanvasArea(390, 844, { composerTop: 500 });
  const box = { left: 2000, top: 1000, width: 720, height: 1800 };
  const viewport = frameCanvasBoxes([box], area, true), screen = project(box, viewport);
  assert.equal(screen.left, area.left);
  assert.ok(screen.left + screen.width <= area.left + area.width + .001);
  assert.equal(screen.top, area.top);
});

test('empty, invalid and zero-sized drawing bounds cannot produce an invalid viewport', () => {
  const area = usableCanvasArea(390, 844);
  assert.equal(frameCanvasBoxes([], area), null);
  assert.equal(frameCanvasBoxes([{ left: NaN, top: 0, width: 1, height: 1 }], area), null);
  assert.ok(frameCanvasBoxes([{ left: 5, top: 8, width: 0, height: 0 }], area, true).every(Number.isFinite));
});

test('new note leading is bounded on import while older drawings stay unchanged', () => {
  const legacy = { type: 'MuzeNote', text: 'Existing note', fontSize: 18 }, current = { ...legacy, muzeLeading: 1.5 };
  assert.deepEqual(parseObjects([legacy, current]), [legacy, current]);
  assert.equal(Object.hasOwn(legacy, 'muzeLeading'), false);
  for (const muzeLeading of [0, .9, 2.1, Infinity, NaN, '1.5', null]) assert.throws(() => parseObjects([{ ...legacy, muzeLeading }]));
});
