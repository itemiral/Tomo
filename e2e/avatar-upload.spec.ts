import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('avatar uploads fit the request budget and retain transparent pixels', async ({ page }) => {
  const bundle = await build({
    stdin: { resolveDir: resolve('.'), loader: 'ts', contents: "import {normalizeAvatarImage} from './src/components/muse/avatar-upload'; window.normalizeAvatarImage=normalizeAvatarImage;" },
    bundle: true, write: false, platform: 'browser', format: 'iife',
  });
  await page.route('**/__avatar-upload-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  const requestSizes: number[] = [];
  await page.route('**/__avatar-upload-request', route => {
    requestSizes.push(Buffer.byteLength(route.request().postData()!));
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/__avatar-upload-fixture');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const normalize = (window as unknown as { normalizeAvatarImage: (file: File) => Promise<string> }).normalizeAvatarImage;
    const makeFile = async (canvas: HTMLCanvasElement) => new File([await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))], 'avatar.png', { type: 'image/png' });
    const inspect = async (source: string) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, cornerAlpha: context.getImageData(0, 0, 1, 1).data[3], centerAlpha: context.getImageData(image.width / 2, image.height / 2, 1, 1).data[3] };
    };
    const noisy = document.createElement('canvas'); noisy.width = noisy.height = 1536;
    const context = noisy.getContext('2d')!, pixels = context.createImageData(noisy.width, noisy.height);
    let seed = 70411;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[offset] = seed & 255; pixels.data[offset + 1] = seed >>> 8 & 255; pixels.data[offset + 2] = seed >>> 16 & 255; pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const original = await makeFile(noisy), source = await normalize(original);
    await fetch('/__avatar-upload-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    const transparent = document.createElement('canvas'); transparent.width = transparent.height = 64;
    const icon = transparent.getContext('2d')!; icon.fillStyle = '#426de8'; icon.fillRect(16, 16, 32, 32);
    const transparentSource = await normalize(await makeFile(transparent));
    return { originalBytes: original.size, normalizedLength: source.length, large: await inspect(source), icon: await inspect(transparentSource), png: transparentSource.startsWith('data:image/png;base64,') };
  });
  expect(result.originalBytes).toBeGreaterThan(4_500_000);
  expect(result.originalBytes).toBeLessThan(10_000_000);
  expect(result.normalizedLength).toBeLessThanOrEqual(3_700_000);
  expect(result.large.width).toBeLessThanOrEqual(1024); expect(result.large.height).toBeLessThanOrEqual(1024);
  expect(requestSizes).toHaveLength(1); expect(requestSizes[0]).toBeLessThan(3_800_000);
  expect(result.png).toBe(true);
  expect(result.icon).toEqual({ width: 64, height: 64, cornerAlpha: 0, centerAlpha: 255 });
});
