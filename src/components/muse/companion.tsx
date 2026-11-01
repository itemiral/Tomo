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
 const [profile,setProfile]=useState<MuseProfile|null>(null),[error,setError]=useState(''),[iconBusy,setIconBusy]=useState(false),[chatOpen,setChatOpen]=useState(false),[avatarConfirm,setAvatarConfirm]=useState(false),[activity,setActivity]=useState<MuseActivity>({label:''});
 const ownerVersion=useRef(0),iconInput=useRef<HTMLInputElement>(null),workTimers=useRef<ReturnType<typeof setTimeout>[]>([]);
 const stopActivity=useCallback(()=>{workTimers.current.forEach(clearTimeout);workTimers.current=[];setActivity({label:''});},[]);
 const thinking=useCallback((value:boolean)=>{stopActivity();if(value)setActivity({label:'Thinking…'});},[stopActivity]);
 const clear=useCallback(()=>{ownerVersion.current++;setProfile(null);setChatOpen(false);setError('Sign in again to open your Muse.');},[]);
 useEffect(()=>{if(chatRequest)setChatOpen(chatRequest>0);},[chatRequest]);
 useEffect(()=>{stopActivity();return()=>workTimers.current.forEach(clearTimeout);},[thread,stopActivity]);
 useEffect(()=>{const controller=new AbortController();void request<MuseProfile>('session',{signal:controller.signal}).then(v=>{if(!controller.signal.aborted&&v.ownerId===userId)setProfile(v);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{controller.abort();ownerVersion.current++;};},[userId]);
  async function changeIcon(file: File) {
    const generation = ownerVersion.current; setIconBusy(true); setError('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10_000_000) throw new Error('Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
      const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      const result = await request<Partial<MuseProfile['muse']>>('avatar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
      if (generation === ownerVersion.current) { setAvatarConfirm(false); setProfile(value => value ? { ...value, muse: { ...value.muse, gazeVersion: null, candidateVersion: null, ...result } } : value);await appearanceChanged?.(); }
    } catch (cause) { if (cause instanceof RequestError && cause.status === 401) clear(); else if (generation === ownerVersion.current) setError(cause instanceof RequestError ? cause.message : 'That image could not be opened. Choose a PNG, JPEG, WebP, or GIF under 10 MB.'); }
    finally { if (generation === ownerVersion.current) setIconBusy(false); }
  }
  async function generateIcon(activate = false) {
    if (!profile || iconBusy) return;
    const generation = ownerVersion.current; setIconBusy(true); setError(''); setAvatarConfirm(false);
    try {
      const result = await request<Partial<MuseProfile['muse']>>('avatar', { method: activate ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activate ? { action: 'activate', version: profile.muse.candidateVersion } : { sourceVersion: profile.muse.iconVersion, confirmCost: true, shareWithMeta: true, maxCostUsd: 0.01 }) });
      if (generation === ownerVersion.current) setProfile(value => value ? { ...value, muse: { ...value.muse, ...result } } : value);
    } catch (cause) { if (generation === ownerVersion.current) setError((cause as Error).message); }
    finally { if (generation === ownerVersion.current) setIconBusy(false); }
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
  {open && profile && appearanceSelected && <div className="muse-appearance-actions" style={{left:Math.max(12,Math.min(innerWidth-292,appearanceAnchor?.x||20)),top:Math.max(80,Math.min(innerHeight-300,appearanceAnchor?.y||120))}}><div className="muse-appearance-actions-content"><button className="muse-change-icon" aria-label="Change Muse icon" disabled={iconBusy} onClick={()=>iconInput.current?.click()}><Pencil size={15}/>Swap image</button>{iconBusy&&<p role="status">Updating avatar…</p>}{profile.muse.iconVersion&&<button disabled={iconBusy} onClick={()=>setAvatarConfirm(true)}>Generate gaze · $0.01</button>}{avatarConfirm&&<div role="group" aria-label="Confirm avatar generation"><p>Send this picture to Meta for one nine-view image? Maximum cost: $0.01.</p><button disabled={iconBusy} onClick={()=>void generateIcon()}>Confirm $0.01 generation</button><button onClick={()=>setAvatarConfirm(false)}>Cancel</button></div>}{profile.muse.candidateVersion&&profile.muse.candidateVersion!==profile.muse.gazeVersion&&<div className="muse-gaze-preview"><img alt="Nine generated gaze directions to review" src={'/api/muse/avatar?sheet=true&v='+profile.muse.candidateVersion}/><p>Check that every view still looks like your Muse.</p><button disabled={iconBusy} onClick={()=>void generateIcon(true)}>Use these gaze frames</button></div>}</div></div>}
  <input type="file" ref={iconInput} hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose Muse icon" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void changeIcon(file);}}/>
  {error&&<div className="muze-toast" role="alert">{error}</div>}
 </div>;
}
