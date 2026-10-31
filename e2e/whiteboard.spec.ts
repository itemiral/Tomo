import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Shape = { fontFamily?: string; fontSize?: number; fontWeight?: string; autoWidth?: boolean; labelFor?: string; boxHeight?: number; textAlign?: string; frameId?: string; bend?: number; arrowEnd?: string; muzeDash?: string; muzeFill?: string; muzeKind?: string; id: string; type: string; left: number; top: number; width: number; height: number; scaleX: number; scaleY: number; text?: string; stroke?: string; fill?: string; src?: string; startBinding?: string; endBinding?: string; objects?: Shape[] };
type BoardFile = { format: string; board: { name: string; activePage: string; pages: { id: string; name: string; objects: Shape[]; viewport: number[] }[] } };
const shapes = (file: BoardFile) => file.board.pages.find(p => p.id === file.board.activePage)!.objects;
async function ready(page: Page) { await page.goto('/'); await expect(page.getByRole('button', { name: 'Draw', exact: true })).toBeVisible(); await expect(page.locator('canvas.upper-canvas')).toBeVisible(); await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true'); }
async function stroke(page: Page, tool: string, from = { x: 300, y: 240 }, to = { x: 520, y: 400 }) {
  if (tool === 'Eraser') await page.getByRole('button', { name: 'More tools', exact: true }).click();
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Muse Board file', exact: true }).click();
  const file = await pending, bytes = await readFile((await file.path())!);
  return { filename: file.suggestedFilename(), bytes, board: JSON.parse(bytes.toString()) as BoardFile };
}
async function newBoard(page: Page) { await page.getByRole('button', { name: 'Main menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'New board', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Board name' })).toHaveValue('Untitled board'); }

test('draws shapes, connected arrows, handwriting, editable text and notes on our own canvas', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page); await expect(page).toHaveTitle('Muse Board — your whiteboard');
  await expect(page.getByText(/license for production/i)).toHaveCount(0);
  expect((await request.get('/api/muse/chat?thread=board:page')).status()).toBe(401);
  await stroke(page, 'Rectangle', { x: 250, y: 220 }, { x: 440, y: 350 });
  await stroke(page, 'Rectangle', { x: 700, y: 220 }, { x: 890, y: 350 });
  await stroke(page, 'Arrow', { x: 345, y: 285 }, { x: 795, y: 285 });
  await stroke(page, 'Draw', { x: 260, y: 470 }, { x: 480, y: 530 });
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(570, 450); await page.keyboard.type('A place for ideas'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Note', exact: true }).click(); await page.mouse.click(850, 500); await page.keyboard.type('Try something new'); await page.keyboard.press('Escape');
  const file = (await save(page)).board, objects = shapes(file);
  expect(objects.map(o => o.type).sort()).toEqual(['MuzeArrow', 'MuzeNote', 'MuzeShape', 'MuzeShape', 'MuzeText', 'Path']);
  expect(objects.find(o => o.type === 'MuzeArrow')).toMatchObject({ startBinding: objects[0].id, endBinding: objects[1].id });
  expect(objects.find(o => o.type === 'MuzeText')?.text).toBe('A place for ideas');
  expect(objects.find(o => o.type === 'MuzeNote')?.text).toBe('Try something new');
  expect(errors).toEqual([]); await expect(page.locator('.muze-toast')).toHaveCount(0);
  await page.screenshot({ path: 'verification/muze-native-drawing.png' });
});

test('styles, moves, resizes, duplicates, groups, undoes and erases canvas objects', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle');
  await page.getByRole('button', { name: 'Red', exact: true }).click(); await page.getByRole('button', { name: 'Solid fill', exact: true }).click();
  let objects = shapes((await save(page)).board); expect(objects[0].stroke).toBe('#e03131');
  await page.mouse.move(410, 300); await page.mouse.down(); await page.mouse.move(530, 380, { steps: 10 }); await page.mouse.up();
  objects = shapes((await save(page)).board); expect(objects[0].left).toBeGreaterThan(400); expect(objects[0].top).toBeGreaterThan(300);
  await page.mouse.move(642, 482); await page.mouse.down(); await page.mouse.move(720, 540, { steps: 10 }); await page.mouse.up();
  const resized = shapes((await save(page)).board)[0]; expect(resized.width).toBeGreaterThan(260);
  await page.getByRole('button', { name: 'Duplicate selected', exact: true }).click(); expect(shapes((await save(page)).board)).toHaveLength(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(shapes((await save(page)).board)).toHaveLength(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect(shapes((await save(page)).board)).toHaveLength(2);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+g'); expect(shapes((await save(page)).board)[0].type).toBe('Group');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(shapes((await save(page)).board)).toHaveLength(2);
  await stroke(page, 'Eraser', { x: 510, y: 400 }, { x: 600, y: 450 }); expect(shapes((await save(page)).board).length).toBeLessThan(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(shapes((await save(page)).board)).toHaveLength(2);
});

test('keeps boards and pages separate and saves drawings immediately for reload', async ({ page }) => {
  await ready(page); await page.getByRole('textbox', { name: 'Board name' }).fill('Design ideas'); await page.getByRole('textbox', { name: 'Board name' }).press('Enter');
  await stroke(page, 'Rectangle');
  await page.getByRole('button', { name: 'Pages', exact: true }).click(); await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await stroke(page, 'Draw'); const first = await save(page); expect(first.filename).toBe('Design ideas.muze'); expect(first.board.board.pages).toHaveLength(2);
  await newBoard(page); await page.getByRole('textbox', { name: 'Board name' }).fill('Second board'); await page.getByRole('textbox', { name: 'Board name' }).press('Enter'); await stroke(page, 'Rectangle');
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Board name' })).toHaveValue('Second board'); expect(shapes((await save(page)).board)).toHaveLength(1);
  await page.getByRole('button', { name: 'Main menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Design ideas', exact: true }).click();
  const restored = (await save(page)).board; expect(restored.board.pages).toHaveLength(2); expect(shapes(restored).map(o => o.id)).toEqual(shapes(first.board).map(o => o.id));
});

test('saves and opens images in a portable board file without replacing existing work', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle');
  await page.getByLabel('Choose an image').setInputFiles({ name: 'circle.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="45" fill="#4564ef"/></svg>') });
  await expect(page.getByRole('button', { name: 'Duplicate selected' })).toBeEnabled();
  await expect.poll(async () => shapes((await save(page)).board).length).toBe(2);
  const original = await save(page); expect(shapes(original.board).find(o => o.type === 'Image')?.src).toMatch(/^data:image\/png/);
  await newBoard(page); await page.getByRole('textbox', { name: 'Board name' }).fill('Keep this board'); await page.getByRole('textbox', { name: 'Board name' }).press('Enter');
  await page.getByLabel('Open a board file').setInputFiles({ name: 'import.muze', mimeType: 'application/json', buffer: original.bytes });
  await expect(page.getByRole('textbox', { name: 'Board name' })).toHaveValue(original.board.board.name);
  await page.reload(); await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  const imported = (await save(page)).board; expect(shapes(imported).map(o => o.id)).toEqual(shapes(original.board).map(o => o.id));
  await page.getByRole('button', { name: 'Main menu', exact: true }).click(); await expect(page.getByRole('menuitem', { name: 'Keep this board', exact: true })).toBeVisible();
});

test('rejects damaged files without altering the current board', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle'); const before = await save(page);
  await page.getByLabel('Open a board file').setInputFiles({ name: 'broken.muze', mimeType: 'application/json', buffer: Buffer.from('{"not":"a board"}') });
  await expect(page.locator('.muze-toast')).toContainText('Choose a valid Muse Board file.'); expect(shapes((await save(page)).board).map(o => o.id)).toEqual(shapes(before.board).map(o => o.id));
});

test('pans, zooms, draws a minimap, and exports real PNG and SVG files', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle'); const before = (await save(page)).board;
  await stroke(page, 'Hand', { x: 800, y: 600 }, { x: 1000, y: 700 });
  const after = (await save(page)).board; expect(after.board.pages[0].viewport[4] - before.board.pages[0].viewport[4]).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.getByRole('button', { name: 'Zoom', exact: true })).not.toHaveText('100%');
  await page.getByRole('button', { name: 'Toggle minimap', exact: true }).click(); await expect(page.getByLabel('Minimap', { exact: true })).toBeVisible();
  for (const format of ['PNG', 'SVG']) {
    await page.getByRole('button', { name: 'Export', exact: true }).click(); const pending = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export as ' + format, exact: true }).click();
    const file = await pending, bytes = await readFile((await file.path())!); expect(file.suggestedFilename()).toMatch(new RegExp('\\.' + format.toLowerCase() + '$'));
    if (format === 'SVG') expect(bytes.toString()).toContain('<svg'); else expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  }
});

test('offers the extra drawing tools and a phone layout with reachable controls', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 }); await ready(page);
  await stroke(page, 'Draw', { x: 80, y: 220 }, { x: 280, y: 390 }); expect(shapes((await save(page)).board)).toHaveLength(1);
  await page.getByRole('button', { name: 'More tools', exact: true }).click(); await expect(page.getByRole('button', { name: 'Star', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ellipse', exact: true }).click(); await page.mouse.move(100, 430); await page.mouse.down(); await page.mouse.move(260, 550, { steps: 8 }); await page.mouse.up();
  expect(shapes((await save(page)).board)).toHaveLength(2);
  for (const label of ['Main menu', 'Select', 'Export']) { const box = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(393); expect(box.y + box.height).toBeLessThanOrEqual(852); }
  await page.screenshot({ path: 'verification/muze-native-mobile.png' });
});

test('keeps connectors attached after moving shapes and gives duplicated groups new identities', async ({ page }) => {
  await ready(page);
  await stroke(page, 'Rectangle', { x: 250, y: 220 }, { x: 440, y: 350 });
  await page.getByRole('button', { name: 'Soft fill', exact: true }).click();
  await stroke(page, 'Rectangle', { x: 700, y: 220 }, { x: 890, y: 350 });
  await stroke(page, 'Arrow', { x: 345, y: 285 }, { x: 795, y: 285 });
  const before = shapes((await save(page)).board).find(o => o.type === 'MuzeArrow')!;
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.mouse.move(345, 285); await page.mouse.down(); await page.mouse.move(465, 365, { steps: 10 }); await page.mouse.up();
  const moved = shapes((await save(page)).board).find(o => o.type === 'MuzeArrow')!;
  expect(moved.left).toBeGreaterThan(before.left + 70);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+g');
  await page.getByRole('button', { name: 'Duplicate selected', exact: true }).click();
  const groups = shapes((await save(page)).board); expect(groups).toHaveLength(2);
  const ids = groups.flatMap(group => [group.id, ...group.objects!.map(o => o.id)]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const group of groups) { const arrow = group.objects!.find(o => o.type === 'MuzeArrow')!; expect(group.objects!.map(o => o.id)).toEqual(expect.arrayContaining([arrow.startBinding, arrow.endBinding])); }
});

test('saves text while it is being edited and retains readable drawing data across theme changes', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(350, 260); await page.keyboard.type('Save this thought');
  const pending = page.waitForEvent('download'); await page.keyboard.press('ControlOrMeta+s'); const file = await pending;
  expect(shapes(JSON.parse(await readFile((await file.path())!, 'utf8')))[0].text).toBe('Save this thought');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Main menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Dark canvas', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveClass(/muze-dark/);
  expect(shapes((await save(page)).board)[0].fill).toBe('#1d1d1d');
  await page.screenshot({ path: 'verification/muze-native-dark.png' });
});

test('matches the measured type widths and line heights for all four fonts and sizes', async ({ page }) => {
  test.setTimeout(60000);
  await ready(page); await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.mouse.click(180, 230); await page.keyboard.insertText('Hamburgefonts 0123456789 AaBbYy'); await page.keyboard.press('Escape');
  const widths = [[337.890625, 450.1875, 674.78125, 824.515625], [308.75, 411.328125, 616.5, 753.28125], [318.765625, 424.671875, 636.515625, 777.734375], [335.8125, 447.40625, 670.609375, 819.40625]];
  for (const [fontIndex, font] of ['Draw', 'Sans', 'Serif', 'Mono'].entries()) {
    await page.getByRole('button', { name: font + ' font', exact: true }).click();
    for (const [sizeIndex, size] of ['S', 'M', 'L', 'XL'].entries()) {
      await page.getByRole('button', { name: size + ' stroke size', exact: true }).click();
      const text = shapes((await save(page)).board)[0];
      expect(text.fontSize).toBe([18, 24, 36, 44][sizeIndex]);
      expect(text.height).toBe([24, 32, 49, 59][sizeIndex]);
      expect(Math.abs(text.width - widths[fontIndex][sizeIndex]), font + ' ' + size + ' width').toBeLessThan(.12);
    }
  }
  await page.getByRole('button', { name: 'Draw font', exact: true }).click();
  await page.getByRole('button', { name: 'M stroke size', exact: true }).click();
  await page.keyboard.press('Enter'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('First line\nSecond line'); await page.keyboard.press('Escape');
  expect(shapes((await save(page)).board)[0].height).toBe(64);
  await page.screenshot({ path: 'verification/muze-typography.png' });
});

test('supports auto-width text, drag-to-wrap text, and removes empty text', async ({ page }) => {
  await ready(page); await page.mouse.dblclick(200, 220); await page.keyboard.insertText('Text grows as you type without an arbitrary box'); await page.keyboard.press('Escape');
  let objects = shapes((await save(page)).board);
  expect(objects[0]).toMatchObject({ type: 'MuzeText', autoWidth: true, fontFamily: 'Shantell Sans', top: 204 }); expect(objects[0].width).toBeGreaterThan(450);
  await stroke(page, 'Text', { x: 200, y: 380 }, { x: 410, y: 430 }); await page.keyboard.insertText('This text wraps within a width that I deliberately chose.'); await page.keyboard.press('Escape');
  objects = shapes((await save(page)).board); expect(objects[1]).toMatchObject({ autoWidth: false, width: 210 }); expect(objects[1].height).toBeGreaterThan(64);
  await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(850, 500); await page.keyboard.press('Escape');
  expect(shapes((await save(page)).board)).toHaveLength(2);
});

test('edits shape labels, moves and duplicates them with their shapes, and restores them', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle', { x: 230, y: 200 }, { x: 530, y: 370 });
  await page.mouse.dblclick(380, 270); await page.keyboard.insertText('One shared plan'); await page.keyboard.press('Escape');
  let objects = shapes((await save(page)).board), label = objects.find(o => o.labelFor)!;
  expect(label).toMatchObject({ text: 'One shared plan', labelFor: objects[0].id, fontFamily: 'Shantell Sans', fontSize: 22, textAlign: 'center' });
  await page.mouse.move(380, 280); await page.mouse.down(); await page.mouse.move(500, 360, { steps: 12 }); await page.mouse.up();
  objects = shapes((await save(page)).board); expect(objects.find(o => o.labelFor)!.left - label.left).toBeCloseTo(120, 0);
  await page.getByRole('button', { name: 'Duplicate selected', exact: true }).click();
  objects = shapes((await save(page)).board); expect(objects).toHaveLength(4);
  for (const item of objects.filter(o => o.labelFor)) expect(objects.map(o => o.id)).toContain(item.labelFor);
  expect(new Set(objects.map(o => o.id)).size).toBe(4);
  await page.reload(); await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true');
  expect(shapes((await save(page)).board).filter(o => o.text === 'One shared plan')).toHaveLength(2);
});

test('centers notes at the cursor and reflects selected fonts, size, and colors', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Note', exact: true }).click(); await page.mouse.click(500, 350);
  await page.keyboard.insertText('A note with a next step'); await page.keyboard.press('Escape');
  let note = shapes((await save(page)).board)[0]; expect(note).toMatchObject({ left: 400, top: 250, width: 200, height: 200, textAlign: 'center', fontFamily: 'Shantell Sans', fontSize: 22 });
  await page.getByRole('button', { name: 'Serif font', exact: true }).click(); await page.getByRole('button', { name: 'L stroke size', exact: true }).click(); await page.getByRole('button', { name: 'Blue', exact: true }).click();
  await stroke(page, 'Rectangle', { x: 800, y: 300 }, { x: 1000, y: 450 });
  await page.getByRole('button', { name: 'Red', exact: true }).click();
  await page.mouse.click(500, 350);
  await expect(page.getByRole('button', { name: 'Serif font', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('button', { name: 'Blue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  note = shapes((await save(page)).board)[0]; expect(note.fontSize).toBe(26);
});

test('locks tools for repeated shapes, constrains lines, and zooms to the selection', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Rectangle', exact: true }).click(); await page.keyboard.press('q');
  for (const x of [240, 600]) { await page.mouse.move(x, 240); await page.mouse.down(); await page.mouse.move(x + 180, 380, { steps: 12 }); await page.mouse.up(); }
  expect(shapes((await save(page)).board)).toHaveLength(2); await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('a'); await page.keyboard.down('Shift'); await page.mouse.move(300, 500); await page.mouse.down(); await page.mouse.move(650, 520, { steps: 12 }); await page.mouse.up(); await page.keyboard.up('Shift');
  const arrow = shapes((await save(page)).board).find(o => o.type === 'MuzeArrow')!; expect(arrow.height).toBeLessThan(1);
  await page.keyboard.press('Shift+2'); const zoomed = (await save(page)).board.board.pages[0].viewport[0]; expect(zoomed).toBeGreaterThan(1); expect(zoomed).toBeLessThanOrEqual(2);
  await page.keyboard.press('Shift+0'); await expect(page.getByRole('button', { name: 'Zoom', exact: true })).toHaveText('100%');
});

test('reshapes arrows with their handles and preserves curved connectors and arrowheads', async ({ page }) => {
  await ready(page); await stroke(page, 'Arrow', { x: 300, y: 300 }, { x: 700, y: 300 });
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(500, 420, { steps: 15 }); await page.mouse.up();
  let arrow = shapes((await save(page)).board)[0]; expect(Math.abs(arrow.bend || 0)).toBeGreaterThan(100);
  await page.getByLabel('Arrow end', { exact: true }).selectOption('triangle');
  await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(820, 230, { steps: 15 }); await page.mouse.up();
  arrow = shapes((await save(page)).board)[0]; expect(arrow.arrowEnd).toBe('triangle'); expect(arrow.width).toBeGreaterThan(500);
  await page.reload(); await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true');
  arrow = shapes((await save(page)).board)[0]; expect(arrow.arrowEnd).toBe('triangle'); expect(Math.abs(arrow.bend || 0)).toBeGreaterThan(100);
});

test('moves frame contents together, snaps shapes, and navigates through the minimap', async ({ page }) => {
  await ready(page); await page.keyboard.press('f'); await page.mouse.move(200, 170); await page.mouse.down(); await page.mouse.move(650, 500, { steps: 12 }); await page.mouse.up();
  await stroke(page, 'Rectangle', { x: 300, y: 270 }, { x: 450, y: 380 });
  let objects = shapes((await save(page)).board); const frame = objects.find(o => o.muzeKind === 'frame')!, child = objects.find(o => o.type === 'MuzeShape')!; expect(child.frameId).toBe(frame.id);
  await page.mouse.move(210, 190); await page.mouse.down(); await page.mouse.move(330, 260, { steps: 12 }); await page.mouse.up();
  objects = shapes((await save(page)).board); expect(objects.find(o => o.id === child.id)!.left - child.left).toBeCloseTo(120, 0);
  await stroke(page, 'Rectangle', { x: 900, y: 240 }, { x: 1050, y: 350 });
  await page.keyboard.down('Control'); await page.mouse.move(975, 280); await page.mouse.down(); await page.mouse.move(925, 378, { steps: 12 }); await page.mouse.up(); await page.keyboard.up('Control');
  objects = shapes((await save(page)).board); const rectangles = objects.filter(o => o.type === 'MuzeShape'); expect(Math.abs(rectangles[0].top - rectangles[1].top)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Toggle minimap', exact: true }).click(); const viewport = (await save(page)).board.board.pages[0].viewport;
  await page.getByLabel('Minimap', { exact: true }).locator('svg').click({ position: { x: 170, y: 90 } });
  expect((await save(page)).board.board.pages[0].viewport).not.toEqual(viewport);
});

test('copies labeled drawings between pages and pastes external text after copying a shape', async ({ page }) => {
  await ready(page); await stroke(page, 'Rectangle'); await page.keyboard.press('Enter'); await page.keyboard.insertText('Reusable idea'); await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+c');
  await page.getByRole('button', { name: 'Pages', exact: true }).click(); await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => shapes((await save(page)).board).length).toBe(2);
  let objects = shapes((await save(page)).board); expect(objects.find(o => o.labelFor)?.text).toBe('Reusable idea');
  await page.evaluate(() => { const data = new DataTransfer(); data.setData('text/plain', 'Something copied from another app'); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await page.keyboard.press('Escape'); objects = shapes((await save(page)).board); expect(objects).toHaveLength(3); expect(objects.find(o => o.type === 'MuzeText')?.text).toBe('Something copied from another app');
});

test('formats rich text, embeds fonts in SVG, and exports visible pixels in PNG', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Text', exact: true }).click(); await page.mouse.click(300, 260); await page.keyboard.insertText('An important thought'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+b'); await page.keyboard.press('Escape');
  await expect(page.locator('.muze-vector-surface text')).toContainText('An important thought');
  await page.getByRole('button', { name: 'Export', exact: true }).click(); let pending = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export as SVG', exact: true }).click(); let file = await pending;
  const svg = await readFile((await file.path())!, 'utf8'); expect(svg).toContain('data:font/woff2;base64,'); expect(svg).toContain('font-weight: bold');
  await page.getByRole('button', { name: 'Export', exact: true }).click(); pending = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export as PNG', exact: true }).click(); file = await pending;
  const png = await readFile((await file.path())!);
  const pixels = await page.evaluate(async source => { const image = new Image(); image.src = source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, image.width, image.height).data; let visible = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 100) visible++; return visible; }, 'data:image/png;base64,' + png.toString('base64'));
  expect(pixels).toBeGreaterThan(500);
  const original = await save(page); await newBoard(page); await page.getByLabel('Open a board file').setInputFiles({ name: 'formatted.muze', mimeType: 'application/json', buffer: original.bytes });
  await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true'); await expect(page.locator('.muze-vector-surface text')).toContainText('An important thought');
});

test('supports two-finger panning and pinch zoom without creating accidental shapes', async ({ page, context }) => {
  await page.setViewportSize({ width: 800, height: 900 }); await ready(page); await stroke(page, 'Rectangle');
  const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 550, id: 1 }, { x: 500, y: 550, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 220, y: 590, id: 1 }, { x: 580, y: 590, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const file = (await save(page)).board; expect(file.board.pages[0].viewport[0]).toBeGreaterThan(1.5); expect(file.board.pages[0].viewport[0]).toBeLessThanOrEqual(2); expect(shapes(file)).toHaveLength(1);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await stroke(page, 'Draw', { x: 100, y: 250 }, { x: 300, y: 390 }); expect(shapes((await save(page)).board)).toHaveLength(2);
});
