'use client';
import {useEffect,useRef,useState} from 'react';
import {validMuseName} from '@/lib/muse-name';
export function NameOnCanvas({name,left,top,zoom,save,cancel}:{name:string;left:number;top:number;zoom:number;save:(name:string)=>void;cancel:()=>void}){
 const [value,setValue]=useState(name),[error,setError]=useState(''),[confirm,setConfirm]=useState(false);
 const form=useRef<HTMLFormElement>(null),dialog=useRef<HTMLDivElement>(null),rename=useRef<HTMLButtonElement>(null);
 const [viewportWidth,setViewportWidth]=useState(()=>innerWidth);
 useEffect(()=>{const resize=()=>setViewportWidth(innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 const changed=value.trim().normalize('NFC')!==name;
 const inputWidth=Math.max(130,Math.min(700,[...value].length*26)),width=430+inputWidth,scale=Math.min(zoom,(viewportWidth-32)/width),screenLeft=Math.max(16,Math.min(left,viewportWidth-width*scale-16));
 const ask=()=>{if(changed)setConfirm(true);else cancel();};
 useEffect(()=>{if(confirm)rename.current?.focus();},[confirm]);
 useEffect(()=>{
  const outside=(event:PointerEvent)=>{if(form.current?.contains(event.target as Node)||dialog.current?.contains(event.target as Node))return;if(changed){event.preventDefault();event.stopPropagation();setConfirm(true);}};
  document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);
 },[changed]);
 return <><form ref={form} className="muse-name-editor" data-muse-ui="true" style={{left:screenLeft,top:Math.max(68,top),transform:`scale(${scale})`,transformOrigin:'top left'}} onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();cancel();}}} onSubmit={e=>{e.preventDefault();ask();}}><label><span>Hello, my name is </span><input aria-label="Muse name" autoFocus value={value} maxLength={80} style={{width:inputWidth}} onChange={e=>{setValue(e.target.value);setError('');}} onBlur={()=>{if(!confirm&&changed)setConfirm(true);}}/><span>.</span></label></form>
 {confirm&&<div className="muze-dialog-backdrop" data-muse-ui="true"><div ref={dialog} className="muse-rename-confirm" role="dialog" aria-modal="true" aria-label="Confirm Muse name" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();cancel();}if(e.key==='Tab'){const buttons=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);e.preventDefault();buttons[(index+(e.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();}}}><p>Rename {name} to {value.trim()||'…'}?</p>{error&&<p role="alert">{error}</p>}<div><button onClick={cancel}>Revert</button><button ref={rename} onClick={()=>{try{save(validMuseName(value));}catch(e){setError((e as Error).message);}}}>Rename</button></div>{error&&<button onClick={()=>{setConfirm(false);setTimeout(()=>form.current?.querySelector('input')?.focus(),0);}}>Edit name</button>}</div></div>}</>;
}
