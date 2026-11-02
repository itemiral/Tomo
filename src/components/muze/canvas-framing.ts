export type CanvasBox = { left: number; top: number; width: number; height: number };
type Obstructions = { headerBottom?: number; composerTop?: number; toolbarTop?: number };

export function usableCanvasArea(width: number, height: number, obstructions: Obstructions = {}): CanvasBox {
  const margin = width <= 700 ? 18 : 36;
  const top = Math.min(Math.max(width <= 700 ? 112 : 84, (obstructions.headerBottom ?? 64) + 20), Math.max(20, height - 100));
  const bottom = Math.min(height - 24, obstructions.composerTop ?? height - (width <= 700 ? 180 : 150), obstructions.toolbarTop ?? height - 24) - 16;
  return { left: margin, top, width: Math.max(80, width - margin * 2), height: Math.max(60, bottom - top) };
}

function bounds(boxes: CanvasBox[]): CanvasBox {
  const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top));
  return { left, top, width: Math.max(1, Math.max(...boxes.map(box => box.left + box.width)) - left), height: Math.max(1, Math.max(...boxes.map(box => box.top + box.height)) - top) };
}

// Reading a long plan starts with its first section. Explicit Fit can still
// show the complete board, while automatic framing keeps text large enough.
export function frameCanvasBoxes(boxes: CanvasBox[], area: CanvasBox, readable = false, maxZoom = 1): [number, number, number, number, number, number] | null {
  const valid = boxes.filter(box => Object.values(box).every(Number.isFinite) && box.width >= 0 && box.height >= 0);
  if (!valid.length) return null;
  const ordered = [...valid].sort((a, b) => Math.abs(a.top - b.top) < 24 ? a.left - b.left : a.top - b.top);
  const first = ordered[0];
  let target = bounds(valid), zoom = Math.min(maxZoom, area.width / target.width, area.height / target.height), partial = false;
  const minimum = Math.min(.85, area.width / Math.max(1, first.width));
  if (readable && zoom < minimum) {
    const firstRow = bounds(ordered.filter(box => box.top < first.top + Math.max(1, Math.min(80, first.height / 3))));
    target = firstRow.width * minimum <= area.width ? firstRow : bounds([first]);
    zoom = Math.min(maxZoom, Math.max(minimum, Math.min(area.width / target.width, area.height / target.height)));
    partial = true;
  }
  zoom = Math.max(.1, zoom);
  return [zoom, 0, 0, zoom,
    area.left + Math.max(0, (area.width - target.width * zoom) / 2) - target.left * zoom,
    area.top + (partial ? 0 : Math.max(0, (area.height - target.height * zoom) / 2)) - target.top * zoom];
}
