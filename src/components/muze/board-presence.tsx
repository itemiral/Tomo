'use client';
import {useEffect,useState} from 'react';
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
export function BoardPeerMuses({peers,userId,pageId,profiles={}}:{peers:BoardPerson[];userId?:string;pageId:string;profiles?:BoardProfiles}){
  const people=uniquePeople(peers).filter(person=>person.userId!==userId&&person.pageId===pageId);
  return <div className="board-peer-muses" aria-label="Collaborators’ Muses">{people.slice(0,4).map(person=>{const profile=profiles[person.userId],name=profile?.name||person.name,museName=profile?.museName||'Muse';return <div key={person.userId} className={'board-peer-muse'+(person.muse==='working'?' working':'')} aria-label={name+'’s '+museName+', '+person.muse}><div className="board-peer-muse-icon"><ParticipantMuse profile={profile}/></div><span title={name+'’s '+museName}>{museName==='Muse'?name+'’s Muse':museName}</span>{museName!=='Muse'&&<small>{name}’s Muse</small>}{person.muse==='working'&&<small>Working</small>}</div>;})}{people.length>4&&<span className="board-more-muses">+{people.length-4} Muses</span>}</div>;
}
