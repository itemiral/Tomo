import { expect, test, type Page } from '@playwright/test';
import { exported, museFixture, send } from './muse-fixture';

const note = (id: string, left: number, top: number) => ({ type: 'MuzeNote', id, text: id + '\n\nA short starting point.', left, top, width: 300, boxHeight: 180, inset: 26, fontSize: 18, fontFamily: 'IBM Plex Sans', verticalAlign: 'top', fill: '#1d1d1d', backgroundColor: '#f8e9b5', strokeWidth: 0 });
async function openPlan(page: Page) {
  const objects = [note('focus-note', 200, 180), note('neighbor-note', 200, 420), note('distant-note', 8000, 180)];
  const board = { id: 'placement', name: 'Placement plan', activePage: 'placement-page', pages: [{ id: 'placement-page', name: 'Plan', objects, viewport: [1, 0, 0, 1, 0, 0] }] };
  await page.getByLabel('Open a board file', { exact: true }).setInputFiles({ name: 'placement.muze', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'muze', version: 1, board })) });
  await expect(page.locator('.muze-vector-surface [id="focus-note"]')).toBeVisible();
  await page.mouse.click(240, 220);
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toHaveAttribute('placeholder', 'Ask about your selection…');
  await page.getByRole('button', { name: 'Zoom', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Zoom to 100%/ }).click();
}

test('focused additions stay near their selected section and leave existing notes unchanged', async ({ page }) => {
  const fixture = await museFixture(page); await openPlan(page);
  const before = await exported(page);
  fixture.response(async () => ({ cards: [{ id: 'focused-addition', title: 'A useful next step', body: 'Test the idea with one person.' }], updates: [] }));
  await send(page, 'Add a next step beside this');
  await expect(page.locator('.muze-vector-surface [id="focused-addition"]')).toBeVisible();
  const after = await exported(page), added = after.objects.find(object => object.id === 'focused-addition')!;
  expect(after.objects.filter(object => object.id !== added.id)).toEqual(before.objects);
  expect(added.left).toBeGreaterThanOrEqual(520); expect(added.left).toBeLessThan(1200);
  expect(added.top).toBeLessThan(500);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toEqual(before.objects);
});

test('a growing focused note finds nearby room without moving other notes or the camera', async ({ page }) => {
  const fixture = await museFixture(page); await openPlan(page);
  const before = await exported(page), selected = before.objects.find(object => object.id === 'focus-note')!;
  const replacement = 'Expanded section\n\n' + Array.from({ length: 22 }, (_, index) => 'Step ' + (index + 1) + ': Try one small improvement.').join('\n');
  fixture.response(async () => ({ cards: [], updates: [{ id: selected.id, text: replacement, expectedText: selected.text }] }));
  await send(page, 'Expand this into concrete steps');
  await expect(page.locator('.muze-vector-surface [id="focus-note"]')).toContainText('Expanded section');
  const after = await exported(page), updated = after.objects.find(object => object.id === selected.id)!;
  expect(after.viewport).toEqual(before.viewport);
  expect(after.objects.filter(object => object.id !== selected.id)).toEqual(before.objects.filter(object => object.id !== selected.id));
  expect(updated.left).toBeLessThan(1200); expect(updated.text).toBe(replacement);
  for (const other of after.objects.filter(object => object.id !== selected.id)) expect(updated.left < other.left + other.width && updated.left + updated.width > other.left && updated.top < other.top + other.height && updated.top + updated.height > other.top).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toEqual(before.objects);
});
