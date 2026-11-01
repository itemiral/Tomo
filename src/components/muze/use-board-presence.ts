'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from '@clerk/nextjs';
import type {RealtimeChannel} from '@supabase/supabase-js';
import {useSupabaseClient} from '@/utils/supabase/client';
import {presenceName,readCursor,readRoom,worldPoint,type BoardCursor,type BoardPerson,type CursorPosition} from './presence-state';

type Options={boardId?:string;userId?:string;name:string;pageId?:string;viewport:number[];enabled:boolean;museWorking:boolean};
type RoomView={scope:string;peers:BoardPerson[];cursors:BoardCursor[];connected:boolean};
export function useBoardPresence(options:Options){
  const {session}=useSession(),client=useSupabaseClient();
  const scope=options.enabled&&options.boardId&&options.userId?options.boardId+':'+options.userId+':'+session?.id:'';
  const current=useRef({...options,scope});current.current={...options,scope};
  const [view,setView]=useState<RoomView>({scope:'',peers:[],cursors:[],connected:false});
  const roomRef=useRef<{channel:RealtimeChannel;scope:string;tabId:string;ready:boolean}|null>(null);
  useEffect(()=>{
    if(!scope||!client||!session||!options.userId||!options.pageId)return;
    let cancelled=false;const tabId=crypto.randomUUID(),channel=client.channel('board:'+options.boardId,{config:{private:true,broadcast:{self:false},presence:{key:tabId}}});
    const room={channel,scope,tabId,ready:false};roomRef.current=room;
    let peers:BoardPerson[]=[],cursors=new Map<string,BoardCursor>();
    let cursorTimer:ReturnType<typeof setTimeout>|undefined,lastSent=0,pending:CursorPosition|null=null;
    const active=()=>!cancelled&&current.current.scope===scope;
    const render=()=>{if(active())setView({scope,peers,cursors:[...cursors.values()],connected:room.ready});};
    const track=()=>{
      const value=current.current;if(!active()||!room.ready||document.hidden||!value.pageId)return;
      void channel.track({userId:value.userId,name:presenceName(value.name),tabId,pageId:value.pageId,muse:value.museWorking?'working':'idle'}).catch(()=>{});
    };
    const flushCursor=()=>{
      cursorTimer=undefined;if(!active()||!room.ready||!pending)return;
      const payload=pending;pending=null;lastSent=performance.now();
      void channel.send({type:'broadcast',event:'cursor',payload}).catch(()=>{});
    };
    const queueCursor=(point:{x:number;y:number}|null)=>{
      if(!active()||!room.ready||!current.current.pageId)return;
      pending={tabId,pageId:current.current.pageId,x:point?.x??null,y:point?.y??null};
      if(cursorTimer)return;const wait=Math.max(0,50-(performance.now()-lastSent));
      if(wait===0)flushCursor();else cursorTimer=setTimeout(flushCursor,wait);
    };
    const hide=()=>queueCursor(null);
    const move=(event:PointerEvent)=>{
      if(event.pointerType==='touch'||document.hidden||!(event.target instanceof Element)||!event.target.closest('.muze-drawing-surface')){hide();return;}
      queueCursor(worldPoint(event.clientX,event.clientY,current.current.viewport));
    };
    const leave=(event:PointerEvent)=>{if(!event.relatedTarget)hide();};
    const visibility=()=>{if(document.hidden){hide();void channel.untrack().catch(()=>{});}else track();};
    channel.on('presence',{event:'sync'},()=>{
      if(!active())return;peers=readRoom(channel.presenceState());
      const present=new Map(peers.map(person=>[person.tabId,person]));
      for(const [key,cursor] of cursors){const person=present.get(key);if(!person||person.pageId!==cursor.pageId)cursors.delete(key);else cursors.set(key,{...cursor,...person});}
      render();
    });
    channel.on('broadcast',{event:'cursor'},({payload})=>{
      if(!active())return;const point=readCursor(payload);if(!point||point.tabId===tabId)return;
      const person=peers.find(peer=>peer.tabId===point.tabId&&peer.pageId===point.pageId&&peer.userId!==current.current.userId);
      if(!person)return;
      if(point.x===null||point.y===null)cursors.delete(point.tabId);else cursors.set(point.tabId,{...person,x:point.x,y:point.y,receivedAt:Date.now()});
      render();
    });
    let subscribed=false,authBusy=false,authAttempt=0;let authRetry:ReturnType<typeof setTimeout>|undefined;
    const refreshAuth=async()=>{
      if(authBusy||!active())return;authBusy=true;
      try{
        const token=await session.getToken({skipCache:true});if(!active())return;
        if(!token){room.ready=false;peers=[];cursors.clear();render();void client.removeChannel(channel);return;}
        await client.realtime.setAuth(token);if(!active())return;authAttempt=0;if(authRetry)clearTimeout(authRetry);
        if(!subscribed){subscribed=true;channel.subscribe(status=>{if(!active())return;room.ready=status==='SUBSCRIBED';if(room.ready)track();else{peers=[];cursors.clear();}render();});}
        else if(channel.state==='joined'){room.ready=true;track();render();}
      }catch{if(active()){room.ready=false;peers=[];cursors.clear();render();if(authAttempt<3)authRetry=setTimeout(()=>void refreshAuth(),[1000,3000,10000][authAttempt++]);}}
      finally{authBusy=false;}
    };
    void refreshAuth();
    const refresh=setInterval(()=>void refreshAuth(),30000);
    const expiry=setInterval(()=>{let changed=false;for(const [key,cursor] of cursors)if(Date.now()-cursor.receivedAt>10000){cursors.delete(key);changed=true;}if(changed)render();},2000);
    window.addEventListener('pointermove',move);window.addEventListener('pointerout',leave);window.addEventListener('blur',hide);document.addEventListener('visibilitychange',visibility);
    render();
    return()=>{cancelled=true;room.ready=false;if(roomRef.current===room)roomRef.current=null;clearInterval(refresh);clearInterval(expiry);if(cursorTimer)clearTimeout(cursorTimer);if(authRetry)clearTimeout(authRetry);window.removeEventListener('pointermove',move);window.removeEventListener('pointerout',leave);window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',visibility);void client.removeChannel(channel);};
  },[scope,client,session]);
  useEffect(()=>{
    const room=roomRef.current;
    if(!room||!room.ready||room.scope!==scope||!options.pageId||document.hidden)return;
    void room.channel.track({userId:options.userId,name:presenceName(options.name),tabId:room.tabId,pageId:options.pageId,muse:options.museWorking?'working':'idle'}).catch(()=>{});
  },[scope,options.name,options.pageId,options.museWorking,options.userId]);
  return view.scope===scope&&scope?view:{scope,peers:[],cursors:[],connected:false};
}
