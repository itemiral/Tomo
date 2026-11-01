export const AVATAR_INPUT_LIMIT = 40_000_000;
export const AVATAR_PIXEL_LIMIT = 48_000_000;
export const AVATAR_UPLOAD_LIMIT = 2_000_000;
export const AVATAR_EDGE = 1600;
type ImageInfo = { width: number; height: number; type: string };
const invalid = () => new Error('Choose a different PNG, JPEG, WebP, or GIF image.');

// Inspect a bounded header before decoding; never trust the extension or MIME label.
export function avatarImageInfo(bytes: Uint8Array, size: number): ImageInfo {
  if (!size || size > AVATAR_INPUT_LIMIT) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  let width = 0, height = 0, type = '', orientation = 1;
  if (bytes.length >= 24 && bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); type = 'image/png';
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true); type = 'image/gif';
  } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4); type = 'image/webp';
    const u24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
    if (chunk === 'VP8X') { width = 1 + u24(24); height = 1 + u24(27); }
    else if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
    else if (chunk === 'VP8L' && bytes[20] === 47) { const bits = view.getUint32(21, true); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    type = 'image/jpeg';
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at] !== 255) break;
      const marker = bytes[at + 1], length = view.getUint16(at + 2);
      if (length < 2 || at + 2 + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) { height = view.getUint16(at + 5); width = view.getUint16(at + 7); }
      if (marker === 225 && text(at + 4, 6) === 'Exif\0\0') {
        const base = at + 10, end = at + 2 + length;
        if (base + 8 <= end) {
          const little = text(base, 2) === 'II', directory = base + view.getUint32(base + 4, little);
          if (directory >= base && directory + 2 <= end) {
            const count = Math.min(view.getUint16(directory, little), 256);
            for (let i = 0; i < count; i++) { const row = directory + 2 + i * 12; if (row + 12 > end) break; if (view.getUint16(row, little) === 274) orientation = view.getUint16(row + 8, little); }
          }
        }
      }
      at += length + 2;
      if (marker === 218) break;
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > AVATAR_PIXEL_LIMIT) throw invalid();
  if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
  return { width, height, type };
}
export function avatarDimensions(width: number, height: number) {
  const scale = Math.min(1, AVATAR_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
function dataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); signal.removeEventListener('abort', abort); reject(signal.reason); };
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(invalid());
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    reader.readAsDataURL(blob);
  });
}
export async function normalizeAvatarImage(file: File, signal: AbortSignal = new AbortController().signal): Promise<string> {
  signal.throwIfAborted();
  if (!file.size || file.size > AVATAR_INPUT_LIMIT) throw invalid();
  const info = avatarImageInfo(new Uint8Array(await file.slice(0, 262144).arrayBuffer()), file.size);
  const target = avatarDimensions(info.width, info.height);
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high', imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    // Valid small originals retain their exact bytes, alpha and metadata.
    if (file.size <= AVATAR_UPLOAD_LIMIT && Math.max(info.width, info.height) <= AVATAR_EDGE) return await dataUrl(new Blob([file], { type: info.type }), signal);
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); if (!context) throw invalid();
    context.drawImage(bitmap, 0, 0);
    const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(invalid()), type, quality));
    let output = await encode('image/png');
    for (const quality of [.9, .8, .7, .6]) {
      signal.throwIfAborted(); if (output.size <= AVATAR_UPLOAD_LIMIT) break;
      output = await encode('image/webp', quality);
    }
    if (output.size > AVATAR_UPLOAD_LIMIT) throw invalid();
    signal.throwIfAborted(); return await dataUrl(output, signal);
  } finally { bitmap.close(); canvas.width = canvas.height = 0; }
}
