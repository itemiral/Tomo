'use client';
import {MuseOrb} from '../muse/orb';
import '../muse/muse.css';
import {personColor,screenPoint,uniquePeople,type BoardPerson,type BoardCursor} from './presence-state';
import './presence.css';

export function BoardParticipants({peers,userId,connected}:{peers:BoardPerson[];userId?:string;connected:boolean}){
  const people=uniquePeople(peers).sort((a,b)=>a.userId===userId?-1:b.userId===userId?1:a.name.localeCompare(b.name));
  return <div className="board-participants" role="list" aria-label="People on this board" data-muse-ui="true">
    {!connected?<span className="board-connecting">Connecting…</span>:<>{people.slice(0,4).map(person=><span role="listitem" className="board-person" key={person.userId} title={person.userId===userId?'You':person.name}><i style={{background:personColor(person.userId)}}/>{person.userId===userId?'You':person.name}</span>)}{people.length>4&&<span title={people.slice(4).map(person=>person.name).join(', ')}>+{people.length-4}</span>}</>}
  </div>;
}
export function BoardPeerCursors({cursors,pageId,viewport}:{cursors:BoardCursor[];pageId:string;viewport:number[]}){
  const latest=new Map<string,BoardCursor>();for(const cursor of cursors)if(cursor.pageId===pageId&&(!latest.has(cursor.userId)||latest.get(cursor.userId)!.receivedAt<cursor.receivedAt))latest.set(cursor.userId,cursor);
  return <div className="board-peer-cursors" aria-label="Collaborator cursors">{[...latest.values()].map(cursor=>{
    const point=screenPoint(cursor.x,cursor.y,viewport);return <div key={cursor.userId} className="board-peer-cursor" aria-label={cursor.name+'’s cursor'} style={{transform:`translate(${point.x}px,${point.y}px)`,color:personColor(cursor.userId)}}><svg width="18" height="23" viewBox="0 0 18 23" aria-hidden="true"><path d="M2 2v16l4.8-4 3.5 7 3.3-1.7-3.5-6.8 6.2-.7Z" fill="currentColor" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/></svg><span>{cursor.name}</span></div>;
  })}</div>;
}
export function BoardPeerMuses({peers,userId,pageId}:{peers:BoardPerson[];userId?:string;pageId:string}){
  const people=uniquePeople(peers).filter(person=>person.userId!==userId&&person.pageId===pageId);
  return <div className="board-peer-muses" aria-label="Collaborators’ Muses">{people.slice(0,4).map(person=><div key={person.userId} className={'board-peer-muse'+(person.muse==='working'?' working':'')} aria-label={person.name+'’s Muse, '+person.muse}><div className="board-peer-muse-icon"><MuseOrb followCursor/></div><span>{person.name}’s Muse</span>{person.muse==='working'&&<small>Working</small>}</div>)}{people.length>4&&<span className="board-more-muses">+{people.length-4} Muses</span>}</div>;
}
