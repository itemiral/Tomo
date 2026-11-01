import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { museFixture } from './muse-fixture';

const boardId = '8b72557c-0a22-4b39-b6fc-791d75cc2207';
type Message = { operation: string; topic: string; key: string; actor?: string; payload?: Record<string, unknown>; event?: string };
type Subscription = { page: Page; topic: string; key: string; actor: string; payload?: Record<string, unknown> };

function transport() {
  const subscriptions = new Map<string, Subscription>();
  const messages: Message[] = [];
  async function deliver(subscription: Subscription, kind: string, payload: unknown) {
    if (subscription.page.isClosed()) return;
    await subscription.page.evaluate(({ key, kind, payload }) => {
      (window as unknown as { presenceDeliver: (key: string, kind: string, value: unknown) => void }).presenceDeliver(key, kind, payload);
    }, { key: subscription.key, kind, payload });
  }
  async function sync(topic: string) {
    const peers = [...subscriptions.values()].filter(value => value.topic === topic);
    const state = Object.fromEntries(peers.filter(value => value.payload).map(value => [value.key, [{ ...value.payload, presence_ref: value.key }]]));
    await Promise.all(peers.map(peer => deliver(peer, 'sync', state)));
  }
  return {
    messages,
    connections: () => subscriptions.size,
    async attach(page: Page) {
      await page.exposeFunction('presenceTransport', async (message: Message) => {
        messages.push(structuredClone(message));
        if (message.operation === 'subscribe') {
          if (!message.actor || !['ada', 'bo'].includes(message.actor) || message.topic !== 'board:' + boardId) return 'CHANNEL_ERROR';
          subscriptions.set(message.key, { page, topic: message.topic, key: message.key, actor: message.actor });
          await sync(message.topic);
          return 'SUBSCRIBED';
        }
        const current = subscriptions.get(message.key);
        if (!current) return 'error';
        if (message.operation === 'track') { current.payload = message.payload; await sync(current.topic); }
        if (message.operation === 'untrack') { delete current.payload; await sync(current.topic); }
        if (message.operation === 'leave') { subscriptions.delete(message.key); await sync(current.topic); }
        if (message.operation === 'broadcast') await Promise.all([...subscriptions.values()].filter(peer => peer.topic === current.topic && peer.key !== current.key).map(peer => deliver(peer, 'broadcast', { event: message.event, payload: message.payload })));
        return 'ok';
      });
    },
  };
}

let bundle: Promise<{ js: string; css: string }>;
function compiledFixture() {
  return bundle ||= build({
    stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {useBoardPresence} from './src/components/muze/use-board-presence';
      import {BoardParticipants,BoardPeerCursors,BoardPeerMuses} from './src/components/muze/board-presence';
      import './src/app/globals.css'; import './src/components/muze/whiteboard.css'; import './src/components/muse/muse.css';
      function Board(){
        const seed=window.presenceSeed;
        const [userId,setUserId]=useState(seed.userId),[pageId,setPageId]=useState('page-one'),[enabled,setEnabled]=useState(true),[museWorking,setWorking]=useState(false),[viewport,setViewport]=useState(seed.viewport),[clicks,setClicks]=useState(0);
        const presence=useBoardPresence({boardId:seed.boardId,userId,name:seed.name,pageId,viewport,enabled,museWorking,soul:'SECRET_SOUL',memory:'SECRET_MEMORY',chat:'SECRET_CHAT'});
        return <main className="muze-app"><div className="muze-drawing-surface" style={{position:'fixed',inset:0}} aria-label="Shared canvas"/>
          <nav style={{position:'fixed',top:12,left:12,zIndex:1000}} data-muse-ui="true">
            <button onClick={()=>setViewport([.5,0,0,.5,80,40])}>Pan and zoom</button>
            <button onClick={()=>setPageId(p=>p==='page-one'?'page-two':'page-one')}>Change page</button>
            <button onClick={()=>setWorking(v=>!v)}>Toggle Muse work</button>
            <button onClick={()=>setEnabled(v=>!v)}>Private notebook</button>
            <button onClick={()=>{setUserId(undefined);window.presenceOwner=undefined;window.dispatchEvent(new Event('presence-owner'));}}>Sign out</button>
            <button onClick={()=>{setUserId('bo');window.presenceOwner='bo';window.dispatchEvent(new Event('presence-owner'));}}>Switch account</button>
            <button onClick={()=>window.presenceUnmount()}>Leave board</button>
            <input aria-label="Private chat" value="SECRET_CHAT" readOnly/>
          </nav>
          <div className="muse-chat-stack" style={{position:'fixed',left:400,top:400,bottom:'auto',width:300,zIndex:24,transform:'none'}} onPointerMove={event=>event.stopPropagation()}>
            <button aria-label="Chat overlay action" style={{width:300,height:100,background:'#fff',pointerEvents:'auto'}} onClick={()=>setClicks(value=>value+1)}>Chat action {clicks}</button>
          </div>
          <BoardParticipants peers={presence.peers} userId={userId} connected={presence.connected}/>
          <BoardPeerCursors cursors={presence.cursors} pageId={pageId} viewport={viewport}/>
          <BoardPeerMuses peers={presence.peers} userId={userId} pageId={pageId}/>
        </main>;
      }
      const root=createRoot(document.getElementById('root'));window.presenceUnmount=()=>root.unmount();root.render(<Board/>);
    ` },
    bundle: true, write: false, outdir: '/tmp/muze-presence-fixture', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_SUPABASE_URL':'"https://presence.invalid"', 'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY':'"fixture-public-key"' },
    plugins: [{ name: 'presence-transport-fixture', setup(b) {
      b.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: 'clerk', namespace: 'presence' }));
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'transport', namespace: 'presence' }));
      b.onLoad({ filter: /.*/, namespace: 'presence' }, args => ({ loader: 'tsx', resolveDir: resolve('.'), contents: args.path === 'clerk' ? `
        import {useState,useEffect,useMemo} from 'react';
        export function useSession(){const [resource,setResource]=useState(0);useEffect(()=>{const change=()=>setResource(value=>value+1);window.addEventListener('presence-owner',change);window.addEventListener('presence-resource',change);return()=>{window.removeEventListener('presence-owner',change);window.removeEventListener('presence-resource',change)}},[]);const owner=window.presenceOwner;const session=useMemo(()=>owner?{id:'session-'+owner,getToken:async()=>{window.presenceTokenAttempts=(window.presenceTokenAttempts||0)+1;window.presenceTokenResource=resource;if(window.presenceTokenFailures>0){window.presenceTokenFailures--;throw new Error('Temporary network failure');}return btoa('{}')+'.'+btoa(JSON.stringify({sub:owner,exp:Math.floor(Date.now()/1000)+60})) +'.test';},user:{id:owner}}:null,[owner,resource]);return {session,isLoaded:true,isSignedIn:!!owner};}
      ` : `
        const channels=new Map();
        window.presenceDeliver=(key,kind,value)=>{const channel=channels.get(key);if(!channel)return;if(kind==='sync'){channel.presence=value;for(const cb of channel.handlers.filter(h=>h.kind==='presence'&&h.filter.event==='sync'))cb.callback();}else for(const cb of channel.handlers.filter(h=>h.kind==='broadcast'&&h.filter.event===value.event))cb.callback({payload:value.payload});};
        export function createClient(_url,_key,{accessToken:getToken}){window.presenceClientCount=(window.presenceClientCount||0)+1;let token='';const owned=new Set();const client={realtime:{setAuth:async(value)=>{token=value;}},channel(topic,options){const key=options.config.presence.key;const channel={state:'closed',presence:{},handlers:[],on(kind,filter,callback){this.handlers.push({kind,filter,callback});return this;},presenceState(){return this.presence;},subscribe(callback){void getToken().then(value=>window.presenceTransport({operation:'subscribe',topic,key,actor:JSON.parse(atob((token||value).split('.')[1])).sub})).then(status=>{this.state=status==='SUBSCRIBED'?'joined':'closed';callback(status)});return this;},track(payload){return window.presenceTransport({operation:'track',topic,key,payload});},untrack(){return window.presenceTransport({operation:'untrack',topic,key});},send(message){return window.presenceTransport({operation:'broadcast',topic,key,event:message.event,payload:message.payload});},async unsubscribe(){this.state='closed';await window.presenceTransport({operation:'leave',topic,key});channels.delete(key);owned.delete(channel);return 'ok';}};channels.set(key,channel);owned.add(channel);return channel;},removeChannel(channel){return channel.unsubscribe();},removeAllChannels(){return Promise.all([...owned].map(c=>c.unsubscribe()));}};return client;}
      ` }));
    } }],
  }).then(result => ({ js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text }));
}

async function fixture(page: Page, bus: ReturnType<typeof transport>, userId: 'ada' | 'bo', viewport: number[] = [1, 0, 0, 1, 0, 0], authFailures = 0) {
  const assets = await compiledFixture();
  await bus.attach(page);
  await page.addInitScript(seed => { (window as any).presenceSeed = seed; (window as any).presenceOwner = seed.userId; (window as any).presenceTokenFailures = seed.authFailures; }, { authFailures, userId, name: userId === 'ada' ? 'Ada' : 'Bo', boardId, viewport });
  await page.route('**/__presence-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/__presence-fixture.css"></head><body><div id="root"></div><script src="/__presence-fixture.js"></script></body></html>' }));
  await page.route('**/__presence-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__presence-fixture.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.goto('/__presence-fixture');
  await expect(page.getByLabel('Shared canvas')).toBeAttached();
}

test('board members see named cursors at world positions across pan and zoom', async ({ browser }) => {
  const bus = transport(), a = await browser.newContext(), b = await browser.newContext();
  try {
    const ada = await a.newPage(), bo = await b.newPage();
    await fixture(ada, bus, 'ada', [2, 0, 0, 2, 100, 50]); await fixture(bo, bus, 'bo');
    await expect(bo.getByLabel('People on this board')).toContainText('Ada');
    await expect(ada.getByLabel('People on this board')).toContainText('Bo');
    await ada.mouse.move(500, 350);
    const cursor = bo.getByLabel('Ada’s cursor', { exact: true });
    await expect(cursor).toBeVisible();
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.x)).toBe(200);
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.y)).toBe(150);
    await bo.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.x)).toBe(180);
    await expect.poll(async () => Math.round((await cursor.boundingBox())!.y)).toBe(115);
    await bo.screenshot({ path: '/tmp/muze-presence-cursors.png' });
    await bo.getByRole('button', { name: 'Change page', exact: true }).click();
    await expect(cursor).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});

test('late joiners see stationary cursors and keepalives preserve them until the pointer leaves',async({browser})=>{
 const bus=transport(),a=await browser.newContext(),b=await browser.newContext();
 try{
  const ada=await a.newPage(),bo=await b.newPage();
  await ada.clock.install();await bo.clock.install();
  await fixture(ada,bus,'ada');await expect(ada.getByLabel('People on this board')).toContainText('You');await ada.mouse.move(500,350);
  await fixture(bo,bus,'bo');await expect(bo.getByLabel('People on this board')).toContainText('Ada');
  await ada.clock.runFor(3100);const cursor=bo.getByLabel('Ada’s cursor',{exact:true});await expect(cursor).toBeVisible();
  // A connected peer keeps its last position even when no cursor heartbeat arrives.
  const cursorMessages=bus.messages.filter(message=>message.operation==='broadcast').length;
  await bo.clock.runFor(16000);await expect(cursor).toBeVisible();
  expect(bus.messages.filter(message=>message.operation==='broadcast')).toHaveLength(cursorMessages);
  for(let interval=0;interval<5;interval++){await ada.clock.runFor(3000);await bo.clock.runFor(3000);await expect(cursor).toBeVisible();}
  await ada.getByRole('button',{name:'Pan and zoom',exact:true}).focus();await ada.keyboard.press('Enter');await ada.clock.runFor(3100);
  await expect.poll(async()=>Math.round((await cursor.boundingBox())!.x)).toBe(840);await expect.poll(async()=>Math.round((await cursor.boundingBox())!.y)).toBe(620);
  await ada.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerout',{relatedTarget:null})));await expect(cursor).toHaveCount(0);
  await ada.clock.runFor(12000);await expect(cursor).toHaveCount(0);
 }finally{await a.close();await b.close();}
});

test('cursor positions include chat and toolbar controls without blocking their clicks',async({browser})=>{
 const bus=transport(),a=await browser.newContext(),b=await browser.newContext();
 try{
  const ada=await a.newPage(),bo=await b.newPage();
  await ada.clock.install();await bo.clock.install();
  await fixture(ada,bus,'ada');await fixture(bo,bus,'bo');
  await expect(bo.getByLabel('People on this board')).toContainText('Ada');
  const tracks=bus.messages.filter(message=>message.operation==='track').length;
  const cursor=bo.getByLabel('Ada’s cursor',{exact:true});
  await ada.mouse.move(440,430);await ada.clock.runFor(100);
  await expect(cursor).toBeVisible();
  await expect.poll(async()=>Math.round((await cursor.boundingBox())!.x)).toBe(440);
  const layer=await bo.locator('.board-peer-cursors').evaluate(element=>({z:Number(getComputedStyle(element).zIndex),nonInteractive:[element,...element.querySelectorAll('*')].every(item=>getComputedStyle(item).pointerEvents==='none')}));
  expect(layer.z).toBeGreaterThan(1000);expect(layer.nonInteractive).toBe(true);
  expect(await bo.evaluate(()=>document.elementFromPoint(444,435)?.closest('button')?.getAttribute('aria-label'))).toBe('Chat overlay action');
  await bo.mouse.click(444,435);await expect(bo.getByRole('button',{name:'Chat overlay action',exact:true})).toHaveText('Chat action 1');
  const label=await cursor.locator('.board-cursor-label').boundingBox();
  await bo.mouse.click(label!.x+label!.width/2,label!.y+label!.height/2);
  await expect(bo.getByRole('button',{name:'Chat overlay action',exact:true})).toHaveText('Chat action 2');
  const toolbar=await ada.getByRole('button',{name:'Pan and zoom',exact:true}).boundingBox();
  await ada.mouse.move(toolbar!.x+8,toolbar!.y+8);await ada.clock.runFor(100);
  await expect.poll(async()=>Math.round((await cursor.boundingBox())!.x)).toBe(Math.round(toolbar!.x+8));
  await expect.poll(async()=>Math.round((await cursor.boundingBox())!.y)).toBe(Math.round(toolbar!.y+8));
  // Hiding the tab clears the pointer immediately, without a delayed timer or presence update.
  await ada.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(cursor).toHaveCount(0);
  expect(bus.messages.filter(message=>message.operation==='track')).toHaveLength(tracks);
  expect(bus.messages.filter(message=>message.operation==='untrack')).toHaveLength(0);
 }finally{await a.close();await b.close();}
});

test('Muse status is public metadata only and private notebooks, sign-out, and unmount clear presence', async ({ browser }) => {
  const bus = transport(), a = await browser.newContext(), b = await browser.newContext();
  try {
    const ada = await a.newPage(), bo = await b.newPage();
    await ada.clock.install();
    await fixture(ada, bus, 'ada'); await fixture(bo, bus, 'bo');
    await expect(bo.getByLabel('People on this board')).toContainText('Ada');
    await ada.getByRole('button', { name: 'Toggle Muse work', exact: true }).click();
    await expect(bo.getByLabel('Ada’s Muse, working', { exact: true })).toBeVisible();
    const orb = await bo.getByLabel('Ada’s Muse, working', { exact: true }).locator('.board-peer-muse-icon').boundingBox();
    expect(orb!.width).toBeGreaterThan(30); expect(orb!.height).toBeGreaterThan(30);
    await ada.getByRole('button', { name: 'Change page', exact: true }).click();
    await expect(bo.getByLabel('Ada’s Muse, working', { exact: true })).toHaveCount(0);
    await expect(bo.getByLabel('People on this board')).toContainText('Ada');
    await ada.getByRole('button', { name: 'Change page', exact: true }).click();
    await expect(bo.getByLabel('Ada’s Muse, working', { exact: true })).toBeVisible();
    await ada.mouse.move(550, 350);
    await expect(bo.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
    await ada.getByRole('button', { name: 'Private notebook', exact: true }).click();
    await expect(bo.getByLabel('Ada’s cursor', { exact: true })).toHaveCount(0);
    await expect(bo.getByLabel('Ada’s Muse, working', { exact: true })).toHaveCount(0);
    await expect(bo.getByLabel('People on this board')).not.toContainText('Ada');
    await ada.clock.fastForward(33000);
    await ada.getByRole('button', { name: 'Private notebook', exact: true }).click();
    await expect(bo.getByLabel('People on this board')).toContainText('Ada');
    await ada.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(bo.getByLabel('People on this board')).not.toContainText('Ada');
    await expect.poll(bus.connections).toBe(1);
    await bo.getByRole('button', { name: 'Leave board', exact: true }).click();
    await expect.poll(bus.connections).toBe(0);
    const payloads = bus.messages.filter(message => message.payload).map(message => message.payload!);
    expect(payloads.length).toBeGreaterThan(2);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toMatch(/SECRET_|soul|memory|chat|prompt|reply|api.?key/i);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024);
      expect(Object.keys(payload).every(key => ['userId', 'name', 'tabId', 'pageId', 'muse', 'x', 'y', 'updatedAt', 'sentAt', 'ts'].includes(key))).toBe(true);
    }
  } finally { await a.close(); await b.close(); }
});

test('presence recovers after a temporary session-token failure', async ({ browser }) => {
  const bus = transport(), a = await browser.newContext(), b = await browser.newContext();
  try {
    const ada = await a.newPage(), bo = await b.newPage();
    await fixture(ada, bus, 'ada', [1, 0, 0, 1, 0, 0], 1);
    await fixture(bo, bus, 'bo');
    await expect(bo.getByLabel('People on this board')).toContainText('Ada');
    await expect(ada.getByLabel('People on this board')).toContainText('Bo');
    expect(await ada.evaluate(() => (window as any).presenceTokenAttempts)).toBeGreaterThan(1);
    await ada.mouse.move(300, 300);
    await expect(bo.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
  } finally { await a.close(); await b.close(); }
});

test('session resource refreshes keep one connection and account changes replace it', async ({page})=>{
 const bus=transport();await page.clock.install();await fixture(page,bus,'ada');
 const people=page.getByLabel('People on this board');await expect(people).toContainText('You');
 await page.evaluate(()=>{const element=document.querySelector('[aria-label="People on this board"]')!;(window as any).connectingFlashes=0;new MutationObserver(()=>{if(element.textContent?.includes('Connecting'))(window as any).connectingFlashes++;}).observe(element,{subtree:true,childList:true,characterData:true});});
 for(let index=0;index<3;index++){await page.evaluate(()=>window.dispatchEvent(new Event('presence-resource')));await page.clock.runFor(10);}
 await page.clock.fastForward(30000);
 await expect.poll(()=>page.evaluate(()=>(window as any).presenceTokenResource)).toBe(3);
 expect(await page.evaluate(()=>(window as any).presenceClientCount)).toBe(1);
 expect(bus.messages.filter(message=>message.operation==='subscribe')).toHaveLength(1);
 expect(bus.messages.filter(message=>message.operation==='leave')).toHaveLength(0);
 expect(await page.evaluate(()=>(window as any).connectingFlashes)).toBe(0);
 await page.getByRole('button',{name:'Switch account',exact:true}).click();await expect(people).toContainText('You');
 await expect.poll(()=>bus.messages.filter(message=>message.operation==='subscribe').length).toBe(2);
 expect(bus.messages.filter(message=>message.operation==='subscribe').map(message=>message.actor)).toEqual(['ada','bo']);
 expect(bus.messages.some(message=>message.operation==='leave')).toBe(true);
 expect(await page.evaluate(()=>(window as any).presenceClientCount)).toBe(2);expect(bus.connections()).toBe(1);
});

test('temporary token refresh errors keep a valid connection but expiry clears it and recovery rejoins',async({page})=>{
 const bus=transport();await page.clock.install();await fixture(page,bus,'ada');
 const people=page.getByLabel('People on this board');await expect(people).toContainText('You');
 const attempts=await page.evaluate(()=>(window as any).presenceTokenAttempts);
 await page.evaluate(()=>{(window as any).presenceTokenFailures=20;});await page.clock.fastForward(30000);
 await expect.poll(()=>page.evaluate(()=>(window as any).presenceTokenAttempts)).toBeGreaterThan(attempts);
 await expect(people).toContainText('You');expect(bus.messages.filter(message=>message.operation==='leave')).toHaveLength(0);
 await page.clock.fastForward(31000);await expect(people).toContainText('Connecting');
 await expect.poll(bus.connections).toBe(0);
 await page.evaluate(()=>{(window as any).presenceTokenFailures=0;});await page.clock.fastForward(30000);
 await expect(people).toContainText('You');await expect.poll(bus.connections).toBe(1);
});

test('presence controls fit the full editor on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await museFixture(page);
  await page.getByRole('textbox', { name: 'Board name' }).fill('Our next project');
  await page.getByRole('textbox', { name: 'Board name' }).press('Enter');
  for (const note of [{ x: 420, y: 310, text: 'What are we making?\nChoose one clear outcome.' }, { x: 750, y: 440, text: 'Next steps\nGather ideas and decide together.' }]) {
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    await page.mouse.click(note.x, note.y); await page.keyboard.type(note.text); await page.keyboard.press('Escape');
  }
  // Render the real presence components over the complete editor. Behavioral tests above use the live hook.
  const overlay = await build({
    stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BoardParticipants,BoardPeerCursors,BoardPeerMuses} from './src/components/muze/board-presence';
      const peers=[{userId:'owner-a',name:'You',tabId:'self',pageId:'page-one',muse:'idle'},{userId:'ada',name:'Ada',tabId:'a',pageId:'page-one',muse:'working'},{userId:'bo',name:'Bo',tabId:'b',pageId:'page-one',muse:'idle'}];
      const header=document.createElement('div');header.style.display='contents';document.querySelector('.muze-header').append(header);
      createRoot(header).render(<BoardParticipants peers={peers} userId="owner-a" connected/>);
      const canvas=document.createElement('div');canvas.style.display='contents';document.querySelector('.muze-app').append(canvas);
      createRoot(canvas).render(<><BoardPeerCursors cursors={[{...peers[1],x:465,y:280,receivedAt:Date.now()},{...peers[2],x:800,y:420,receivedAt:Date.now()}]} pageId="page-one" viewport={[1,0,0,1,0,0]}/><BoardPeerMuses peers={peers} userId="owner-a" pageId="page-one"/></>);
    ` },
    bundle: true, write: false, outdir: '/tmp/muze-presence-editor-overlay', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.addScriptTag({ content: overlay.outputFiles.find(file => file.path.endsWith('.js'))!.text });
  await expect(page.getByLabel('People on this board')).toContainText('Ada');
  await expect(page.getByLabel('Ada’s cursor', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ada’s Muse, working', { exact: true })).toBeVisible();
  const people = await page.getByLabel('People on this board').boundingBox(), controls = await page.locator('.muze-header-right').boundingBox();
  expect(people!.x + people!.width).toBeLessThan(controls!.x);
  await page.screenshot({ path: '/tmp/muze-presence-editor.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePeople = await page.getByLabel('People on this board').boundingBox(), mobileControls = await page.locator('.muze-header-right').boundingBox();
  expect(mobilePeople!.y).toBeGreaterThan(mobileControls!.y + mobileControls!.height);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/muze-presence-editor-mobile.png' });
});
