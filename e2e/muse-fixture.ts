import { build } from 'esbuild';
import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {museNameStyles} from '../src/lib/muse-name';
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
        export const useClerk = () => ({openSignIn() { window.fixtureSignInOpened = true; }});
        export const useSession = () => ({session:null});
        export const SignInButton = ({children}) => children;
        export const SignUpButton = ({children}) => children;
        export const UserButton = () => <button aria-label="Sign out" onClick={()=>{window.fixtureOwner=null;window.dispatchEvent(new Event('fixture-owner'))}}>Account</button>;
      ` }));
    } }],
  }).then(result => ({ js: result.outputFiles!.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles!.find(file => file.path.endsWith('.css'))!.text }));
}

type Message = { id: string; role: 'user' | 'assistant'; content: string };
export async function museFixture(page: Page, initialNotes:Partial<Record<'soul'|'memory',string>>={}) {
  const assets = await fixtureBundle();
  const defaultAvatar='data:image/png;base64,'+(await readFile('public/muse/default-avatar.png')).toString('base64');
  let owner = 'owner-a', turn = 0, icon: string | null = null;
  const boards = new Map<string, {cards: unknown[]; comments: unknown[]; revision: string}>();
  let generated = false, activated = false;const tasks=new Map<string,any>();const names=new Map<string,string>();
  let beforeCanvasSave=async()=>{};
  const canvases = new Map<string, {board:any;revision:string;notes:Record<string,string>}>();
  const notes = new Map<string, { content: string; revision: string; updatedAt: number }>();
  for(const [key,content] of Object.entries(initialNotes))notes.set('owner-a:'+key,{content,revision:'initial',updatedAt:Date.now()});
  const history = new Map<string, Message[]>();
  let respond: (body: { message: string; board: string }) => Promise<MuseActions & {suggestions?:string[];personalizationUpdated?:boolean}> = async () => ({ cards: [
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
    if (key === 'session') return route.fulfill({ json: { ownerId: owner, ownerName: owner === 'owner-a' ? 'First owner' : 'Second owner', muse: { id: owner + '-muse', name: names.get(owner)||'Muse', iconVersion: icon ? 'test-icon' : null, gazeVersion: activated ? 'gaze-test' : null, candidateVersion: generated ? 'gaze-test' : null } } });
    if (key === 'canvas') {
      if(!canvases.has(owner)) {
        const documents=['soul','memory'].map((key,i)=>{
          const id=owner+':'+key;if(!notes.has(id))notes.set(id,{content:'# '+key+'\n\nA few things about me.',revision:'initial',updatedAt:Date.now()});
          return {type:'MuzeDocument',id:'muse-file-'+key,markdown:notes.get(id)!.content,documentTitle:key+'.md',text:notes.get(id)!.content,left:220+i*530,top:190+i*80,width:430,boxHeight:360,inset:28,angle:i?2:-2,fontFamily:'IBM Plex Sans',fontSize:20,fill:'#202124',backgroundColor:'#ffffff',strokeWidth:0,verticalAlign:'top'};
        });
        canvases.set(owner,{board:{id:'muse-private',name:'My Muse’s notebook',activePage:'muse-notebook',pages:[{id:'muse-notebook',name:'Notebook',objects:[...documents,{type:'MuzeText',id:'muse-name',styles:museNameStyles('Muse'),text:'Hello, my name is Muse.',left:220,top:100,width:950,fontFamily:'Inter',fontSize:40,fill:'#202124',editable:false},{type:'Image',id:'muse-appearance',muzeKind:'muse-appearance',src:defaultAvatar,left:1240,top:300,width:256,height:256}],viewport:[.75,0,0,.75,0,0]}],comments:[{id:'muse-welcome',pageId:'muse-notebook',x:1230,y:150,author:'Muze',text:'Your private Muse notebook. Your notes, comments, and captions help Muse understand you.'}]},revision:'initial',notes:{soul:'initial',memory:'initial'}});
      }
      const current=canvases.get(owner)!;
      if(req.method()==='PUT') {
        await beforeCanvasSave();
        const body=req.postDataJSON();if(body.revision!==current.revision)return route.fulfill({status:409,json:{error:'This notebook changed elsewhere.'}});
        for(const key of ['soul','memory']) {
          const note=notes.get(owner+':'+key)!;if(body.notes[key]!==note.revision)return route.fulfill({status:409,json:{error:key+'.md changed elsewhere.'}});
          let doc:any;const walk=(objects:any[])=>objects.forEach(o=>{if(o.id==='muse-file-'+key)doc=o;if(o.objects)walk(o.objects)});body.board.pages.forEach((p:any)=>walk(p.objects));
          if(doc){const revision='revision-'+ ++turn;notes.set(owner+':'+key,{content:doc.markdown??doc.text,revision,updatedAt:Date.now()});body.notes[key]=revision;}
        }
        const nameObject=body.board.pages.flatMap((p:any)=>p.objects).find((o:any)=>o.id==='muse-name');if(nameObject){names.set(owner,nameObject.text.slice(18,-1).trim());body.board.museName=names.get(owner);}
        canvases.set(owner,{...body,revision:'canvas-'+ ++turn});
      }
      const result=canvases.get(owner)!;return route.fulfill({json:req.method()==='PUT'?{name:names.get(owner)||'Muse',revision:result.revision,notes:result.notes}:result});
    }
    if(key==='tasks'){const body=req.method()==='POST'?req.postDataJSON():null,id=owner+':'+(body?.thread||url.searchParams.get('thread'));if(body?.action==='create')tasks.set(id,{id:'task-1',goal:body.goal,status:'paused',cursor:0,attempts:0,steps:[{name:'Plan',status:'pending'},{name:'Compose',status:'pending'}],notes:[],sources:[]});if(body?.action==='step'&&tasks.has(id)){const t=tasks.get(id);t.steps[t.cursor].status='done';t.cursor++;t.attempts++;t.status=t.cursor===t.steps.length?'done':'paused';}if(body?.action==='cancel'&&tasks.has(id))tasks.get(id).status='cancelled';return route.fulfill({json:{task:tasks.get(id)||null,enabled:true}});}
    if(key==='image')return route.fulfill({json:{src:defaultAvatar,sourceUrl:'https://example.org/photo.png',sourceTitle:'example.org',retrievedAt:'2026-11-01T00:00:00Z'}});
    if (key === 'board') { if (!boards.has(owner)) boards.set(owner, {cards: [], comments: [], revision: 'initial'}); if(req.method()==='PUT') boards.set(owner, {...req.postDataJSON(), revision: 'rev-'+ ++turn}); return route.fulfill({json: boards.get(owner)}); }
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
      if(req.method()==='POST') {generated=true;activated=true;icon=req.postDataJSON().source||icon;return route.fulfill({json:{status:'completed',iconVersion:'test-icon',gazeVersion:'gaze-test'}});}
      if(req.method()==='PUT' && req.postDataJSON().action==='activate') {activated=true;return route.fulfill({json:{gazeVersion:'gaze-test',candidateVersion:'gaze-test'}});}
      if (req.method() === 'PUT') { icon = req.postDataJSON().source || req.postDataJSON().image; return route.fulfill({ json: { iconVersion: 'test-icon' } }); }
      return route.fulfill({ contentType: 'image/png', body: Buffer.from((icon||defaultAvatar).split(',')[1], 'base64') });
    }
    if (key === 'chat') {
      const body = req.method() === 'POST' ? req.postDataJSON() : null;
      const id = ownerAtRequest + ':' + (body?.thread || url.searchParams.get('thread'));
      if (!body) return route.fulfill({ json: { messages: history.get(id) || [] } });
      const actions = await respond(body);
      const messages: Message[] = [...(history.get(id) || []), { id: 'user-' + ++turn, role: 'user', content: body.message }, { id: 'assistant-' + turn, role: 'assistant', content: 'Prepared the next steps for your board.' }];
      history.set(id, messages);
      return route.fulfill({ json: { messages, actions, suggestions:actions.suggestions||[],personalizationUpdated:actions.personalizationUpdated } }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/__muse-fixture');
  await expect(page.getByRole('main', { name: 'Muze' })).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Open Muse' })).toBeVisible();
  return {
    notes, canvases,
    canvasSave: (handler:()=>Promise<void>)=>{beforeCanvasSave=handler;},
    response: (callback: typeof respond) => { respond = callback; },
    owner: async (value: string) => { owner = value; await page.evaluate(value => { (window as unknown as { fixtureOwner: string }).fixtureOwner = value; window.dispatchEvent(new Event('fixture-owner')); }, value); },
  };
}
export async function exported(page: Page) {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Save editable copy (.muze)', exact: true }).click();
  const text = await readFile((await (await pending).path())!, 'utf8');
  const data = JSON.parse(text);
  return { text, objects: data.board.pages.find((page: { id: string }) => page.id === data.board.activePage).objects as { type: string; markdown?:string; id: string; text: string; left: number; top: number; width: number; height: number }[], viewport: data.board.pages[0].viewport as number[] };
}
export async function chat(page: Page) { await page.getByRole('textbox', { name: 'Message Muse', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Message Muse' })).toBeEnabled(); }
export async function send(page: Page, text = 'Help me plan a project') { await page.getByRole('textbox', { name: 'Message Muse' }).fill(text); await page.getByRole('button', { name: 'Send to Muse' }).click(); }
