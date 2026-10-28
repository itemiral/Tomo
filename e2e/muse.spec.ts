import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragMuse(page: Page, agent: Locator, destination: { x: number; y: number }) {
  const box = (await agent.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 40); await page.mouse.down();
  await page.mouse.move(destination.x + 50, destination.y + 40, { steps: 8 }); await page.mouse.up();
  await page.mouse.move(1380, 850);
}

async function expectMuseClear(page: Page, agent: Locator) {
  await expect(agent).toBeVisible();
  await expect.poll(() => agent.evaluate(element => {
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const parts = Array.from(element.querySelectorAll('.canvas-agent-node, .muse-agent-name, .muse-agent-listening, .muse-agent-thought')).map(part => part.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    const obstacles = Array.from(document.querySelectorAll('.muse-plan-surface, .react-flow__node, .muse-chat-dock, .muse-tools, .muse-topbar > *, .muse-bottom-controls, .muse-work-status, .muse-popover')).map(part => part.getBoundingClientRect());
    const otherAgents = Array.from(document.querySelectorAll('.muse-floating-agent')).filter(other => other !== element && other.getAttribute('data-positioned') !== 'false').flatMap(other => Array.from(other.querySelectorAll('.canvas-agent-node, .muse-agent-name')).map(part => part.getBoundingClientRect()));
    return parts.every(part => part.left >= 0 && part.right <= window.innerWidth && part.top >= 0 && part.bottom <= window.innerHeight && ![...obstacles, ...otherAgents].some(obstacle => overlaps(part, obstacle)));
  })).toBe(true);
}

test('starts with a direction, saves edits, and creates only empty new boards', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue('New board');
  await expect(page.locator('.muse-card')).toHaveCount(0);
  await expect(page.locator('.muse-floating-agent')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add checklist', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('My first steps');
  await page.getByLabel('Checklist · one item per line').fill('Make a sketch\nAsk a friend');
  await page.getByRole('button', { name: 'Save thought', exact: true }).click();
  await page.locator('.muse-plan-surface').getByRole('checkbox', { name: 'Make a sketch' }).click();
  await expect(page.locator('.muse-plan-surface').getByRole('checkbox', { name: 'Make a sketch' })).toBeChecked();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.muse-plan-surface').getByRole('checkbox', { name: 'Make a sketch' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Your preferences', exact: true }).click();
  await page.getByLabel('Things you’re drawn to').fill('Sketching, quiet places, slow travel');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.locator('.muse-save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('.muse-plan-surface').getByRole('checkbox', { name: 'Make a sketch' })).toBeChecked();
  await page.getByRole('button', { name: 'Your boards', exact: true }).click();
  await page.getByRole('button', { name: 'New board', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Board name').fill('My next idea');
  await page.getByRole('button', { name: 'Open a new board' }).click();
  await expect(page.getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue('My next idea');
  await expect(page.locator('.muse-card')).toHaveCount(0);
});

test('the four Muses refine one connected plan, with an automatic title', async ({ page }) => {
  let payload: Record<string, unknown> | null = null;
  await page.route('**/api/muse/chat', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ready: true } });
    payload = route.request().postDataJSON();
    const events = ['planner', 'explorer', 'critic', 'organizer'].flatMap(agent => [{ type: 'working', agent }, { type: 'result', turn: { agent, boardTitle: 'Creative weekend', reply: `A contribution from ${agent}.`, cards: [{ id: 'shared-plan', kind: 'note', title: 'Our weekend plan', body: `Refined by ${agent}`, color: 'neutral', items: [] }], removeCardIds: [], connections: [{ source: 'user-brief', target: 'shared-plan', label: 'the plan' }] } }]);
    await route.fulfill({ contentType: 'application/x-ndjson', body: [...events, { type: 'done' }].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('Help me outline a creative weekend.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue('Creative weekend');
  expect(payload).toMatchObject({ mode: 'team', message: 'Help me outline a creative weekend.', preferences: { name: 'Izat' } });
  await expect(page.locator('.muse-card')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.locator('.muse-plan-surface').getByText('Refined by organizer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.muse-plan-surface').getByText('Refined by critic', { exact: true })).toBeVisible();
});

test('background dragging pans and the Muses can be repositioned', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.muse-floating-agent')).toHaveCount(4);
  const viewport = page.locator('.react-flow__viewport');
  await expect(viewport).toHaveAttribute('style', /translate\(0px, 0px\)/);
  await page.mouse.move(650, 700); await page.mouse.down();
  await page.mouse.move(820, 600, { steps: 12 }); await page.mouse.up();
  await expect(viewport).not.toHaveAttribute('style', /translate\(0px, 0px\)/);
  const agent = page.locator('[data-agent="planner"]');
  const before = (await agent.boundingBox())!;
  await page.mouse.move(before.x + 50, before.y + 40); await page.mouse.down();
  await page.mouse.move(before.x + 240, before.y + 170, { steps: 12 }); await page.mouse.up();
  const after = (await agent.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(150);
  expect(after.y - before.y).toBeGreaterThan(90);
  const composer = (await page.locator('.muse-chat-dock').boundingBox())!;
  expect(Math.abs(composer.x + composer.width / 2 - 720)).toBeLessThan(2);
});

test('connection errors keep the draft and the board remains usable', async ({ page }) => {
  await page.route('**/api/muse/chat', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'The model could not connect.' } }) : route.fulfill({ json: { ready: true } }));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('A thought worth keeping');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.muse-chat-error')).toContainText('The model could not connect.');
  await expect(page.getByRole('textbox', { name: 'Message your Muses' })).toHaveValue('A thought worth keeping');
  await expect(page.getByRole('textbox', { name: 'Edit your direction' })).toHaveText('A thought worth keeping');
  await expect(page.locator('.muse-message.assistant')).toHaveCount(0);
});

test('the composer stays on screen on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.muse-floating-agent')).toHaveCount(4);
  const box = (await page.locator('.muse-composer').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThan(844);
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('A mobile thought');
  await page.getByRole('button', { name: 'Save thought', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit title: A mobile thought' })).toBeVisible();
  const plan = (await page.locator('.muse-plan-surface').boundingBox())!;
  expect(plan.x + plan.width).toBeLessThanOrEqual(390);
  const actions = (await page.locator('.muse-top-actions').boundingBox())!;
  expect(actions.x + actions.width).toBeLessThanOrEqual(390);
});

test('document edits persist, tooltips explain tools, and navigation jumps instantly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add note', exact: true }).hover();
  await expect(page.locator('.muse-tool-note .muse-tool-tip')).toBeVisible();
  await expect(page.locator('.muse-tool-note .muse-tool-tip')).toContainText('Put your own thought into the shared plan.');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('A direction');
  await page.getByLabel('Your thought', { exact: true }).fill('Keep this flexible.');
  await page.getByRole('button', { name: 'Save thought', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Edit details: A direction' });
  await field.fill('Make it a collaborative plan.');
  await field.blur();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveText('Keep this flexible.');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveText('Make it a collaborative plan.');
  const viewport = page.locator('.react-flow__viewport');
  const documentPosition = await viewport.getAttribute('style');
  const canvasButton = page.getByRole('button', { name: 'Go to canvas map', exact: true });
  const planButton = page.getByRole('button', { name: 'Go to plan', exact: true });
  await expect(page.locator('.muse-tools').getByRole('button', { name: 'Go to canvas map' })).toHaveCount(0);
  const canvasPosition = (await canvasButton.boundingBox())!, planPosition = (await planButton.boundingBox())!;
  expect(canvasPosition.x + canvasPosition.width).toBeLessThan(planPosition.x);
  expect(canvasPosition.y).toBe(planPosition.y);
  await page.getByRole('button', { name: 'Go to canvas map', exact: true }).click();
  await expect(viewport).not.toHaveAttribute('style', documentPosition!);
  await expect(page.locator('.muse-card').getByRole('heading', { name: 'A direction' })).toBeInViewport();
  await page.getByRole('button', { name: 'Go to plan', exact: true }).click();
  await expect(field).toBeInViewport();
  await expect(page.locator('.muse-save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Edit details: A direction' })).toHaveText('Make it a collaborative plan.');
  await expect(page.locator('.react-flow__attribution')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Auto layout');
});

test('Plan opens the first section at reading size and keeps the rest scrollable', async ({ page }) => {
  await page.route('**/api/muse/chat', route => route.fulfill({ contentType: 'application/x-ndjson', body: [
    { type: 'result', turn: { agent: 'planner', boardTitle: 'Community workshop', reply: 'The outline is ready.', cards: Array.from({ length: 5 }, (_, index) => ({ id: `section-${index}`, kind: 'note', title: `Step ${index + 1}`, body: 'Bring a small group together to learn and make something. Start with one achievable outcome, leave room for conversation, and finish with something each person can take home.', color: 'neutral', items: [] })), removeCardIds: [], connections: [] } },
    { type: 'done' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n' }));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('Outline a community workshop.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const scroll = page.locator('.muse-document-scroll');
  await expect(scroll.getByRole('textbox', { name: 'Edit title: Step 1', exact: true })).toBeVisible();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'Go to canvas map', exact: true }).click();
  const canvasZoom = () => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  expect(await canvasZoom()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  await expect(page.locator('.react-flow__node[data-id="user-brief"]')).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Fit all cards', exact: true }).click();
  expect(await canvasZoom()).toBeLessThan(1);
  await page.getByRole('button', { name: 'Go to canvas map', exact: true }).click();
  expect(await canvasZoom()).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Go to plan', exact: true }).click();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
  await expect(scroll.getByRole('textbox', { name: 'Edit title: Step 1', exact: true })).toBeInViewport();
  const readingSize = () => page.getByRole('textbox', { name: 'Edit details: Step 1', exact: true }).evaluate(element => {
    const viewport = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
    return parseFloat(getComputedStyle(element).fontSize) * viewport.a;
  });
  expect(await readingSize()).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Go to canvas map', exact: true }).click();
  expect(await canvasZoom()).toBeGreaterThanOrEqual(.9);
  await expect(page.locator('.react-flow__node[data-id="user-brief"]')).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Go to plan', exact: true }).click();
  expect(await readingSize()).toBeGreaterThanOrEqual(16);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(scroll.getByRole('textbox', { name: 'Edit title: Step 5', exact: true })).toBeInViewport();
});

test('agents leave home to work, recover from manual positioning, and return when done', async ({ page }) => {
  let release: (() => void) | undefined;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/muse/chat', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: {} });
    await responseReady;
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', turn: { agent: 'planner', boardTitle: 'A shared project', reply: 'A concise outline is ready.', cards: [{ id: 'shared-plan', kind: 'note', title: 'First step', body: 'Make a small prototype.', color: 'neutral', items: [] }], removeCardIds: [], connections: [] } }) + '\n' + JSON.stringify({ type: 'done' }) + '\n' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Talk to Planner', exact: true }).click();
  const agent = page.locator('[data-agent="planner"]');
  const homeX = Number(await agent.getAttribute('data-home-x'));
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('Outline a small project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(agent).toHaveClass(/is-working/);
  await expect.poll(async () => Math.abs((await agent.boundingBox())!.x - homeX)).toBeGreaterThan(100);
  const position = (await agent.boundingBox())!;
  await page.mouse.move(position.x + 50, position.y + 40); await page.mouse.down();
  await page.mouse.move(position.x - 150, position.y + 130, { steps: 12 }); await page.mouse.up();
  await page.mouse.move(1380, 850);
  await expectMuseClear(page, agent);
  await expect(agent).toHaveClass(/is-working/);
  release!();
  await expect(page.getByRole('button', { name: 'Stop Muses' })).toHaveCount(0);
  await expect.poll(async () => Math.abs((await agent.boundingBox())!.x - homeX)).toBeLessThan(2);
  await expect(agent).not.toHaveClass(/is-dragging/);
});

test('each dragged Muse resumes independently, including while the team is idle', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/muse/chat', async route => {
    await responseReady;
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done' }) + '\n' });
  });
  await page.goto('/');
  const planner = page.locator('[data-agent="planner"]'), explorer = page.locator('[data-agent="explorer"]');
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('Outline a small project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(planner).toHaveClass(/is-working/);
  await expectMuseClear(page, planner);
  // Both agents are deliberately dropped over the document before either timer expires.
  await dragMuse(page, planner, { x: 350, y: 300 });
  await dragMuse(page, explorer, { x: 550, y: 300 });
  await expectMuseClear(page, planner);
  await expectMuseClear(page, explorer);
  await expect(planner).toHaveClass(/is-working/);
  release();
  await expect(page.getByRole('button', { name: 'Stop Muses' })).toHaveCount(0);
  const homeX = Number(await explorer.getAttribute('data-home-x'));
  await dragMuse(page, explorer, { x: 550, y: 300 });
  await expect.poll(async () => Math.abs((await explorer.boundingBox())!.x - homeX)).toBeLessThan(2);
  await expectMuseClear(page, explorer);
});

test('working Muses stay beside the content after panning, switching views, and opening chat', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/muse/chat', async route => {
    await responseReady;
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done' }) + '\n' });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message your Muses' }).fill('Plan a community workshop.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const agent = page.locator('[data-agent="planner"]');
  await expect(agent).toHaveClass(/is-working/);
  await expectMuseClear(page, agent);
  const before = (await agent.boundingBox())!;
  // Move the document beneath the agent's old position.
  await page.mouse.move(950, 620); await page.mouse.down();
  await page.mouse.move(1300, 620, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => Math.abs((await agent.boundingBox())!.x - before.x)).toBeGreaterThan(100);
  await expectMuseClear(page, agent);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Planner is thinking', exact: true }).click();
  await expectMuseClear(page, agent);
  await page.getByRole('button', { name: 'Go to canvas map', exact: true }).click();
  await expectMuseClear(page, agent);
  await page.getByRole('button', { name: 'Go to plan', exact: true }).click();
  await expectMuseClear(page, agent);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectMuseClear(page, agent);
  for (const role of ['explorer', 'critic', 'organizer']) await expectMuseClear(page, page.locator(`[data-agent="${role}"]`));
  release();
  await expect(page.getByRole('button', { name: 'Stop Muses' })).toHaveCount(0);
});
