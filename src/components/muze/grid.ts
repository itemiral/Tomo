// Share the same world-space step with snapping. At low zoom, show major dots
// instead of packing subpixel CSS gradient tiles into a moiré pattern.
export const GRID_STEP = 20;

export function gridPattern(zoom: number, panX: number, panY: number) {
  const level = Math.max(0, Math.ceil(Math.log2(16 / (GRID_STEP * zoom))));
  const spacing = GRID_STEP * 2 ** level * zoom;
  const offset = (pan: number) => ((pan % spacing) + spacing) % spacing - spacing / 2;
  return { spacing, x: offset(panX), y: offset(panY) };
}
