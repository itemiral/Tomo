import { build } from 'esbuild';
import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MuseActions } from '../src/lib/muse-board';

let bundle: Promise<{ js: string; css: string }>;
function fixtureBundle() {
  return bundle ||= build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import Editor from './src/components/muze/editor'; import './src/app/globals.css'; createRoot(document.getElementById('root')).render(<Editor/>);`, resolveDir: resolve('.'), loader: 'tsx' },
    bundle: true, write: false, outdir: '/tmp/muze-fixture', platform: 'browser', format: 'iife', jsx: 'automatic', external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'component-auth-fixture', setup(build) {
      build.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: 'auth-fixture', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: resolve('.'), contents: `
        import { useState, useEffect } from 'react';
        export function useUser() { const [id,setId]=useState(window.fixtureOwner || 'owner-a'); useEffect(()=>{const change=()=>setId(window.fixtureOwner);window.addEventListener('fixture-owner',change);return()=>window.removeEventListener('fixture-owner',change)},[]);return {isLoaded:true,isSignedIn:!!id,user:id?{id}:null}; }
        export const SignInButton = ({children}) => children;
        export const SignUpButton = ({children}) => children;
        export const UserButton = () => <button aria-label="Sign out" onClick={()=>{window.fixtureOwner=null;window.dispatchEvent(new Event('fixture-owner'))}}>Account</button>;
      ` }));
    } }],
  }).then(result => ({ js: result.outputFiles!.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles!.find(file => file.path.endsWith('.css'))!.text }));
}

type Message = { id: string; role: 'user' | 'assistant'; content: string };
export async function museFixture(page: Page) {
  const assets = await fixtureBundle();
  let owner = 'owner-a', turn = 0, icon: string | null = null;
  const notes = new Map<string, { content: string; revision: string; updatedAt: number }>();
  const history = new Map<string, Message[]>();
  let respond: (body: { message: string; board: string }) => Promise<MuseActions> = async () => ({ cards: [
    { id: 'muse-test-0', title: 'Set the direction', body: 'Choose a goal and define what success looks like.\n• Name the outcome\n• Set a useful deadline' },
    { id: 'muse-test-1', title: 'Make room for the work', body: 'Gather the people, time, and resources you need.\n• Keep the scope manageable\n• Choose the first step' },
    { id: 'muse-test-2', title: 'Check progress', body: 'Review what is working and adjust together.\n• Make decisions visible\n• Keep the next step clear' },
  ], updates: [] });
  await page.route('**/__muse-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/__fixture.css"></head><body><div id="root"></div><script src="/__fixture.js"></script></body></html>' }));
  await page.route('**/__fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: assets.js }));
  await page.route('**/__fixture.css', route => route.fulfill({ contentType: 'text/css', body: assets.css }));
  await page.route('**/api/muse/**', async route => {
    const req = route.request(), url = new URL(req.url()), key = url.pathname.split('/').at(-1)!;
    const ownerAtRequest = owner;
    if (key === 'session') return route.fulfill({ json: { ownerId: owner, ownerName: owner === 'owner-a' ? 'First owner' : 'Second owner', muse: { id: owner + '-muse', name: 'Muse', iconVersion: icon ? 'test-icon' : null } } });
    if (key === 'soul' || key === 'memory') {
      const id = owner + ':' + key;
      if (!notes.has(id)) notes.set(id, { content: '# ' + (key === 'soul' ? 'Soul' : 'Memory') + '\n\nDefault template for ' + owner, revision: 'initial', updatedAt: Date.now() });
      const note = notes.get(id)!;
      if (req.method() === 'PUT') {
        const body = req.postDataJSON();
        if (body.revision !== note.revision) return route.fulfill({ status: 409, json: { error: 'This note changed elsewhere. Cancel to reload it.' } });
        notes.set(id, { content: body.content, revision: 'revision-' + ++turn, updatedAt: Date.now() });
      }
      return route.fulfill({ json: { key, ...notes.get(id) } });
    }
    if (key === 'avatar') {
      if (req.method() === 'PUT') { icon = req.postDataJSON().image; return route.fulfill({ json: { iconVersion: 'test-icon' } }); }
      return route.fulfill({ contentType: 'image/png', body: Buffer.from(icon!.split(',')[1], 'base64') });
    }
    if (key === 'chat') {
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      const id = ownerAtRequest + ':' + (body?.thread || url.searchParams.get('thread'));
      if (!body) return route.fulfill({ json: { messages: history.get(id) || [] } });
      const actions = await respond(body);
      const messages: Message[] = [...(history.get(id) || []), { id: 'user-' + ++turn, role: 'user', content: body.message }, { id: 'assistant-' + turn, role: 'assistant', content: 'Prepared the next steps for your board.' }];
      history.set(id, messages);
      return route.fulfill({ json: { messages, actions } }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/__muse-fixture');
  await expect(page.getByRole('main', { name: 'Muse Board' })).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Talk to Muse' })).toBeVisible();
  return {
    notes,
    response: (callback: typeof respond) => { respond = callback; },
    owner: async (value: string) => { owner = value; await page.evaluate(value => { (window as unknown as { fixtureOwner: string }).fixtureOwner = value; window.dispatchEvent(new Event('fixture-owner')); }, value); },
  };
}
export async function exported(page: Page) {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Muse Board file', exact: true }).click();
  const text = await readFile((await (await pending).path())!, 'utf8');
  const data = JSON.parse(text);
  return { text, objects: data.board.pages.find((page: { id: string }) => page.id === data.board.activePage).objects as { id: string; text: string; left: number; top: number; width: number; height: number }[], viewport: data.board.pages[0].viewport as number[] };
}
export async function chat(page: Page) { await page.getByRole('button', { name: 'Talk to Muse' }).click(); await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled(); }
export async function send(page: Page, text = 'Help me plan a project') { await page.getByRole('textbox', { name: 'Message Muse' }).fill(text); await page.getByRole('button', { name: 'Send to Muse' }).click(); }
