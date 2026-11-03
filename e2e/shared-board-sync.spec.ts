import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { Board } from '../src/components/muze/storage';

const boardId='1d6e0a20-9095-4bd3-a826-f53c6d9cd480';
const initial=():Board=>({id:boardId,name:'Shared plan',activePage:'page',pages:[{id:'page',name:'Page',viewport:[1,0,0,1,0,0],objects:[{id:'one',type:'MuzeNote',text:'Original wording',left:20,top:30,width:280,height:160}]}],comments:[]});
let assets:Promise<string>;
function bundle(){return assets ||= build({stdin:{contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useSharedBoard} from './src/components/muze/use-shared-board';
 function Fixture(){const [owner,setOwner]=useState('owner-a');const shared=useSharedBoard(owner,()=>window.receive!==false);window.sync={...shared,setOwner};return <pre id="state">{JSON.stringify({board:shared.board,boardId:shared.boardId,error:shared.error,conflict:shared.conflict,busy:shared.busy})}</pre>};
 createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).then(value=>value.outputFiles[0].text);}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
async function fixture(page:Page){
 let board=initial(),revision=1,reads=0,writes=0,failWrites=false;
 let beforeRead=async()=>{},beforeWrite=async()=>{};
 const source=await bundle();
 await page.route(/\/__shared-sync(?:\?.*)?$/,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script src="/__sync-bundle.js"></script>'}));
 await page.route('**/__sync-bundle.js',route=>route.fulfill({contentType:'application/javascript',body:source}));
 await page.route('**/api/boards{,/**}',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
  if(path==='/api/boards')return route.fulfill({json:{boards:[{id:boardId,name:board.name,role:'owner'}]}});
  if(path!=='/api/boards/'+boardId)return route.fulfill({status:404,json:{error:'Board not found.'}});
  if(method==='GET'){reads++;const snapshot={board:structuredClone(board),revision:String(revision),role:'owner'};await beforeRead();return route.fulfill({json:snapshot});}
  if(method==='PUT'){
   writes++;await beforeWrite();if(failWrites)return route.fulfill({status:503,json:{error:'Saving is unavailable.'}});
   const body=request.postDataJSON();if(body.revision!==String(revision))return route.fulfill({status:409,json:{error:'The board changed.'}});
   board=structuredClone(body.board);revision++;return route.fulfill({json:{board,revision:String(revision),role:'owner'}});
  }
  return route.fulfill({status:405,json:{error:'Unsupported request.'}});
 });
 await page.goto('/__shared-sync?board='+boardId);
 await expect.poll(()=>page.evaluate(()=>Boolean((window as any).sync?.board))).toBe(true);
 return {current:()=>structuredClone(board),reads:()=>reads,writes:()=>writes,failWrites(value:boolean){failWrites=value;},beforeRead(fn:()=>Promise<void>){beforeRead=fn;},beforeWrite(fn:()=>Promise<void>){beforeWrite=fn;},remote(change:(value:Board)=>Board){board=change(structuredClone(board));revision++;}};
}
const state=(page:Page)=>page.locator('#state').textContent().then(value=>JSON.parse(value!));
const resume=(page:Page)=>page.evaluate(()=>dispatchEvent(new Event('online')));
const changeText=(page:Page,text:string)=>page.evaluate(text=>{const sync=(window as any).sync;const previous=structuredClone(sync.board.pages[0]);sync.updateDrawing('page',{...previous,objects:previous.objects.map((object:any)=>({...object,text}))},previous);},text);

test('native history navigation keeps an unsaved board when saving fails and retries after reconnect',async({page})=>{
 const api=await fixture(page);api.failWrites(true);
 await changeText(page,'My offline draft');
 await page.evaluate(()=>{history.pushState(null,'','/__shared-sync');dispatchEvent(new PopStateEvent('popstate'));});
 await expect.poll(()=>new URL(page.url()).searchParams.get('board')).toBe(boardId);
 await expect.poll(async()=>(await state(page)).error).toBe('Saving is unavailable.');
 expect((await state(page)).board.pages[0].objects[0].text).toBe('My offline draft');
 expect(api.current().pages[0].objects[0].text).toBe('Original wording');
 api.failWrites(false);await resume(page);
 await expect.poll(()=>api.current().pages[0].objects[0].text).toBe('My offline draft');
 await page.evaluate(()=>{history.pushState(null,'','/__shared-sync');dispatchEvent(new PopStateEvent('popstate'));});
 await expect.poll(async()=>(await state(page)).boardId).toBeNull();
});

test('an unrendered remote note survives a subsequent canvas change from an older scene',async({page})=>{
 const api=await fixture(page);const previous=api.current().pages[0];
 api.remote(board=>({...board,pages:board.pages.map(value=>({...value,objects:[...value.objects,{id:'peer-note',type:'MuzeNote',text:'Peer contribution',left:400,top:30}]}))}));
 await resume(page);await expect.poll(async()=>(await state(page)).board.pages[0].objects.length).toBe(2);
 await page.evaluate(previous=>{(window as any).sync.updateDrawing('page',{...previous,objects:previous.objects.map(object=>({...object,left:140}))},previous);},previous);
 await expect.poll(()=>api.current().pages[0].objects[0].left).toBe(140);
 expect(api.current().pages[0].objects.map(value=>value.id)).toEqual(['one','peer-note']);
});

test('same-text conflicts from an older canvas keep the local draft and block later save acknowledgements',async({page})=>{
 const api=await fixture(page);const previous=api.current().pages[0];
 api.remote(board=>({...board,pages:board.pages.map(value=>({...value,objects:value.objects.map(object=>({...object,text:'Peer wording'}))}))}));
 await resume(page);await expect.poll(async()=>(await state(page)).board.pages[0].objects[0].text).toBe('Peer wording');
 const gate=deferred();api.beforeWrite(()=>gate.promise);
 await page.evaluate(previous=>{(window as any).sync.updateDrawing('page',{...previous,objects:previous.objects.map(object=>({...object,left:140}))},previous);},previous);
 await expect.poll(api.writes).toBe(1);
 await page.evaluate(previous=>{(window as any).sync.updateDrawing('page',{...previous,objects:previous.objects.map(object=>({...object,left:140,text:'My draft wording'}))},previous);},previous);
 await expect.poll(async()=>(await state(page)).conflict).toBe(true);
 gate.resolve();await expect.poll(async()=>(await state(page)).busy).toBe(false);
 expect(api.current().pages[0].objects[0].text).toBe('Peer wording');
 expect((await state(page)).board.pages[0].objects[0].text).toBe('My draft wording');
 await resume(page);expect(api.writes()).toBe(1);
});

test('slow polling never overlaps and reconnect fetches the latest board promptly',async({page})=>{
 const api=await fixture(page);const gate=deferred();api.beforeRead(()=>gate.promise);
 await resume(page);await expect.poll(api.reads).toBe(2);
 await page.waitForTimeout(2300);expect(api.reads()).toBe(2);
 gate.resolve();api.beforeRead(async()=>{});
 api.remote(board=>({...board,name:'Latest shared name'}));
 await resume(page);
 await expect.poll(async()=>(await state(page)).board.name).toBe('Latest shared name');
});
