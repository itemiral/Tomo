import { expect, test, type Page } from '@playwright/test';
import { museFixture, send } from './muse-fixture';

const rename = (page: Page, name: string) => page.evaluate(name => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-a', name } })), name);

test('chat errors and pending copy use the saved name and follow later renames', async ({ page }) => {
  await museFixture(page);
  await rename(page, 'Kumo');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/muse/chat', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await pending;
    await route.fulfill({ status: 502, json: { error: 'Muse could not prepare this lookup. Try again.' } });
  });
  const prompt = 'Generate an image of a cheerful banana';
  await send(page, prompt);
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toHaveAttribute('placeholder', 'Kumo is working…');
  release();
  const error = page.locator('.muse-chat-error');
  await expect(error).toHaveText('Kumo could not prepare this lookup. Try again.');
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toHaveValue(prompt);
  await rename(page, 'Little $&');
  await expect(error).toHaveText('Little $& could not prepare this lookup. Try again.');
  await rename(page, 'Muse');
  await expect(error).toHaveText('Muse could not prepare this lookup. Try again.');
});

test('personalized errors remain plain text rather than rendered markup', async ({ page }) => {
  await museFixture(page);
  await rename(page, 'Kumo');
  const markup = '<img src=x onerror="window.errorMarkupRan=true">';
  await page.route('**/api/muse/chat', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: markup + ' Muse could not complete this response.' } })
    : route.fallback());
  await send(page, 'Generate a picture of a moon garden');
  const error = page.locator('.muse-chat-error');
  await expect(error).toHaveText(markup + ' Kumo could not complete this response.');
  await expect(error.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { errorMarkupRan?: boolean }).errorMarkupRan)).toBeUndefined();
});
