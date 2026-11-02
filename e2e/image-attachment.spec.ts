import { expect, test, type Page } from '@playwright/test';
import { museFixture, exported } from './muse-fixture';

async function openAttachments(page: Page) {
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
}
const imageInput = (page: Page) => page.getByLabel('Choose image attachment', { exact: true });

async function imageFile(page: Page, noisy = false) {
  const source = await page.evaluate(noisy => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = noisy ? 1536 : 64;
    const context = canvas.getContext('2d')!;
    if (noisy) {
      const image = context.createImageData(canvas.width, canvas.height); let seed = 70411;
      for (let i = 0; i < image.data.length; i += 4) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        image.data[i] = seed & 255; image.data[i + 1] = seed >>> 8 & 255; image.data[i + 2] = seed >>> 16 & 255; image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    } else { context.fillStyle = '#426de8'; context.fillRect(16, 16, 32, 32); }
    return canvas.toDataURL('image/png');
  }, noisy);
  return { name: 'board-image.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') };
}

test('the collapsed composer opens an image picker, adds a sized board image and supports undo without a model request', async ({ page }) => {
  await museFixture(page); const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/muse\/(image|avatar|chat|tasks)(\?|$)/.test(request.url())) writes.push(request.url()); });
  const file = await imageFile(page, true); expect(file.buffer.length).toBeGreaterThan(4_500_000);
  await openAttachments(page);
  await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/);
  await expect(page.locator('.muse-task-panel')).toHaveCount(0);
  await expect(page.getByLabel('Image URL', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Add an image from a link', { exact: true })).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach image', exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
  const board = await exported(page), images = board.objects.filter(object => object.type === 'Image');
  expect(images).toHaveLength(1);
  const image = images[0] as typeof images[0] & { src: string };
  expect(image.src).toMatch(/^data:image\/png;base64,/); expect(image.src.length).toBeLessThanOrEqual(1_500_000);
  expect(image.width).toBeLessThanOrEqual(1024); expect(image.height).toBeLessThanOrEqual(1024);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects.filter(object => object.type === 'Image')).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exported(page)).objects.filter(object => object.type === 'Image')).toHaveLength(1);
  expect(writes).toEqual([]);
});

test('attachments reject unsupported files and preserve transparent pixels in the private notebook', async ({ page }) => {
  const fixture = await museFixture(page);
  await page.getByRole('button', { name: 'Open Muse', exact: true }).click();
  await page.getByRole('dialog', { name: 'Muse', exact: true }).getByRole('button', { name: 'Edit Muse', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Muze' })).toHaveAttribute('data-muse-board', 'true');
  await openAttachments(page);
  await imageInput(page).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Not an image') });
  await expect(page.getByRole('alert')).toContainText('Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
  await imageInput(page).setInputFiles(await imageFile(page));
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
  const image = (await exported(page)).objects.find(object => object.type === 'Image' && object.id !== 'muse-appearance') as { id: string; src: string } | undefined;
  expect(image).toBeTruthy();
  const alpha = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [context.getImageData(0, 0, 1, 1).data[3], context.getImageData(32, 32, 1, 1).data[3]];
  }, image!.src);
  expect(alpha).toEqual([0, 255]);
  await expect.poll(() => fixture.canvases.get('owner-a')?.board.pages.flatMap((page: { objects: { id: string }[] }) => page.objects).some((object: { id: string }) => object.id === image!.id)).toBe(true);
});

for (const destination of ['another board', 'another owner'] as const) test(`an image still decoding cannot land on ${destination}`, async ({ page }) => {
  const fixture = await museFixture(page), file = await imageFile(page);
  await openAttachments(page);
  await page.evaluate(() => {
    const property = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    let blobs = 0;
    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...property, set(value: string) {
      // Pause the engine's decode after normalization has finished; no application seam is needed.
      if (value.startsWith('blob:') && ++blobs === 2) {
        (window as any).releaseImage = () => { this.addEventListener('load', () => { (window as any).delayedImageLoaded = true; }, { once: true }); property.set!.call(this, value); };
      } else property.set!.call(this, value);
    } });
  });
  await imageInput(page).setInputFiles(file);
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseImage)).toBe('function');
  if (destination === 'another owner') await fixture.owner('owner-b');
  else {
    await page.getByRole('button', { name: 'Main menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New board', exact: true }).click();
  }
  await page.evaluate(() => (window as any).releaseImage());
  await expect.poll(() => page.evaluate(() => !!(window as any).delayedImageLoaded)).toBe(true);
  expect((await exported(page)).objects.filter(object => object.type === 'Image')).toHaveLength(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const width of [1440, 390]) test(`attachment and drawing controls stay compact and aligned at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await museFixture(page); await openAttachments(page);
  const attach = page.getByRole('button', { name: 'Attach image', exact: true });
  const message = page.getByRole('textbox', { name: 'Message Muse', exact: true });
  const send = page.getByRole('button', { name: 'Send to Muse', exact: true });
  await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/);
  await expect(attach).toHaveAttribute('title', 'Attach image');
  await expect(attach).toHaveText('');
  const boxes = await Promise.all([attach, message, send].map(control => control.boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  const [plus, input, submit] = boxes.map(box => box!);
  expect(plus.x).toBeGreaterThanOrEqual(0);
  expect(plus.x + plus.width).toBeLessThanOrEqual(input.x + 1);
  expect(input.x + input.width).toBeLessThanOrEqual(submit.x + 1);
  expect(submit.x + submit.width).toBeLessThanOrEqual(width);
  expect(input.width).toBeGreaterThan(150);
  const sharedTop = Math.max(plus.y, input.y, submit.y);
  const sharedBottom = Math.min(plus.y + plus.height, input.y + input.height, submit.y + submit.height);
  expect(sharedBottom - sharedTop).toBeGreaterThan(20);
  expect(Math.max(plus.height, input.height, submit.height)).toBeLessThanOrEqual(50);
  const dock = page.locator('.muze-toolbar-dock'), tools = page.getByRole('toolbar', { name: 'Whiteboard tools', exact: true });
  const composerBox = (await page.locator('.muse-chat').boundingBox())!, dockBox = (await dock.boundingBox())!;
  expect(Math.abs(composerBox.x - dockBox.x)).toBeLessThan(2);
  expect(Math.abs(composerBox.width - dockBox.width)).toBeLessThan(2);
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(dockBox.y);
  expect(dockBox.width).toBeLessThanOrEqual(Math.min(440, width - 24));
  for (const name of ['Undo', 'Redo', 'Select', 'More tools']) {
    const control = tools.getByRole('button', { name, exact: true }); await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(dockBox.x); expect(box.x + box.width).toBeLessThanOrEqual(dockBox.x + dockBox.width);
  }
  await expect(page.locator('.muse-history-controls')).toHaveCount(0);
  await page.screenshot({ path: `/tmp/muze-clear-controls-${width}.png` });
});
