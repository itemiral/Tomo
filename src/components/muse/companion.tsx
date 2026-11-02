"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { ArrowUp } from 'lucide-react';
import { museRequest as request, RequestError, type MuseProfile } from './shared';
import { normalizeAvatarImage } from './avatar-upload';
import { AvatarFeedback, type AvatarState } from './avatar-feedback';
import { MuseChat } from './chat';
import { FloatingMuse, type Obstacle, type MuseActivity } from './floating';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';
import './muse.css';
type Props={attachImage:(file:File,signal:AbortSignal)=>Promise<void>;onActivity?:(activity:MuseActivity)=>void;selectedIds?:string[];prepareContext?:()=>Promise<string>;appearanceSelected?:boolean;appearanceAnchor?:{x:number;y:number};openAppearance?:()=>void;appearanceChanged?:()=>Promise<void>;open:boolean;onOpenChange:(open:boolean)=>void;chatRequest:number;beforeSend?:()=>Promise<void>;obstacles:Obstacle[];thread:string;boardContext:string;applyActions:(actions:MuseActions)=>MuseApplyResult};
export function MuseCompanion(props:Props) {
 const {isLoaded,isSignedIn,user}=useUser(),clerk=useClerk();
 const [guestText,setGuestText]=useState('');
 useEffect(()=>{if(props.chatRequest>0&&isLoaded&&!isSignedIn)clerk.openSignIn();},[props.chatRequest]);
 if(!isLoaded||!isSignedIn||!user)return <div data-muse-ui="true" className="muse-interface"><FloatingMuse profileLoading={!isLoaded||!!isSignedIn} obstacles={props.obstacles} activity={{label:''}} open={()=>{if(isLoaded)clerk.openSignIn();}}/><div className="muse-chat-stack"><form className="muse-inline-guest" onSubmit={e=>{e.preventDefault();if(isLoaded)clerk.openSignIn();}}><input aria-label="Message Muse" placeholder="A thought, a question…" value={guestText} onChange={e=>setGuestText(e.target.value)} onKeyDown={e=>e.stopPropagation()}/><button aria-label="Send to Muse" disabled={!isLoaded}><ArrowUp size={17}/></button></form></div></div>;
 return <OwnedMuse key={user.id} {...props} userId={user.id}/>;
}
function OwnedMuse({attachImage,onActivity,selectedIds,prepareContext,appearanceSelected,openAppearance,appearanceChanged,open,onOpenChange,chatRequest,beforeSend,obstacles,thread,boardContext,applyActions,userId}:Props&{userId:string}) {
 const [profile,setProfile]=useState<MuseProfile|null>(null),[error,setError]=useState(''),[avatarState,setAvatarState]=useState<AvatarState>('idle'),[chatOpen,setChatOpen]=useState(false),[avatarStatus,setAvatarStatus]=useState(''),[retryFile,setRetryFile]=useState<File|null>(null),[activity,setActivity]=useState<MuseActivity>({label:''});
 const iconBusy=avatarState==='pending',appearanceBox=obstacles.find(box=>box.id==='muse-appearance');
 const currentActivity=activity.thread===thread?activity:{label:''};
 const workingBoxes=open?[]:obstacles.filter(box=>box.id&&(currentActivity.targetIds||[currentActivity.targetId]).includes(box.id));
 useEffect(()=>{onActivity?.(!open&&activity.label&&activity.thread===thread?activity:{label:''});},[onActivity,open,activity,thread]);
 useEffect(()=>()=>onActivity?.({label:''}),[onActivity]);
 useEffect(()=>{const renamed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail.ownerId===userId)setProfile(p=>p?{...p,muse:{...p.muse,name:detail.name}}:p);};window.addEventListener('muse-name-saved',renamed);return()=>window.removeEventListener('muse-name-saved',renamed);},[userId]);
 const avatarRequest=useRef<AbortController|null>(null),lastOperation=useRef<string|null>(null);
 useEffect(()=>()=>avatarRequest.current?.abort(),[]);
 const ownerVersion=useRef(0),iconInput=useRef<HTMLInputElement>(null),activityTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const stopActivity=useCallback(()=>{if(activityTimer.current)clearTimeout(activityTimer.current);activityTimer.current=null;setActivity({label:''});},[]);
 const thinking=useCallback((value:boolean,focusIds:string[]=[])=>{stopActivity();if(value)setActivity({label:'Thinking…',targetId:focusIds[0],targetIds:focusIds,thread,ownerId:userId});},[stopActivity,thread,userId]);
 const clear=useCallback(()=>{ownerVersion.current++;setProfile(null);setChatOpen(false);setError('Sign in again to open your Muse.');},[]);
 useEffect(()=>{if(chatRequest)setChatOpen(chatRequest>0);},[chatRequest]);
 useEffect(()=>{stopActivity();return()=>{if(activityTimer.current)clearTimeout(activityTimer.current);};},[thread,stopActivity]);
 useEffect(()=>{const controller=new AbortController();void request<MuseProfile>('session',{signal:controller.signal}).then(v=>{if(!controller.signal.aborted&&v.ownerId===userId)setProfile(v);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{controller.abort();ownerVersion.current++;};},[userId]);
  async function changeIcon(file: File, retry=false) {
    if(avatarRequest.current)return;
    const generation=ownerVersion.current,abort=new AbortController();avatarRequest.current=abort;
    setAvatarState('pending');setAvatarStatus('Updating Muse avatar.');
    if(!retry){lastOperation.current=null;setRetryFile(null);}
    const apply=async(result:Partial<MuseProfile['muse']>)=>{
      if(generation!==ownerVersion.current||abort.signal.aborted)return;
      await appearanceChanged?.();
      if(generation!==ownerVersion.current||abort.signal.aborted)return;
      setProfile(p=>p?{...p,muse:{...p.muse,...result}}:p);
      window.dispatchEvent(new CustomEvent('muse-appearance-saved',{detail:{ownerId:userId}}));
      setRetryFile(null);lastOperation.current=null;setAvatarState('idle');setAvatarStatus('Avatar updated.');
    };
    try{
      // Recover a lost response before starting another potentially paid attempt.
      if(retry&&lastOperation.current){
        for(let check=0;check<60;check++){
          const result=await request<Partial<MuseProfile['muse']>&{status:string}>('avatar?operation='+encodeURIComponent(lastOperation.current),{signal:abort.signal});
          if(result.status==='completed'){await apply(result);return;}
          if(result.status!=='running'){
            // Reuse an unknown ID so a delayed first submission remains idempotent.
            if(result.status!=='not-found')lastOperation.current=null;
            break;
          }
          if(check===59)throw new Error('Still pending');
          await new Promise<void>((resolve,reject)=>{
            const stopped=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',stopped);reject(abort.signal.reason);};
            const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',stopped);resolve();},2000);
            abort.signal.addEventListener('abort',stopped,{once:true});
            if(abort.signal.aborted)stopped();
          });
        }
      }
      const source=await normalizeAvatarImage(file,abort.signal);
      if(generation!==ownerVersion.current||abort.signal.aborted)return;
      setRetryFile(file);
      const operationId=lastOperation.current||crypto.randomUUID();lastOperation.current=operationId;
      const result=await request<Partial<MuseProfile['muse']>>('avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'replace',source,operationId,confirmCost:true,shareWithMeta:true,maxCostUsd:.01}),signal:abort.signal});
      await apply(result);
    }catch(cause){if(generation===ownerVersion.current&&!abort.signal.aborted){setAvatarState('error');setAvatarStatus('Avatar unchanged. Use the retry control to try again or choose another image.');if(cause instanceof RequestError&&cause.status===401)clear();}}
    finally{if(avatarRequest.current===abort)avatarRequest.current=null;}
  }
  function apply(actions: MuseActions) {
    stopActivity();
    const result = applyActions(actions);
    if (result.ids.length) {
      setActivity({label:'',targetId:result.ids[0],targetIds:result.ids,thread,ownerId:userId});
      activityTimer.current=setTimeout(stopActivity,1600);
    }
    return result;
  }

 return <>
  {workingBoxes.map(box=><span key={box.id} className={'muse-working-target'+(activity.label?'':' completed')} data-target-id={box.id} aria-hidden="true" style={{left:box.x-8,top:box.y-8,width:box.w+16,height:box.h+16}}/>)}
  <div data-muse-ui="true" className="muse-interface">
  {!open && <FloatingMuse profile={profile} profileLoading={!profile} avatarPending={iconBusy} open={()=>onOpenChange(true)} changeAvatar={()=>{openAppearance?.();}} chat={()=>setChatOpen(true)} obstacles={obstacles} activity={currentActivity} chatOpen={chatOpen}/>}
  {profile && <div className="muse-chat-stack"><MuseChat attachImage={attachImage} key={thread} hidden={!chatOpen} expand={()=>setChatOpen(true)} beforeSend={beforeSend} prepareContext={prepareContext} selectedIds={selectedIds} profile={profile} thread={thread} boardContext={boardContext} close={()=>setChatOpen(false)} locked={clear} onThinking={thinking} applyActions={apply}/></div>}
  {open&&profile&&appearanceBox&&<AvatarFeedback box={appearanceBox} state={avatarState} selected={!!appearanceSelected} canRetry={!!retryFile} choose={()=>iconInput.current?.click()} retry={()=>{if(retryFile)void changeIcon(retryFile,true);else iconInput.current?.click();}}/>}
  <span className="muse-sr-only" id="avatar-replace-disclosure">Meta processes this image to generate and apply your avatar.</span>
  <span className="muse-sr-only" role="status" aria-live="polite">{avatarStatus}</span>
  <input type="file" ref={iconInput} hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose Muse icon" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void changeIcon(file);}}/>
  {error&&<div className="muze-toast" role="alert">{error}</div>}
 </div></>;
}
