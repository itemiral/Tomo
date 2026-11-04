import { expect, test, type Page } from '@playwright/test';
import { museFixture, exported, chat, send } from './muse-fixture';
import type { Board } from '../src/components/muze/storage';
import {removesProtectedObjects, type ProtectedBoardObject} from '../src/lib/shared-board-leases';

const boardId = '1d6e0a20-9095-4bd3-a826-f53c6d9cd480';
type Role = 'owner' | 'editor';

// Browser fixtures share a small revisioned API. Database permissions are
// exercised separately against Postgres; these tests exercise actual UI state.
function sharedApi() {
  let board: Board | null = null, revision = 0, tokenVersion = 0, token: string | null = null;
  const members = new Map<string, Role>();
  const published: Board[] = [], saves: Board[] = [], joins: string[] = [];
  const leases=new Map<string,{user:string;objects:ProtectedBoardObject[]}>();
  const protectedObjects=()=>[...leases.values()].flatMap(value=>value.objects);
  return {
    published, saves, joins,
    activeLeases:()=>leases.size,
    acquire(user:string,requestId:string,objects:{pageId:string;objectId:string}[]){leases.set(requestId,{user,objects:objects.map(item=>({...item,expiresAt:new Date(Date.now()+90000).toISOString()}))});},
    current: () => board,
    token: () => token,
    remoteChange(change: (board: Board) => Board) { board = change(structuredClone(board!)); revision++; },
    async attach(page: Page, actor: () => string) {
      await page.route('**/api/boards{,/**}', async route => {
        const request = route.request(), url = new URL(request.url());
        const path = url.pathname.slice('/api/boards'.length), method = request.method();
        const user = actor(), role = members.get(user);
        const body = method === 'POST' || method === 'PUT' || method === 'DELETE' && path.endsWith('/leases') ? request.postDataJSON() : null;
        const snapshot = () => ({ board, revision: String(revision), role: members.get(user),protectedObjects:protectedObjects() });
        if (!user) return route.fulfill({ status: 401, json: { error: 'Sign in to join this board.' } });
        if (!path && method === 'GET') return route.fulfill({ json: { boards: role && board ? [{ id: boardId, name: board.name, role, updatedAt: new Date().toISOString() }] : [] } });
        if (!path && method === 'POST') {
          published.push(structuredClone(body.board));
          board = { ...structuredClone(body.board), id: boardId };
          revision++; members.set(user, 'owner');
          return route.fulfill({ json: snapshot() });
        }
        if (path === '/join') {
          if (!board || body.boardId !== boardId || !token || body.token !== token) return route.fulfill({ status: 404, json: { error: 'This invite link is no longer available.' } });
          if (!members.has(user)) { members.set(user, 'editor'); joins.push(user); }
          return route.fulfill({ json: snapshot() });
        }
        if (!role || !board || !path.startsWith('/' + boardId)) return route.fulfill({ status: 404, json: { error: 'This board is not available to your account.' } });
        if(path.endsWith('/leases')){
          const held=leases.get(body.requestId);if(held&&held.user!==user)return route.fulfill({status:403,json:{error:'Private request.'}});
          if(method==='DELETE')leases.delete(body.requestId);
          return route.fulfill({json:{}});
        }
        if (path.endsWith('/invite')) {
          if (role !== 'owner') return route.fulfill({ status: 403, json: { error: 'Only the board owner can manage invitations.' } });
          if (method === 'DELETE') { token = null; return route.fulfill({ json: { revoked: true } }); }
          token = 'a'.repeat(42) + String(++tokenVersion % 10);
          return route.fulfill({ json: { token } });
        }
        if (method === 'PUT') {
          if (body.revision !== String(revision)) return route.fulfill({ status: 409, json: { error: 'This board changed elsewhere.' } });
          if(removesProtectedObjects(board,body.board,protectedObjects()))return route.fulfill({status:423,json:{error:'Muse is using those notes. Try deleting them after the response finishes.'}});
          board = structuredClone(body.board); revision++; saves.push(structuredClone(board!));
        }
        return route.fulfill({ json: snapshot() });
      });
    },
  };
}

async function openLink(page: Page, token?: string) {
  await page.evaluate(({ boardId, token }) => {
    history.pushState(null, '', '/__muse-fixture?board=' + boardId + (token ? '#invite=' + token : ''));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, { boardId, token });
}

async function addNote(page: Page, text: string, x = 420, y = 280) {
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.mouse.click(x, y);
  await page.keyboard.insertText(text);
  await page.keyboard.press('Escape');
}

async function openShare(page: Page) {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  return page.getByRole('dialog', { name: 'Share board', exact: true });
}

const canvasText = (page: Page) => page.locator('.muze-vector-surface').evaluateAll(elements => elements.map(element => element.textContent).join('').replace(/\s+/g, ''));
async function localWorkspace(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('muze-whiteboards', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<string>((resolve, reject) => { const request = db.transaction('workspace').objectStore('workspace').get('current'); request.onsuccess = () => resolve(JSON.stringify(request.result)); request.onerror = () => reject(request.error); }); } finally { db.close(); }
  });
}

test('shared board endpoints require a real signed-in session', async ({ request }) => {
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3201';
  for (const path of ['/api/boards', '/api/boards/' + boardId]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toContain('no-store');
  }
  for (const path of ['/api/boards', '/api/boards/join', '/api/boards/' + boardId + '/invite', '/api/boards/' + boardId + '/leases']) {
    expect((await request.post(path, { headers: { Origin: origin }, data: {} })).status()).toBe(401);
  }
  expect((await request.put('/api/boards/' + boardId, { headers: { Origin: origin }, data: {} })).status()).toBe(401);
  expect((await request.delete('/api/boards/' + boardId + '/invite', { headers: { Origin: origin } })).status()).toBe(401);
  expect((await request.delete('/api/boards/' + boardId + '/leases', { headers: { Origin: origin }, data: {} })).status()).toBe(401);
  expect((await request.post('/api/boards/join', { headers: { Origin: 'https://another.invalid' }, data: {} })).status()).toBe(403);
});

test('an invited editor sees shared notes and changes sync back without publishing private Muse files', async ({ page, browser }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = sharedApi();
  await api.attach(page, () => 'owner-a');
  await museFixture(page);
  await addNote(page, 'Plan the community workshop');
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(share.getByRole('button', { name: 'Copy invite link', exact: true })).toBeVisible();
  await share.getByRole('button', { name: 'Copy invite link', exact: true }).click();
  await expect(share.getByText('Link copied', { exact: true })).toBeVisible();
  const copiedLink = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copiedLink.searchParams.get('board')).toBe(boardId);
  expect(new URLSearchParams(copiedLink.hash.slice(1)).get('invite')).toBe(api.token());
  expect(JSON.stringify(api.published)).not.toMatch(/muse-file-soul|muse-file-memory|muse-private/);
  expect(api.published).toHaveLength(1);
  await expect.poll(() => localWorkspace(page)).not.toContain('Plan the community workshop');
  await page.screenshot({ path: 'verification/shared-board-invite.png' });
  await page.keyboard.press('Escape');

  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const second = await secondContext.newPage();
    let actor = 'owner-b'; await api.attach(second, () => actor);
    const fixture = await museFixture(second); await fixture.owner('owner-b');
    await openLink(second, api.token()!);
    await expect.poll(() => canvasText(second)).toContain('Planthecommunityworkshop');
    await expect.poll(() => new URL(second.url()).hash).toBe('');
    const editorShare = await openShare(second);
    await expect(editorShare.getByRole('button', { name: 'Copy board link', exact: true })).toBeVisible();
    await expect(editorShare.getByRole('button', { name: 'Reset invite link' })).toHaveCount(0);
    await expect(editorShare.getByRole('button', { name: 'Disable invite link' })).toHaveCount(0);
    await second.keyboard.press('Escape');

    await addNote(second, 'Invite the neighborhood', 850, 420);
    await expect.poll(() => JSON.stringify(api.current())).toContain('Invite the neighborhood');
    await expect.poll(() => canvasText(page), { timeout: 10000 }).toContain('Invitetheneighborhood');
    expect((await exported(page)).objects).toHaveLength(2);
    await addNote(page, 'Temporary owner idea', 500, 580);
    await expect.poll(() => api.current()?.pages[0].objects.length).toBe(3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => JSON.stringify(api.current())).not.toContain('Temporary owner idea');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => api.current()?.pages[0].objects.length).toBe(2);
    expect(JSON.stringify(api.current())).toContain('Invite the neighborhood');
    expect(JSON.stringify(api.current())).toContain('Plan the community workshop');

    const cachedWorkspace = await localWorkspace(second);
    expect(cachedWorkspace).not.toContain('Invite the neighborhood');
    expect(cachedWorkspace).not.toContain(boardId);
    expect(JSON.stringify(api.saves)).not.toMatch(/muse-file-soul|muse-file-memory|muse-private/);
    actor = 'owner-c'; await fixture.owner(actor);
    await expect(second.getByText('This board is not available to your account.', { exact: true })).toBeVisible();
    await expect.poll(() => canvasText(second)).not.toContain('Invitetheneighborhood');
    expect(api.joins).not.toContain('owner-c');
  } finally { await secondContext.close(); }
});

test('conflicting edits keep the local draft until the person reloads the shared version', async ({ page }) => {
  const api = sharedApi(); await api.attach(page, () => 'owner-a'); await museFixture(page);
  await addNote(page, 'Original shared wording');
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(share.getByRole('button', { name: 'Copy invite link', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const note = api.current()!.pages[0].objects[0];
  const bounds = (await page.locator('.muze-vector-surface [id="' + note.id + '"]').boundingBox())!;
  await page.mouse.dblclick(bounds.x + 30, bounds.y + 30);
  const editor = page.locator('textarea[data-fabric="textarea"]');
  await expect(editor).toBeAttached();
  await editor.fill('My unsaved wording');
  api.remoteChange(board => ({ ...board, pages: board.pages.map(p => ({ ...p, objects: p.objects.map(object => object.id === note.id ? { ...object, text: 'Another person’s wording' } : object) })) }));
  await editor.press('Escape');
  await expect(page.getByRole('alert')).toContainText('Someone else changed the same part of this board');
  await expect.poll(() => canvasText(page)).toContain('Myunsavedwording');
  expect(JSON.stringify(api.current())).toContain('Another person’s wording');
  await page.getByRole('button', { name: 'Reload shared version', exact: true }).click();
  await expect.poll(() => canvasText(page)).toContain('Anotherperson’swording');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the private Muse notebook does not expose an invitation action', async ({ page }) => {
  const api = sharedApi(); await api.attach(page, () => 'owner-a'); await museFixture(page);
  await page.getByRole('button', { name: 'Open Muse', exact: true }).click();
  await page.getByRole('dialog', { name: 'Muse', exact: true }).getByRole('button', { name: 'Edit Muse', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Muze' })).toHaveAttribute('data-muse-board', 'true');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create invite link', exact: true })).toHaveCount(0);
  expect(api.published).toHaveLength(0);
});

test('changing accounts clears the shared scene and an unauthorized account cannot reopen it', async ({ page }) => {
  const api = sharedApi(); let actor = 'owner-a';
  await api.attach(page, () => actor);
  const fixture = await museFixture(page);
  await addNote(page, 'Private to board members');
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(share.getByRole('button', { name: 'Copy invite link', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  actor = 'owner-c'; await fixture.owner(actor);
  await expect.poll(() => canvasText(page)).not.toContain('Privatetoboardmembers');
  await openLink(page);
  await expect(page.getByText('This board is not available to your account.', { exact: true })).toBeVisible();
  await expect.poll(() => canvasText(page)).not.toContain('Privatetoboardmembers');
});

test('the owner can disable an invitation and the old link stops new members joining', async ({ page, browser }) => {
  const api = sharedApi(); await api.attach(page, () => 'owner-a'); await museFixture(page);
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(share.getByRole('button', { name: 'Disable invite link', exact: true })).toBeVisible();
  const oldToken = api.token()!;
  await share.getByRole('button', { name: 'Disable invite link', exact: true }).click();
  await expect.poll(api.token).toBeNull();
  const context = await browser.newContext();
  try {
    const stranger = await context.newPage(); await api.attach(stranger, () => 'owner-c');
    const fixture = await museFixture(stranger); await fixture.owner('owner-c');
    await openLink(stranger, oldToken);
    await expect(stranger.getByText('This invite link is no longer available.', { exact: true })).toBeVisible();
    await expect(stranger.getByRole('button', { name: 'Back to my boards', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('an invite stays pending while signed out and joins the account that signs in', async ({ page, browser }) => {
  const api = sharedApi(); await api.attach(page, () => 'owner-a'); await museFixture(page);
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(share.getByRole('button', { name: 'Copy invite link', exact: true })).toBeVisible();
  const token = api.token()!;
  const context = await browser.newContext();
  try {
    const guest = await context.newPage(); let actor = '';
    await api.attach(guest, () => actor);
    const fixture = await museFixture(guest); await fixture.owner('');
    await openLink(guest, token);
    await expect(guest.getByRole('button', { name: 'Sign in to join', exact: true })).toBeVisible();
    expect(new URLSearchParams(new URL(guest.url()).hash.slice(1)).get('invite')).toBe(token);
    expect(api.joins).toEqual([]);
    actor = 'owner-b'; await fixture.owner(actor);
    await expect(guest.getByRole('main', { name: 'Muze', exact: true })).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => new URL(guest.url()).hash).toBe('');
    expect(api.joins).toEqual(['owner-b']);
  } finally { await context.close(); }
});

for(const finish of ['complete','cancel'] as const)test('active Muse notes are protected across two members until the request '+finish+'s',async({page,browser})=>{
 const api=sharedApi();await api.attach(page,()=> 'owner-a');const owner=await museFixture(page);await addNote(page,'Shared task to protect');
 const share=await openShare(page);await share.getByRole('button',{name:'Create invite link',exact:true}).click();await expect(share.getByRole('button',{name:'Copy invite link',exact:true})).toBeVisible();await page.keyboard.press('Escape');
 const note=api.current()!.pages[0].objects[0],pageId=api.current()!.activePage;
 let release!:()=>void;const gate=new Promise<void>(done=>release=done);
 owner.response(async body=>{const packet=body as typeof body&{requestId:string;sharedBoardId:string};expect(packet.sharedBoardId).toBe(boardId);expect(packet.requestId).toBeTruthy();api.acquire('owner-a',packet.requestId,JSON.parse(packet.board).objects.map((object:{id:string})=>({pageId,objectId:object.id})));await gate;return {cards:[],updates:[{id:String(note.id),text:'Muse refined the task',expectedText:String(note.text)}]};});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 try{
  const peer=await context.newPage();await api.attach(peer,()=> 'owner-b');const second=await museFixture(peer);await second.owner('owner-b');await openLink(peer,api.token()!);await expect.poll(()=>canvasText(peer)).toContain('Sharedtasktoprotect');
  await chat(page);await send(page,'Improve this task');await expect.poll(api.activeLeases).toBe(1);
  await peer.evaluate(()=>dispatchEvent(new Event('online')));await peer.waitForTimeout(350);
  const select=async()=>{const box=(await peer.locator('.muze-vector-surface [id="'+note.id+'"]').boundingBox())!;await peer.mouse.click(box.x+35,box.y+35);};
  await select();await peer.keyboard.press('Backspace');await expect.poll(()=>api.current()!.pages[0].objects.some(object=>object.id===note.id)).toBe(true);
  await expect(peer.getByRole('alert')).toContainText('Muse is using');await peer.getByRole('button',{name:'Dismiss message'}).click();
  await addNote(peer,'Independent peer contribution',900,500);await expect.poll(()=>JSON.stringify(api.current())).toContain('Independent peer contribution');
  if(finish==='complete')release();else await page.getByRole('button',{name:'Stop response',exact:true}).click();
  await expect.poll(api.activeLeases).toBe(0);
  if(finish==='complete')expect(JSON.stringify(api.current())).toContain('Muse refined the task');
  await peer.evaluate(()=>dispatchEvent(new Event('online')));
  if(finish==='complete')await expect.poll(()=>canvasText(peer)).toContain('Muserefinedthetask');else await peer.waitForTimeout(350);
  await select();await peer.keyboard.press('Backspace');await expect.poll(()=>api.current()!.pages[0].objects.some(object=>object.id===note.id)).toBe(false);
  expect(JSON.stringify(api.current())).toContain('Independent peer contribution');
  await expect(peer.getByText('Reload shared version',{exact:true})).toHaveCount(0);
 }finally{release();await context.close();}
});
