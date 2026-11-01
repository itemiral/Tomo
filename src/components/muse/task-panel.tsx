'use client';
import {useEffect,useRef,useState} from 'react';
import {museRequest,MuseMarkdown} from './shared';
import type {MuseActions,MuseApplyResult} from '@/lib/muse-board';
type Task={id:string;goal:string;status:string;cursor:number;attempts:number;error?:string;steps:{name:string;status:string}[];notes:{step:string;text:string}[];sources:{url:string;title:string;excerpt:string}[];actions?:MuseActions};
export function MuseTaskPanel({thread,board,goal,beforeSend,applyActions,attachImage}:{thread:string;board:string;goal:string;beforeSend?:()=>Promise<void>;applyActions:(actions:MuseActions)=>MuseApplyResult;attachImage:(file:File,signal:AbortSignal)=>Promise<void>}){
 const [task,setTask]=useState<Task|null>(null),[enabled,setEnabled]=useState(false),[research,setResearch]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[imageBusy,setImageBusy]=useState(false);const abort=useRef<AbortController|null>(null),alive=useRef(true),imageAbort=useRef<AbortController|null>(null),imageInput=useRef<HTMLInputElement>(null);
 useEffect(()=>()=>imageAbort.current?.abort(),[thread]);
 useEffect(()=>{alive.current=true;const controller=new AbortController();void museRequest<{task:Task|null;enabled:boolean}>('tasks?thread='+encodeURIComponent(thread),{signal:controller.signal}).then(r=>{setTask(r.task);setEnabled(r.enabled);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{alive.current=false;controller.abort();abort.current?.abort();};},[thread]);
 async function action(action:string){
  if(busy&&action!=='cancel')return;
  if(action==='cancel')abort.current?.abort();
  const controller=new AbortController();abort.current=controller;setBusy(true);setError('');
  const post=async(kind:string,current:Task|null)=>museRequest<{task:Task}>('tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:kind,thread,goal,research,id:current?.id,cursor:current?.cursor,board}),signal:controller.signal});
  try{
   await beforeSend?.();let result=await post(action,task);if(!alive.current||controller.signal.aborted)return;setTask(result.task);
   // Each successful checkpoint advances automatically; failures require an explicit retry.
   if(action!=='cancel')for(let i=0;i<6&&result.task.status==='paused'&&result.task.attempts<6;i++){
    result=await post('step',result.task);if(!alive.current||controller.signal.aborted)return;setTask(result.task);
   }
   if(action!=='cancel'&&result.task.status==='done'&&result.task.actions)applyActions(result.task.actions);
  }catch(e){if(alive.current&&!controller.signal.aborted){setError((e as Error).message);try{const r=await museRequest<{task:Task}>('tasks?thread='+encodeURIComponent(thread),{signal:controller.signal});if(alive.current&&!controller.signal.aborted)setTask(r.task);}catch{}}}
  finally{if(alive.current&&abort.current===controller)setBusy(false);}
 }

 async function image(file:File){
  if(imageAbort.current)return;
  const controller=new AbortController();imageAbort.current=controller;setImageBusy(true);setError('');
  try{await attachImage(file,controller.signal);}catch(e){if(alive.current&&!controller.signal.aborted)setError((e as Error).message);}
  finally{if(imageAbort.current===controller){imageAbort.current=null;if(alive.current&&!controller.signal.aborted)setImageBusy(false);}}
 }
 return <details className="muse-task-panel"><summary>Work through a task</summary>{!enabled&&<p>Tasks are unavailable in this deployment.</p>}{(!task||['done','cancelled'].includes(task.status))&&<><label><input type="checkbox" checked={research} onChange={e=>setResearch(e.target.checked)}/>Research the public web</label>{research&&<p>Only your task text is sent to web search. Leave private details out.</p>}<button disabled={busy||!enabled||!goal.trim()} onClick={()=>void action('create')}>Run task from message</button></>}{task&&<><p>{task.goal}</p><ol>{task.steps.map(s=><li key={s.name}>{s.name} · {s.status}</li>)}</ol><p role="status">{task.status} · {task.attempts}/6 requests</p>{task.error&&<p>{task.error}</p>}{task.notes.map((n,i)=><details key={i}><summary>{n.step}</summary><MuseMarkdown text={n.text}/></details>)}{task.sources.map(s=><p key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></p>)}{['paused','error'].includes(task.status)&&<button disabled={busy||!enabled} onClick={()=>void action('step')}>Resume task</button>}{task.status==='running'&&!busy&&<button onClick={()=>void action('recover')}>Recover interrupted step</button>}{!['done','cancelled'].includes(task.status)&&<button onClick={()=>void action('cancel')}>Cancel task</button>}{task.status==='done'&&task.actions&&<button onClick={()=>{const result=applyActions(task.actions!);setError(result.skipped?'Some newer edits were preserved.':'Added to board. Repeating this keeps existing cards.');}}>Add result to board</button>}</>}
 <button type="button" disabled={imageBusy} aria-busy={imageBusy} onClick={()=>imageInput.current?.click()}>Attach image</button><input ref={imageInput} type="file" hidden aria-label="Attach image" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void image(file);}}/>{error&&<p role="alert">{error}</p>}</details>;
}
