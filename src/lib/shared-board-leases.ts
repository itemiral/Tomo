import type {Board} from '../components/muze/storage';

export type ProtectedBoardObject = {pageId: string; objectId: string; expiresAt: string};
export const MUSE_SCENE_CHANGED = 'Some notes changed before Muse started. Reading the board again.';
export const MUSE_NOTES_PROTECTED = 'Muse is using those notes. Try deleting them after the response finishes.';

export function readProtectedObjects(value: unknown): ProtectedBoardObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProtectedBoardObject => !!item && typeof item === 'object' &&
    typeof item.pageId === 'string' && typeof item.objectId === 'string' && typeof item.expiresAt === 'string' &&
    Number.isFinite(Date.parse(item.expiresAt)));
}

function objectIds(objects: Record<string, unknown>[], found = new Set<string>()) {
  for (const object of objects) {
    if (typeof object.id === 'string') found.add(object.id);
    if (Array.isArray(object.objects)) objectIds(object.objects as Record<string, unknown>[], found);
  }
  return found;
}

export function removesProtectedObjects(previous: Board, next: Board, protectedObjects: ProtectedBoardObject[], now = Date.now()) {
  return protectedObjects.some(item => {
    if (Date.parse(item.expiresAt) <= now) return false;
    const before = previous.pages.find(page => page.id === item.pageId), after = next.pages.find(page => page.id === item.pageId);
    return !!before && objectIds(before.objects).has(item.objectId) && (!after || !objectIds(after.objects).has(item.objectId));
  });
}

/** Recover a rejected deletion without discarding unrelated unsaved edits. */
export function restoreProtectedObjects(draft: Board, remote: Board, protectedObjects: ProtectedBoardObject[], now = Date.now()): Board {
  const protectedByPage = new Map<string, Set<string>>();
  for (const item of protectedObjects) if (Date.parse(item.expiresAt) > now) {
    const ids = protectedByPage.get(item.pageId) || new Set<string>(); ids.add(item.objectId); protectedByPage.set(item.pageId, ids);
  }
  const pages = [...draft.pages];
  for (const [pageId, ids] of protectedByPage) {
    const saved = remote.pages.find(page => page.id === pageId); if (!saved) continue;
    const index = pages.findIndex(page => page.id === pageId);
    if (index < 0) { pages.push(saved); continue; }
    const existing = objectIds(pages[index].objects);
    const current = new Map<string, {item: Record<string, unknown>; parent?: string}>();
    const indexObjects = (objects: Record<string, unknown>[], parent?: string) => {for(const item of objects){if(typeof item.id==='string')current.set(item.id,{item,parent});if(Array.isArray(item.objects))indexObjects(item.objects as Record<string,unknown>[],String(item.id));}};
    indexObjects(pages[index].objects);
    const restored = new Map<string, Record<string, unknown>>();
    const rebuild = (source: Record<string, unknown>, parent?: string): Record<string, unknown> => {
      const present=typeof source.id==='string'?current.get(source.id):undefined;
      const item={...source,...present?.item};
      if(present&&present.parent!==parent) {
        // Undoing an ungroup restores the original coordinate system, while
        // keeping edits to the descendant's text, style and other content.
        for(const key of ['left','top','originX','originY','angle','scaleX','scaleY','skewX','skewY','flipX','flipY']) {
          if(source[key]===undefined)delete item[key];else item[key]=source[key];
        }
      }
      if(Array.isArray(source.objects)) {
        const children=source.objects as Record<string,unknown>[],known=new Set(children.map(child=>child.id));
        const additions=Array.isArray(present?.item.objects)?(present.item.objects as Record<string,unknown>[]).filter(child=>!known.has(child.id)):[];
        item.objects=[...children.map(child=>rebuild(child,String(source.id))),...additions];
      }
      if(typeof source.id==='string')restored.set(source.id,item);
      return item;
    };
    const restore = (local: Record<string, unknown>[], source: Record<string, unknown>[]): Record<string, unknown>[] => {
      const result = [...local];
      for (const item of source) {
        const nested = objectIds([item]);
        if (![...ids].some(id => nested.has(id) && !existing.has(id))) continue;
        const at = result.findIndex(value => value.id === item.id);
        if (at < 0) result.push(rebuild(item));
        else if (Array.isArray(item.objects)) result[at] = {...result[at], objects: restore(Array.isArray(result[at].objects) ? result[at].objects as Record<string, unknown>[] : [], item.objects as Record<string, unknown>[])};
      }
      return result;
    };
    const repaired=restore(pages[index].objects,saved.objects);
    const withoutRelocatedDuplicates=(objects:Record<string,unknown>[]):Record<string,unknown>[]=>objects.filter(item=>typeof item.id!=='string'||!restored.has(item.id)||restored.get(item.id)===item).map(item=>Array.isArray(item.objects)?{...item,objects:withoutRelocatedDuplicates(item.objects as Record<string,unknown>[])}:item);
    pages[index] = {...pages[index], objects: withoutRelocatedDuplicates(repaired)};
  }
  return {...draft, pages};
}
