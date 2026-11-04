export const DEFAULT_MUSE_STYLE = Object.freeze({
  tone: 'Calm, curious, and direct',
  detail: 'Concise, with more detail when useful',
  language: 'Follow the language the owner uses',
  format: 'Clear steps and readable notes',
  pace: 'Small useful steps',
  collaboration: 'Ask when a key preference or constraint is missing',
});

export const PREVIOUS_NOTE_TEMPLATES = {
  soul: '# Soul\n\n## Who I am\nI’m Muse, your companion inside Muze. I help turn rough ideas into clear plans on a shared whiteboard.\n\n## How I work\n- Start with the goal, then break it into useful steps.\n- Keep related ideas together and the board easy to read.\n- Offer a clear next step when a plan feels stuck.\n- Ask when a preference or constraint is missing.\n\n## My default style\n' + Object.entries(DEFAULT_MUSE_STYLE).map(([key, value]) => '- ' + key[0].toUpperCase() + key.slice(1) + ': ' + value + '.').join('\n') + '\n\n## Make me yours\nMy working style adapts as we talk. Edit this note whenever you want; your words take priority.\n',
  memory: '# Memory\n\n## About you\nUseful context and preferences will grow here as we talk. You can edit them at any time.\n\n## Your notes\nAdd anything you want me to keep in mind.\n',
};

export const LEGACY_NOTE_TEMPLATES = {
  soul: '# Soul\n\n## Who I am\nI’m Muse, your companion inside Muze. I help turn rough ideas into clear plans on a shared whiteboard.\n\n## How I work\n- Start with the goal, then break it into useful steps.\n- Keep related ideas together and the board easy to read.\n- Offer a clear next step when a plan feels stuck.\n- Ask when a preference or constraint is missing.\n\n## My voice\nCalm, curious, and direct. Use plain language and keep explanations concise.\n\n## Make me yours\nEdit this note to choose my role, working style, and the way I communicate.\n',
  memory: '# Memory\n\n## About you\nAdd the context you want Muse to remember about you.\n\n## Preferences\n- How I like to plan:\n- How much detail I prefer:\n- Things to keep in mind:\n\n## Current focus\nAdd what you’re working on and what a good result looks like.\n\n## Decisions worth keeping\nRecord choices, useful discoveries, and things to revisit.\n',
};

// Neutral starting notes adapt through learned entries and owner edits.
export const MEMORY_INTRODUCTION = 'Your Muse learns what matters to you as you work together. Useful preferences, decisions, and ongoing projects will collect here to make its help more personal. You can edit or remove anything.';
export const MUSE_NOTE_TEMPLATES = {
  soul: PREVIOUS_NOTE_TEMPLATES.soul.split('\n\n## Make me yours')[0] + '\n',
  memory: '# Memory\n\n' + MEMORY_INTRODUCTION + '\n',
};

export function restoreMuseNoteDefaults(content, target, name = 'Muse') {
  const learned = [...content.matchAll(/<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/g)].map(match => match[0]);
  let ownerText = content.replace(/<!-- muze-learned:start -->[\s\S]*?<!-- muze-learned:end -->/g, '').trim();
  const nameLine = `My name is ${name}.\n\n`;
  if (target === 'soul' && ownerText.startsWith(nameLine)) ownerText = ownerText.slice(nameLine.length).trim();
  if (ownerText && ownerText !== (target === 'soul' ? '# Soul' : '# Memory')) return content;
  const initial = MUSE_NOTE_TEMPLATES[target].replace('I’m Muse,', () => `I’m ${name},`).trimEnd();
  return initial + (learned.length ? '\n\n' + learned.join('\n\n') : '') + '\n';
}

export function cleanMuseNoteDefaults(content, target, name = 'Muse') {
  let result = content;
  for (const template of [PREVIOUS_NOTE_TEMPLATES, LEGACY_NOTE_TEMPLATES].flatMap(templates => [...new Set([name, 'Muse'])].map(alias => templates[target].replace('I’m Muse,', () => `I’m ${alias},`).trimEnd()))) {
    if (result.trimEnd() === template || result.startsWith(template + '\n')) {
      result = MUSE_NOTE_TEMPLATES[target].replace('I’m Muse,', () => `I’m ${name},`).trimEnd() + result.slice(template.length);
      break;
    }
  }
  // An owner may already have customized the rest of the note. Remove only
  // the exact old instruction, preserving their writing and learned blocks.
  if (target === 'soul') for (const paragraph of [
    'Edit this note to choose my role, working style, and the way I communicate.',
    'My working style adapts as we talk. Edit this note whenever you want; your words take priority.',
  ]) result = result.replace('## Make me yours\n' + paragraph, '');
  return result;
}
