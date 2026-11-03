'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from '@clerk/nextjs';
import {getClientSessionToken,sessionTokenExpiration,useSupabaseClient} from '@/utils/supabase/client';
import {museTargetId,presenceName,readActivity,readCursor,readRoom,worldPoint,type BoardActivity,type BoardCursor,type BoardPerson,type CursorPosition} from './presence-state';
import {reservePresenceUpdate} from './presence-schedule';

type Options={boardId?:string;userId?:string;name:string;pageId?:string;viewport:number[];enabled:boolean;museWorking:boolean;museTargetId?:string};
type RoomView={scope:string;peers:BoardPerson[];cursors:BoardCursor[];connected:boolean};
export function useBoardPresence(options:Options){
 const {session}=useSession(),client=useSupabaseClient();
 const scope=options.enabled&&options.boardId&&options.userId&&options.pageId&&session?.user.id===options.userId?options.boardId+':'+options.userId+':'+session.id:'';
 const current=useRef({...options,scope});current.current={...options,scope};
 const [view,setView]=useState<RoomView>({scope:'',peers:[],cursors:[],connected:false}),[connection,setConnection]=useState(0);
 const lastPointer=useRef<{scope:string;point:{x:number;y:number}|null}>({scope:'',point:null});
 const viewportKey=options.viewport.join(':');
 const reconnect=useRef({scope:'',attempt:0});
 const roomRef=useRef<{scope:string;changed:()=>void}|null>(null);
 useEffect(()=>{
  if(!scope||!client)return;
  if(reconnect.current.scope!==scope)reconnect.current={scope,attempt:0};
  const tabId=crypto.randomUUID(),channel=client.channel('board:'+options.boardId,{config:{private:true,broadcast:{self:false},presence:{key:tabId}}});
  let cancelled=false,joined=false,subscribed=false,restarting=false,ready=false,validUntil=0;
  let peers:BoardPerson[]=[],announced:BoardPerson|null=null,cursors=new Map<string,BoardCursor>();
  const activities=new Map<string,BoardActivity>();let activityRevision=0,activityKey='',lastActivity='',forceActivity=false;
  let pointer=lastPointer.current.scope===scope&&!document.hidden?lastPointer.current.point:null,pending:CursorPosition|null=null,lastSent=0,trackBusy=false,authBusy=false,authAttempt=0;
  let activityTimer:ReturnType<typeof setTimeout>|undefined,cursorTimer:ReturnType<typeof setTimeout>|undefined,trackTimer:ReturnType<typeof setTimeout>|undefined,authRetry:ReturnType<typeof setTimeout>|undefined,tokenTimer:ReturnType<typeof setTimeout>|undefined,restartTimer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>!cancelled&&current.current.scope===scope;
  const authorized=()=>active()&&!restarting&&validUntil>Date.now();
  const render=()=>{if(active())setView({scope,peers,cursors:[...cursors.values()],connected:ready});};
  const restart=()=>{
   if(!active()||restarting)return;restarting=true;ready=false;joined=false;announced=null;peers=[];cursors.clear();render();
   if(activityTimer)clearTimeout(activityTimer);if(trackTimer)clearTimeout(trackTimer);if(tokenTimer)clearTimeout(tokenTimer);
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
   pending={tabId,pageId:current.current.pageId!,x:point?.x??null,y:point?.y??null};
   if(cursorTimer)return;const wait=Math.max(0,50-(performance.now()-lastSent));if(wait===0)flushCursor();else cursorTimer=setTimeout(flushCursor,wait);
  };
  const desired=():BoardPerson=>{
   const target=current.current.museWorking?museTargetId(current.current.museTargetId):undefined;
   const value={tabId,pageId:current.current.pageId!,muse:current.current.museWorking?'working' as const:'idle' as const,...(target?{museTargetId:target}:{})};
   const key=JSON.stringify(value);if(key!==activityKey){activityKey=key;activityRevision++;}
   return {userId:current.current.userId!,name:presenceName(current.current.name),...value,activityRevision};
  };
  // Presence tracks are quota-limited. Small activity broadcasts keep page and
  // work targets current without spending another membership update.
  const scheduleActivity=(force=false)=>{
   if(!authorized()||!ready)return;forceActivity=forceActivity||force;if(activityTimer)return;
   activityTimer=setTimeout(()=>{
    activityTimer=undefined;if(!authorized()||!ready)return;
    const {tabId,pageId,muse,museTargetId,activityRevision}=desired(),value={tabId,pageId,muse,...(museTargetId?{museTargetId}:{})},key=JSON.stringify(value);
    if(!forceActivity&&key===lastActivity)return;forceActivity=false;lastActivity=key;
    void channel.send({type:'broadcast',event:'activity',payload:{...value,revision:activityRevision}}).catch(()=>{});
    if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));
   },50);
  };
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
    if(result==='ok'){announced=value;ready=true;reconnect.current.attempt=0;render();scheduleActivity();if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));}
    else if(channel.state!=='joined'){restart();return;}
   }catch{if(active()&&channel.state!=='joined'){restart();return;}}
   finally{trackBusy=false;}
   if(authorized()&&(!announced||JSON.stringify(desired())!==JSON.stringify(announced)))scheduleTrack(1000);
  };
  const hide=()=>{const visible=pointer!==null;pointer=null;lastPointer.current={scope,point:null};if(!visible)return;queueCursor(null);if(cursorTimer){clearTimeout(cursorTimer);cursorTimer=undefined;flushCursor();}};
  const changed=()=>{scheduleActivity();scheduleTrack();if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));};
  const room={scope,changed};roomRef.current=room;
  const move=(event:PointerEvent)=>{
   if(event.pointerType==='touch'||document.hidden||!(event.target instanceof Element)||!event.target.closest('.muze-app')){hide();return;}
   pointer={x:event.clientX,y:event.clientY};lastPointer.current={scope,point:pointer};queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));
  };
  const leave=(event:PointerEvent)=>{if(!event.relatedTarget)hide();};
  const visibility=()=>{if(document.hidden)hide();};
  channel.on('presence',{event:'sync'},()=>{
   if(!authorized())return;
   const previous=new Set(peers.map(person=>person.tabId));
   peers=readRoom(channel.presenceState()).map(person=>{
    const activity=activities.get(person.tabId);if(!activity)return person;
    if(activity.revision<=(person.activityRevision||0)){activities.delete(person.tabId);return person;}
    return {...person,pageId:activity.pageId,muse:activity.muse,museTargetId:activity.museTargetId,activityRevision:activity.revision};
   });
   const present=new Map(peers.map(person=>[person.tabId,person]));
   for(const key of activities.keys())if(!present.has(key))activities.delete(key);
   for(const [key,cursor] of cursors){const person=present.get(key);if(!person||person.pageId!==cursor.pageId)cursors.delete(key);else cursors.set(key,{...cursor,...person});}
   render();
   if(peers.some(person=>person.tabId!==tabId&&!previous.has(person.tabId))){scheduleActivity(true);if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));}
  });
  channel.on('broadcast',{event:'activity'},({payload})=>{
   if(!authorized())return;const activity=readActivity(payload);if(!activity||activity.tabId===tabId)return;
   const index=peers.findIndex(peer=>peer.tabId===activity.tabId&&peer.userId!==current.current.userId);
   if(index<0||Math.max(activities.get(activity.tabId)?.revision||0,peers[index].activityRevision||0)>=activity.revision)return;
   activities.set(activity.tabId,activity);
   const person={...peers[index],pageId:activity.pageId,muse:activity.muse,museTargetId:activity.museTargetId,activityRevision:activity.revision};peers=peers.map((peer,position)=>position===index?person:peer);
   const cursor=cursors.get(activity.tabId);
   if(cursor){if(cursor.pageId!==person.pageId)cursors.delete(activity.tabId);else cursors.set(activity.tabId,{...cursor,...person});}
   render();
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
  const keepalive=setInterval(()=>{if(!authorized()||!ready)return;if(announced&&JSON.stringify(desired())!==JSON.stringify(announced))scheduleActivity(true);if(pointer&&!document.hidden)queueCursor(worldPoint(pointer.x,pointer.y,current.current.viewport));},3000);
  window.addEventListener('pointermove',move,{capture:true,passive:true});window.addEventListener('pointerout',leave);window.addEventListener('blur',hide);document.addEventListener('visibilitychange',visibility);render();
  return()=>{cancelled=true;if(current.current.scope!==scope)lastPointer.current={scope:'',point:null};pointer=null;ready=false;if(roomRef.current===room)roomRef.current=null;clearInterval(refresh);clearInterval(keepalive);for(const timer of [activityTimer,cursorTimer,trackTimer,authRetry,tokenTimer,restartTimer])if(timer)clearTimeout(timer);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerout',leave);window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',visibility);void client.removeChannel(channel);};
 },[scope,client,connection]);
 useEffect(()=>{const room=roomRef.current;if(room?.scope===scope)room.changed();},[scope,options.name,options.pageId,options.museWorking,options.museTargetId,viewportKey]);
 return view.scope===scope&&scope?view:{scope,peers:[],cursors:[],connected:false};
}
