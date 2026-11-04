import { expect, test, type Page } from '@playwright/test';
import { exported, museFixture, send } from './muse-fixture';

type Packet = { message: string; board: string; project?: string; images?: { pageId: string; objectId: string; kind?: string; dataUrl: string }[] };
const emptyActions = { cards: [], updates: [] };
const note = (id: string, text: string, left = 240, top = 200) => ({ type: 'MuzeNote', id, text, left, top, width: 270, height: 240, fontFamily: 'IBM Plex Sans', fontSize: 20, fill: '#202124', backgroundColor: '#fff3aa' });

async function openBoard(page: Page, objects: Record<string, unknown>[], extras: Record<string, unknown> = {}) {
  const board = { id: 'project-fixture', name: 'Community workshop', activePage: 'page-main', pages: [{ id: 'page-main', name: 'Overview', objects, viewport: [1, 0, 0, 1, 0, 0] }], ...extras };
  await page.getByLabel('Open a board file', { exact: true }).setInputFiles({ name: 'project.muze', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'muze', version: 1, board })) });
  await expect(page.getByRole('main', { name: 'Tomo' })).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue('Community workshop');
}

async function select(page: Page, id: string, extend = false) {
  const element = page.locator(`.muze-vector-surface [id="${id}"]`); await expect(element).toBeVisible();
  const box = (await element.boundingBox())!;
  if (extend) await page.keyboard.down('Shift');
  await page.mouse.click(box.x + Math.min(30, box.width / 2), box.y + Math.min(35, box.height / 2));
  if (extend) await page.keyboard.up('Shift');
}

async function pixels(page: Page, source: string) {
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < values.length; i += 4) if (values[i + 3] && Math.max(values[i], values[i + 1], values[i + 2]) - Math.min(values[i], values[i + 1], values[i + 2]) > 30) colored++;
    return { width: image.width, height: image.height, colored };
  }, source);
}

test('a turn reads related pages and ordinary comments while keeping the private notebook separate', async ({ page }) => {
  const fixture = await museFixture(page, { soul: '# Soul\nPRIVATE_OWNER_STYLE_7Q', memory: '# Memory\nPRIVATE_OWNER_MEMORY_8R' });
  const requests: Packet[] = []; fixture.response(async body => { requests.push(body as Packet); return emptyActions; });
  const overview = note('workshop-goal', 'Workshop goal\nRun a welcoming community workshop.');
  const details = note('workshop-access', 'Workshop accessibility\nReserve wheelchair-accessible tables and a quiet room.');
  await openBoard(page, [overview], { pages: [{ id: 'page-main', name: 'Overview', objects: [overview], viewport: [1, 0, 0, 1, 0, 0] }, { id: 'page-details', name: 'Access and logistics', objects: [details], viewport: [1, 0, 0, 1, 0, 0] }], comments: [{ id: 'comment-access', pageId: 'page-details', author: 'Collaborator', text: 'Workshop access: confirm the elevator before inviting guests.', x: 500, y: 240 }] });
  await send(page, 'Continue our workshop plan and check accessibility');
  await expect.poll(() => requests.length).toBe(1);
  const packet = requests[0], project = JSON.parse(packet.project!);
  expect(project.pages.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['page-main', 'page-details']));
  expect(project.excerpts).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: 'page-details', objectId: 'workshop-access', text: expect.stringContaining('quiet room') })]));
  expect(project.comments).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'comment-access', text: expect.stringContaining('elevator') })]));
  expect(JSON.stringify(packet)).not.toMatch(/PRIVATE_OWNER_|muse-notebook/);
  expect(JSON.parse(packet.board).objects.map((item: { id: string }) => item.id)).toEqual(['workshop-goal']);
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open Muse', exact: true }).click();
  await page.getByRole('dialog', { name: 'Muse', exact: true }).getByRole('button', { name: 'Edit Muse', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Tomo' })).toHaveAttribute('data-muse-board', 'true');
  await send(page, 'Summarize my notebook preferences');
  await expect.poll(() => requests.length).toBe(2);
  const privateProject = JSON.parse(requests[1].project!);
  expect(privateProject.pages.map((item: { id: string }) => item.id)).toEqual(['muse-notebook']);
  expect(requests[1].board).toContain('PRIVATE_OWNER_STYLE_7Q');
  expect(JSON.stringify(requests[1])).not.toMatch(/workshop-goal|workshop-access|comment-access/);
});

test('a selected board image is sent as bounded real pixels with its scene reference', async ({ page }) => {
  const fixture = await museFixture(page); let captured: Packet | undefined;
  fixture.response(async body => { captured = body as Packet; return emptyActions; });
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 120;
    const context = canvas.getContext('2d')!; context.fillStyle = '#2766dc'; context.fillRect(0, 0, 90, 120); context.fillStyle = '#e74d3d'; context.fillRect(90, 0, 90, 120);
    return canvas.toDataURL('image/png');
  });
  await openBoard(page, [{ type: 'Image', id: 'color-study', left: 300, top: 230, width: 180, height: 120, src: source }]);
  await select(page, 'color-study');
  await send(page, 'Describe this picture');
  await expect.poll(() => captured?.images?.length).toBe(1);
  expect(JSON.parse(captured!.board).selectedIds).toEqual(['color-study']);
  expect(captured!.images![0]).toEqual(expect.objectContaining({ pageId: 'page-main', objectId: 'color-study', kind: 'image' }));
  expect(captured!.images![0].dataUrl).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  expect(captured!.images![0].dataUrl.length).toBeLessThanOrEqual(390_000);
  expect(await pixels(page, captured!.images![0].dataUrl)).toEqual({ width: 180, height: 120, colored: 21_600 });
  expect(JSON.parse(captured!.project!).images).toEqual(expect.arrayContaining([expect.objectContaining({ objectId: 'color-study', selected: true })]));
  expect(captured!.board).not.toContain('data:image'); expect(captured!.project).not.toContain('data:image');
});

test('unselected request additions stay near the relevant plan and undo without moving existing notes', async ({ page }) => {
  const fixture = await museFixture(page); let captured: Packet | undefined;
  await openBoard(page, [note('unrelated-archive', 'Holiday recipe collection\nCinnamon biscuits and apple pie.', 8000, 180), note('relevant-plan', 'Community workshop accessibility plan\nReserve a quiet room and accessible tables.', 240, 200)]);
  await expect(page.locator('.muze-vector-surface [id="relevant-plan"]')).toBeVisible();
  // Persist the canvas's imported defaults before comparing saved objects.
  await page.getByRole('button', { name: 'Zoom', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Zoom to 100%/ }).click();
  const before = await exported(page), anchor = before.objects.find(object => object.id === 'relevant-plan')!;
  fixture.response(async body => {
    captured = body as Packet;
    return { cards: [{ id: 'relevant-addition', title: 'Confirm access', body: 'Check the entrance and room layout with one participant.' }], updates: [] };
  });
  await send(page, 'Add a next step to the community workshop accessibility plan');
  await expect(page.locator('.muze-vector-surface [id="relevant-addition"]')).toBeVisible();
  expect(JSON.parse(captured!.board).selectedIds).toEqual([]);
  const after = await exported(page), added = after.objects.find(object => object.id === 'relevant-addition')!;
  expect(after.objects.filter(object => object.id !== added.id)).toEqual(before.objects);
  expect(added.left).toBeGreaterThanOrEqual(anchor.left + anchor.width);
  expect(added.left - anchor.left).toBeLessThan(1000); expect(Math.abs(added.top - anchor.top)).toBeLessThan(500);
  expect(added.left).toBeLessThan(2000);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toEqual(before.objects);
});

test('a plural visual request captures an unselected line-only diagram', async ({ page }) => {
  const fixture = await museFixture(page); let captured: Packet | undefined;
  fixture.response(async body => { captured = body as Packet; return emptyActions; });
  await openBoard(page, [{ type: 'Line', id: 'line-only', left: 260, top: 220, x1: 0, y1: 0, x2: 280, y2: 160, stroke: '#e95f27', strokeWidth: 6 }]);
  await expect(page.locator('.muze-vector-surface [id="line-only"]')).toBeVisible();
  const before = await exported(page);
  await send(page, 'Explain these diagrams');
  await expect.poll(() => captured?.images?.length).toBe(1);
  expect(JSON.parse(captured!.board).selectedIds).toEqual([]);
  expect(captured!.images![0]).toEqual(expect.objectContaining({ pageId: 'page-main', objectId: 'scene-preview', kind: 'scene' }));
  const image = await pixels(page, captured!.images![0].dataUrl);
  expect(image.colored).toBeGreaterThan(100); expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1024);
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled();
  const after = await exported(page); expect(after.objects).toEqual(before.objects); expect(after.viewport).toEqual(before.viewport);
});

for (const grouped of [false, true]) test(`selected ${grouped ? 'grouped' : 'single'} diagram capture preserves the viewport, selection and editable objects`, async ({ page }) => {
  const fixture = await museFixture(page); const requests: Packet[] = [];
  fixture.response(async body => { requests.push(body as Packet); return emptyActions; });
  const diagram = { type: 'Path', id: 'diagram-one', left: 220, top: 180, width: 260, height: 180, path: [['M', 0, 0], ['L', 260, 0], ['L', 260, 180], ['L', 0, 180], ['Z']], fill: '#ec8f32', stroke: '#1d1d1d', strokeWidth: 3 };
  const objects = grouped ? [{ type: 'Group', id: 'diagram-group', left: 220, top: 180, width: 260, height: 180, objects: [{ ...diagram, left: 0, top: 0 }] }] : [diagram];
  await openBoard(page, objects, { pages: [{ id: 'page-main', name: 'Overview', objects, viewport: [1.25, 0, 0, 1.25, -60, 40] }] });
  await select(page, grouped ? 'diagram-group' : 'diagram-one'); const before = await exported(page);
  await send(page, 'Explain this'); await expect.poll(() => requests.length).toBe(1);
  const first = requests[0]; expect(JSON.parse(first.board).selectedIds).toEqual(['diagram-one']);
  const scene = first.images?.find(image => image.objectId === 'scene-preview'); expect(scene?.kind).toBe('scene');
  const image = await pixels(page, scene!.dataUrl); expect(image.colored).toBeGreaterThan(1000); expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1024);
  expect(JSON.parse(first.project!).images).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: 'page-main', objectId: 'scene-preview', kind: 'scene' })]));
  await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled();
  const after = await exported(page); expect(after.objects).toEqual(before.objects); expect(after.viewport).toEqual(before.viewport);
  await send(page, 'Explain the same diagram briefly'); await expect.poll(() => requests.length).toBe(2);
  expect(JSON.parse(requests[1].board).selectedIds).toEqual(['diagram-one']);
});

test('streamed status labels progress without exposing thought text or applying partial results', async ({ page }) => {
  await museFixture(page);
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input) !== '/api/muse/chat' || init?.method !== 'POST') return original(input, init);
      (window as any).chatRequest = JSON.parse(String(init.body));
      return new Response(new ReadableStream({ start(controller) {
        (window as any).museEvent = (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
        (window as any).endMuseStream = () => controller.close();
        init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  await send(page, 'Help me get started');
  await expect.poll(() => page.evaluate(() => typeof (window as any).museEvent)).toBe('function');
  for (const [phase, label] of [['research', 'Checking sources…'], ['vision', 'Looking at the visuals…'], ['thinking', 'Working on it…'], ['saving', 'Finishing up…']]) {
    await page.evaluate(phase => (window as any).museEvent({ type: 'progress', phase, thought: 'INTERNAL_THOUGHT_MUST_NOT_APPEAR' }), phase);
    await expect(page.locator('.muse-chat header')).toContainText(label);
  }
  await page.evaluate(() => (window as any).museEvent({ type: 'progress', phase: 'INTERNAL_THOUGHT_MUST_NOT_APPEAR' }));
  await expect(page.getByText('INTERNAL_THOUGHT_MUST_NOT_APPEAR')).toHaveCount(0);
  await expect(page.locator('.muze-vector-surface [id="streamed-card"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).museEvent({ type: 'result', result: { messages: [{ id: 'answer', role: 'assistant', content: 'Here is one next step.' }], actions: { cards: [{ id: 'streamed-card', title: 'Start here', body: 'Choose one useful outcome.' }], updates: [] } } }));
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
  await expect(page.locator('.muze-vector-surface [id="streamed-card"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).endMuseStream());
  await expect(page.locator('.muze-vector-surface [id="streamed-card"]')).toBeVisible();
  await expect(page.getByText('Here is one next step.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
});
