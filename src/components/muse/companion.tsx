"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { ArrowUp, Pencil } from 'lucide-react';
import { MuseIcon, museRequest as request, RequestError, type MuseProfile } from './shared';
import { MuseChat } from './chat';
import { FloatingMuse, type Obstacle, type MuseActivity } from './floating';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';
import './muse.css';
type Props={historyControls?:ReactNode;appearanceSelected?:boolean;appearanceAnchor?:{x:number;y:number};openAppearance?:()=>void;appearanceChanged?:()=>Promise<void>;open:boolean;onOpenChange:(open:boolean)=>void;chatRequest:number;beforeSend?:()=>Promise<void>;obstacles:Obstacle[];thread:string;boardContext:string;addToBoard:(text:string)=>void;applyActions:(actions:MuseActions)=>MuseApplyResult};
export function MuseCompanion(props:Props) {
 const {isLoaded,isSignedIn,user}=useUser(),clerk=useClerk();
 const [guestText,setGuestText]=useState('');
 useEffect(()=>{if(props.chatRequest>0&&isLoaded&&!isSignedIn)clerk.openSignIn();},[props.chatRequest]);
 if(!isSignedIn||!user)return <div data-muse-ui="true" className="muse-interface"><FloatingMuse obstacles={props.obstacles} activity={{label:''}} open={()=>{if(isLoaded)clerk.openSignIn();}}/><div className="muse-chat-stack">{props.historyControls}<form className="muse-inline-guest" onSubmit={e=>{e.preventDefault();if(isLoaded)clerk.openSignIn();}}><input aria-label="Message Muse" placeholder="A thought, a question…" value={guestText} onChange={e=>setGuestText(e.target.value)} onKeyDown={e=>e.stopPropagation()}/><button aria-label="Send to Muse" disabled={!isLoaded}><ArrowUp size={17}/></button></form></div></div>;
 return <OwnedMuse key={user.id} {...props} userId={user.id}/>;
}
function OwnedMuse({historyControls,appearanceSelected,appearanceAnchor,openAppearance,appearanceChanged,open,onOpenChange,chatRequest,beforeSend,obstacles,thread,boardContext,addToBoard,applyActions,userId}:Props&{userId:string}) {
 const [profile,setProfile]=useState<MuseProfile|null>(null),[error,setError]=useState(''),[iconBusy,setIconBusy]=useState(false),[chatOpen,setChatOpen]=useState(false),[avatarStatus,setAvatarStatus]=useState(''),[retryFile,setRetryFile]=useState<File|null>(null),[activity,setActivity]=useState<MuseActivity>({label:''});
 useEffect(()=>{const renamed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail.ownerId===userId)setProfile(p=>p?{...p,muse:{...p.muse,name:detail.name}}:p);};window.addEventListener('muse-name-saved',renamed);return()=>window.removeEventListener('muse-name-saved',renamed);},[userId]);
 const avatarRequest=useRef<AbortController|null>(null),lastOperation=useRef<string|null>(null);
 useEffect(()=>()=>avatarRequest.current?.abort(),[]);
 const ownerVersion=useRef(0),iconInput=useRef<HTMLInputElement>(null),workTimers=useRef<ReturnType<typeof setTimeout>[]>([]);
 const stopActivity=useCallback(()=>{workTimers.current.forEach(clearTimeout);workTimers.current=[];setActivity({label:''});},[]);
 const thinking=useCallback((value:boolean)=>{stopActivity();if(value)setActivity({label:'Thinking…'});},[stopActivity]);
 const clear=useCallback(()=>{ownerVersion.current++;setProfile(null);setChatOpen(false);setError('Sign in again to open your Muse.');},[]);
 useEffect(()=>{if(chatRequest)setChatOpen(chatRequest>0);},[chatRequest]);
 useEffect(()=>{stopActivity();return()=>workTimers.current.forEach(clearTimeout);},[thread,stopActivity]);
 useEffect(()=>{const controller=new AbortController();void request<MuseProfile>('session',{signal:controller.signal}).then(v=>{if(!controller.signal.aborted&&v.ownerId===userId)setProfile(v);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{controller.abort();ownerVersion.current++;};},[userId]);
  async function refreshAvatar(operationId:string){
    const generation=ownerVersion.current;const result=await request<Partial<MuseProfile['muse']>&{status:string}>('avatar?operation='+encodeURIComponent(operationId));
    if(generation!==ownerVersion.current)return result.status;
    if(result.status==='completed'){setProfile(p=>p?{...p,muse:{...p.muse,...result}}:p);await appearanceChanged?.();setRetryFile(null);setAvatarStatus('Avatar updated.');}
    else setAvatarStatus(result.status==='running'?'Generation is still running. Check again shortly.':'Your current avatar is kept. Retry starts a new generation attempt.');
    return result.status;
  }
  async function changeIcon(file: File) {
    if(avatarRequest.current)return;
    const generation=ownerVersion.current,abort=new AbortController();avatarRequest.current=abort;
    setIconBusy(true);setError('');setAvatarStatus('Generating your avatar…');setRetryFile(file);
    try{
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>10_000_000)throw new Error('Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
      const source=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Could not read that image.'));reader.readAsDataURL(file);});
      if(abort.signal.aborted)return;
      const operationId=crypto.randomUUID();lastOperation.current=operationId;
      const result=await request<Partial<MuseProfile['muse']>>('avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'replace',source,operationId,confirmCost:true,shareWithMeta:true,maxCostUsd:.01}),signal:abort.signal});
      if(generation===ownerVersion.current&&!abort.signal.aborted){setProfile(p=>p?{...p,muse:{...p.muse,...result}}:p);await appearanceChanged?.();setRetryFile(null);setAvatarStatus('Avatar updated.');}
    }catch(cause){if(generation===ownerVersion.current){setAvatarStatus(abort.signal.aborted?'Stopped waiting. Your previous avatar stays visible; check status before retrying.':(cause as Error).message);if(cause instanceof RequestError&&cause.status===401)clear();}}
    finally{if(avatarRequest.current===abort)avatarRequest.current=null;if(generation===ownerVersion.current)setIconBusy(false);}
  }
  function apply(actions: MuseActions) {
    stopActivity();
    const result = applyActions(actions);
    result.ids.forEach((id, index) => {
      const show = () => setActivity({ label: 'Working here', targetId: id });
      if (!index) show(); else workTimers.current.push(setTimeout(show, index * 1100));
    });
    if (result.ids.length) workTimers.current.push(setTimeout(() => setActivity({ label: '' }), result.ids.length * 1100 + 1600));
    return result;
  }

 return <div data-muse-ui="true" className="muse-interface">
  {!open && <FloatingMuse profile={profile} open={()=>onOpenChange(true)} changeAvatar={()=>{openAppearance?.();}} chat={()=>setChatOpen(true)} obstacles={obstacles} activity={activity} chatOpen={chatOpen}/>}
  {profile && <div className="muse-chat-stack">{historyControls}<MuseChat key={thread} hidden={!chatOpen} expand={()=>setChatOpen(true)} beforeSend={beforeSend} profile={profile} thread={thread} boardContext={boardContext} close={()=>setChatOpen(false)} edit={()=>onOpenChange(true)} locked={clear} onThinking={thinking} applyActions={apply} addToBoard={addToBoard}/></div>}
  {open && profile && (appearanceSelected||iconBusy) && <div className="muse-appearance-actions" style={{left:Math.max(12,Math.min(innerWidth-292,appearanceAnchor?.x||20)),top:Math.max(80,Math.min(innerHeight-300,appearanceAnchor?.y||120))}}><div className="muse-appearance-actions-content"><p id="avatar-replace-disclosure">Meta processes this image to generate and apply your avatar.</p><button className="muse-change-icon" aria-label="Change Muse icon" aria-describedby="avatar-replace-disclosure" disabled={iconBusy} onClick={()=>iconInput.current?.click()}><Pencil size={15}/>Replace image</button>{avatarStatus&&<p role="status">{avatarStatus}</p>}{iconBusy?<button onClick={()=>avatarRequest.current?.abort()}>Cancel generation</button>:retryFile&&<><button onClick={()=>{if(lastOperation.current)void refreshAvatar(lastOperation.current).catch(e=>setAvatarStatus(e.message));}}>Check generation status</button><button onClick={()=>void changeIcon(retryFile)}>Retry generation</button></>}</div></div>}
  <input type="file" ref={iconInput} hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose Muse icon" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void changeIcon(file);}}/>
  {error&&<div className="muze-toast" role="alert">{error}</div>}
 </div>;
}
