import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { normalizeBoardImage } from '../scripts/muse-image-import.mjs';
import { chat, exported, museFixture, send } from './muse-fixture';

const reply = 'Made you a banana with a face — it’s on the board now.';
async function generatedImage() {
  // Use the production normalizer: its WebP output exposed the PNG-only canvas bug.
  const pixels = await sharp({ create: { width: 640, height: 480, channels: 4, background: '#f4cf3d' } }).png().toBuffer();
  return normalizeBoardImage(pixels) as Promise<string>;
}
async function response(page: Page, src: string, includeNote = false) {
  await page.route('**/api/muse/chat', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: {
      messages: [{ id: 'request', role: 'user', content: route.request().postDataJSON().message }, { id: 'response', role: 'assistant', content: reply }],
      actions: { cards: includeNote ? [{ id: 'image-caption', title: 'Banana', body: 'A cheerful character.' }] : [], updates: [], images: [{ id: 'generated-banana', src, sourceTitle: 'Generated with Muse', retrievedAt: '2026-11-03T12:00:00Z' }] },
    } });
  });
}
async function delayDecode(page: Page) {
  await page.evaluate(() => {
    const property = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...property, set(value: string) {
      if (value.startsWith('data:image/webp;base64,')) {
        (window as any).releaseGeneratedImage = () => property.set!.call(this, value);
      } else property.set!.call(this, value);
    } });
  });
}

test('Muse WebP generation becomes a real saved canvas image with one undoable batch', async ({ page }) => {
  await museFixture(page);
  const src = await generatedImage(); expect(src).toMatch(/^data:image\/webp;base64,/);
  await response(page, src, true); await chat(page); await send(page, 'Draw a banana with a face');
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  const board = await exported(page), image = board.objects.find(object => object.id === 'generated-banana');
  expect(image).toMatchObject({ type: 'Image', src, sourceTitle: 'Generated with Muse', width: 640, height: 480 });
  expect(board.objects.find(object => object.id === 'image-caption')).toBeDefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('main', { name: 'Muze' })).toHaveAttribute('data-ready', 'true');
  expect((await exported(page)).objects.find(object => object.id === 'generated-banana')).toMatchObject({ type: 'Image', src });
});

test('chat waits for generated image decoding before displaying the result', async ({ page }) => {
  await museFixture(page); await response(page, await generatedImage()); await delayDecode(page);
  await chat(page); await send(page, 'Draw a banana with a face');
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseGeneratedImage)).toBe('function');
  await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
  expect((await exported(page)).objects).toHaveLength(0);
  await page.evaluate(() => (window as any).releaseGeneratedImage());
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  expect((await exported(page)).objects.find(object => object.id === 'generated-banana')?.type).toBe('Image');
});

for (const src of ['data:image/webp;base64,aW52YWxpZCBwaXhlbHM=', 'https://example.com/unverified-image.png']) {
  test(`an unusable ${src.startsWith('data:') ? 'image' : 'image URL'} cannot produce a success reply or partial board edit`, async ({ page }) => {
    await museFixture(page); await response(page, src, true); await chat(page); await send(page, 'Draw a banana with a face');
    await expect(page.locator('.muse-chat-error')).toBeVisible();
    await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
    expect((await exported(page)).objects).toHaveLength(0);
  });
}

for (const interruption of ['stop', 'board switch', 'owner switch'] as const) {
  test(`a generated image decoding during ${interruption} cannot land afterward`, async ({ page }) => {
    const fixture = await museFixture(page); await response(page, await generatedImage(), true); await delayDecode(page);
    await chat(page); await send(page, 'Draw a banana with a face');
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseGeneratedImage)).toBe('function');
    if (interruption === 'stop') await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    else if (interruption === 'owner switch') await fixture.owner('owner-b');
    else {
      await page.getByRole('button', { name: 'Main menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New board', exact: true }).click();
    }
    await page.evaluate(() => (window as any).releaseGeneratedImage());
    await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
    expect((await exported(page)).objects).toHaveLength(0);
    await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
  });
}
