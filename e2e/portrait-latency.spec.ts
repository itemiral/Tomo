import {test,expect,type Page} from '@playwright/test';
import {build} from 'esbuild';
import {resolve} from 'node:path';

async function fixture(page:Page,poses:9|15){
 const result=await build({stdin:{resolveDir:resolve('.'),loader:'tsx',contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {MusePortrait} from './src/components/muse/portrait';import {MuseOrb} from './src/components/muse/orb';
  const sheet=document.createElement('canvas'),columns=${poses===15?5:3};sheet.width=columns*32;sheet.height=96;const ctx=sheet.getContext('2d');
  for(let index=0;index<${poses};index++){ctx.fillStyle='rgb('+(20+index*10)+',100,160)';ctx.fillRect(index%columns*32,Math.floor(index/columns)*32,32,32);}
  const src=sheet.toDataURL(),root=createRoot(document.getElementById('root'));
  window.showPortrait=(follow=true)=>root.render(<><div id="portrait"><MusePortrait src={src} sheet poses={${poses}} follow={follow} onLoad={()=>window.loaded=(window.loaded||0)+1} onError={()=>{throw new Error('Fixture image failed')}}/></div><div id="orb"><MuseOrb followCursor={follow}/></div></>);
  window.showPortrait();
 `},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 await page.route('**/__portrait-latency',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><style>body{margin:0}#portrait{position:absolute;left:640px;top:370px;width:160px;height:160px}#portrait canvas{width:100%;height:100%}#orb{position:absolute;left:260px;top:410px;width:80px;height:80px}.muse-orb{display:block;width:100%;height:100%}</style><div id="root"></div><script src="/__portrait-latency.js"></script></html>'}));
 await page.route('**/__portrait-latency.js',route=>route.fulfill({contentType:'application/javascript',body:result.outputFiles[0].text}));
 await page.goto('/__portrait-latency');await expect(page.locator('.muse-portrait')).toHaveAttribute('data-portrait-ready','true');
}

for(const poses of [9,15] as const)test(`${poses}-pose gaze changes direction within two frames and settles without idle repainting`,async({page})=>{
 await fixture(page,poses);
 for(const direction of [1,-1]){
  const targetCell=poses===15?(direction>0?0:6):(direction>0?5:3);
  const result=await page.evaluate(async({direction,targetCell})=>{
   const canvas=document.querySelector<HTMLCanvasElement>('.muse-portrait')!,start=performance.now();let frames=0,firstFrame=0,firstMs=0,settledMs=0;
   window.dispatchEvent(new PointerEvent('pointermove',{clientX:720+direction*500,clientY:450,pointerType:'mouse'}));
   await new Promise<void>(resolve=>{const sample=(now:number)=>{frames++;if(!firstFrame&&canvas.dataset.poseCell===String(targetCell)){firstFrame=frames;firstMs=now-start;}if(!settledMs&&Math.abs(Number(canvas.style.getPropertyValue('--motion-x'))-direction)<.005)settledMs=now-start;if(now-start<200)requestAnimationFrame(sample);else resolve();};requestAnimationFrame(sample);});
   return {firstFrame,firstMs,settledMs,motion:Number(canvas.style.getPropertyValue('--motion-x'))};
  },{direction,targetCell});
  expect(result.firstFrame).toBeGreaterThan(0);expect(result.firstFrame).toBeLessThanOrEqual(2);expect(result.settledMs).toBeGreaterThan(0);expect(result.settledMs).toBeLessThan(140);expect(result.motion).toBe(direction);
  test.info().annotations.push({type:'gaze latency',description:JSON.stringify({poses,direction,...result})});
 }
 const idlePaints=await page.evaluate(async()=>{
  const canvas=document.querySelector('.muse-portrait'),orb=document.querySelector<HTMLElement>('.muse-orb')!,draw=CanvasRenderingContext2D.prototype.drawImage,set=CSSStyleDeclaration.prototype.setProperty;let count=0,orbWrites=0;
  CanvasRenderingContext2D.prototype.drawImage=function(...args:any[]){if(this.canvas===canvas)count++;return (draw as any).apply(this,args);};
  CSSStyleDeclaration.prototype.setProperty=function(...args:Parameters<typeof set>){if(this===orb.style)orbWrites++;return set.apply(this,args);};
  try{await new Promise<void>(resolve=>{let frames=0;const tick=()=>{if(++frames===8)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);});return {canvas:count,orb:orbWrites};}finally{CanvasRenderingContext2D.prototype.drawImage=draw;CSSStyleDeclaration.prototype.setProperty=set;}
 });
 expect(idlePaints).toEqual({canvas:0,orb:0});
 await page.evaluate(()=>{const holder=document.getElementById('portrait')!;holder.style.left='100px';holder.dispatchEvent(new TransitionEvent('transitionend',{bubbles:true,propertyName:'left'}));});
 await expect(page.locator('.muse-portrait')).toHaveAttribute('data-pose-cell',poses===15?'12':'4');
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect(page.locator('.muse-portrait')).toHaveAttribute('data-pose-cell',poses===15?'12':'4');
 await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointermove',{clientX:1220,clientY:450,pointerType:'mouse'})));
 await expect.poll(()=>page.locator('.muse-orb').evaluate(element=>Number.parseFloat((element as HTMLElement).style.getPropertyValue('--muse-gaze-x')))).toBe(8);
 await page.emulateMedia({reducedMotion:'reduce'});await expect.poll(()=>page.locator('.muse-portrait').evaluate(element=>Number((element as HTMLElement).style.getPropertyValue('--motion-x')))).toBe(0);
 await expect.poll(()=>page.locator('.muse-orb').evaluate(element=>Number.parseFloat((element as HTMLElement).style.getPropertyValue('--muse-gaze-x')))).toBe(0);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>(window as any).showPortrait(false));await expect(page.locator('.muse-portrait')).toHaveAttribute('data-portrait-ready','true');
 await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointermove',{clientX:1220,clientY:450,pointerType:'mouse'})));
 await expect(page.locator('.muse-portrait')).toHaveAttribute('data-pose-cell',poses===15?'12':'4');
 expect(await page.locator('.muse-orb').evaluate(element=>Number.parseFloat((element as HTMLElement).style.getPropertyValue('--muse-gaze-x')))).toBe(0);
});
