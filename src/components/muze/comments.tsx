'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Pencil, Trash2, X } from 'lucide-react';
import type { BoardComment } from './storage';
type Placement={x:number;y:number;nonce:number};
type Props={comments:BoardComment[];pageId:string;firstPageId:string;viewport:number[];placement:Placement|null;save:(comments:BoardComment[])=>Promise<void>|void};
export function CanvasComments({comments,pageId,firstPageId,viewport,placement,save}:Props) {
 const [opened,setOpened]=useState<BoardComment|null>(null),[editing,setEditing]=useState(false),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const popup=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),handled=useRef(placement?.nonce);
 const located=comments.map((comment,index)=>({...comment,pageId:comment.pageId||firstPageId,x:comment.x??(comment.id==='muse-welcome'?1230:400+index*48),y:comment.y??(comment.id==='muse-welcome'?150:240)}));
 const visible=located.filter(comment=>comment.pageId===pageId);
 const close=()=>{setOpened(null);setEditing(false);setError('');};
 useEffect(()=>{if(placement&&placement.nonce!==handled.current){handled.current=placement.nonce;setOpened({id:'',author:'You',text:'',pageId,x:placement.x,y:placement.y});setText('');setError('');setEditing(true);}},[placement,pageId]);
 useEffect(()=>{if(editing)input.current?.focus();},[editing,opened?.id,placement?.nonce]);
 useEffect(()=>{
  if(!opened)return;
  const outside=(event:PointerEvent)=>{if(!popup.current?.contains(event.target as Node)&&!(event.target as Element).closest('.canvas-comment-pin'))close();};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
 },[opened]);
 async function submit(remove=false) {
  if(!opened||busy||(!remove&&!text.trim()))return;
  if(!opened.id&&comments.length>=100){setError('This board has 100 comments. Remove one before adding another.');return;}
  setBusy(true);setError('');
  const next={...opened,id:opened.id||crypto.randomUUID(),text:text.trim()};
  try {await save(remove?comments.filter(c=>c.id!==opened.id):opened.id?comments.map(c=>c.id===opened.id?next:c):[...comments,next]);if(remove)close();else{setOpened(next);setEditing(false);}}
  catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
 }
 const screen=(comment:BoardComment)=>({x:(comment.x||0)*viewport[0]+viewport[4],y:(comment.y||0)*viewport[0]+viewport[5]});
 const point=opened?screen(opened):{x:0,y:0};
 return <div className="canvas-comments" data-muse-ui="true">
  {visible.map(comment=>{const point=screen(comment);return <button key={comment.id} className="canvas-comment-pin" aria-label={'Comment: '+comment.text.slice(0,80)} aria-expanded={opened?.id===comment.id} data-comment-id={comment.id} data-world-x={comment.x} data-world-y={comment.y} style={{left:point.x,top:point.y}} onClick={()=>{setOpened(comment);setText(comment.text);setEditing(false);setError('');}}><MessageCircle size={17}/></button>;})}
  {opened&&<><span className="canvas-comment-anchor" style={{left:point.x,top:point.y}}/><div ref={popup} role="dialog" aria-label="Canvas comment" className="canvas-comment-popup" style={{left:Math.max(12,Math.min(innerWidth-292,point.x+22)),top:Math.max(76,Math.min(innerHeight-330,point.y-16))}} onKeyDown={event=>event.stopPropagation()}>
   <header><strong>{opened.author}</strong><button aria-label="Close comment" onClick={close}><X size={16}/></button></header>
   {editing?<form onSubmit={event=>{event.preventDefault();void submit();}}><textarea ref={input} aria-label="Write a comment" maxLength={4000} value={text} onChange={event=>setText(event.target.value)} placeholder="Leave a thought here…"/><footer><button type="button" onClick={()=>{if(!opened.id)close();else{setText(opened.text);setEditing(false);}}}>Cancel</button><button disabled={busy||!text.trim()}>{opened.id?'Save comment':'Post comment'}</button></footer></form>:<><p>{opened.text}</p><footer><button aria-label="Delete comment" disabled={busy} onClick={()=>void submit(true)}><Trash2 size={15}/></button><button aria-label="Edit comment" onClick={()=>setEditing(true)}><Pencil size={15}/>Edit</button></footer></>}
   {error&&<p role="alert">{error}</p>}
  </div></>}
 </div>;
}
