export const FONTS = [
  { name: 'Draw', family: 'Shantell Sans', file: 'draw' },
  { name: 'Sans', family: 'IBM Plex Sans', file: 'sans' },
  { name: 'Serif', family: 'IBM Plex Serif', file: 'serif' },
  { name: 'Mono', family: 'IBM Plex Mono', file: 'mono' },
] as const;

export const COLORS = [
  ['Black', '#1d1d1d'], ['Grey', '#9fa8b2'], ['Light violet', '#e085f4'], ['Violet', '#ae3ec9'],
  ['Blue', '#4465e9'], ['Light blue', '#4ba1f1'], ['Yellow', '#f1ac4b'], ['Orange', '#e16919'],
  ['Green', '#099268'], ['Light green', '#4cb05e'], ['Light red', '#f87777'], ['Red', '#e03131'],
] as const;

export const SIZES = [
  { name: 'S', stroke: 2, text: 18, label: 18 },
  { name: 'M', stroke: 3.5, text: 24, label: 22 },
  { name: 'L', stroke: 5, text: 36, label: 26 },
  { name: 'XL', stroke: 10, text: 44, label: 32 },
] as const;

export function pale(color: string, amount = .22) {
  const hex = color.replace('#', '');
  if (hex.length !== 6) return '#f1f3f5';
  return '#' + [0, 2, 4].map(offset => Math.round(255 * (1 - amount) + parseInt(hex.slice(offset, offset + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}

export async function loadFonts() {
  await Promise.all(FONTS.flatMap(font => ['400', '700', 'italic 400', 'italic 700'].map(weight => document.fonts.load(`${weight} 24px "${font.family}"`))));
}

let embeddedFonts: Promise<string> | undefined;
export function svgFonts() {
  return embeddedFonts ||= Promise.all(FONTS.flatMap(font => [['regular', '400', 'normal'], ['bold', '700', 'normal'], ['italic', '400', 'italic'], ['bold-italic', '700', 'italic']].map(async ([style, weight, italic]) => {
    const bytes = new Uint8Array(await (await fetch(`/fonts/${font.file}-${style}.woff2`)).arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return `@font-face{font-family:'${font.family}';font-weight:${weight};font-style:${italic};src:url(data:font/woff2;base64,${btoa(binary)}) format('woff2')}`;
  }))).then(styles => `<defs><style>${styles.join('')}</style></defs>`);
}
