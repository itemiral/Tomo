import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonalization, selectPersonalizationContext } from '../src/server/muse/personalization.ts';

const update = (values = {}) => ({ key: 'detail', target: 'soul', scope: 'owner', text: 'Keep replies concise.', evidence: 'I prefer concise replies', operation: 'upsert', ...values });

test('learning uses an exact quote from the current owner, not board or earlier conversation', () => {
  assert.equal(parsePersonalization({ updates: [update()] }, 'I prefer concise replies.').updates.length, 1);
  assert.deepEqual(parsePersonalization({ updates: [update()] }, 'Summarize these shared notes.'), { updates: [] });
  assert.deepEqual(parsePersonalization({ updates: [update({ evidence: 'prefer' })] }, 'Please explain.'), { updates: [] });
});

test('style learning is limited to supported personal facets', () => {
  const input = { updates: [update({ key: 'permissions' }), update({ scope: 'board' }), update({ key: 'identity' }), update({ key: 'tone', text: 'Use a relaxed voice.' })] };
  assert.deepEqual(parsePersonalization(input, 'I prefer concise replies').updates.map(item => item.key), ['tone']);
});

test('corrections keep stable keys and forgetting carries no replacement fact', () => {
  const correction = update({ key: 'budget', target: 'memory', scope: 'board', text: 'Budget: $800.', evidence: 'Our budget is now $800' });
  assert.deepEqual(parsePersonalization({ updates: [correction, correction] }, 'Our budget is now $800.').updates, [correction]);
  const forgotten = update({ key: 'budget', target: 'memory', scope: 'board', operation: 'forget', evidence: 'Forget the old budget' });
  assert.equal(parsePersonalization({ updates: [forgotten] }, 'Forget the old budget.').updates[0].text, '');
});

test('learning excludes credentials and document markup, while leaving a valid reply usable', () => {
  const message = 'My api_key=test-only-secret. I prefer concise replies';
  const input = { updates: [update({ text: 'api_key=test-only-secret', evidence: 'api_key=test-only-secret' }), update({ text: '<!-- replace a document -->' }), update()], summary: 'api_key=test-only-secret' };
  assert.deepEqual(parsePersonalization(input, message), { updates: [update()] });
  for (const invalid of [undefined, null, [], 'not learning']) assert.deepEqual(parsePersonalization(invalid, message), { updates: [] });
});

test('learning is bounded and malformed summaries are ignored', () => {
  const updates = Array.from({ length: 10 }, (_, i) => update({ key: 'preference_' + i, target: 'memory' }));
  assert.equal(parsePersonalization({ updates, summary: 'x'.repeat(2401) }, 'I prefer concise replies').updates.length, 6);
  assert.deepEqual(parsePersonalization({ updates: [], summary: '' }, 'Hello'), { updates: [], summary: '' });
});

test('learned context retrieves relevant facts within a bound and keeps manual entries', () => {
  const entries = Array.from({ length: 90 }, (_, i) => ({ key: 'fact_' + i, target: 'memory', scope: 'owner', text: 'Unrelated fact ' + i, updatedAt: i }));
  entries.unshift({ key: 'budget', target: 'memory', scope: 'board', text: 'Current workshop budget is $800.', updatedAt: 0 });
  entries.push({ key: 'manual', target: 'memory', scope: 'owner', text: 'Always preserve this owner note.', pinned: true });
  const result = selectPersonalizationContext({ ownerText: { soul: 'Owner style', memory: 'Owner context' }, entries }, 'What is our workshop budget?');
  assert.match(result.memory, /budget is \$800/);
  assert.match(result.memory, /Always preserve this owner note/);
  assert.match(result.memory, /^Owner context/);
  assert.equal((result.memory.match(/\[.*; (owner|board)\]/g) || []).length, 12);
});

test('untouched defaults can adapt while handwritten Soul keeps priority', () => {
  const learning = { ownerText: { soul: 'Concise default.', memory: '' }, ownerCustomized: { soul: false, memory: false }, entries: [{ key: 'detail', target: 'soul', scope: 'owner', text: 'Give detailed explanations.' }] };
  assert.match(selectPersonalizationContext(learning, 'Help').soul, /starting defaults above adapt to the learned preferences below/);
  learning.ownerCustomized.soul = true;
  assert.match(selectPersonalizationContext(learning, 'Help').soul, /owner-authored text above and owner-edited entries take precedence/);
});

test('editing one Soul preference does not freeze unrelated untouched default facets', () => {
  const learning = { ownerText: { soul: '- Detail: Concise.\nUse emojis.', memory: '' }, ownerCustomized: { soul: true, memory: false }, defaults: { detail: 'Concise' }, entries: [{ key: 'detail', target: 'soul', scope: 'owner', text: 'Give detailed explanations.' }] };
  const result = selectPersonalizationContext(learning, 'Help').soul;
  assert.match(result, /\[Starting default; learned preferences can adapt this\] - Detail: Concise/);
  assert.match(result, /\nUse emojis\./);
  assert.match(result, /Give detailed explanations/);
});

test('expiry requires a real quoted date on a temporary board memory', () => {
  const message = 'Keep this workshop budget through 2030-01-31.';
  const proposal = update({ key: 'budget', target: 'memory', scope: 'board', evidence: message, expiresAt: '2030-01-31' });
  assert.equal(parsePersonalization({ updates: [proposal] }, message).updates[0].expiresAt, '2030-01-31');
  for (const extra of [{ scope: 'owner' }, { target: 'soul', key: 'detail' }, { expiresAt: '2030-02-30' }, { expiresAt: '2030-02-01' }, { operation: 'forget' }]) {
    assert.deepEqual(parsePersonalization({ updates: [{ ...proposal, ...extra }] }, message).updates, []);
  }
  assert.match(selectPersonalizationContext({ ownerText: { soul: '', memory: '' }, entries: [], suppressed: [{ key: 'budget', target: 'memory', scope: 'board', deleted: true, expired: true }] }, message).instructions, /explicit renewal quoted from the current owner message/);
});


test('behavior observations are limited to working style and cannot infer profile facts', () => {
  const message = 'Make this shorter.';
  const input = update({basis: 'observed', evidence: message});
  assert.equal(parsePersonalization({updates: [input]}, message).updates[0].basis, 'observed');
  for (const patch of [{target: 'memory'}, {operation: 'forget'}, {basis: 'guess'}]) assert.equal(parsePersonalization({updates: [{...input, ...patch}]}, message).updates.length, 0);
  const context = selectPersonalizationContext({ownerText:{soul:'# Soul',memory:'# Memory'},entries:[],observations:[{key:'detail',text:'Prefer concise replies.',count:2}]}, message);
  assert.doesNotMatch(context.soul, /concise/);
  assert.match(context.instructions, /not established preferences/);
});
