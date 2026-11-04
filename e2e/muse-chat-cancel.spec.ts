import {expect, test, type Page} from '@playwright/test';
import {chat, museFixture, send} from './muse-fixture';

async function cancellationFixture(page: Page) {
  await museFixture(page);
  await page.evaluate(() => {
    const original = window.fetch;
    const fixture: {
      turns: {request: Record<string, unknown>; aborted: boolean; emit: (event: unknown) => void; finish: () => void}[];
      cancellations: {requestId: string; release: () => void}[];
      cancellationStatus: number;
      holdCancellation: boolean;
    } = (window as any).cancellationFixture = {turns: [], cancellations: [], cancellationStatus: 200, holdCancellation: true};
    window.fetch = async (input, init) => {
      if (String(input) !== '/api/muse/chat' || !['POST', 'DELETE'].includes(init?.method || '')) return original(input, init);
      const request = JSON.parse(String(init!.body));
      if (init!.method === 'DELETE') {
        let release!: () => void;
        const held = new Promise<void>(resolve => {release = resolve;});
        fixture.cancellations.push({requestId: request.requestId, release});
        if (fixture.holdCancellation) await held;
        return new Response('{}', {status: fixture.cancellationStatus});
      }
      return new Response(new ReadableStream({start(controller) {
        const turn = {request, aborted: false, emit: (event: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')), finish: () => controller.close()};
        fixture.turns.push(turn);
        init!.signal?.addEventListener('abort', () => {turn.aborted = true; controller.error(init!.signal!.reason);}, {once: true});
      }}), {headers: {'Content-Type': 'application/x-ndjson'}});
    };
  });
}

const counts = (page: Page) => page.evaluate(() => {
  const fixture = (window as any).cancellationFixture;
  return {turns: fixture.turns.length, cancellations: fixture.cancellations.length};
});
const progress = (page: Page, turn = 0) => page.evaluate(turn => (window as any).cancellationFixture.turns[turn].emit({type: 'progress', phase: 'context'}), turn);
const releaseCancellation = (page: Page, index = 0) => page.evaluate(index => (window as any).cancellationFixture.cancellations[index].release(), index);
async function finish(page: Page, turn: number, hasDraft = false) {
  await page.evaluate(turn => {
    const response = (window as any).cancellationFixture.turns[turn];
    response.emit({type: 'result', result: {messages: [{id: 'user-' + turn, role: 'user', content: response.request.message}, {id: 'answer-' + turn, role: 'assistant', content: 'Your next request was accepted.'}], actions: {cards: [], updates: []}}});
    response.finish();
  }, turn);
  await expect(page.getByRole('button', {name: 'Stop response', exact: true})).toHaveCount(0);
  if (hasDraft) await expect(page.locator('.muse-chat')).not.toHaveClass(/collapsed/);
  else { await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/); await chat(page); }
  await expect(page.getByText('Your next request was accepted.', {exact: true})).toBeVisible();
}

for (const width of [1440, 390]) test(`Stop then immediately send keeps the composer responsive at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900});
  await cancellationFixture(page);
  const input = page.getByRole('textbox', {name: 'Message Muse'});
  await send(page, 'Research a weekend plan');
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 0});
  await progress(page);
  await page.getByRole('button', {name: 'Stop response', exact: true}).click();
  await expect(input).toBeEnabled();
  await expect(page.getByRole('button', {name: 'Send to Muse', exact: true})).toBeVisible();

  await send(page, 'Actually, help with a shorter plan');
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 1});
  await expect(input).toBeEnabled();
  await input.fill('Keep this draft while the new answer arrives');
  await expect(input).toHaveValue('Keep this draft while the new answer arrives');
  await expect(page.locator('.muse-chat-error')).toHaveCount(0);
  await releaseCancellation(page);
  await expect.poll(() => counts(page)).toEqual({turns: 2, cancellations: 1});
  const state = await page.evaluate(() => {
    const {turns, cancellations} = (window as any).cancellationFixture;
    return {first: turns[0].request.requestId, next: turns[1].request.requestId, cancelled: cancellations[0].requestId, aborted: turns[0].aborted, message: turns[1].request.message};
  });
  expect(state.first).toMatch(/^[a-f\d-]{36}$/i);
  expect(state.next).not.toBe(state.first);
  expect(state.cancelled).toBe(state.first);
  expect(state.aborted).toBe(true);
  expect(state.message).toBe('Actually, help with a shorter plan');
  await finish(page, 1, true);
  await expect(input).toHaveValue('Keep this draft while the new answer arrives');
  await expect(page.locator('.muse-chat-error')).toHaveCount(0);
});

test('Stop before first server progress waits for acquisition and then accepts the next request', async ({page}) => {
  await cancellationFixture(page);
  await send(page, 'Start researching a plan');
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 0});
  await page.getByRole('button', {name: 'Stop response', exact: true}).click();
  await send(page, 'Use this direction instead');
  await expect(page.getByRole('textbox', {name: 'Message Muse'})).toBeEnabled();
  expect(await counts(page)).toEqual({turns: 1, cancellations: 0});
  await progress(page);
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 1});
  await releaseCancellation(page);
  await expect.poll(() => counts(page)).toEqual({turns: 2, cancellations: 1});
  await finish(page, 1);
  await expect(page.locator('.muse-chat-error')).toHaveCount(0);
});

test('failed Stop preserves the next draft and retries cancellation before submitting it', async ({page}) => {
  await cancellationFixture(page);
  await page.evaluate(() => {const fixture = (window as any).cancellationFixture; fixture.holdCancellation = false; fixture.cancellationStatus = 503;});
  await send(page, 'Research this first idea');
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 0});
  await progress(page);
  await page.getByRole('button', {name: 'Stop response', exact: true}).click();
  const error = page.locator('.muse-chat-error'), input = page.getByRole('textbox', {name: 'Message Muse'});
  await expect(error).toHaveText('Could not stop the previous response yet. Try again.');
  const draft = 'Here is the corrected plan I want to work on';
  await send(page, draft);
  await expect.poll(() => counts(page)).toEqual({turns: 1, cancellations: 2});
  await expect(error).toHaveText('Could not stop the previous response yet. Try again.');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(draft);
  await expect(page.getByRole('button', {name: 'Send to Muse', exact: true})).toBeEnabled();
  await page.evaluate(() => {(window as any).cancellationFixture.cancellationStatus = 200;});
  await page.getByRole('button', {name: 'Send to Muse', exact: true}).click();
  await expect.poll(() => counts(page)).toEqual({turns: 2, cancellations: 3});
  expect(await page.evaluate(() => {
    const fixture = (window as any).cancellationFixture;
    return fixture.cancellations.every((cancel: any) => cancel.requestId === fixture.turns[0].request.requestId);
  })).toBe(true);
  await finish(page, 1);
  await expect(error).toHaveCount(0);
});
