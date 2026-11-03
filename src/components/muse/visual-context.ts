import type { Board } from '../muze/storage';
import type { MuseVisualInput } from '../../lib/muse-request';
import { normalizeImageFile } from './image-upload';

type ImageRef = { pageId: string; objectId: string; kind?: 'image' | 'scene' };
const supported = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Read only images already present in this board. No remote image requests. */
export async function prepareMuseVisuals(board: Board, refs: ImageRef[], signal: AbortSignal, scene?: string): Promise<MuseVisualInput[]> {
  const images: MuseVisualInput[] = [];
  const find = (objects: Record<string, unknown>[], id: string, depth = 0): Record<string, unknown> | undefined => {
    if (depth > 12) return;
    for (const object of objects) {
      if (object.id === id) return object;
      if (Array.isArray(object.objects)) { const child = find(object.objects, id, depth + 1); if (child) return child; }
    }
  };
  for (const ref of refs.slice(0, 3)) {
    signal.throwIfAborted();
    const page = board.pages.find(page => page.id === ref.pageId);
    if (!page) continue;
    const source = ref.kind === 'scene' && ref.objectId === 'scene-preview' && page.id === board.activePage ? scene : find(page.objects, ref.objectId)?.src;
    if (typeof source !== 'string' || source.length > 14_000_000) continue;
    const match = supported.exec(source);
    if (!match) continue;
    try {
      const binary = atob(match[2]), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const dataUrl = await normalizeImageFile(new File([bytes], 'context-image', { type: 'image/' + match[1] }), { maxDimension: 1024, maxSourceLength: 390_000 }, signal);
      images.push({ pageId: ref.pageId, objectId: ref.objectId, kind: ref.kind || 'image', dataUrl });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Could not prepare that image for Muse. Try a smaller image.');
    }
  }
  return images;
}
