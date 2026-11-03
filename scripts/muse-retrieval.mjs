// Small, deterministic retrieval helpers. Concepts supplement literal matching;
// they are not embedding similarity and never decide whether a fact is true.
const stop = new Set('a an the and or but to of in on at for from with about is are was were be been being i me my we our you your it its this that these those do does did can could would should please tell what when where why how remember recall again have has had as by then than they them their le la les de des du un une el los las en y que por para der die das und ein eine ist'.split(' '));
const concepts = [
  ['budget','cost','price','expense','affordable','cheap','spend','funding','money','presupuesto','costo','precio','cout','бюджет','стоимость','цена','预算','預算','費用','予算','예산','비용'],
  ['deadline','schedule','timeline','calendar','due','milestone','plazo','fecha','echeance','срок','расписание','дедлайн','期限','日程','마감','일정'],
  ['learn','study','practice','teach','course','education','aprender','estudiar','etudier','учеба','учиться','обучение','学习','學習','勉強','공부','학습'],
  ['concise','brief','short','succinct','breve','corto','court','кратко','коротко','简洁','簡潔','간결'],
  ['detailed','thorough','comprehensive','detallado','detaille','подробно','详细','詳細','자세히'],
  ['plan','organize','outline','roadmap','planning','organiser','план','организация','计划','計画','계획'],
  ['travel','trip','holiday','vacation','viaje','voyage','reise','поездка','путешествие','旅行','여행'],
];
export const normalizeSearchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{Script=Latin}\p{M}]+/gu, text => text.normalize('NFD').replace(/\p{M}/gu, '')).replace(/[’']/g, "'");
const stem = term => /^[a-z]+$/.test(term) && term.length > 4 ? term.replace(/ies$/, 'y').replace(/(?:ing|ed)$/, '').replace(/([^s])s$/, '$1').replace(/([b-df-hj-np-tv-z])\1$/, '$1') : term;
const conceptFor = new Map(concepts.flatMap((values, index) => values.map(term => [stem(term), '@' + index])));
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
export function retrievalTerms(value) {
  const normalized = normalizeSearchText(value), terms = new Set();
  const tokens = segmenter ? [...segmenter.segment(normalized)].filter(item => item.isWordLike).map(item => item.segment) : normalized.match(/[\p{L}\p{N}]+/gu) || [];
  for (const token of tokens) {
    if (stop.has(token) || token.length > 80 || token.length < 2 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) continue;
    const root = stem(token); terms.add(root);
    if (conceptFor.has(root)) terms.add(conceptFor.get(root));
    // Character pairs help CJK queries when segmentation boundaries differ.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) {
      const chars = [...token]; for (let i = 0; i < chars.length - 1; i++) terms.add('~' + chars.slice(i, i + 2).join(''));
    }
  }
  return terms;
}
export function retrievalScore(text, query, frequencies = new Map(), documentCount = 1) {
  const terms = retrievalTerms(text), wanted = query instanceof Set ? query : retrievalTerms(query);
  let score = 0;
  for (const term of wanted) if (terms.has(term)) score += (term.startsWith('@') ? .4 : term.startsWith('~') ? .5 : 1) * (1 + Math.log((documentCount + 1) / ((frequencies.get(term) || 0) + 1)));
  return score / (1 + .12 * Math.log(1 + terms.size));
}
export function completeExchanges(messages) {
  const groups = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
    if (message.role === 'user') groups.push([message]);
    else if (groups.length) groups.at(-1).push(message);
  }
  return groups.filter(group => group.length > 1 && group.at(-1).role === 'assistant');
}

// Bloom filters have no false negatives. A collision can only suppress extra old
// context or read an extra archive candidate; it cannot reveal a forgotten fact.
export function filterAdd(encoded, values, bytes = 1024) {
  const data = typeof encoded === 'string' && encoded.length <= Math.ceil(bytes / 3) * 4 ? Buffer.from(encoded, 'base64') : Buffer.alloc(bytes);
  const bits = data.length === bytes ? data : Buffer.alloc(bytes);
  for (const value of values) for (const index of filterIndices(String(value), bytes * 8)) bits[index >>> 3] |= 1 << (index & 7);
  return bits.toString('base64');
}
export function filterHas(encoded, value, bytes = 1024) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(bytes / 3) * 4) return false;
  const bits = Buffer.from(encoded, 'base64');
  return bits.length === bytes && filterIndices(String(value), bytes * 8).every(index => bits[index >>> 3] & 1 << (index & 7));
}
function filterIndices(value, size) {
  let first = 2166136261, second = 5381;
  for (const char of value) { const code = char.codePointAt(0); first = Math.imul(first ^ code, 16777619) >>> 0; second = (Math.imul(second, 33) ^ code) >>> 0; }
  return [0, 1, 2, 3].map(index => ((first + Math.imul(index, second | 1)) >>> 0) % size);
}

const factWords = new Map([['brief','short'],['concise','short'],['succinct','short'],['reply','response'],['replies','response'],['responses','response'],['answer','response'],['answers','response'],['prefers','prefer'],['likes','like']]);
export function factForms(value) {
  const literal = normalizeSearchText(value).replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/[^\p{L}\p{N}%+\-.$€£¥<>]+/gu, ' ').trim();
  // Keep quantities, negations, subjects and all other words. Equivalence is
  // intentionally narrow so “my partner” or “not” cannot disappear in a merge.
  const equivalent = literal.split(/\s+/).map(word => factWords.get(word) || word).join(' ');
  return [literal, equivalent];
}
