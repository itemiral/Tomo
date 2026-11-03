import test from 'node:test';
import assert from 'node:assert/strict';
import { completeExchanges, factForms, filterAdd, filterHas, retrievalScore, retrievalTerms } from '../scripts/muse-retrieval.mjs';

test('retrieval supplements literal words with multilingual concepts and inflections', () => {
  assert.ok(retrievalScore('Workshop budget is $800.', '¿Cuál es el presupuesto?') > 0);
  assert.ok(retrievalScore('Workshop deadline is Friday.', 'срок') > 0);
  assert.ok(retrievalScore('日本旅行の予算は八万円です。', '予算') > 0);
  assert.ok(retrievalScore('We are organizing the workshop.', 'organize workshop') > 0);
  assert.ok(retrievalTerms('coût').has('@0'));
  assert.equal(retrievalScore('The workshop deadline is Friday.', 'rooibos'), 0);
});

test('fact normalization merges narrow equivalents without losing subjects or quantities', () => {
  assert.equal(factForms('Prefers concise replies.')[1], factForms('Prefers short responses.')[1]);
  for (const [left, right] of [
    ['I prefer tea.', 'My partner prefers tea.'],
    ['I like tea.', 'I do not like tea.'],
    ['Budget is $500.', 'Budget is $800.'],
    ['Change is -5.', 'Change is 5.'],
    ['Rate is 5%.', 'Rate is 5.'],
    ['Budget is $500.', 'Budget is €500.'],
    ['Alice likes Bob.', 'Bob likes Alice.'],
  ]) assert.notEqual(factForms(left)[1], factForms(right)[1]);
});

test('bounded filters retain every added source across incremental writes', () => {
  let filter;
  const values = Array.from({ length: 5000 }, (_, i) => 'board:shared:message-' + i);
  for (let i = 0; i < values.length; i += 100) filter = filterAdd(filter, values.slice(i, i + 100), 8192);
  assert.equal(Buffer.from(filter, 'base64').length, 8192);
  for (const value of values) assert.equal(filterHas(filter, value, 8192), true);
  assert.equal(filterHas(filter, 'board:other:message-0', 8192), false);
  assert.equal(filterHas('invalid', 'anything', 8192), false);
});

test('complete exchanges omit orphan answers and unfinished requests', () => {
  const messages = [
    { role: 'assistant', content: 'Orphan' }, { role: 'user', content: 'One' },
    { role: 'assistant', content: 'Answer' }, { role: 'assistant', content: 'Continuation' },
    { role: 'user', content: 'Unanswered' }, { role: 'user', content: 'Two' },
    { role: 'assistant', content: 'Another answer' }, { role: 'user', content: 'Pending' },
  ];
  assert.deepEqual(completeExchanges(messages).map(group => group.map(message => message.content)), [['One', 'Answer', 'Continuation'], ['Two', 'Another answer']]);
});
