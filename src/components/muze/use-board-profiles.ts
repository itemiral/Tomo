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
  let cancelled=false,busy=false,publishPending=false,readPending=false;const abort=new AbortController();
  const active=()=>!cancelled&&current.current.scope===scope;
  const refresh=(publish=false)=>{
   publishPending ||= publish;
   readPending ||= !publish;
   if(!active()||busy||document.hidden)return;
   busy=true;let failed=false;const write=publishPending;publishPending=false;readPending=false;
   void fetch('/api/boards/'+encodeURIComponent(options.boardId!)+'/participants',{method:write?'POST':'GET',cache:'no-store',signal:abort.signal}).then(async response=>{
    if(!response.ok){if(response.status===401||response.status===403||response.status===404){if(active()){profiles.current=EMPTY;setView({scope,profiles:EMPTY});}return;}throw new Error('Could not read board participants.');}
    const value=readBoardProfiles(await response.json(),options.boardId!);if(active()){profiles.current=value;setView({scope,profiles:value});}
   }).catch(()=>{failed=true;if(active()&&write)publishPending=true;}).finally(()=>{busy=false;if(active()&&(publishPending||readPending)&&!failed&&!document.hidden)refresh();});
  };
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
