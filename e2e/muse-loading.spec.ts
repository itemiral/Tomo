import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import sharp from 'sharp';

const boardId = '8b72557c-0a22-4b39-b6fc-791d75cc2207';
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const customSource = (owner: string) => '/api/muse/avatar?sheet=true&v=sheet-' + owner + '&display=portrait';
const profile = (owner: string) => ({ ownerId: owner, ownerName: owner, muse: { id: owner + '-muse', name: owner === 'owner-a' ? 'Kumo' : 'Pip', iconVersion: 'icon-' + owner, gazeVersion: 'sheet-' + owner } });
const peerSource = '/api/boards/' + boardId + '/participants/owner-b/avatar?v=' + 'a'.repeat(64);
const peerProfile = (custom = true) => ({ participants: [{ userId: 'owner-b', name: 'Bo', avatarUrl: null, museName: custom ? 'Kumo' : 'Muse', museAvatarUrl: custom ? peerSource : '/muse/default-gaze-15.png?v=fluffyblob-v1', museAvatarVersion: custom ? 'a'.repeat(64) : null, musePoses: custom ? 9 : 15, museSheet: true }] });
let compiled: Promise<{ js: string; css: string }>;
function bundle() {
  return compiled ||= build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{useUser}from'@clerk/nextjs';
    import{MuseCompanion}from'./src/components/muse/companion';import{MuseIcon}from'./src/components/muse/shared';import{useBoardProfiles}from'./src/components/muze/use-board-profiles';import{BoardPeerMuses}from'./src/components/muze/board-presence';
    import'./src/app/globals.css';import'./src/components/muze/whiteboard.css';
    const peers=[{userId:'owner-b',name:'Bo',tabId:'b',pageId:'page',muse:'idle'}];
    function Peers(){const{isLoaded,isSignedIn,user}=useUser();const profiles=useBoardProfiles({boardId:'${boardId}',userId:user?.id,enabled:!!(isLoaded&&isSignedIn),connected:true,peerIds:['owner-b']});return <><output data-testid="own-profile-name">{profiles[user?.id]?.museName}</output><BoardPeerMuses profiles={profiles} peers={peers} userId={user?.id} pageId="page"/></>;}
    function Appearances(){const[version,setVersion]=useState('a');useEffect(()=>{const update=event=>setVersion(event.detail);window.addEventListener('loading-appearance',update);return()=>window.removeEventListener('loading-appearance',update)},[]);const profile={ownerId:'owner-a',ownerName:'Owner',muse:{id:'owner-muse',name:'Kumo',iconVersion:'icon-version-'+version,gazeVersion:'sheet-version-'+version}},peer={userId:'owner-b',name:'Bo',avatarUrl:null,museName:'Pip',museAvatarUrl:'/api/boards/${boardId}/participants/owner-b/avatar?v='+version.repeat(64),museAvatarVersion:version.repeat(64),musePoses:9,museSheet:true};return <><div data-testid="owner-appearance" style={{position:'absolute',top:120,left:120,width:64,height:64}}><MuseIcon profile={profile}/></div><BoardPeerMuses profiles={{'owner-b':peer}} peers={peers} userId="owner-a" pageId="page"/></>;}
    function App(){useEffect(()=>{window.loadingFixtureMounted=true},[]);return <main className="muze-app" aria-label="Loading test canvas">{window.loadingMode==='appearance'?<Appearances/>:window.loadingMode==='peer'?<Peers/>:<MuseCompanion appearanceChanged={async()=>{if(window.loadingAppearanceFailure)throw new Error("Preview refresh unavailable");}} attachImage={async()=>{}} open={false} onOpenChange={()=>{}} chatRequest={0} obstacles={[]} thread="board:page" boardContext="" applyActions={()=>({ids:[],skipped:0})}/>}</main>;}createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', outdir: '/tmp/muze-loading-fixture', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'delayed-clerk-fixture', setup(builder) {
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: resolve('.'), contents: `
        import{useState,useEffect}from'react';export function useUser(){const[state,setState]=useState(window.loadingAuth);useEffect(()=>{const update=()=>setState(window.loadingAuth);window.addEventListener('loading-auth',update);return()=>window.removeEventListener('loading-auth',update)},[]);return {isLoaded:state.loaded,isSignedIn:state.loaded&&!!state.owner,user:state.loaded&&state.owner?{id:state.owner}:null};}export const useClerk=()=>({openSignIn(){}});export const useSession=()=>({session:null});
      ` }));
    } }],
  }).then(result => ({ js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text }));
}
async function fixture(page: Page, initial = { loaded: true, owner: 'owner-a' }, mode = 'owner') {
  const assets = await bundle();
  await page.addInitScript(({ initial, mode }) => {
    (window as any).loadingAuth = initial; (window as any).loadingMode = mode;
    if (mode === 'appearance') {
      // Keep real image decoding while preventing Chrome's decoded-image cache
      // from hiding a newly mounted portrait's pending state for a reused URL.
      const NativeImage = window.Image; let attempt = 0;
      window.Image = class extends NativeImage {
        get src() { return super.src; }
        set src(value: string) { const url = new URL(value, location.href); url.searchParams.set('fixture-load', String(++attempt)); super.src = url.href; }
      };
    }
    const seen = { sources: [] as string[], orbs: 0 }; (window as any).loadingSeen = seen;
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return;
      for (const element of [node, ...node.querySelectorAll('[data-portrait-source],.muse-orb')]) {
        const source = element.getAttribute('data-portrait-source'); if (source) seen.sources.push(source);
        if (element.matches('.muse-orb')) seen.orbs++;
      }
    };
    new MutationObserver(records => { for (const record of records) { if (record.type === 'attributes' && record.oldValue) seen.sources.push(record.oldValue); inspect(record.target); record.addedNodes.forEach(inspect); } }).observe(document, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-portrait-source'] });
  }, { initial, mode });
  await page.route('**/__muse-loading', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/__muse-loading.css"><div id="root"></div><script src="/__muse-loading.js"></script>' }));
  await page.route('**/__muse-loading.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__muse-loading.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.route('**/api/muse/chat?*', route => route.fulfill({ json: { messages: [] } }));
  await page.goto('/__muse-loading');
  await expect.poll(() => page.evaluate(() => !!(window as any).loadingFixtureMounted)).toBe(true);
}
async function auth(page: Page, owner: string) { await page.evaluate(owner => { (window as any).loadingAuth = { loaded: true, owner }; window.dispatchEvent(new Event('loading-auth')); }, owner); }
async function noWrongAvatar(page: Page) {
  const seen = await page.evaluate(() => (window as any).loadingSeen as { sources: string[]; orbs: number });
  expect(seen.sources.filter(source => source.includes('/muse/default'))).toEqual([]); expect(seen.orbs).toBe(0);
}
async function painted(page: Page, source: string, channel: number) {
  const portrait = page.locator('canvas[data-portrait-source]');
  await expect(portrait).toHaveAttribute('data-portrait-source', source);
  await expect(portrait).toHaveAttribute('data-portrait-ready', 'true');
  await expect.poll(() => portrait.evaluate((canvas, channel) => (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(128, 128, 1, 1).data[channel], channel)).toBeGreaterThan(150);
}

test('cold loading stays neutral and refresh restores the owner’s avatar before the session response', async ({ page }) => {
  let sessionGate = gate(), imageGate = gate(), sessions = 0, images = 0;
  const image = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  const defaults: string[] = []; page.on('request', request => { if (request.url().includes('/muse/default')) defaults.push(request.url()); });
  await page.route('**/api/muse/session', async route => { sessions++; await sessionGate.promise; await route.fulfill({ json: profile('owner-a') }).catch(() => {}); });
  await page.route('**/api/muse/avatar?*', async route => { images++; await imageGate.promise; await route.fulfill({ contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: image }).catch(() => {}); });
  try {
    await fixture(page, { loaded: false, owner: 'owner-a' });
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await noWrongAvatar(page); expect(sessions).toBe(0);
    await auth(page, 'owner-a'); await expect.poll(() => sessions).toBe(1);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await noWrongAvatar(page); sessionGate.release(); await expect.poll(() => images).toBe(1);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await expect(page.locator('canvas[data-portrait-source]')).toHaveAttribute('data-portrait-ready', 'false');
    await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled();
    await noWrongAvatar(page); imageGate.release(); await painted(page, customSource('owner-a'), 2);
    await expect(page.locator('.muse-avatar-loading')).toHaveCount(0);
    await expect(page.locator('.muse-floating-name')).toHaveText('Kumo'); await noWrongAvatar(page);
    await expect.poll(() => page.evaluate(() => !!JSON.parse(sessionStorage.getItem('muze:muse-preview:v1') || '{}').image)).toBe(true);
    sessionGate = gate(); imageGate = gate(); await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).loadingFixtureMounted)).toBe(true);
    await expect(page.locator('canvas[data-portrait-source]')).toHaveCount(0);
    await auth(page, 'owner-a'); await expect.poll(() => sessions).toBe(2);
    await painted(page, customSource('owner-a'), 2);
    await expect(page.locator('.muse-avatar-loading')).toHaveCount(0);
    expect(images).toBe(1); // The session request is still blocked; pixels came from this owner's cache.
    await noWrongAvatar(page); sessionGate.release();
    expect(defaults).toEqual([]);
  } finally { sessionGate.release(); imageGate.release(); }
});

test('a cached portrait stays visible until its newer version has decoded', async ({ page }) => {
  let fresh = false, newRequested = false;
  const newImage = gate();
  const blue = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  const red = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#dd3322' } }).png().toBuffer();
  const updated = { ...profile('owner-a'), muse: { ...profile('owner-a').muse, iconVersion: 'icon-owner-a-new', gazeVersion: 'sheet-owner-a-new' } };
  await page.route('**/api/muse/session', route => route.fulfill({ json: fresh ? updated : profile('owner-a') }));
  await page.route('**/api/muse/avatar?*', async route => {
    const next = route.request().url().includes('owner-a-new');
    if (next) { newRequested = true; await newImage.promise; }
    await route.fulfill({ contentType: 'image/png', body: next ? red : blue }).catch(() => {});
  });
  try {
    await fixture(page); await painted(page, customSource('owner-a'), 2);
    fresh = true; await page.reload(); await expect.poll(() => newRequested).toBe(true);
    await painted(page, customSource('owner-a'), 2); await expect(page.locator('.muse-avatar-loading')).toHaveCount(0);
    newImage.release(); await painted(page, customSource('owner-a-new'), 0);
    await expect(page.locator('.muse-avatar-loading')).toHaveCount(0); await noWrongAvatar(page);
  } finally { newImage.release(); }
});

test('a denied session removes the cached portrait and its stored preview', async ({ page }) => {
  let denied = false;
  const response = gate();
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/muse/session', async route => {
    if (denied) { await response.promise; await route.fulfill({ status: 403, json: { error: 'Sign in again.' } }).catch(() => {}); }
    else await route.fulfill({ json: profile('owner-a') });
  });
  await page.route('**/api/muse/avatar?*', route => route.fulfill({ contentType: 'image/png', body: bytes }));
  try {
    await fixture(page); await painted(page, customSource('owner-a'), 2);
    denied = true; await page.reload(); await painted(page, customSource('owner-a'), 2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-a', name: 'Nova' } })));
    await expect(page.locator('.muse-floating-name')).toHaveText('Nova');
    response.release(); await expect(page.locator('canvas[data-portrait-source]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('muze:muse-preview:v1'))).toBe(null);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible(); await noWrongAvatar(page);
  } finally { response.release(); }
});

test('a saved avatar with failed notebook and portrait previews does not become another generation attempt', async ({ page }) => {
  let replacements = 0;
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/muse/session', route => route.fulfill({ json: profile('owner-a') }));
  await page.route('**/api/muse/avatar', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    replacements++;
    return route.fulfill({ json: { status: 'completed', iconVersion: 'icon-new', gazeVersion: 'sheet-new' } });
  });
  await page.route('**/api/muse/avatar?*', route => route.request().url().includes('sheet-new')
    ? route.fulfill({ status: 503, json: { error: 'Preview unavailable.' } })
    : route.fulfill({ contentType: 'image/png', body: bytes }));
  await fixture(page); await painted(page, customSource('owner-a'), 2);
  await page.evaluate(() => { (window as any).loadingAppearanceFailure = true; });
  await page.getByLabel('Choose Muse icon', { exact: true }).setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: bytes });
  await expect.poll(() => replacements).toBe(1);
  await expect(page.getByRole('progressbar', { name: 'Updating Muse avatar' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Avatar updated.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('muze:muse-preview:v1') || '{}').profile?.muse?.gazeVersion)).toBe('sheet-new');
  expect(replacements).toBe(1);
});

test('a delayed startup profile cannot undo a rename made from the cached profile', async ({ page }) => {
  let delay = false;
  const session = gate();
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/muse/session', async route => { if (delay) await session.promise; await route.fulfill({ json: profile('owner-a') }).catch(() => {}); });
  await page.route('**/api/muse/avatar?*', route => route.fulfill({ contentType: 'image/png', body: bytes }));
  try {
    await fixture(page); await painted(page, customSource('owner-a'), 2);
    delay = true; await page.reload(); await painted(page, customSource('owner-a'), 2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-a', name: 'Nova' } })));
    await expect(page.locator('.muse-floating-name')).toHaveText('Nova');
    const received = page.waitForResponse(response => response.url().endsWith('/api/muse/session'));
    session.release(); await received;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.muse-floating-name')).toHaveText('Nova');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('muze:muse-preview:v1') || '{}').profile?.muse?.name)).toBe('Nova');
  } finally { session.release(); }
});

test('upload completion preserves a rename during preload and ignores the old startup profile', async ({ page }) => {
  let delay = false, newRequested = false;
  const session = gate(), image = gate();
  const blue = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  const red = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#dd3322' } }).png().toBuffer();
  await page.route('**/api/muse/session', async route => { if (delay) await session.promise; await route.fulfill({ json: profile('owner-a') }).catch(() => {}); });
  await page.route('**/api/muse/avatar', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { status: 'completed', iconVersion: 'icon-owner-a-new', gazeVersion: 'sheet-owner-a-new' } }) : route.fallback());
  await page.route('**/api/muse/avatar?*', async route => {
    const next = route.request().url().includes('owner-a-new');
    if (next) { newRequested = true; await image.promise; }
    await route.fulfill({ contentType: 'image/png', body: next ? red : blue }).catch(() => {});
  });
  try {
    await fixture(page); await painted(page, customSource('owner-a'), 2);
    delay = true; await page.reload(); await painted(page, customSource('owner-a'), 2);
    await page.getByLabel('Choose Muse icon', { exact: true }).setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: red });
    await expect.poll(() => newRequested).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('muse-name-saved', { detail: { ownerId: 'owner-a', name: 'Nova' } })));
    image.release(); await painted(page, customSource('owner-a-new'), 0);
    await expect(page.locator('.muse-floating-name')).toHaveText('Nova');
    const received = page.waitForResponse(response => response.url().endsWith('/api/muse/session'));
    session.release(); await received;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await painted(page, customSource('owner-a-new'), 0); await expect(page.locator('.muse-floating-name')).toHaveText('Nova');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('muze:muse-preview:v1') || '{}').profile?.muse?.gazeVersion)).toBe('sheet-owner-a-new');
  } finally { session.release(); image.release(); }
});

test('switching owners clears the old appearance while the new Muse loads', async ({ page }) => {
  let owner = 'owner-a', waitingForB = false, loadingBImage = false;
  const sessionB = gate(), imageB = gate();
  const blue = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  const red = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#dd3322' } }).png().toBuffer();
  await page.route('**/api/muse/session', async route => { const selected = owner; if (selected === 'owner-b') { waitingForB = true; await sessionB.promise; } await route.fulfill({ json: profile(selected) }).catch(() => {}); });
  await page.route('**/api/muse/avatar?*', async route => { const second = route.request().url().includes('owner-b'); if (second) { loadingBImage = true; await imageB.promise; } await route.fulfill({ contentType: 'image/png', body: second ? red : blue }).catch(() => {}); });
  try {
    await fixture(page); await painted(page, customSource('owner-a'), 2);
    owner = 'owner-b'; await auth(page, owner); await expect.poll(() => waitingForB).toBe(true);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await expect(page.locator('canvas[data-portrait-source*="owner-a"]')).toHaveCount(0); await noWrongAvatar(page);
    sessionB.release(); await expect.poll(() => loadingBImage).toBe(true);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await expect(page.locator('canvas[data-portrait-source*="owner-a"]')).toHaveCount(0); await noWrongAvatar(page);
    imageB.release(); await painted(page, customSource('owner-b'), 0);
    await expect(page.locator('.muse-floating-name')).toHaveText('Pip'); await noWrongAvatar(page);
  } finally { sessionB.release(); imageB.release(); }
});

test('unknown peer avatars stay neutral and existing custom profiles load before a blocked own publication', async ({ page }) => {
  const get = gate(), post = gate(), imageGate = gate(); let reads = 0, writes = 0, images = 0;
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/boards/*/participants', async route => { if (route.request().method() === 'POST') { writes++; await post.promise; } else { reads++; await get.promise; } await route.fulfill({ json: peerProfile() }).catch(() => {}); });
  await page.route('**/api/boards/*/participants/*/avatar?*', async route => { images++; await imageGate.promise; await route.fulfill({ contentType: 'image/png', body: bytes }).catch(() => {}); });
  try {
    await fixture(page, { loaded: true, owner: 'owner-a' }, 'peer');
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await expect.poll(() => writes).toBe(1); await noWrongAvatar(page);
    get.release(); await expect.poll(() => reads).toBeGreaterThan(0); await expect.poll(() => images).toBe(1);
    await expect(page.locator('.muse-avatar-loading')).toBeVisible();
    await noWrongAvatar(page); imageGate.release(); await painted(page, peerSource, 2);
    await expect(page.getByLabel('Bo’s Kumo, idle', { exact: true })).toBeVisible(); await noWrongAvatar(page);
  } finally { get.release(); post.release(); imageGate.release(); }
});

test('a slow older profile read cannot replace a newer custom appearance', async ({ page }) => {
  const read = gate(); let reads = 0;
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/boards/*/participants', async route => { const old = route.request().method() === 'GET' && ++reads === 1; if (old) await read.promise; await route.fulfill({ json: peerProfile(!old) }).catch(() => {}); });
  await page.route('**/api/boards/*/participants/*/avatar?*', route => route.fulfill({ contentType: 'image/png', body: bytes }));
  try {
    await fixture(page, { loaded: true, owner: 'owner-a' }, 'peer'); await expect.poll(() => reads).toBeGreaterThan(0);
    await painted(page, peerSource, 2); read.release();
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(page.getByLabel('Bo’s Kumo, idle', { exact: true })).toBeVisible(); await noWrongAvatar(page);
  } finally { read.release(); }
});

test('revisited owner and peer images load neutrally and retry previous failures', async ({ page }) => {
  const pendingB = gate(), repeatedA = gate(), repeatedC = gate(), counts = new Map<string, number>();
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route(/\/api\/(?:muse\/avatar|boards\/[^/]+\/participants\/[^/]+\/avatar)\?/, async route => {
    const url = new URL(route.request().url()), own = url.pathname.startsWith('/api/muse/'), version = own ? url.searchParams.get('v')!.at(-1)! : url.searchParams.get('v')![0];
    const key = (own ? 'owner-' : 'peer-') + version, count = (counts.get(key) || 0) + 1; counts.set(key, count);
    if (version === 'b') await pendingB.promise;
    if (version === 'a' && count === 2) await repeatedA.promise;
    if (version === 'c' && count === 2) await repeatedC.promise;
    await route.fulfill(version === 'c' && count === 1 ? { status: 404, body: 'Unavailable' } : { contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: bytes }).catch(() => {});
  });
  const choose = async (version: string) => page.evaluate(version => window.dispatchEvent(new CustomEvent('loading-appearance', { detail: version })), version);
  const requested = async (version: string, count: number) => { for (const kind of ['owner', 'peer']) await expect.poll(() => counts.get(kind + '-' + version)).toBe(count); };
  const pending = async () => { await expect(page.locator('.muse-avatar-loading')).toHaveCount(2); for (const element of await page.locator('.muse-avatar-loading').all()) await expect(element).toBeVisible(); await expect(page.locator('.muse-orb')).toHaveCount(0); };
  const ready = async (version: string) => {
    for (const source of [customSource('version-' + version), peerSource.replace('a'.repeat(64), version.repeat(64))]) await expect(page.locator(`canvas[data-portrait-source="${source}"]`)).toHaveAttribute('data-portrait-ready', 'true');
    await expect(page.locator('.muse-avatar-loading')).toHaveCount(0); await expect(page.locator('.muse-orb')).toHaveCount(0);
  };
  try {
    await fixture(page, { loaded: true, owner: 'owner-a' }, 'appearance'); await ready('a');
    await choose('b'); await requested('b', 1); await pending();
    await choose('a'); await requested('a', 2); await pending(); repeatedA.release(); await ready('a');
    await choose('c'); await requested('c', 1); await expect(page.locator('.muse-orb')).toHaveCount(2);
    await choose('d'); await ready('d');
    await choose('c'); await requested('c', 2); await pending(); repeatedC.release(); await ready('c');
  } finally { pendingB.release(); repeatedA.release(); repeatedC.release(); }
});

test('a delayed publication cannot restore an older peer after a newer profile read', async ({ page }) => {
  const post = gate(), firstReads = gate(); let writes = 0, reads = 0, posted = false;
  const latestSource = peerSource.replace('a'.repeat(64), 'b'.repeat(64));
  const own = { ...peerProfile(false).participants[0], userId: 'owner-a', name: 'Owner', museName: 'Before publication' };
  const latest = { participants: [own, { ...peerProfile().participants[0], museAvatarVersion: 'b'.repeat(64), museAvatarUrl: latestSource, museName: 'New peer' }] };
  const stale = { participants: [{ ...own, museName: 'Published owner' }, ...peerProfile().participants] };
  const bytes = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#2244dd' } }).png().toBuffer();
  await page.route('**/api/boards/*/participants', async route => {
    if (route.request().method() === 'POST') { writes++; await post.promise; posted = true; await route.fulfill({ json: stale }).catch(() => {}); }
    else { reads++; await firstReads.promise; await route.fulfill({ json: { participants: [{ ...own, museName: posted ? 'Published owner' : own.museName }, latest.participants[1]] } }).catch(() => {}); }
  });
  await page.route('**/api/boards/*/participants/*/avatar?*', route => route.fulfill({ contentType: 'image/png', body: bytes }));
  try {
    await fixture(page, { loaded: true, owner: 'owner-a' }, 'peer'); await expect.poll(() => writes).toBe(1);
    firstReads.release(); await painted(page, latestSource, 2); const before = reads;
    post.release(); await expect(page.getByTestId('own-profile-name')).toHaveText('Published owner');
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(page.getByLabel('Bo’s New peer, idle', { exact: true })).toBeVisible();
    const seen = await page.evaluate(() => (window as any).loadingSeen.sources as string[]);
    expect(seen).not.toContain(peerSource); await noWrongAvatar(page);
  } finally { post.release(); firstReads.release(); }
});
