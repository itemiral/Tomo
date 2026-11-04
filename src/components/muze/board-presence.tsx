'use client';
import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {MuseAvatarImage} from '../muse/avatar-image';
import type {BoardProfile,BoardProfiles} from './board-profiles';
import '../muse/muse.css';
import {personColor,screenPoint,uniquePeople,type BoardPerson,type BoardCursor} from './presence-state';
import './presence.css';

function ParticipantAvatar({name,src}:{name:string;src?:string|null}){
 const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);
 return <span className="board-user-avatar" aria-hidden="true">{src&&!failed?<img src={src} alt="" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:name.split(/\s+/).map(part=>[...part][0]).slice(0,2).join('')}</span>;
}
function ParticipantMuse({profile}:{profile?:BoardProfile}){
 return <MuseAvatarImage src={profile?.museAvatarUrl||null} poses={profile?.musePoses||9} sheet={profile?.museSheet||false} follow/>;
}
export function BoardParticipants({peers,userId,connected,profiles={}}:{peers:BoardPerson[];userId?:string;connected:boolean;profiles?:BoardProfiles}){
  const people=uniquePeople(peers).sort((a,b)=>a.userId===userId?-1:b.userId===userId?1:a.name.localeCompare(b.name));
  return <div className="board-participants" role="list" aria-label="People on this board" data-muse-ui="true">
    {!connected?<span className="board-connecting">Connecting…</span>:<>{people.slice(0,4).map(person=>{const profile=profiles[person.userId],name=profile?.name||person.name;return <span role="listitem" className="board-person" key={person.userId} title={person.userId===userId?'You':name}><ParticipantAvatar name={name} src={profile?.avatarUrl}/>{person.userId===userId?'You':name}</span>;})}{people.length>4&&<span title={people.slice(4).map(person=>profiles[person.userId]?.name||person.name).join(', ')}>+{people.length-4}</span>}</>}
  </div>;
}
export function BoardPeerCursors({cursors,pageId,viewport,profiles={}}:{cursors:BoardCursor[];pageId:string;viewport:number[];profiles?:BoardProfiles}){
  const latest=new Map<string,BoardCursor>();for(const cursor of cursors)if(cursor.pageId===pageId&&(!latest.has(cursor.userId)||latest.get(cursor.userId)!.receivedAt<cursor.receivedAt))latest.set(cursor.userId,cursor);
  return <div className="board-peer-cursors" aria-label="Collaborator cursors">{[...latest.values()].map(cursor=>{
    const point=screenPoint(cursor.x,cursor.y,viewport),profile=profiles[cursor.userId],name=profile?.name||cursor.name;return <div key={cursor.userId} className="board-peer-cursor" aria-label={name+'’s cursor'} style={{transform:`translate(${point.x}px,${point.y}px)`,color:personColor(cursor.userId)}}><svg width="18" height="23" viewBox="0 0 18 23" aria-hidden="true"><path d="M2 2v16l4.8-4 3.5 7 3.3-1.7-3.5-6.8 6.2-.7Z" fill="currentColor" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/></svg><span className="board-cursor-label"><ParticipantAvatar name={name} src={profile?.avatarUrl}/>{name}</span></div>;
  })}</div>;
}
type WorkItem={id?:string;x:number;y:number;w:number;h:number};
type ScreenBox={x:number;y:number;w:number;h:number};
const intersects=(a:ScreenBox,b:ScreenBox)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
function itemBox(item:WorkItem,viewport:number[]):ScreenBox|null{
  if(![item.x,item.y,item.w,item.h,...viewport].every(Number.isFinite)||item.w<=0||item.h<=0)return null;
  const corners=[screenPoint(item.x,item.y,viewport),screenPoint(item.x+item.w,item.y,viewport),screenPoint(item.x,item.y+item.h,viewport),screenPoint(item.x+item.w,item.y+item.h,viewport)];
  const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y)),box={x,y,w:Math.max(...corners.map(p=>p.x))-x,h:Math.max(...corners.map(p=>p.y))-y};
  return [box.x,box.y,box.w,box.h].every(Number.isFinite)?box:null;
}
function workBox(person:BoardPerson,items:WorkItem[],viewport:number[]){
  if(person.muse!=='working'||!person.museTargetId||typeof window==='undefined')return null;
  const item=items.find(item=>item.id===person.museTargetId),box=item?itemBox(item,viewport):null;
  return box&&intersects(box,{x:0,y:0,w:innerWidth,h:innerHeight})?box:null;
}
export function BoardPeerMuses({peers,userId,pageId,profiles={},items=[],viewport=[1,0,0,1,0,0]}:{peers:BoardPerson[];userId?:string;pageId:string;profiles?:BoardProfiles;items?:WorkItem[];viewport?:number[]}){
  const people=uniquePeople(peers.filter(person=>person.userId!==userId&&person.pageId===pageId));
  const visible=people.slice(0,4).map(person=>({person,box:workBox(person,items,viewport)}));
  const roster=useRef<HTMLElement>(null),[bottom,setBottom]=useState(108);
  useEffect(()=>{
    if(!people.length)return;
    const place=()=>{
      const rect=roster.current?.getBoundingClientRect(),tools=document.querySelector('.muze-toolbar-dock')?.getBoundingClientRect(),chat=document.querySelector('.muse-chat-stack')?.getBoundingClientRect();
      let next=tools?innerHeight-tools.top+12:108;
      if(rect&&chat&&chat.width&&chat.height&&rect.left<chat.right+12&&rect.right>chat.left-12)next=Math.max(next,innerHeight-chat.top+12);
      setBottom(Math.round(next));
    };
    const observer=new ResizeObserver(place);
    for(const selector of ['.muze-toolbar-dock','.muse-chat-stack']){const element=document.querySelector(selector);if(element)observer.observe(element);}
    if(roster.current)observer.observe(roster.current);
    window.addEventListener('resize',place);place();
    return()=>{observer.disconnect();window.removeEventListener('resize',place);};
  },[people.length]);
  return <>
    <div className="board-muse-targets" aria-label="Muse activity">{visible.filter(entry=>entry.box).map(({person,box})=><div key={person.userId} data-target-id={person.museTargetId}><span className="board-muse-target-outline" aria-hidden="true" style={{left:box!.x-6,top:box!.y-6,width:box!.w+12,height:box!.h+12,color:personColor(person.userId)}}/></div>)}</div>
    {!!people.length&&<aside ref={roster} className="board-peer-muses" aria-label="Collaborators’ Muses" data-muse-ui="true" style={{'--peer-muses-bottom':bottom+'px'} as CSSProperties}>
      <header><span>Muses</span><small>{people.length} here</small></header>
      <div className="board-peer-muse-list">{visible.map(({person})=>{const profile=profiles[person.userId],name=profile?.name||person.name,museName=profile?.museName||'Muse';return <div key={person.userId} className={'board-peer-muse'+(person.muse==='working'?' working':'')} aria-label={name+'’s '+museName+', '+person.muse}>
        <div className="board-peer-muse-icon"><ParticipantMuse profile={profile}/><span className="board-peer-owner-avatar"><ParticipantAvatar name={name} src={profile?.avatarUrl}/></span></div>
        <div className="board-peer-muse-copy"><span title={museName}>{museName}</span><small title={name}>with {name}</small></div>
        <span className="board-peer-muse-state"><i aria-hidden="true"/>{person.muse==='working'?'Working':'Here'}</span>
      </div>;})}</div>
      {people.length>4&&<span className="board-more-muses">+{people.length-4} more</span>}
    </aside>}
  </>;
}
