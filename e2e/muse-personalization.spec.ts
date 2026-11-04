import { expect, test } from '@playwright/test';
import { exported, museFixture, send } from './muse-fixture';

const learned = (value: string) => '\n\n<!-- muze-learned:start -->\n## Learned working style\n\n<!-- muze-entry:aaaaaaaaaaaaaaaaaaaaaaaa:start -->\n- ' + value + '\n<!-- muze-entry:aaaaaaaaaaaaaaaaaaaaaaaa:end -->\n<!-- muze-learned:end -->';
async function openNotebook(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open Muse', exact: true }).click();
  await page.getByRole('dialog', { name: 'Muse', exact: true }).getByRole('button', { name: 'Edit Muse', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Tomo' })).toHaveAttribute('data-muse-board', 'true');
  await expect(page.getByRole('main', { name: 'Tomo' })).toHaveAttribute('data-ready', 'true');
}
function updateSoul(fixture: Awaited<ReturnType<typeof museFixture>>, text: string) {
  const canvas = fixture.canvases.get('owner-a')!;
  const document = canvas.board.pages.flatMap((page: any) => page.objects).find((object: any) => object.id === 'muse-file-soul');
  document.markdown = document.text = text;
  fixture.notes.set('owner-a:soul', { content: text, revision: 'learned-revision', updatedAt: Date.now() });
  canvas.notes.soul = 'learned-revision';
}

test('learned Soul updates refresh the notebook and remain directly editable', async ({ page }) => {
  const initial = '# Soul\n\nMy default style.';
  const fixture = await museFixture(page, { soul: initial });
  await openNotebook(page);
  const before = await exported(page);
  updateSoul(fixture, initial + learned('Keep the steps concise.'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-personalization-updated', { detail: { ownerId: 'owner-a' } })));
  const soul = page.locator('.muze-vector-surface [id="muse-file-soul"]');
  await expect(soul).toContainText('Keep the steps concise.');
  expect((await exported(page)).viewport).toEqual(before.viewport);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(300, 250);
  const input = page.locator('textarea[data-fabric="textarea"]');
  await expect(input).toBeAttached();
  await expect(input).not.toHaveValue(/muze-entry|muze-learned/);
  await input.fill((await input.inputValue()).replace('Keep the steps concise.','Use detailed examples when needed.'));
  await input.press('Escape');
  await expect.poll(() => fixture.notes.get('owner-a:soul')?.content).toContain('Use detailed examples when needed.');
  expect(fixture.notes.get('owner-a:soul')?.content).toContain('muze-entry:aaaaaaaaaaaaaaaaaaaaaaaa:start');
  await page.mouse.dblclick(300,250);
  await expect(input).toBeAttached();
  await input.fill('# My own style\n\nGive detailed examples when I ask.');
  await input.press('Escape');
  await expect.poll(() => fixture.notes.get('owner-a:soul')?.content).toContain('My own style');
  await expect(page.locator('.muse-save-status')).toHaveText('Saved');
});

test('learning waits for an active owner draft and merges without replacing it', async ({ page }) => {
  const initial = '# Soul\n\nMy default style.';
  const fixture = await museFixture(page, { soul: initial });
  await openNotebook(page);
  await page.mouse.dblclick(300, 250);
  const input = page.locator('textarea[data-fabric="textarea"]');
  await expect(input).toBeAttached();
  await input.fill('# Soul\n\nMy handwritten preference.');
  updateSoul(fixture, initial + learned('Use concrete examples.'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-personalization-updated', { detail: { ownerId: 'owner-a' } })));
  await page.waitForTimeout(450);
  await expect(input).toHaveValue('# Soul\n\nMy handwritten preference.');
  await input.press('Escape');
  await expect.poll(() => fixture.notes.get('owner-a:soul')?.content).toContain('My handwritten preference.');
  await expect.poll(() => fixture.notes.get('owner-a:soul')?.content).toContain('Use concrete examples.');
  await expect(page.locator('.muse-save-status')).toHaveText('Saved');
  await expect(page.locator('.muse-save-error')).toHaveCount(0);
});

test('a late refresh cannot reveal the previous owner notebook', async ({ page }) => {
  const fixture = await museFixture(page);
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  let intercepted = false;
  await page.route('**/api/muse/canvas', async route => {
    if (route.request().method() !== 'GET' || intercepted) return route.fallback();
    intercepted = true;
    const response = structuredClone(fixture.canvases.get('owner-a')!);
    response.board.pages[0].objects.find((object: any) => object.id === 'muse-file-soul').markdown = 'Previous owner private text';
    requested(); await gate;
    await route.fulfill({ json: response }).catch(() => {});
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-personalization-updated', { detail: { ownerId: 'owner-a' } })));
  await started;
  await fixture.owner('owner-b');
  release();
  await openNotebook(page);
  await expect(page.locator('.muze-vector-surface')).not.toContainText('Previous owner private text');
  expect((await exported(page)).text).not.toContain('Previous owner private text');
  await expect(page.locator('.muse-save-error')).toHaveCount(0);
});

test('a successful chat refreshes its owner notebook automatically', async ({ page }) => {
  const initial = '# Soul\n\nMy default style.';
  const fixture = await museFixture(page, { soul: initial });
  fixture.response(async () => {
    updateSoul(fixture, initial + learned('Prefer short, practical answers.'));
    return { cards: [], updates: [], personalizationUpdated: true };
  });
  await send(page, 'I prefer short practical answers.');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await openNotebook(page);
  await expect(page.locator('.muze-vector-surface [id="muse-file-soul"]')).toContainText('Prefer short, practical answers.');
});
