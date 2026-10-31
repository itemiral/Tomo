import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaveFeedback } from '../src/components/muze/save-feedback.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [], errors = [];
  const feedback = createSaveFeedback(value => states.push(value), () => errors.push('failed'));
  t.after(() => feedback.dispose());
  return { feedback, states, errors };
}

test('writes immediately and keeps fast saves steady, without a late Saving flash', async t => {
  const { feedback, states } = setup(t);
  let writes = 0;
  await feedback.track(() => { writes++; return Promise.resolve(); }, 'a');
  assert.equal(writes, 1);
  t.mock.timers.tick(10000);
  assert.ok(states.every(value => value === 'Saved on this device'));
});

test('shows Saving only after 2.5 seconds, then clears it on completion', async t => {
  const { feedback, states } = setup(t), save = deferred();
  const done = feedback.track(() => save.promise, 'a');
  t.mock.timers.tick(2499);
  assert.equal(states.at(-1), 'Saved on this device');
  t.mock.timers.tick(1);
  assert.equal(states.at(-1), 'Saving…');
  save.resolve(); await done;
  assert.equal(states.at(-1), 'Saved on this device');
});

test('continuous changes do not postpone slow-save feedback or accept stale completion', async t => {
  const { feedback, states } = setup(t), first = deferred(), last = deferred();
  const a = feedback.track(() => first.promise, 'a');
  t.mock.timers.tick(2000);
  const b = feedback.track(() => last.promise, 'a');
  first.resolve(); await a;
  t.mock.timers.tick(500);
  assert.equal(states.at(-1), 'Saving…');
  last.resolve(); await b;
  assert.equal(states.at(-1), 'Saved on this device');
});

test('switching boards resets the timer and old writes cannot change new feedback', async t => {
  const { feedback, states } = setup(t), first = deferred(), second = deferred();
  const a = feedback.track(() => first.promise, 'a');
  t.mock.timers.tick(2400);
  const b = feedback.track(() => second.promise, 'b');
  t.mock.timers.tick(100);
  assert.equal(states.at(-1), 'Saved on this device');
  second.resolve(); await b;
  const count = states.length;
  first.reject(new Error('superseded snapshot')); await a;
  t.mock.timers.tick(5000);
  assert.equal(states.length, count);
});

test('errors appear immediately and stay visible until a successful retry', async t => {
  const { feedback, states, errors } = setup(t);
  await feedback.track(() => Promise.reject(new Error('disk full')), 'a');
  assert.equal(states.at(-1), 'Not saved'); assert.equal(errors.length, 1);
  const save = deferred(), done = feedback.track(() => save.promise, 'b');
  t.mock.timers.tick(5000);
  assert.equal(states.at(-1), 'Not saved');
  save.resolve(); await done;
  assert.equal(states.at(-1), 'Saved on this device');
});

test('synchronous storage failure is reported and unmount cancels feedback', async t => {
  const { feedback, states, errors } = setup(t);
  await feedback.track(() => { throw new Error('database closed'); }, 'a');
  assert.equal(errors.length, 1);
  const save = deferred(), done = feedback.track(() => save.promise, 'a');
  feedback.dispose(); const count = states.length;
  t.mock.timers.tick(10000); save.resolve(); await done;
  assert.equal(states.length, count);
});
