import {expect,test,type Page} from '@playwright/test';
import {museFixture,send} from './muse-fixture';

async function streamFixture(page:Page) {
 await museFixture(page);
 await page.evaluate(()=>{
  const original=window.fetch,w=window as any;w.activityStreams=[];
  window.fetch=async(input,init)=>{
   if(String(input)!=='/api/muse/chat'||init?.method!=='POST')return original(input,init);
   return new Response(new ReadableStream({start(controller){
    w.activityStreams.push({request:JSON.parse(String(init.body)),emit:(event:unknown)=>controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n')),finish:()=>controller.close()});
    init.signal?.addEventListener('abort',()=>controller.error(init.signal!.reason),{once:true});
   }}),{headers:{'Content-Type':'application/x-ndjson'}});
  };
 });
}
const emit=(page:Page,turn:number,event:unknown)=>page.evaluate(({turn,event})=>(window as any).activityStreams[turn].emit(event),{turn,event});
async function status(page:Page,label:string) {
 const badge=page.locator('.muse-floating .muse-floating-activity');
 await expect(badge).toHaveText(label);await expect(badge).toBeVisible();
 const box=(await badge.boundingBox())!;expect(box.width).toBeGreaterThan(40);expect(box.height).toBeGreaterThan(12);
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}
async function start(page:Page,turn:number) {
 await send(page,turn?'Refine this plan':'Make a small plan');
 await expect.poll(()=>page.evaluate(()=>(window as any).activityStreams.length)).toBe(turn+1);
 await emit(page,turn,{type:'progress',phase:'thinking'});await status(page,'Working on it…');
}
async function finish(page:Page,turn:number,cards:unknown[]=[]) {
 await emit(page,turn,{type:'result',result:{messages:[{id:'answer-'+turn,role:'assistant',content:'Prepared your plan.'}],actions:{cards,updates:[]}}});
 await page.evaluate(turn=>(window as any).activityStreams[turn].finish(),turn);
 await expect(page.getByRole('button',{name:'Stop response',exact:true})).toHaveCount(0);
 await expect(page.locator('.muse-floating [role="status"]')).toHaveCount(0);
}

for(const width of [1440,390])test(`Muse keeps a visible status on consecutive requests and clears it after stopping at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});await streamFixture(page);
 await start(page,0);
 if(width<700)for(const x of [20,width-20]){
  const muse=(await page.locator('.muse-floating').boundingBox())!;
  await page.mouse.move(muse.x+muse.width/2,muse.y+muse.height/2);await page.mouse.down();await page.mouse.move(x,140,{steps:5});await page.mouse.up();
  await status(page,'Working on it…');
 }
 await finish(page,0,[{id:'activity-note',title:'A small plan',body:'Choose an outcome and a first step.'}]);
 const note=page.locator('.muze-vector-surface [id="activity-note"]');await expect(note).toBeVisible();
 await page.getByRole('button',{name:'Select',exact:true}).click();await page.keyboard.press('ControlOrMeta+a');
 await start(page,1);await expect(page.locator('.muse-working-target[data-target-id="activity-note"]')).toHaveCount(1);
 for(const [phase,label] of [['research','Checking sources…'],['vision','Looking at the visuals…'],['saving','Finishing up…']]){
  await emit(page,1,{type:'progress',phase});await status(page,label);
 }
 await page.screenshot({path:'verification/muse-working-status-'+width+'.png'});
 await finish(page,1);
 await start(page,2);await page.getByRole('button',{name:'Stop response',exact:true}).click();
 await expect(page.locator('.muse-floating [role="status"]')).toHaveCount(0);
 await start(page,3);await finish(page,3);
});
