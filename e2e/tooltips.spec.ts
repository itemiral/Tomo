import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) test(`tool descriptions stay above the composer and inside the viewport at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'Muze', exact: true })).toHaveAttribute('data-ready', 'true');
  const composer = page.locator('.muse-chat-stack');
  const before = await composer.boundingBox();
  const draw = page.getByRole('button', { name: 'Draw', exact: true });
  await draw.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Sketch a freehand line with your mouse or pen.');
  const box = (await tooltip.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(before!.y - 9);
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
  expect(await composer.boundingBox()).toEqual(before);
  await expect(draw).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id'))!);
  await page.screenshot({ path: `verification/tooltips-${width}.png` });
  await page.mouse.move(200, 300);
  await expect(tooltip).toHaveCount(0);

  const paletteButton = page.locator('.muze-always-styles button').last();
  await paletteButton.hover();
  await expect(tooltip).toBeVisible();
  const paletteBox = (await tooltip.boundingBox())!;
  expect(paletteBox.x).toBeGreaterThanOrEqual(12);
  expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(width - 12);
});

test('keyboard tool descriptions dismiss with Escape without changing the tool', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'Muze', exact: true })).toHaveAttribute('data-ready', 'true');
  await page.keyboard.press('Tab');
  const hand = page.getByRole('button', { name: 'Hand', exact: true });
  await hand.focus();
  await expect(page.getByRole('tooltip')).toContainText('Grab the canvas and move around.');
  await expect(hand).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(hand).not.toHaveAttribute('aria-describedby');
  await expect(hand).toBeFocused();
});
