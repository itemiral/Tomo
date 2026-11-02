import type { Board } from '../components/muze/storage';
import { mergeSharedBoard } from '../components/muze/shared-merge';

export type MuseCanvasSnapshot = {
  name?: string;
  soul?: string;
  ownerId?: string;
  board: Board;
  revision: string;
  notes: { soul: string; memory: string };
};

const start = '<!-- muze-learned:start -->', end = '<!-- muze-learned:end -->';
const entryPattern = /<!-- muze-entry:([a-f0-9]{24}):start -->[\s\S]*?<!-- muze-entry:\1:end -->/g;

function learnedSection(text: string) {
  const first = text.indexOf(start), last = text.indexOf(end);
  if (first < 0 && last < 0) return { outside: text.trimEnd(), before: text, after: '', entries: new Map<string, string>(), body: '', exists: false };
  if (first < 0 || last < first || text.indexOf(start, first + start.length) >= 0 || text.indexOf(end, last + end.length) >= 0) return null;
  const body = text.slice(first + start.length, last), matches = [...body.matchAll(entryPattern)];
  const entries = new Map(matches.map(match => [match[1], match[0]]));
  if (entries.size !== matches.length) return null;
  return {
    outside: (text.slice(0, first) + text.slice(last + end.length)).trimEnd(),
    before: text.slice(0, first), after: text.slice(last + end.length), entries, body, exists: true,
  };
}

// Only generated blocks may merge over a simultaneous owner edit. Handwritten
// changes from another tab retain the normal three-way conflict protection.
export function mergeLearnedNote(base: string, local: string, remote: string): string | null {
  if (local === base) return remote;
  if (remote === base || local === remote) return local;
  const previous = learnedSection(base), ours = learnedSection(local), theirs = learnedSection(remote);
  if (!previous || !ours || !theirs || previous.outside !== theirs.outside) return null;
  if (previous.exists && !ours.exists) return local;
  const ids = [...new Set([...ours.entries.keys(), ...theirs.entries.keys()])];
  const entries = new Map(ids.flatMap(id => {
    const before = previous.entries.get(id), own = ours.entries.get(id), other = theirs.entries.get(id);
    const value = own === before ? other : own;
    return value === undefined ? [] : [[id, value] as const];
  }));
  const template=ours.exists?ours:theirs,seen=new Set<string>();
  let body=template.body.replace(entryPattern,(_match,id:string)=>{seen.add(id);return entries.get(id)||'';});
  const added=[...entries].filter(([id])=>!seen.has(id)).map(([,value])=>value);
  if(added.length)body=body.trimEnd()+'\n\n'+added.join('\n\n')+'\n';
  const region = body.trim() ? start + body + end : '';
  if (ours.exists) return ours.before + region + ours.after;
  return region ? local.trimEnd() + '\n\n' + region + theirs.after : local;
}

const noteIds = new Set(['muse-file-soul', 'muse-file-memory']);
function notes(board: Board) {
  const values = new Map<string, Record<string, unknown>>();
  const walk = (objects: Record<string, unknown>[]) => objects.forEach(object => {
    if (noteIds.has(String(object.id))) values.set(String(object.id), object);
    if (Array.isArray(object.objects)) walk(object.objects);
  });
  board.pages.forEach(page => walk(page.objects));
  return values;
}

export function reconcileMuseCanvas(base: Board, local: Board, remote: Board): Board {
  if (base.id !== local.id || base.id !== remote.id) throw new Error('This notebook changed. Your draft is preserved.');
  const previous = notes(base), ours = notes(local), theirs = notes(remote);
  const replacements = new Map<string, string>();
  for (const id of noteIds) {
    const before = previous.get(id), own = ours.get(id), other = theirs.get(id);
    const baseText = before?.markdown ?? before?.text, localText = own?.markdown ?? own?.text, remoteText = other?.markdown ?? other?.text;
    if (typeof baseText !== 'string' || typeof localText !== 'string' || typeof remoteText !== 'string') continue;
    const merged = mergeLearnedNote(baseText, localText, remoteText);
    if (merged !== null) replacements.set(id, merged);
  }
  const withMergedNotes = (board: Board): Board => {
    const visit = (objects: Record<string, unknown>[]): Record<string, unknown>[] => objects.map(object => {
      const text = replacements.get(String(object.id));
      return { ...object, ...(text !== undefined ? { text, markdown: text } : {}), ...(Array.isArray(object.objects) ? { objects: visit(object.objects) } : {}) };
    });
    return { ...board, pages: board.pages.map(page => ({ ...page, objects: visit(page.objects) })) };
  };
  return mergeSharedBoard(base, withMergedNotes(local), withMergedNotes(remote));
}
