import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let compiled: Promise<{ js: string; css: string }>;
function bundle() {
  return compiled ||= build({
    stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
      import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import{BoardPeerMuses}from'./src/components/muze/board-presence';
      import'./src/app/globals.css';import'./src/components/muze/whiteboard.css';
      function App(){
        const[state,setState]=useState({count:3,pageId:'page-one',chatHeight:130,chatVisible:true});window.rosterOptions=patch=>setState(value=>({...value,...patch}));
        const names=['Izat','Yuhao',...Array.from({length:18},(_,i)=>'Person '+(i+3))];
        const peers=[{userId:'owner',name:'Owner',tabId:'owner-tab',pageId:'page-one',muse:'idle'},...names.slice(0,state.count).map((name,i)=>({userId:'peer-'+i,name,tabId:'tab-'+i,pageId:'page-one',muse:i===2?'working':'idle',museTargetId:i===2?'active-note':undefined})),{userId:'elsewhere',name:'Elsewhere',tabId:'another-page',pageId:'page-two',muse:'idle'}];
        const profiles=Object.fromEntries(peers.map(person=>[person.userId,{userId:person.userId,name:person.name,museName:person.userId==='peer-0'?'Kumo':'Muse',avatarUrl:'/__roster-avatar.png',museAvatarUrl:'/__roster-avatar.png',museAvatarVersion:null,musePoses:9,museSheet:false}]));
        return <main className="muze-app">
          <div className="muze-toolbar-dock" style={{height:104}}>Drawing tools</div>
          {state.chatVisible&&<div className="muse-chat-stack" style={{position:'absolute',left:'50%',bottom:126,transform:'translateX(-50%)',width:'min(520px,calc(100vw - 24px))',height:state.chatHeight}}>Chat</div>}
          <BoardPeerMuses peers={[...peers,peers[1]]} userId="owner" pageId={state.pageId} profiles={profiles} items={[{id:'active-note',x:240,y:150,w:180,h:120}]}/>
        </main>;
      }createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, outdir: '/tmp/muze-roster-fixture', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"' },
  }).then(result => ({ js: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))!.text }));
}
async function fixture(page: Page) {
  const assets = await bundle(), icon = await readFile('public/muse/default-avatar.png');
  await page.route('**/__muse-roster', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/__muse-roster.css"><div id="root"></div><script src="/__muse-roster.js"></script>' }));
  await page.route('**/__muse-roster.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__muse-roster.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.route('**/__roster-avatar.png', route => route.fulfill({ contentType: 'image/png', body: icon }));
  await page.goto('/__muse-roster');
}
async function options(page: Page, value: { count?: number; pageId?: string; chatHeight?: number; chatVisible?: boolean }) {
  await page.evaluate(value => (window as any).rosterOptions(value), value);
}
async function expectClearOfControls(page: Page) {
  await expect.poll(() => page.locator('.board-peer-muses').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 80 && box.bottom <= innerHeight && ['.muze-toolbar-dock', '.muse-chat-stack'].every(selector => {
      const element = document.querySelector(selector); if (!element) return true;
      const obstacle = element.getBoundingClientRect();
      return box.right <= obstacle.left || box.left >= obstacle.right || box.bottom <= obstacle.top || box.top >= obstacle.bottom;
    });
  })).toBe(true);
}

test('three collaborators keep two identity rows and reveal the third by keyboard', async ({ page }) => {
  await fixture(page);
  const roster = page.getByLabel('Collaborators’ Muses'), rows = roster.locator('.board-peer-muse');
  await expect(rows).toHaveCount(2);
  await expect(roster).toContainText('with Izat'); await expect(roster).toContainText('with Yuhao');
  await expect(roster).not.toContainText('Owner'); await expect(roster).not.toContainText('Elsewhere');
  await expect(roster.getByLabel('Izat’s Kumo, idle').locator('canvas')).toHaveAttribute('data-portrait-source', '/__roster-avatar.png');
  await expect(roster.getByLabel('Izat’s Kumo, idle').locator('.board-user-avatar img')).toHaveAttribute('src', '/__roster-avatar.png');
  // Collapsing the list must not hide a working collaborator's note outline.
  await expect(page.locator('.board-muse-targets [data-target-id="active-note"]')).toHaveCount(1);
  const more = roster.getByRole('button', { name: '+1 more', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.focus(); await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(3);
  const less = roster.getByRole('button', { name: 'Show less', exact: true });
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  const list = roster.getByRole('region', { name: 'Muses on this page' });
  expect(await less.getAttribute('aria-controls')).toBe(await list.getAttribute('id'));
  await list.focus(); await page.keyboard.press('Escape');
  await expect(more).toBeFocused(); await expect(rows).toHaveCount(2);
  await expectClearOfControls(page);
});

test('many collaborators stay compact and all remain reachable in the expanded scroll list', async ({ page }) => {
  await fixture(page); await options(page, { count: 18 });
  const roster = page.getByLabel('Collaborators’ Muses'), rows = roster.locator('.board-peer-muse');
  await expect(rows).toHaveCount(2); await expect(roster).toContainText('18 here');
  expect((await roster.boundingBox())!.height).toBeLessThan(220);
  await page.screenshot({ path: '/tmp/muze-roster-compact-desktop.png' });
  await roster.getByRole('button', { name: '+16 more', exact: true }).click();
  await expect(rows).toHaveCount(18);
  const list = roster.getByRole('region', { name: 'Muses on this page' });
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect((await roster.boundingBox())!.height).toBeLessThan(360);
  await rows.last().scrollIntoViewIfNeeded(); await expect(rows.last()).toBeInViewport();
  await expectClearOfControls(page);
  await options(page, { pageId: 'page-two' });
  await expect(roster.locator('.board-peer-muse')).toHaveCount(1);
  await options(page, { pageId: 'page-one' });
  await expect(rows).toHaveCount(2); await expect(roster.getByRole('button', { name: '+16 more', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('phone roster expands above chat and drawing tools without taking over the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page); await options(page, { count: 12 });
  const roster = page.getByLabel('Collaborators’ Muses'), rows = roster.locator('.board-peer-muse');
  await expect(rows).toHaveCount(2); expect((await roster.boundingBox())!.width).toBeLessThan(190);
  await expectClearOfControls(page);
  await roster.getByRole('button', { name: '+10 more', exact: true }).click();
  await expect(rows).toHaveCount(12); expect((await roster.boundingBox())!.width).toBeLessThan(260);
  await expectClearOfControls(page);
  await page.screenshot({ path: '/tmp/muze-roster-expanded-phone.png' });
  await page.setViewportSize({ width: 390, height: 568 }); await expectClearOfControls(page);
  await rows.last().scrollIntoViewIfNeeded(); await expect(rows.last()).toBeInViewport();
  await options(page, { chatHeight: 170 }); await expectClearOfControls(page);
  await roster.getByRole('button', { name: 'Show less', exact: true }).click(); await expect(rows).toHaveCount(2);
  await options(page, { count: 2 }); await expect(roster.getByRole('button')).toHaveCount(0);
  await expectClearOfControls(page);
  await options(page, { chatVisible: false });
  await expect.poll(async () => Math.round((await roster.boundingBox())!.y + (await roster.boundingBox())!.height)).toBe(442);
  await options(page, { chatVisible: true }); await expectClearOfControls(page);
});
