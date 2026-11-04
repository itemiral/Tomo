import assert from 'node:assert/strict';
import test from 'node:test';
import { personalMuseError } from '../src/lib/muse-error.ts';

test('operational errors address the saved companion without changing provider names', () => {
  assert.equal(personalMuseError('Muse could not prepare this lookup. Try again.', 'Kumo'), 'Kumo could not prepare this lookup. Try again.');
  assert.equal(personalMuseError('Could not reach Muse. Try again.', 'Kumo'), 'Could not reach Kumo. Try again.');
  assert.equal(personalMuseError('Use a smaller image for Muse to inspect.', 'Kumo'), 'Use a smaller image for Kumo to inspect.');
  assert.equal(personalMuseError('Muse’s context budget is not configured correctly.', 'Kumo'), 'Kumo’s context budget is not configured correctly.');
  for (const message of ['Muse Image returned no usable image.', 'Muse Spark is unavailable.', 'The Muse API is unavailable.', 'The Muse service could not authenticate.', 'The Muse token counter is not configured correctly.']) {
    assert.equal(personalMuseError(message, 'Kumo'), message);
  }
});

test('saved names are inserted literally and neutral or default errors stay unchanged', () => {
  const message = 'Muse could not complete this response. Try again.';
  for (const name of ['Kumo $&', '$` $\u0027 $$', 'みずき', 'Little Muse']) {
    assert.equal(personalMuseError(message, name), name + ' could not complete this response. Try again.');
  }
  assert.equal(personalMuseError(message, 'Muse'), message);
  assert.equal(personalMuseError(message, '   '), message);
  assert.equal(personalMuseError('This board changed elsewhere. Reload before saving.', 'Kumo'), 'This board changed elsewhere. Reload before saving.');
});
