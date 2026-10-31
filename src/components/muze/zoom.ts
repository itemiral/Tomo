export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
export const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

// Keep the same world point at the center when opening an older, more zoomed-in
// board. Return a fresh transform so the saved source is never mutated in place.
export function clampViewport(viewport: readonly number[], width: number, height: number): [number, number, number, number, number, number] {
  const ratio = clampZoom(viewport[0]) / viewport[0];
  if (ratio === 1) return [viewport[0], viewport[1], viewport[2], viewport[3], viewport[4], viewport[5]];
  return [viewport[0] * ratio, viewport[1] * ratio, viewport[2] * ratio, viewport[3] * ratio,
    width / 2 + (viewport[4] - width / 2) * ratio,
    height / 2 + (viewport[5] - height / 2) * ratio];
}
