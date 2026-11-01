'use client';
import {useEffect,useRef} from 'react';
let pointerTracking=false;
let lastPointer:{clientX:number;clientY:number}|null=null;
// Hybrid: genuine generated poses plus rigid, time-smoothed motion. No mesh distortion or dynamic relighting.
export function MusePortrait({src,sheet=false,poses=9,follow=false,onError}:{src:string;sheet?:boolean;poses?:9|15;follow?:boolean;onError:()=>void}) {
 const canvas=useRef<HTMLCanvasElement>(null),failure=useRef(onError);failure.current=onError;
 useEffect(()=>{
  if(!pointerTracking){pointerTracking=true;window.addEventListener('pointermove',event=>{lastPointer={clientX:event.clientX,clientY:event.clientY};},{passive:true});window.addEventListener('blur',()=>{lastPointer=null;});document.documentElement.addEventListener('pointerleave',()=>{lastPointer=null;});}
  const element=canvas.current,ctx=element?.getContext('2d');if(!element||!ctx)return;
  let closed=false,ready=false,frame=0,last=0,x=0,y=0,tx=0,ty=0,col=1,row=1,cell=poses===15?12:4,lastPose=0;
  const frames:HTMLCanvasElement[]=[];
  const media=matchMedia('(prefers-reduced-motion: reduce)'),image=new Image();
  const sector=(value:number,current:number)=>value<-.38?0:value>.38?2:Math.abs(value)<.22?1:current;
  const draw=(now=0)=>{
   if(sheet&&poses===15&&now-lastPose>85){
    const radius=Math.hypot(x,y),angle=(Math.atan2(y*Math.max(180,innerHeight*.3),x*Math.max(180,innerWidth*.3))*180/Math.PI+360)%360;
    let next=radius<.2?12:radius<.55&&Math.abs(y)>Math.abs(x)*1.6?(y<0?13:14):Math.round(angle/30)%12;
    if(cell<12&&next<12){const distance=Math.abs(((angle-cell*30+540)%360)-180);if(distance<20)next=cell;}
    if(next!==cell){cell=next;lastPose=now;}
   }
   if(sheet&&poses===9&&now-lastPose>100){const nextCol=sector(x,col),nextRow=sector(y,row);if(nextCol!==col||nextRow!==row){col=nextCol;row=nextRow;lastPose=now;}}
   ctx.clearRect(0,0,256,256);ctx.save();ctx.translate(128+x*1.5,128+y*.8);ctx.rotate(x*.018);ctx.scale(1.045,1.045);
   const index=sheet?(poses===15?cell:row*3+col):0;const texture=frames[index];if(texture)ctx.drawImage(texture,-128,-128,256,256);
   ctx.restore();element.style.setProperty('--motion-x',x.toFixed(4));element.style.setProperty('--motion-y',y.toFixed(4));element.dataset.poseCell=String(poses===15?cell:row*3+col);
  };
  const tick=(now:number)=>{frame=0;if(closed||!ready)return;if(follow&&lastPointer&&!media.matches&&!document.hidden){const box=element.getBoundingClientRect();tx=Math.max(-1,Math.min(1,(lastPointer.clientX-box.x-box.width/2)/Math.max(180,innerWidth*.3)));ty=Math.max(-1,Math.min(1,(lastPointer.clientY-box.y-box.height/2)/Math.max(180,innerHeight*.3)));}const dt=Math.min(64,last?now-last:16);last=now;const alpha=1-Math.exp(-dt/180);x+=(tx-x)*alpha;y+=(ty-y)*alpha;draw(now);if(Math.abs(tx-x)+Math.abs(ty-y)>.001||(follow&&lastPointer&&!media.matches&&!document.hidden))frame=requestAnimationFrame(tick);else last=0;};
  const animate=()=>{if(!frame&&ready)frame=requestAnimationFrame(tick);};
  const neutral=()=>{lastPointer=null;tx=ty=0;animate();};
  const move=(event:Pick<PointerEvent,'clientX'|'clientY'>)=>{lastPointer={clientX:event.clientX,clientY:event.clientY};if(!follow||media.matches||document.hidden)return;const box=element.getBoundingClientRect();tx=Math.max(-1,Math.min(1,(event.clientX-box.x-box.width/2)/Math.max(180,innerWidth*.3)));ty=Math.max(-1,Math.min(1,(event.clientY-box.y-box.height/2)/Math.max(180,innerHeight*.3)));animate();};
  const preference=()=>{if(media.matches){tx=ty=x=y=0;col=row=1;cell=poses===15?12:4;cancelAnimationFrame(frame);frame=0;if(ready)draw();}};
  image.onload=()=>{if(closed)return;
   const columns=sheet?(poses===15?5:3):1,rows=sheet?3:1;
   for(let i=0;i<columns*rows;i++){
    // Separate textures prevent interpolation from sampling an adjacent pose.
    const texture=document.createElement('canvas');texture.width=texture.height=256;const target=texture.getContext('2d')!;
    const w=image.naturalWidth/columns,h=image.naturalHeight/rows;let sx=(i%columns)*w,sy=Math.floor(i/columns)*h,sw=w,sh=h;
    if(!sheet){
     const sample=document.createElement('canvas');sample.width=sample.height=256;const sampleContext=sample.getContext('2d')!;sampleContext.drawImage(image,0,0,256,256);
     try{const pixels=sampleContext.getImageData(0,0,256,256).data;let left=256,top=256,right=0,bottom=0,count=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++)if(pixels[(y*256+x)*4+3]>240){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}
      // Remove transparent containment bars around a rectangular photo; preserve irregular cutout silhouettes.
      if(right>left&&bottom>top&&count/((right-left+1)*(bottom-top+1))>.96){sx=left/256*w;sy=top/256*h;sw=(right-left+1)/256*w;sh=(bottom-top+1)/256*h;}
     }catch{/* A non-readable image still gets normal centered cover rendering. */}
    }
    const size=Math.min(sw,sh);sx+=(sw-size)/2;sy+=(sh-size)/2;
    target.drawImage(image,sx,sy,size,size,0,0,256,256);frames.push(texture);
   }
   ready=true;draw();if(lastPointer)move(lastPointer);else if(tx||ty)animate();};image.onerror=()=>{if(!closed)failure.current();};image.src=src;
  window.addEventListener('pointermove',move,{passive:true});document.documentElement.addEventListener('pointerleave',neutral);window.addEventListener('blur',neutral);document.addEventListener('visibilitychange',neutral);media.addEventListener('change',preference);
  return()=>{closed=true;cancelAnimationFrame(frame);window.removeEventListener('pointermove',move);document.documentElement.removeEventListener('pointerleave',neutral);window.removeEventListener('blur',neutral);document.removeEventListener('visibilitychange',neutral);media.removeEventListener('change',preference);};
 },[src,sheet,poses,follow]);
 return <canvas ref={canvas} className="muse-portrait" width={256} height={256} data-portrait-source={src} aria-hidden="true"/>;
}
