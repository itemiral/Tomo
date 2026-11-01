'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from '@clerk/nextjs';
import {getClientSessionToken,sessionTokenExpiration,useSupabaseClient} from '@/utils/supabase/client';
import {presenceName,readCursor,readRoom,worldPoint,type BoardCursor,type BoardPerson,type CursorPosition} from './presence-state';
import {reservePresenceUpdate} from './presence-schedule';

type Options={boardId?:string;userId?:string;name:string;pageId?:string;viewport:number[];enabled:boolean;museWorking:boolean};
type RoomView={scope:string;peers:BoardPerson[];cursors:BoardCursor[];connected:boolean};
export function useBoardPresence(options:Options){
 const {session}=useSession(),client=useSupabaseClient();
 const scope=options.enabled&&options.boardId&&options.userId&&options.pageId&&session?.user.id===options.userId?options.boardId+':'+options.userId+':'+session.id:'';
 const current=useRef({...options,scope});current.current={...options,scope};
 const [view,setView]=useState<RoomView>({scope:'',peers:[],cursors:[],connected:false}),[connection,setConnection]=useState(0);
 const reconnect=useRef({scope:'',attempt:0});
 const roomRef=useRef<{scope:string;changed:()=>void}|null>(null);
 useEffect(()=>{
  if(!scope||!client)return;
  if(reconnect.current.scope!==scope)reconnect.current={scope,attempt:0};
  const tabId=crypto.randomUUID(),channel=client.channel('board:'+options.boardId,{config:{private:true,broadcast:{self:false},presence:{key:tabId}}});
  let cancelled=false,joined=false,subscribed=false,restarting=false,ready=false,validUntil=0;
  let peers:BoardPerson[]=[],announced:BoardPerson|null=null,cursors=new Map<string,BoardCursor>();
  let pointer:{x:number;y:number}|null=null,pending:CursorPosition|null=null,lastSent=0,trackBusy=false,authBusy=false,authAttempt=0;
  let cursorTimer:ReturnType<typeof setTimeout>|undefined,trackTimer:ReturnType<typeof setTimeout>|undefined,authRetry:ReturnType<typeof setTimeout>|undefined,tokenTimer:ReturnType<typeof setTimeout>|undefined,restartTimer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>!cancelled&&current.current.scope===scope;
  const authorized=()=>active()&&!restarting&&validUntil>Date.now();
  const render=()=>{if(active())setView({scope,peers,cursors:[...cursors.values()],connected:ready});};
  const restart=()=>{
   if(!active()||restarting)return;restarting=true;ready=false;joined=false;announced=null;peers=[];cursors.clear();render();
   if(trackTimer)clearTimeout(trackTimer);if(tokenTimer)clearTimeout(tokenTimer);
   const removed=client.removeChannel(channel),delay=[1000,3000,10000,30000][Math.min(reconnect.current.attempt++,3)];
   restartTimer=setTimeout(()=>{void removed.catch(()=>{}).then(()=>{if(active())setConnection(value=>value+1);});},delay);
  };
  const flushCursor=()=>{
   cursorTimer=undefined;if(!authorized()||!ready||!pending)return;
   const payload=pending;pending=null;lastSent=performance.now();
   void channel.send({type:'broadcast',event:'cursor',payload}).catch(()=>{});
  };
  const queueCursor=(point:{x:number;y:number}|null)=>{
   if(!authorized()||!ready||!announced)return;
   if(point&&announced.pageId!==current.current.pageId)point=null;
   pending={tabId,pageId:announced.pageId,x:point?.x??null,y:point?.y??null};
   if(cursorTimer)return;const wait=Math.max(0,50-(performance.now()-lastSent));if(wait===0)flushCursor();else cursorTimer=setTimeout(flushCursor,wait);
  };
  const desired=():BoardPerson=>({userId:current.current.userId!,name:presenceName(current.current.name),tabId,pageId:current.current.pageId!,muse:current.current.museWorking?'working':'idle'});
  const scheduleTrack=(delay=100)=>{
   if(!authorized()||!joined||trackBusy||trackTimer)return;
   trackTimer=setTimeout(()=>{trackTimer=undefined;void track();},delay);
  };
  const track=async()=>{
   if(!authorized()||!joined||trackBusy)return;
   const value=desired();if(announced&&JSON.stringify(value)===JSON.stringify(announced))return;
   const wait=reservePresenceUpdate(client);if(wait){scheduleTrack(wait);return;}
   trackBusy=true;
   try{
    const result=await channel.track(value);if(!authorized()||!joined)return;
    if(result==='ok'){announced=value;ready=true;reconnect.current.attempt=0;render();if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));}
    else if(channel.state!=='joined'){restart();return;}
   }catch{if(active()&&channel.state!=='joined'){restart();return;}}
   finally{trackBusy=false;}
   if(authorized()&&(!announced||JSON.stringify(desired())!==JSON.stringify(announced)))scheduleTrack(1000);
  };
  const hide=()=>{pointer=null;queueCursor(null);};
  const changed=()=>{if(announced?.pageId!==current.current.pageId)queueCursor(null);scheduleTrack();};
  const room={scope,changed};roomRef.current=room;
  const move=(event:PointerEvent)=>{
   if(event.pointerType==='touch'||document.hidden||!(event.target instanceof Element)||!event.target.closest('.muze-drawing-surface')){hide();return;}
   pointer={x:event.clientX,y:event.clientY};queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));
  };
  const leave=(event:PointerEvent)=>{if(!event.relatedTarget)hide();};
  const visibility=()=>{if(document.hidden)hide();};
  channel.on('presence',{event:'sync'},()=>{
   if(!authorized())return;peers=readRoom(channel.presenceState());
   const present=new Map(peers.map(person=>[person.tabId,person]));
   for(const [key,cursor] of cursors){const person=present.get(key);if(!person||person.pageId!==cursor.pageId)cursors.delete(key);else cursors.set(key,{...cursor,...person});}render();
  });
  channel.on('broadcast',{event:'cursor'},({payload})=>{
   if(!authorized())return;const point=readCursor(payload);if(!point||point.tabId===tabId)return;
   const person=peers.find(peer=>peer.tabId===point.tabId&&peer.pageId===point.pageId&&peer.userId!==current.current.userId);if(!person)return;
   if(point.x===null||point.y===null)cursors.delete(point.tabId);else cursors.set(point.tabId,{...person,x:point.x,y:point.y,receivedAt:Date.now()});render();
  });
  const refreshAuth=async()=>{
   if(authBusy||!active()||restarting)return;authBusy=true;
   try{
    const token=await getClientSessionToken(client);if(!active()||restarting)return;
    const expires=token?sessionTokenExpiration(token):0;if(!token||expires<=Date.now()){restart();return;}
    await client.realtime.setAuth(token);if(!active()||restarting)return;
    validUntil=expires;authAttempt=0;if(authRetry)clearTimeout(authRetry);if(tokenTimer)clearTimeout(tokenTimer);
    tokenTimer=setTimeout(restart,Math.min(2_147_483_647,Math.max(0,validUntil-Date.now())));
    if(!subscribed){subscribed=true;channel.subscribe(status=>{if(!active()||restarting)return;if(status==='SUBSCRIBED'){joined=true;scheduleTrack(0);}else restart();});}
   }catch{if(active()&&!restarting){if(validUntil&&validUntil<=Date.now())restart();else if(authAttempt<3)authRetry=setTimeout(()=>void refreshAuth(),[1000,3000,10000][authAttempt++]);}}
   finally{authBusy=false;}
  };
  void refreshAuth();
  const refresh=setInterval(()=>void refreshAuth(),30000);
  const keepalive=setInterval(()=>{if(pointer&&!document.hidden&&authorized()&&ready)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));},3000);
  const expiry=setInterval(()=>{let changed=false;for(const [key,cursor] of cursors)if(Date.now()-cursor.receivedAt>10000){cursors.delete(key);changed=true;}if(changed)render();},2000);
  window.addEventListener('pointermove',move);window.addEventListener('pointerout',leave);window.addEventListener('blur',hide);document.addEventListener('visibilitychange',visibility);render();
  return()=>{cancelled=true;pointer=null;ready=false;if(roomRef.current===room)roomRef.current=null;clearInterval(refresh);clearInterval(keepalive);clearInterval(expiry);for(const timer of [cursorTimer,trackTimer,authRetry,tokenTimer,restartTimer])if(timer)clearTimeout(timer);window.removeEventListener('pointermove',move);window.removeEventListener('pointerout',leave);window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',visibility);void client.removeChannel(channel);};
 },[scope,client,connection]);
 useEffect(()=>{const room=roomRef.current;if(room?.scope===scope)room.changed();},[scope,options.name,options.pageId,options.museWorking]);
 return view.scope===scope&&scope?view:{scope,peers:[],cursors:[],connected:false};
}
