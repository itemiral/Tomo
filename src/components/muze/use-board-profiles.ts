'use client';
import {useEffect,useRef,useState} from 'react';
import {readBoardProfiles,type BoardProfiles} from './board-profiles';
type Options={boardId?:string;userId?:string;enabled:boolean;connected:boolean;peerIds:string[];profileVersion?:string};
const EMPTY:BoardProfiles={};
export function useBoardProfiles(options:Options){
 const scope=options.enabled&&options.boardId&&options.userId?options.boardId+':'+options.userId:'';
 const current=useRef({...options,scope});current.current={...options,scope};
 const [view,setView]=useState<{scope:string;profiles:BoardProfiles}>({scope:'',profiles:EMPTY});
 const actions=useRef<{scope:string;refresh:(publish?:boolean)=>void}|null>(null);
 const profiles=useRef<BoardProfiles>(EMPTY);
 const members=[...new Set(options.peerIds)].sort().join('|');
 useEffect(()=>{
  if(!scope)return;
  let cancelled=false,denied=false,reading=false,publishing=false,publishPending=false,readPending=false,publication=0,readRevision=0;const abort=new AbortController();
  const active=()=>!cancelled&&!denied&&current.current.scope===scope;
  const url='/api/boards/'+encodeURIComponent(options.boardId!)+'/participants';
  const apply=(value:BoardProfiles)=>{if(active()){profiles.current=value;setView({scope,profiles:value});}};
  const responseProfiles=async(response:Response)=>{
   if(!response.ok){
    if([401,403,404].includes(response.status)&&active()){profiles.current=EMPTY;setView({scope,profiles:EMPTY});denied=true;abort.abort();}
    throw new Error('Could not read board participants.');
   }
   return readBoardProfiles(await response.json(),options.boardId!);
  };
  const read=()=>{
   readPending=true;if(!active()||reading||document.hidden)return;
   reading=true;readPending=false;const startedAt=publication;let failed=false;
   void fetch(url,{cache:'no-store',signal:abort.signal}).then(responseProfiles).then(value=>{
    // A read begun before a successful publish must not restore its old avatar.
    if(active()&&startedAt===publication){readRevision++;apply(value);}
   }).catch(()=>{failed=true;}).finally(()=>{reading=false;if(active()&&readPending&&!failed&&!document.hidden)read();});
  };
  const publish=()=>{
   if(!active()||publishing||!publishPending||document.hidden)return;
   publishing=true;publishPending=false;const startedAt=readRevision;let failed=false;
   void fetch(url,{method:'POST',cache:'no-store',signal:abort.signal}).then(responseProfiles).then(value=>{
    publication++;
    // The publish response may have been delayed behind a newer peer read.
    // Its own profile is acknowledged, but it must not roll other Muses back.
    if(readRevision===startedAt)apply(value);
    else if(value[options.userId!])apply({...profiles.current,[options.userId!]:value[options.userId!]});
    read();
   })
    .catch(()=>{failed=true;if(active())publishPending=true;}).finally(()=>{publishing=false;if(active()&&publishPending&&!failed&&!document.hidden)publish();});
  };
  const refresh=(write=false)=>{publishPending ||= write;read();publish();};
  const room={scope,refresh};actions.current=room;profiles.current=EMPTY;setView({scope,profiles:EMPTY});refresh(true);
  const changed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(detail?.ownerId!==options.userId)return;if(event.type==='muse-name-saved'&&detail.name===profiles.current[options.userId!]?.museName)return;refresh(true);};
  const visible=()=>{if(!document.hidden)refresh();};
  window.addEventListener('muse-name-saved',changed);window.addEventListener('muse-appearance-saved',changed);document.addEventListener('visibilitychange',visible);
  const poll=setInterval(()=>refresh(),10000);
  return()=>{cancelled=true;abort.abort();clearInterval(poll);if(actions.current===room)actions.current=null;window.removeEventListener('muse-name-saved',changed);window.removeEventListener('muse-appearance-saved',changed);document.removeEventListener('visibilitychange',visible);};
 },[scope]);
 useEffect(()=>{if(actions.current?.scope===scope)actions.current.refresh();},[scope,members]);
 const previousConnection=useRef({scope:'',connected:false});
 useEffect(()=>{const previous=previousConnection.current;previousConnection.current={scope,connected:options.connected};if(previous.scope===scope&&!previous.connected&&options.connected)actions.current?.refresh(true);},[scope,options.connected]);
 const previousProfile=useRef({scope:'',version:options.profileVersion});
 useEffect(()=>{const previous=previousProfile.current;previousProfile.current={scope,version:options.profileVersion};if(previous.scope===scope&&previous.version!==options.profileVersion)actions.current?.refresh(true);},[scope,options.profileVersion]);
 return view.scope===scope&&scope?view.profiles:EMPTY;
}
