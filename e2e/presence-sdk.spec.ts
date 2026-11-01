import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const boardId = '8b72557c-0a22-4b39-b6fc-791d75cc2207';
type Packet = { actor: string; at: number; event: string; action?: string; payload?: any };
type Member = { socket: WebSocketRoute; actor: string; join: string; topic: string; key: string; presence?: Record<string, unknown> };

// Only the wire server and Clerk identity are fixtures. Supabase, its Phoenix
// connection, binary broadcast codec, and the application hook are all real.
function protocolServer({ rejectFirstTrack = false } = {}) {
  const members = new Map<WebSocketRoute, Member>(), packets: Packet[] = [], failures: string[] = [];
  let now = 0, rejected = false;
  const state = () => Object.fromEntries([...members.values()].filter(member => member.presence).map(member => [member.key, { metas: [{ ...member.presence, phx_ref: member.key }] }]));
  const sync = () => { for (const member of members.values()) member.socket.send(JSON.stringify([member.join, null, member.topic, 'presence_state', state()])); };
  const close = (member: Member, reason: string) => {
    member.socket.send(JSON.stringify([member.join, null, member.topic, 'system', { status: 'error', message: reason }]));
    member.socket.send(JSON.stringify([member.join, null, member.topic, 'phx_close', {}]));
    members.delete(member.socket); sync();
  };
  return {
    packets, failures,
    close(actor: string) { const member = [...members.values()].find(member => member.actor === actor); if (!member) throw new Error('Member not connected'); close(member, 'Server channel restart'); },
    async advance(pages: Page[], milliseconds: number) { now += milliseconds; await Promise.all(pages.map(page => page.clock.fastForward(milliseconds))); },
    attach(page: Page, actor: string) {
      return page.routeWebSocket('**/realtime/v1/websocket**', socket => {
        socket.onMessage(raw => {
          let frame: any[];
          if (typeof raw === 'string') frame = JSON.parse(raw);
          else {
            // SDK 2.118 sends broadcast pushes as kind-3 binary frames.
            const bytes = Buffer.from(raw); if (bytes[0] !== 3 || bytes[6] !== 1) throw new Error('Unexpected broadcast encoding');
            let offset = 7; const fields = [];
            for (const size of [bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]) { fields.push(bytes.subarray(offset, offset + size).toString()); offset += size; }
            const [join, ref, topic, event] = fields;
            frame = [join, ref, topic, 'broadcast', { type: 'broadcast', event, payload: JSON.parse(bytes.subarray(offset).toString()) }];
          }
          const [join, ref, topic, event, payload] = frame;
          packets.push({ actor, at: now, event, action: payload?.event, ...(event === 'presence' || event === 'broadcast' ? { payload: payload.payload } : {}) });
          const reply = (status = 'ok', response = {}) => socket.send(JSON.stringify([join, ref, topic, 'phx_reply', { status, response }]));
          if (event === 'phx_join') {
            if (!payload.config.private || !payload.config.presence.enabled || topic !== 'realtime:board:' + boardId) failures.push('Invalid private presence subscription');
            members.set(socket, { socket, actor, join, topic, key: payload.config.presence.key }); reply(); sync();
          } else if (event === 'presence') {
            const member = members.get(socket); if (!member) { reply('error'); return; }
            const attempts = packets.filter(packet => packet.actor === actor && packet.event === 'presence' && packet.at > now - 30_000);
            if (attempts.length > 5) { failures.push('ClientPresenceRateLimitReached'); close(member, 'ClientPresenceRateLimitReached'); return; }
            if (payload.event === 'track') {
              if (rejectFirstTrack && !rejected && actor === 'owner') { rejected = true; reply('error', { reason: 'Temporary presence failure' }); return; }
              member.presence = payload.payload;
            } else delete member.presence;
            reply(); sync();
          } else if (event === 'broadcast') {
            for (const member of members.values()) if (member.socket !== socket) {
              // Deliver kind-4 binary messages to exercise the real receive codec too.
              const topicBytes = Buffer.from(member.topic), eventBytes = Buffer.from(payload.event), content = Buffer.from(JSON.stringify(payload.payload));
              member.socket.send(Buffer.concat([Buffer.from([4, topicBytes.length, eventBytes.length, 0, 1]), topicBytes, eventBytes, content]));
            }
            reply();
          } else if (event === 'phx_leave') { members.delete(socket); reply(); sync(); }
          else reply();
        });
        socket.onClose(() => { members.delete(socket); sync(); });
      });
    },
  };
}

let compiled: Promise<{ js: string; css: string }>;
function bundle() {
  return compiled ||= build({
    stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
      import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
      import{useBoardPresence}from'./src/components/muze/use-board-presence';
      import{BoardParticipants,BoardPeerCursors}from'./src/components/muze/board-presence';
      import'./src/app/globals.css';import'./src/components/muze/whiteboard.css';
      function App(){const[options,setOptions]=useState({pageId:'page-one',museWorking:false,enabled:true});window.sdkSetOptions=patch=>setOptions(value=>({...value,...patch}));window.sdkOptions=options;
        const state=useBoardPresence({...options,boardId:'${boardId}',userId:window.sdkActor,name:window.sdkActor==='owner'?'Ada':'Bo',viewport:[1,0,0,1,0,0]});window.sdkPresence=state;
        return <main className="muze-app"><div className="muze-drawing-surface" style={{position:'fixed',inset:0}}/><BoardParticipants peers={state.peers} userId={window.sdkActor} connected={state.connected}/><BoardPeerCursors cursors={state.cursors} pageId={options.pageId} viewport={[1,0,0,1,0,0]}/></main>;
      }createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', outdir: '/tmp/muze-presence-sdk-fixture', external: ['/fonts/*'],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_SUPABASE_URL': '"https://presence.invalid"', 'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': '"fixture-publishable-key"' },
    plugins: [{ name: 'clerk-session-fixture', setup(builder) {
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: resolve('.'), contents: `
        import{useEffect,useMemo,useState}from'react';
        export function useSession(){const[version,setVersion]=useState(0);useEffect(()=>{const update=()=>setVersion(v=>v+1);window.addEventListener('sdk-session-resource',update);return()=>window.removeEventListener('sdk-session-resource',update)},[]);
          const session=useMemo(()=>({id:'session-'+window.sdkActor,user:{id:window.sdkActor},getToken:async()=>{window.sdkTokenCalls=(window.sdkTokenCalls||0)+1;return btoa('{}')+'.'+btoa(JSON.stringify({sub:window.sdkActor,exp:Math.floor(Date.now()/1000)+60}))+'.test';}}),[version]);return{session};}
      ` }));
    } }],
  }).then(result => ({ js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text }));
}

async function fixture(browser: Browser, server: ReturnType<typeof protocolServer>, actor: 'owner' | 'guest') {
  const context = await browser.newContext(), page = await context.newPage(), assets = await bundle();
  await page.clock.install({ time: new Date('2026-11-01T12:00:00Z') });
  await page.addInitScript(actor => { (window as any).sdkActor = actor; }, actor);
  await server.attach(page, actor);
  await page.route('**/__presence-sdk', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/__presence-sdk.css"><div id="root"></div><script src="/__presence-sdk.js"></script>' }));
  await page.route('**/__presence-sdk.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__presence-sdk.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.goto('/__presence-sdk');
  return { context, page };
}
async function options(page: Page, patch: { pageId?: string; museWorking?: boolean }) {
  await page.evaluate(patch => (window as any).sdkSetOptions(patch), patch);
  await expect.poll(() => page.evaluate(patch => Object.entries(patch).every(([key, value]) => (window as any).sdkOptions[key] === value), patch)).toBe(true);
}
const tracks = (server: ReturnType<typeof protocolServer>, actor = 'owner') => server.packets.filter(packet => packet.actor === actor && packet.event === 'presence');

test('real SDK delivers owner and invited editor cursors in both directions', async ({ browser }) => {
  const server = protocolServer(), contexts: BrowserContext[] = [];
  try {
    const owner = await fixture(browser, server, 'owner'); contexts.push(owner.context);
    const guest = await fixture(browser, server, 'guest'); contexts.push(guest.context);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await expect(owner.page.getByLabel('People on this board')).toContainText('Bo');
    await owner.page.mouse.move(450, 350); await expect(guest.page.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
    await guest.page.mouse.move(600, 400); await expect(owner.page.getByLabel('Bo’s cursor', { exact: true })).toBeVisible();
    const joins = server.packets.filter(packet => packet.event === 'phx_join').length;
    await owner.page.evaluate(() => { for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('sdk-session-resource')); });
    await owner.page.mouse.move(480, 370);
    await expect.poll(() => guest.page.evaluate(() => (window as any).sdkPresence.cursors.find((cursor: any) => cursor.userId === 'owner')?.x)).toBe(480);
    expect(server.packets.filter(packet => packet.event === 'phx_join')).toHaveLength(joins);
    expect(server.failures).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('rapid Muse, page and visibility changes stay inside the server presence limit', async ({ browser }) => {
  const server = protocolServer(), { page, context } = await fixture(browser, server, 'owner');
  try {
    await expect(page.getByLabel('People on this board')).toContainText('You');
    for (let i = 0; i < 12; i++) {
      await options(page, { museWorking: i % 2 === 0, pageId: i % 2 === 0 ? 'page-two' : 'page-one' });
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    }
    // Spread a second burst beyond the debounce while staying within one quota window.
    for (let i = 0; i < 7; i++) {
      await options(page, { museWorking: i % 2 === 0, pageId: 'page-' + i });
      await server.advance([page], 2100);
      if (i < 3) await expect.poll(() => tracks(server).length).toBeGreaterThanOrEqual(i + 2);
    }
    for (const packet of tracks(server)) expect(tracks(server).filter(other => other.at <= packet.at && other.at > packet.at - 30_000).length).toBeLessThanOrEqual(5);
    expect(server.failures).toEqual([]);
    await options(page, { museWorking: false, pageId: 'page-final' });
    await server.advance([page], 33_000);
    await expect.poll(() => tracks(server).filter(packet => packet.action === 'track').at(-1)?.payload).toMatchObject({ muse: 'idle', pageId: 'page-final' });
    await expect(page.getByLabel('People on this board')).toContainText('You');
  } finally { await context.close(); }
});

test('a resolved track error is retried and does not leave the owner invisible', async ({ browser }) => {
  const server = protocolServer({ rejectFirstTrack: true }), contexts: BrowserContext[] = [];
  try {
    const owner = await fixture(browser, server, 'owner'); contexts.push(owner.context);
    const guest = await fixture(browser, server, 'guest'); contexts.push(guest.context);
    await expect.poll(() => tracks(server).length).toBe(1);
    await server.advance([owner.page, guest.page], 12_000);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await owner.page.mouse.move(420, 320); await expect(guest.page.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
    expect(tracks(server).length).toBeLessThanOrEqual(4); expect(server.failures).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('a server-closed channel rejoins without a reload', async ({ browser }) => {
  const server = protocolServer(), { page, context } = await fixture(browser, server, 'owner');
  try {
    await expect(page.getByLabel('People on this board')).toContainText('You');
    server.close('owner');
    await expect(page.getByLabel('People on this board')).toContainText('Connecting');
    await server.advance([page], 12_000);
    await expect(page.getByLabel('People on this board')).toContainText('You');
    expect(server.packets.filter(packet => packet.event === 'phx_join').length).toBeGreaterThan(1);
    expect(server.failures).toEqual([]);
  } finally { await context.close(); }
});

test('token refresh does not publish unchanged presence metadata', async ({ browser }) => {
  const server = protocolServer(), { page, context } = await fixture(browser, server, 'owner');
  try {
    await expect(page.getByLabel('People on this board')).toContainText('You');
    const initialTracks = tracks(server).length, initialTokens = await page.evaluate(() => (window as any).sdkTokenCalls);
    await server.advance([page], 35_000);
    await expect.poll(() => page.evaluate(() => (window as any).sdkTokenCalls)).toBeGreaterThan(initialTokens);
    expect(tracks(server)).toHaveLength(initialTracks);
    await expect(page.getByLabel('People on this board')).toContainText('You');
    expect(server.failures).toEqual([]);
  } finally { await context.close(); }
});
