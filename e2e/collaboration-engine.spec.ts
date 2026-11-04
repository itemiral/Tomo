import {expect,test,type Page} from '@playwright/test';
import {build} from 'esbuild';
import {resolve} from 'node:path';
let compiled:Promise<string>;
async function fixture(page:Page) {
 compiled ||= build({stdin:{resolveDir:resolve('.'),loader:'ts',contents:`import{WhiteboardEngine}from'./src/components/muze/engine';import{ActiveSelection}from'fabric';window.ActiveSelection=ActiveSelection;window.changes=[];window.errors=[];window.engine=new WhiteboardEngine(document.querySelector('canvas'),(drawing,previous)=>window.changes.push({drawing,previous}),value=>window.state=value,message=>window.errors.push(message));window.loaded=window.engine.load({objects:[{type:'MuzeNote',id:'one',text:'Original',left:100,top:100,width:300,boxHeight:180,fontSize:18},{type:'MuzeNote',id:'two',text:'Second',left:500,top:100,width:300,boxHeight:180,fontSize:18}],viewport:[1,0,0,1,0,0]});`},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).then(result=>result.outputFiles[0].text);
 const js=await compiled;
 await page.route('**/__collaboration-engine',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div style="position:relative;width:100vw;height:90vh"><div><canvas></canvas></div></div><aside data-muse-ui="true"><input aria-label="Chat draft"></aside><script src="/__collaboration-engine.js"></script>'}));
 await page.route('**/__collaboration-engine.js',route=>route.fulfill({contentType:'application/javascript',body:js}));
 await page.goto('/__collaboration-engine');await page.evaluate(()=> (window as any).loaded);
}
const objects=(page:Page)=>page.evaluate(()=> (window as any).engine.serialize().objects);

test('peer updates preserve multi-selection and local undo without undoing peer notes',async({page})=>{
 await fixture(page);
 await page.evaluate(async()=>{const w=window as any,e=w.engine;e.canvas.getObjects()[0].set('text','My edit');e.checkpoint();const selected=e.canvas.getObjects();e.canvas.setActiveObject(new w.ActiveSelection(selected,{canvas:e.canvas}));const remote=e.serialize();remote.objects.push({type:'MuzeNote',id:'peer',text:'Peer note',left:900,top:100,width:280,boxHeight:180,fontSize:18});await e.applySharedDrawing(remote,true);});
 expect(await page.evaluate(()=> (window as any).state.selectedIds)).toEqual(['one','two']);
 expect(await page.evaluate(()=> (window as any).state.canUndo)).toBe(true);
 await page.evaluate(()=> (window as any).engine.undo());
 expect((await objects(page)).find((o:any)=>o.id==='one')?.text).toBe('Original');
 expect((await objects(page)).find((o:any)=>o.id==='peer')?.text).toBe('Peer note');
 await page.evaluate(()=> (window as any).engine.undo(true));
 expect((await objects(page)).find((o:any)=>o.id==='one')?.text).toBe('My edit');
 expect((await objects(page)).find((o:any)=>o.id==='peer')?.text).toBe('Peer note');
});

test('a newer peer edit cannot be overwritten by an older local undo',async({page})=>{
 await fixture(page);
 await page.evaluate(async()=>{const e=(window as any).engine;e.canvas.getObjects()[0].set('text','My edit');e.checkpoint();const remote=e.serialize();remote.objects[0].text='Newer peer edit';await e.applySharedDrawing(remote,true);await e.undo();});
 expect((await objects(page))[0].text).toBe('Newer peer edit');
});

test('queued peer drawing applies after a gesture and retains a local change made meanwhile',async({page})=>{
 await fixture(page);
 await page.evaluate(async()=>{const w=window as any,e=w.engine;w.before=e.serialize();const remote=e.serialize();remote.objects[1].text='Peer change';e.pointerBusy=true;await e.applySharedDrawing(remote,true);e.canvas.getObjects()[0].set('text','Local change');e.checkpoint();});
 expect((await objects(page))[1].text).toBe('Second');
 await page.evaluate(()=>{(window as any).engine.pointerBusy=false;});
 await expect.poll(async()=> (await objects(page))[1].text).toBe('Peer change');
 expect((await objects(page))[0].text).toBe('Local change');
 expect(await page.evaluate(()=> (window as any).changes.at(-1).previous.objects[0].text)).toBe('Original');
});

test('focused Muse chat does not pause remote drawing updates or clear the chat draft',async({page})=>{
 await fixture(page);await page.getByRole('textbox',{name:'Chat draft'}).fill('My unfinished question');
 await page.evaluate(async()=>{const e=(window as any).engine;const remote=e.serialize();remote.objects[1].text='Arrived while chatting';await e.applySharedDrawing(remote,true);});
 expect((await objects(page))[1].text).toBe('Arrived while chatting');
 await expect(page.getByRole('textbox',{name:'Chat draft'})).toHaveValue('My unfinished question');
 await expect(page.getByRole('textbox',{name:'Chat draft'})).toBeFocused();
});

test('remote updates preserve redo and queued work is discarded when the canvas closes',async({page})=>{
 await fixture(page);
 await page.evaluate(async()=>{const e=(window as any).engine;e.canvas.getObjects()[0].set('text','My edit');e.checkpoint();await e.undo();const remote=e.serialize();remote.objects[1].text='Peer change';await e.applySharedDrawing(remote,true);await e.undo(true);});
 expect((await objects(page)).map((o:any)=>o.text)).toEqual(['My edit','Peer change']);
 await page.evaluate(async()=>{const e=(window as any).engine;e.pointerBusy=true;const remote=e.serialize();remote.objects[0].text='Do not apply';await e.applySharedDrawing(remote,true);e.dispose();});
 await page.waitForTimeout(250);
 expect(await page.evaluate(()=> (window as any).errors)).toEqual([]);
});


test('a failed remote render preserves the usable local canvas and undo history',async({page})=>{
 await fixture(page);
 await page.evaluate(async()=>{const w=window as any,e=w.engine;e.canvas.getObjects()[0].set('text','My edit');e.checkpoint();const remote=e.serialize();remote.objects[1].text='Peer update';const load=e.canvas.loadFromJSON.bind(e.canvas);let reject=true;e.canvas.loadFromJSON=(...args:any[])=>{if(reject){reject=false;return Promise.reject(new Error('Image decode failed'));}return load(...args);};try{await e.applySharedDrawing(remote,true);}catch(error){w.failure=(error as Error).message;}});
 expect(await page.evaluate(()=>(window as any).failure)).toContain('current canvas is preserved');
 expect(await page.evaluate(()=>(window as any).state.ready)).toBe(true);
 expect((await objects(page)).map((o:any)=>o.text)).toEqual(['My edit','Second']);
 await page.evaluate(()=>(window as any).engine.undo());
 expect((await objects(page))[0].text).toBe('Original');
});


test('a slow peer scene load blocks stale-object drags and restores canvas interaction',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>{const w=window as any,e=w.engine,remote=e.serialize();remote.objects[1].text='Peer update';const load=e.canvas.loadFromJSON.bind(e.canvas);const gate=new Promise<void>(resolve=>{w.releaseLoad=resolve;});e.canvas.loadFromJSON=(...args:any[])=>gate.then(()=>load(...args));w.pendingLoad=e.applySharedDrawing(remote,true);});
 const drag=async()=>{await page.mouse.move(170,150);await page.mouse.down();await page.mouse.move(270,200,{steps:6});await page.mouse.up();};
 await drag();
 expect((await objects(page))[0].left).toBe(100);
 expect(await page.evaluate(()=>(window as any).changes.length)).toBe(0);
 await page.evaluate(()=>(window as any).releaseLoad());await page.evaluate(()=>(window as any).pendingLoad);
 expect((await objects(page))[1].text).toBe('Peer update');
 await drag();
 expect((await objects(page))[0].left).toBe(200);
 expect(await page.evaluate(()=>(window as any).changes.length)).toBeGreaterThan(0);
 await page.evaluate(()=>(window as any).engine.undo());
 expect((await objects(page))[0].left).toBe(100);
 expect((await objects(page))[1].text).toBe('Peer update');
});


test('active Muse context blocks delete, eraser and undo removal until its lease ends',async({page})=>{
 await fixture(page);
 await page.evaluate(()=>{const e=(window as any).engine;e.setProtectedObjects([{objectId:'one',expiresAt:new Date(Date.now()+60000).toISOString()}]);e.canvas.setActiveObject(e.canvas.getObjects()[0]);e.remove();});
 expect((await objects(page)).map((o:any)=>o.id)).toEqual(['one','two']);
 await page.evaluate(()=> (window as any).engine.setTool('eraser'));
 await page.mouse.click(160,150);
 expect((await objects(page)).map((o:any)=>o.id)).toEqual(['one','two']);
 await page.evaluate(()=>{const e=(window as any).engine;e.setTool('select');e.addText('New note');const created=e.canvas.getObjects().at(-1);e.setProtectedObjects([{objectId:created.id,expiresAt:new Date(Date.now()+60000).toISOString()}]);e.undo();});
 expect((await objects(page))).toHaveLength(3);
 await page.evaluate(async()=>{const e=(window as any).engine;e.setProtectedObjects([]);await e.undo();});
 expect((await objects(page))).toHaveLength(2);
 await page.evaluate(()=>{const e=(window as any).engine;e.canvas.setActiveObject(e.canvas.getObjects()[0]);e.remove();});
 expect((await objects(page)).map((o:any)=>o.id)).toEqual(['two']);
 expect(await page.evaluate(()=> (window as any).errors)).toEqual(['Muse is using this note. You can delete it when the reply is finished.']);
});
