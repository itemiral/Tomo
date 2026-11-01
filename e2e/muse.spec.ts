import { test, expect } from '@playwright/test';
import { museFixture, exported, chat, send } from './muse-fixture';

const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3201';

test('Clerk exposes Google sign-in and keeps private Muse routes closed to anonymous requests', async ({ page, request }) => {
  for (const path of ['session', 'avatar', 'notes/soul', 'notes/memory', 'chat?thread=board:page']) {
    const response = await request.get('/api/muse/' + path);
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toContain('no-store');
  }
  expect((await request.get('/api/muse/notes/soul', { headers: { 'x-clerk-auth-user-id': 'someone-else', 'x-clerk-auth-status': 'signed-in', Cookie: 'muze_muse_owner=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status()).toBe(401);
  expect((await request.put('/api/muse/notes/soul', { headers: { Origin: origin }, data: { content: 'Unauthorized' } })).status()).toBe(401);
  expect((await request.post('/api/muse/chat', { headers: { Origin: origin }, data: {} })).status()).toBe(401);
  expect((await request.put('/api/muse/avatar', { headers: { Origin: 'https://other.invalid' }, data: {} })).status()).toBe(403);
  expect((await request.post('/api/muse/session', { headers: { Origin: origin }, data: {} })).status()).toBe(405);
  const privateRequests: string[] = [];
  page.on('request', value => { if (new URL(value.url()).pathname.startsWith('/api/muse/')) privateRequests.push(value.url()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Edit my Muse', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Talk to Muse' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to share', exact: true }).click();
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  await page.locator('.cl-modalCloseButton').click();
  await page.getByRole('button', { name: 'Talk to Muse' }).click();
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  expect(privateRequests).toEqual([]);
  await page.screenshot({ path: 'verification/muze-clerk-sign-in.png' });
});

// These component fixtures replace network responses and Clerk UI only in the test bundle.
// The real server authorization boundary is exercised separately above.
test('Muse looks toward the pointer, floats through open space, and can be grabbed or moved with the keyboard', async ({ page }) => {
  await museFixture(page);
  const muse = page.getByRole('button', { name: 'Talk to Muse' });
  const face = muse.locator('.muse-orb');
  const gaze = () => face.evaluate(element => parseFloat(element.style.getPropertyValue('--muse-gaze-x')));
  await page.mouse.move(600, 400);
  await expect.poll(gaze).toBeGreaterThan(4);
  await page.mouse.move(0, 650);
  await expect.poll(gaze).toBeLessThan(-1);
  const start = (await muse.boundingBox())!;
  await page.mouse.move(700, 400);
  await expect.poll(async () => Math.abs((await muse.boundingBox())!.x - start.x), { timeout: 11000 }).toBeGreaterThan(45);
  const drifting = (await muse.boundingBox())!;
  await page.mouse.move(drifting.x + 40, drifting.y + 35);
  const grabbed = (await muse.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(grabbed.x + 240, grabbed.y - 65, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('complementary', { name: 'Chat with Muse' })).toBeHidden();
  const dropped = (await muse.boundingBox())!;
  expect(dropped.x - grabbed.x).toBeCloseTo(200, 0);
  expect(dropped.y - grabbed.y).toBeCloseTo(-100, 0);
  await muse.press('ArrowRight');
  await expect.poll(async () => (await muse.boundingBox())!.x).toBeCloseTo(dropped.x + 16, 0);
  await muse.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled();
});

test('private notes edit, persist, handle conflicts, and stay out of whiteboard exports', async ({ page }) => {
  const fixture = await museFixture(page);
  await page.getByRole('button', { name: 'Edit my Muse', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Soul.md', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit Soul.md' }).fill('# My private style\n\nKeep explanations brief.');
  await page.getByRole('button', { name: 'Save Soul.md' }).click();
  await expect(page.getByLabel('Soul.md content', { exact: true })).toContainText('My private style');
  await page.getByRole('button', { name: 'Edit Memory.md', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit Memory.md' }).fill('An unsaved preference');
  fixture.notes.set('owner-a:memory', { content: '# Saved elsewhere', revision: 'newer', updatedAt: Date.now() });
  await page.getByRole('button', { name: 'Save Memory.md' }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByRole('textbox', { name: 'Edit Memory.md' })).toHaveValue('An unsaved preference');
  await page.getByRole('button', { name: 'Cancel editing Memory.md' }).click();
  await expect(page.getByLabel('Memory.md content', { exact: true })).toContainText('Saved elsewhere');
  await page.getByRole('button', { name: 'Back to whiteboard' }).click();
  expect((await exported(page)).text).not.toContain('My private style');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('My private style');
  await page.getByRole('button', { name: 'Edit my Muse', exact: true }).click();
  await expect(page.getByLabel('Soul.md content', { exact: true })).toContainText('My private style');
  await page.screenshot({ path: 'verification/muze-private-notes.png' });
});

test('account changes unmount private notes, drafts, and chat', async ({ page }) => {
  const fixture = await museFixture(page);
  await page.getByRole('button', { name: 'Edit my Muse', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Soul.md', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit Soul.md' }).fill('Owner A private draft');
  await fixture.owner('owner-b');
  await expect(page.getByRole('textbox', { name: 'Edit Soul.md' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Talk to Muse' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit my Muse', exact: true }).click();
  await expect(page.getByLabel('Soul.md content', { exact: true })).toContainText('owner-b');
  await expect(page.getByText('Owner A private draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit my Muse', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Muse private space' })).toHaveCount(0);
});

test('Muse moves to its work, adds spaced editable notes, and returns to its resting spot', async ({ page }) => {
  await museFixture(page);
  const muse = page.getByRole('button', { name: 'Talk to Muse' });
  const initial = (await muse.boundingBox())!;
  await page.mouse.move(initial.x + 40, initial.y + 40); await page.mouse.down(); await page.mouse.move(410, 420, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await muse.boundingBox())!.x).toBeGreaterThan(300);
  await expect(page.getByRole('complementary', { name: 'Chat with Muse' })).toBeHidden();
  await chat(page); await send(page);
  await expect(page.getByText('Updated your board · Undo available')).toBeVisible();
  const plan = await exported(page);
  expect(plan.objects).toHaveLength(3);
  for (const [i, a] of plan.objects.entries()) for (const b of plan.objects.slice(i + 1)) expect(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top).toBe(true);
  await expect(page.locator('.muse-floating')).toHaveClass(/working/);
  await page.screenshot({ path: 'verification/muze-collaboration.png' });
  await page.getByRole('button', { name: 'Close Muse chat' }).click();
  await expect(page.locator('.muse-floating')).not.toHaveClass(/working/, { timeout: 9000 });
  await expect.poll(async () => Math.round((await muse.boundingBox())!.x)).toBe(24);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(3);
});

test('follow-ups update the same plan and preserve edits made while Muse answers', async ({ page }) => {
  const fixture = await museFixture(page);
  await chat(page); await send(page);
  await expect(page.getByText('Updated your board · Undo available')).toBeVisible();
  const plan = await exported(page), first = plan.objects[0], second = plan.objects[1];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.response(async () => { await gate; return { cards: [], updates: [{ id: first.id, text: 'Muse revision', expectedText: first.text }, { id: second.id, text: 'Updated resources\n\nBring a notebook.', expectedText: second.text }] }; });
  await send(page, 'Refine this plan');
  await expect(page.getByText('Muse is thinking', { exact: true })).toBeVisible();
  const [zoom, , , , x, y] = plan.viewport;
  await page.mouse.dblclick(first.left * zoom + x + 70, first.top * zoom + y + 70);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('My newer edit'); await page.keyboard.press('Escape');
  release();
  await expect(page.getByText('Kept 1 card you changed or locked.')).toBeVisible();
  const updated = await exported(page);
  expect(updated.objects).toHaveLength(3);
  expect(updated.objects.find(object => object.id === first.id)?.text).toBe('My newer edit');
  expect(updated.objects.find(object => object.id === second.id)?.text).toContain('Updated resources');
});

test('custom icons and the private editor work on a narrow screen', async ({ page }) => {
  await museFixture(page);
  await page.getByRole('button', { name: 'Edit my Muse', exact: true }).click();
  const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#d497ca'; ctx.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Choose Muse icon', { exact: true }).setInputFiles({ name: 'muse.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await expect(page.locator('.muse-change-icon img')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Back to whiteboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Soul.md', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit Soul.md' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: 'verification/muze-private-mobile.png' });
});

test('switching pages cancels pending work without adding it to the new page', async ({ page }) => {
  const fixture = await museFixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.response(async () => { await gate; return { cards: [{ id: 'late-card', title: 'Old page work', body: 'This belongs to the old page.' }], updates: [] }; });
  await chat(page); await send(page);
  await expect(page.getByText('Muse is thinking', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pages', exact: true })).toContainText('Page 2');
  release();
  await expect(page.getByText('Muse is thinking', { exact: true })).toHaveCount(0);
  expect((await exported(page)).objects).toHaveLength(0);
});
