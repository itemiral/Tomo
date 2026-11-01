// Stable, restrained document-only tints. The surrounding app retains its palette.
const surfaces = ['#edf3fb', '#f2effa', '#f8eff3', '#edf6f1', '#edf6f7', '#f0f1fa'];
export function documentColor(name: string) {
  const normalized = name.trim().normalize('NFC').toLowerCase() || 'document';
  let hash = 2166136261;
  for (const char of normalized) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return surfaces[(hash >>> 0) % surfaces.length];
}
