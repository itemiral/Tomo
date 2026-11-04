import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const boardId = '8b72557c-0a22-4b39-b6fc-791d75cc2207';
type Packet = { actor: string; at: number; event: string; action?: string; payload?: any };
type Member = { socket: WebSocketRoute; actor: string; join: string; topic: string; key: string; presence?: Record<string, unknown>; presenceRevision?:number };

// Only the wire server and Clerk identity are fixtures. Supabase, its Phoenix
// connection, binary broadcast codec, and the application hook are all real.
function protocolServer({ rejectFirstTrack = false } = {}) {
  const members = new Map<WebSocketRoute, Member>(), packets: Packet[] = [], failures: string[] = [];
  let now = 0, rejected = false, dropActivity: string | null = null;
  const state = () => Object.fromEntries([...members.values()].filter(member => member.presence).map(member => [member.key, { metas: [{ ...member.presence, phx_ref: member.key+':'+member.presenceRevision }] }]));
  const sync = () => { for (const member of members.values()) member.socket.send(JSON.stringify([member.join, null, member.topic, 'presence_state', state()])); };
  const close = (member: Member, reason: string) => {
    member.socket.send(JSON.stringify([member.join, null, member.topic, 'system', { status: 'error', message: reason }]));
    member.socket.send(JSON.stringify([member.join, null, member.topic, 'phx_close', {}]));
    members.delete(member.socket); sync();
  };
  return {
    packets, failures,
    dropNextActivity(actor:string){dropActivity=actor;},
    broadcast(event:string,payload:unknown) {for(const member of members.values())member.socket.send(JSON.stringify([member.join,null,member.topic,'broadcast',{type:'broadcast',event,payload}]));},
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
              member.presence = payload.payload; member.presenceRevision=(member.presenceRevision||0)+1;
            } else delete member.presence;
            reply(); sync();
          } else if (event === 'broadcast') {
            if(payload.event==='activity'&&dropActivity===actor){dropActivity=null;reply();return;}
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
      function App(){const[options,setOptions]=useState({pageId:'page-one',museWorking:false,enabled:true,viewport:[1,0,0,1,0,0]});window.sdkSetOptions=patch=>setOptions(value=>({...value,...patch}));window.sdkOptions=options;
        const state=useBoardPresence({...options,boardId:'${boardId}',userId:window.sdkActor,name:window.sdkActor==='owner'?'Ada':window.sdkActor==='guest'?'Bo':'Anel'});window.sdkPresence=state;
        return <main className="muze-app"><div className="muze-drawing-surface" style={{position:'fixed',inset:0}}/><BoardParticipants peers={state.peers} userId={window.sdkActor} connected={state.connected}/><BoardPeerCursors cursors={state.cursors} pageId={options.pageId} viewport={options.viewport}/></main>;
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

async function fixture(browser: Browser, server: ReturnType<typeof protocolServer>, actor: 'owner' | 'guest' | 'guest-two') {
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
async function options(page: Page, patch: { pageId?: string; museWorking?: boolean; museTargetId?: string; viewport?: number[] }) {
  await page.evaluate(patch => (window as any).sdkSetOptions(patch), patch);
  await expect.poll(() => page.evaluate(patch => Object.entries(patch).every(([key, value]) => JSON.stringify((window as any).sdkOptions[key]) === JSON.stringify(value)), patch)).toBe(true);
}
const tracks = (server: ReturnType<typeof protocolServer>, actor = 'owner') => server.packets.filter(packet => packet.actor === actor && packet.event === 'presence');

test('real SDK delivers cursors between the owner and two invited editors in every direction', async ({ browser }) => {
  const server = protocolServer(), contexts: BrowserContext[] = [];
  try {
    const owner = await fixture(browser, server, 'owner'); contexts.push(owner.context);
    const guest = await fixture(browser, server, 'guest'); contexts.push(guest.context);
    const anotherGuest = await fixture(browser, server, 'guest-two'); contexts.push(anotherGuest.context);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await expect(owner.page.getByLabel('People on this board')).toContainText('Bo');
    await owner.page.mouse.move(450, 350); await expect(guest.page.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
    await guest.page.mouse.move(600, 400); await expect(owner.page.getByLabel('Bo’s cursor', { exact: true })).toBeVisible();
    await anotherGuest.page.mouse.move(550, 450);
    for (const [viewer, names] of [[owner.page, ['Bo', 'Anel']], [guest.page, ['Ada', 'Anel']], [anotherGuest.page, ['Ada', 'Bo']]] as const) {
      for (const name of names) await expect(viewer.getByLabel(name + '’s cursor', { exact: true })).toBeVisible();
      await expect(viewer.locator('.board-peer-cursor')).toHaveCount(2);
    }
    const joins = server.packets.filter(packet => packet.event === 'phx_join').length;
    await owner.page.evaluate(() => { for (let i = 0; i < 8; i++) window.dispatchEvent(new Event('sdk-session-resource')); });
    await owner.page.mouse.move(480, 370);
    await expect.poll(() => guest.page.evaluate(() => (window as any).sdkPresence.cursors.find((cursor: any) => cursor.userId === 'owner')?.x)).toBe(480);
    expect(server.packets.filter(packet => packet.event === 'phx_join')).toHaveLength(joins);
    expect(server.failures).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('an idle second tab cannot replace the collaborator’s active cursor with heartbeat replays', async ({ browser }) => {
  const server = protocolServer(), contexts: BrowserContext[] = [];
  try {
    const owner = await fixture(browser, server, 'owner'); contexts.push(owner.context);
    const idle = await fixture(browser, server, 'guest'); contexts.push(idle.context);
    const active = await fixture(browser, server, 'guest'); contexts.push(active.context);
    await expect.poll(() => owner.page.evaluate(() => (window as any).sdkPresence.peers.filter((peer: any) => peer.userId === 'guest').length)).toBe(2);
    const cursor = owner.page.getByLabel('Bo’s cursor', { exact: true });
    await idle.page.mouse.move(400, 300);
    await expect(cursor).toBeVisible();
    await server.advance([owner.page, idle.page, active.page], 500);
    await active.page.mouse.move(650, 420);
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.x)).toBe(650);
    // Keep the receiver's clock ahead so a stale heartbeat would win by arrival time.
    await server.advance([owner.page], 3000);
    await server.advance([idle.page], 3000);
    await expect.poll(() => server.packets.filter(packet => packet.event === 'broadcast' && packet.action === 'cursor' && packet.payload?.x === 400).length).toBeGreaterThan(1);
    await expect(cursor).toHaveCount(1);
    expect(Math.round((await cursor.boundingBox())!.x)).toBe(650);
    await idle.page.mouse.move(430, 320);
    await server.advance([owner.page, idle.page], 150);
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.x)).toBe(430);
    expect(server.failures).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('the owner sees an invited editor’s stationary cursor after window switches and reconnects', async ({ browser }) => {
  const server = protocolServer(), contexts: BrowserContext[] = [];
  try {
    const owner = await fixture(browser, server, 'owner'); contexts.push(owner.context);
    const guest = await fixture(browser, server, 'guest'); contexts.push(guest.context);
    await expect(owner.page.getByLabel('People on this board')).toContainText('Bo');
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await owner.page.mouse.move(450, 350);
    await guest.page.mouse.move(600, 400);
    const guestCursor = owner.page.getByLabel('Bo’s cursor', { exact: true });
    await expect(guestCursor).toBeVisible();
    await expect(guest.page.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();

    await guest.page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null }));
      window.dispatchEvent(new Event('blur'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await server.advance([owner.page, guest.page], 5000);
    await expect(guestCursor).toBeVisible();
    expect(await owner.page.evaluate(() => (window as any).sdkPresence.cursors.find((cursor: any) => cursor.userId === 'guest'))).toMatchObject({ x: 600, y: 400 });

    // A returning receiver must get the last position from a hidden sender.
    server.close('owner');
    await expect(guestCursor).toHaveCount(0);
    await server.advance([owner.page, guest.page], 12000);
    await expect(owner.page.getByLabel('People on this board')).toContainText('Bo');
    await expect(guestCursor).toBeVisible();
    expect(await owner.page.evaluate(() => (window as any).sdkPresence.cursors.find((cursor: any) => cursor.userId === 'guest'))).toMatchObject({ x: 600, y: 400 });

    await guest.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await guest.page.mouse.move(640, 420);
    await server.advance([owner.page, guest.page], 150);
    await expect.poll(() => owner.page.evaluate(() => (window as any).sdkPresence.cursors.find((cursor: any) => cursor.userId === 'guest')?.x)).toBe(640);
    expect(server.failures).toEqual([]);
    await guest.context.close(); contexts.pop();
    await expect(guestCursor).toHaveCount(0);
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


test('page and Muse targets reach peers promptly after the presence track budget is exhausted', async ({browser}) => {
  const server=protocolServer(), contexts:BrowserContext[]=[];
  try {
    const owner=await fixture(browser,server,'owner');contexts.push(owner.context);
    const guest=await fixture(browser,server,'guest');contexts.push(guest.context);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    for(let index=0;index<3;index++) {
      await server.advance([owner.page,guest.page],2100);
      await options(owner.page,{museWorking:index%2===0});
      await server.advance([owner.page,guest.page],150);
      await expect.poll(()=>tracks(server).length).toBe(index+2);
    }
    await options(owner.page,{pageId:'page-two',museWorking:true,museTargetId:'shared-note'});
    await server.advance([owner.page,guest.page],250);
    await expect.poll(()=>guest.page.evaluate(()=>(window as any).sdkPresence.peers.find((peer:any)=>peer.userId==='owner'))).toMatchObject({pageId:'page-two',muse:'working',museTargetId:'shared-note'});
    expect(tracks(server)).toHaveLength(4);expect(server.failures).toEqual([]);
  } finally {await Promise.all(contexts.map(context=>context.close()));}
});

test('a stationary cursor returns after its owner reconnects without another pointer move', async ({browser})=>{
  const server=protocolServer(),contexts:BrowserContext[]=[];
  try {
    const owner=await fixture(browser,server,'owner');contexts.push(owner.context);
    const guest=await fixture(browser,server,'guest');contexts.push(guest.context);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await owner.page.mouse.move(470,330);await expect(guest.page.getByLabel('Ada’s cursor',{exact:true})).toBeVisible();
    server.close('owner');await expect(guest.page.getByLabel('Ada’s cursor',{exact:true})).toHaveCount(0);
    await server.advance([owner.page,guest.page],12000);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await expect(guest.page.getByLabel('Ada’s cursor',{exact:true})).toBeVisible();
    await expect.poll(()=>guest.page.evaluate(()=>(window as any).sdkPresence.cursors.find((cursor:any)=>cursor.userId==='owner')?.x)).toBe(470);
  } finally {await Promise.all(contexts.map(context=>context.close()));}
});

test('panning under a stationary pointer updates the shared world position promptly',async({browser})=>{
  const server=protocolServer(),contexts:BrowserContext[]=[];
  try {
    const owner=await fixture(browser,server,'owner');contexts.push(owner.context);
    const guest=await fixture(browser,server,'guest');contexts.push(guest.context);
    await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
    await owner.page.mouse.move(500,350);await expect(guest.page.getByLabel('Ada’s cursor',{exact:true})).toBeVisible();
    await options(owner.page,{viewport:[2,0,0,2,100,50]});
    await server.advance([owner.page,guest.page],150);
    expect(await guest.page.evaluate(()=>(window as any).sdkPresence.cursors.find((cursor:any)=>cursor.userId==='owner'))).toMatchObject({x:200,y:150});
  } finally {await Promise.all(contexts.map(context=>context.close()));}
});


test('activity updates are ordered, survive membership sync, and ignore unknown tabs',async({browser})=>{
 const server=protocolServer(),contexts:BrowserContext[]=[];
 try{
  const owner=await fixture(browser,server,'owner');contexts.push(owner.context);
  const guest=await fixture(browser,server,'guest');contexts.push(guest.context);
  await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
  await server.advance([owner.page,guest.page],250);
  const person=await guest.page.evaluate(()=>(window as any).sdkPresence.peers.find((peer:any)=>peer.userId==='owner'));
  server.broadcast('activity',{tabId:person.tabId,pageId:'page-two',muse:'working',museTargetId:'shared-note',revision:10});
  await expect.poll(()=>guest.page.evaluate(()=>(window as any).sdkPresence.peers.find((peer:any)=>peer.userId==='owner')?.pageId)).toBe('page-two');
  server.broadcast('activity',{tabId:person.tabId,pageId:'page-one',muse:'idle',revision:9});
  server.broadcast('activity',{tabId:'unknown-tab',pageId:'page-two',muse:'working',revision:99});
  await options(guest.page,{museWorking:true});await server.advance([owner.page,guest.page],2500);
  const peers=await guest.page.evaluate(()=>(window as any).sdkPresence.peers);
  expect(peers).toHaveLength(2);expect(peers.find((peer:any)=>peer.userId==='owner')).toMatchObject({pageId:'page-two',muse:'working',museTargetId:'shared-note'});
  expect(peers.some((peer:any)=>peer.tabId==='unknown-tab')).toBe(false);
 }finally{await Promise.all(contexts.map(context=>context.close()));}
});


test('a newer membership snapshot recovers work status when an activity broadcast is lost',async({browser})=>{
 const server=protocolServer(),contexts:BrowserContext[]=[];
 try{
  const owner=await fixture(browser,server,'owner');contexts.push(owner.context);
  const guest=await fixture(browser,server,'guest');contexts.push(guest.context);
  await expect(guest.page.getByLabel('People on this board')).toContainText('Ada');
  await server.advance([owner.page,guest.page],250);
  server.dropNextActivity('owner');await options(owner.page,{museWorking:true,museTargetId:'shared-note'});
  await server.advance([owner.page,guest.page],2500);
  await expect.poll(()=>guest.page.evaluate(()=>(window as any).sdkPresence.peers.find((peer:any)=>peer.userId==='owner'))).toMatchObject({muse:'working',museTargetId:'shared-note'});
  server.dropNextActivity('owner');await options(owner.page,{museWorking:false});
  await server.advance([owner.page,guest.page],2500);
  await expect.poll(()=>guest.page.evaluate(()=>(window as any).sdkPresence.peers.find((peer:any)=>peer.userId==='owner')?.muse)).toBe('idle');
 }finally{await Promise.all(contexts.map(context=>context.close()));}
});
