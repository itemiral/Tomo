import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const boardId = '8b72557c-0a22-4b39-b6fc-791d75cc2207', otherBoard = '8b72557c-0a22-4b39-b6fc-791d75cc2208';
const appearance = (board: string, user = 'owner-b') => `/api/boards/${board}/participants/${user}/avatar?v=${'a'.repeat(64)}`;
const response = (board = boardId, name = 'Bo', museName = 'Kumo') => ({ participants: [
  { userId: 'owner-a', name: 'Ada', avatarUrl: 'https://img.clerk.com/ada.png', museName: 'Pip', museAvatarUrl: '/muse/default-gaze-15.png?v=hybrid-15', museAvatarVersion: null, museSheet: true, musePoses: 15 },
  { userId: 'owner-b', name, avatarUrl: 'https://img.clerk.com/bo.png', museName, museAvatarUrl: appearance(board), museAvatarVersion: 'a'.repeat(64), museSheet: true, musePoses: 9 },
] });
let compiled: Promise<{ js: string; css: string }>;
function bundle() {
  return compiled ||= build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useBoardProfiles}from'./src/components/muze/use-board-profiles';
    import{BoardParticipants,BoardPeerCursors,BoardPeerMuses}from'./src/components/muze/board-presence';import'./src/app/globals.css';import'./src/components/muze/whiteboard.css';
    const peers=[{userId:'owner-a',name:'Ada',tabId:'a',pageId:'page-one',muse:'idle'},{userId:'owner-b',name:'Bo',tabId:'b',pageId:'page-one',muse:'working'}];
    function App(){const[state,setState]=useState({boardId:'${boardId}',userId:'owner-a',enabled:true});window.profileOptions=state;window.setProfileOptions=patch=>setState(value=>({...value,...patch}));const profiles=useBoardProfiles({...state,connected:true,peerIds:peers.map(peer=>peer.userId)});window.profileView=profiles;
      return <main className="muze-app"><div className="muze-drawing-surface"/><header className="muze-header"><div className="muze-project"><b>Muze</b></div>{state.enabled&&<BoardParticipants peers={peers} userId={state.userId} connected profiles={profiles}/>}</header>{state.enabled&&<><BoardPeerCursors profiles={profiles} cursors={[{...peers[1],x:450,y:300,receivedAt:Date.now()}]} pageId="page-one" viewport={[1,0,0,1,0,0]}/><BoardPeerMuses profiles={profiles} peers={peers} userId={state.userId} pageId="page-one"/></>}</main>;
    }createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: '/tmp/muze-board-profiles-fixture', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"' } }).then(result => ({ js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text }));
}
async function fixture(page: Page) {
  const assets = await bundle(), icon = await readFile('public/muse/default-avatar.png'), sheet = await readFile('public/muse/default-gaze.png');
  await page.route('**/__board-profiles', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/__board-profiles.css"><div id="root"></div><script src="/__board-profiles.js"></script>' }));
  await page.route('**/__board-profiles.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__board-profiles.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.route('https://img.clerk.com/**', route => route.fulfill({ contentType: 'image/png', body: icon }));
  await page.route('**/api/boards/*/participants/*/avatar?*', route => route.fulfill({ contentType: 'image/png', body: sheet }));
  await page.goto('/__board-profiles');
}

test('collaborators show Clerk photos beside names and cursors and render their customized Muse', async ({ page }) => {
  const requests: string[] = [], bodies: (string | null)[] = [];
  page.on('request', request => { requests.push(request.url()); });
  await page.route('**/api/boards/*/participants', route => { if (route.request().method() === 'POST') bodies.push(route.request().postData()); return route.fulfill({ json: response() }); });
  await fixture(page);
  const cursor = page.getByLabel('Bo’s cursor', { exact: true }), marker = page.getByLabel('Bo’s Kumo, working', { exact: true });
  await expect(marker).toBeVisible();
  await expect(cursor.locator('img')).toHaveAttribute('src', 'https://img.clerk.com/bo.png');
  await expect(cursor.locator('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(page.getByRole('listitem').filter({ hasText: 'Bo' }).locator('img')).toHaveAttribute('src', 'https://img.clerk.com/bo.png');
  const portrait = marker.locator('canvas'); await expect(portrait).toHaveAttribute('data-portrait-source', appearance(boardId));
  await expect.poll(() => portrait.evaluate(canvas => [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(100, 100, 20, 20).data].some((value, i) => i % 4 === 3 && value > 0))).toBe(true);
  expect(bodies.length).toBeGreaterThan(0); expect(bodies.every(body => body === null)).toBe(true);
  expect(requests.some(url => /\/api\/muse\//.test(url))).toBe(false);
  await page.screenshot({ path: '/tmp/muze-board-profiles.png' });
});

test('late profile responses cannot restore another owner or board after switching', async ({ page }) => {
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const images: string[] = []; page.on('request', request => { if (/\/participants\/[^/]+\/avatar/.test(request.url())) images.push(request.url()); });
  await page.route('**/api/boards/*/participants', async route => {
    const old = new URL(route.request().url()).pathname.includes(boardId);
    if (old) { started = true; await gate; }
    await route.fulfill({ json: old ? response(boardId, 'Old identity', 'Old Muse') : response(otherBoard, 'Current identity', 'Current Muse') }).catch(() => {});
  });
  await fixture(page); await expect.poll(() => started).toBe(true);
  await page.evaluate(boardId => (window as any).setProfileOptions({ boardId, userId: 'owner-c' }), otherBoard);
  await expect(page.getByLabel('Current identity’s Current Muse, working', { exact: true })).toBeVisible();
  release();
  await expect(page.getByLabel('Old identity’s Old Muse, working', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).profileView['owner-b']?.name)).toBe('Current identity');
  expect(images.every(url => url.includes(otherBoard))).toBe(true);
});

test('private notebook mode removes collaborator profiles and stops refreshing them', async ({ page }) => {
  await page.clock.install(); const requests: string[] = [];
  await page.route('**/api/boards/*/participants', route => { requests.push(route.request().method()); return route.fulfill({ json: response() }); });
  await fixture(page); await expect(page.getByLabel('Bo’s Kumo, working', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).setProfileOptions({ enabled: false }));
  await expect(page.getByLabel('People on this board')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).profileView).length)).toBe(0);
  const count = requests.length; await page.clock.fastForward(20_000); expect(requests).toHaveLength(count);
});

test('profile publication retries transient failures and refreshes only the current owner’s changes', async ({ page }) => {
  await page.clock.install(); let writes = 0;
  await page.route('**/api/boards/*/participants', route => {
    if (route.request().method() === 'POST') writes++;
    if (writes === 1) return route.fulfill({ status: 503, json: { error: 'Try again.' } });
    const value = response(); value.participants[0].museName = 'Version ' + writes;
    return route.fulfill({ json: value });
  });
  await fixture(page); await expect.poll(() => writes).toBe(1);
  await page.clock.fastForward(10_001);
  await expect(page.getByLabel('Bo’s Kumo, working', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).profileView['owner-a']?.museName)).toBe('Version 2');
  await page.evaluate(() => (window as any).setProfileOptions({ profileVersion: 'new-clerk-profile' }));
  await expect.poll(() => page.evaluate(() => (window as any).profileView['owner-a']?.museName)).toBe('Version 3');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-b', name: 'Someone else' } })));
  await page.clock.fastForward(100); expect(writes).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-a', name: 'New name' } })));
  await expect.poll(() => page.evaluate(() => (window as any).profileView['owner-a']?.museName)).toBe('Version 4');
});


test('stalled participant reads and publication time out and recover on the next refresh', async ({page}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.fetch.bind(window), held = new Set<string>();
    (AbortSignal as any).timeout = (milliseconds:number) => {const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('Deadline','TimeoutError')),milliseconds);return controller.signal;};
    (window as any).stalledRequests = 0;
    window.fetch = (input, init) => {
      const url=String(input), method=init?.method || 'GET';
      if(url.endsWith('/participants') && !held.has(method)) {
        held.add(method);(window as any).stalledRequests++;
        return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));
      }
      return original(input, init);
    };
  });
  await page.route('**/api/boards/*/participants', route => route.fulfill({json:response()}));
  await fixture(page);
  await expect.poll(()=>page.evaluate(()=>(window as any).stalledRequests)).toBe(2);
  await page.clock.runFor(15001);
  await page.clock.runFor(5001);
  await expect(page.getByLabel('Bo’s Kumo, working', {exact:true})).toBeVisible();
});
