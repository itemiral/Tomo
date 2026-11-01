export type BoardPerson = {userId:string;name:string;tabId:string;pageId:string;muse:'idle'|'working'};
export type CursorPosition = {tabId:string;pageId:string;x:number|null;y:number|null};
export type BoardCursor = BoardPerson & {x:number;y:number;receivedAt:number};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown,max=128):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[\w-]+$/.test(value);
export function presenceName(value:unknown){return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,40)||'Guest':'Guest';}
export function readPerson(value:unknown):BoardPerson|null{
  if(!record(value)||!id(value.userId)||!id(value.tabId)||!id(value.pageId)||!['idle','working'].includes(String(value.muse)))return null;
  return {userId:value.userId,name:presenceName(value.name),tabId:value.tabId,pageId:value.pageId,muse:value.muse as BoardPerson['muse']};
}
export function readCursor(value:unknown):CursorPosition|null{
  if(!record(value)||!id(value.tabId)||!id(value.pageId))return null;
  if(value.x===null&&value.y===null)return {tabId:value.tabId,pageId:value.pageId,x:null,y:null};
  if(typeof value.x!=='number'||typeof value.y!=='number'||!Number.isFinite(value.x)||!Number.isFinite(value.y)||Math.abs(value.x)>1_000_000||Math.abs(value.y)>1_000_000)return null;
  return {tabId:value.tabId,pageId:value.pageId,x:value.x,y:value.y};
}
export function readRoom(state:unknown):BoardPerson[]{
  if(!record(state))return [];
  const people=new Map<string,BoardPerson>();
  for(const [key,rows] of Object.entries(state).slice(0,200))if(Array.isArray(rows))for(const row of rows.slice(0,10)){
    const person=readPerson(row);if(person&&key===person.tabId)people.set(person.tabId,person);
  }
  return [...people.values()];
}
export function uniquePeople(people:BoardPerson[]):BoardPerson[]{
  const result=new Map<string,BoardPerson>();
  for(const person of people){const previous=result.get(person.userId);if(!previous||person.muse==='working')result.set(person.userId,person);}
  return [...result.values()];
}
export function personColor(userId:string){const palette=['#4376cc','#be5b8a','#7f62bf','#32896f','#af731f','#397f99'];let hash=0;for(const character of userId)hash=(hash*31+character.charCodeAt(0))>>>0;return palette[hash%palette.length];}
export function worldPoint(x:number,y:number,viewport:number[]){
  const [a,b,c,d,tx,ty]=viewport,det=a*d-b*c;
  if(![x,y,a,b,c,d,tx,ty,det].every(Number.isFinite)||Math.abs(det)<.00001)return null;
  const point={x:(d*(x-tx)-c*(y-ty))/det,y:(a*(y-ty)-b*(x-tx))/det};
  return Math.abs(point.x)<=1_000_000&&Math.abs(point.y)<=1_000_000?point:null;
}
export function screenPoint(x:number,y:number,viewport:number[]){return {x:x*viewport[0]+y*viewport[2]+viewport[4],y:x*viewport[1]+y*viewport[3]+viewport[5]};}
