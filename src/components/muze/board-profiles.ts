import {presenceName} from './presence-state';
export type BoardProfile={userId:string;name:string;avatarUrl:string|null;museName:string;museAvatarUrl:string|null;museAvatarVersion:string|null;musePoses:9|15;museSheet:boolean};
export type BoardProfiles=Record<string,BoardProfile>;
function userAvatar(value:unknown){if(typeof value!=='string'||value.length>2048)return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['img.clerk.com','images.clerk.dev'].includes(url.hostname)?url.href:null;}catch{return null;}}
function museAvatar(value:unknown,boardId:string,userId:string){
 if(typeof value!=='string'||value.length>2000||!value.startsWith('/'))return null;
 try{const url=new URL(value,'https://muze.invalid');return url.origin==='https://muze.invalid'&&['/muse/default-gaze-15.png','/api/boards/'+encodeURIComponent(boardId)+'/participants/'+encodeURIComponent(userId)+'/avatar'].includes(url.pathname)?url.pathname+url.search:null;}catch{return null;}
}
export function readBoardProfiles(value:unknown,boardId:string):BoardProfiles{
 const result:BoardProfiles=Object.create(null);
 if(!value||typeof value!=='object'||!Array.isArray((value as {participants?:unknown}).participants))return result;
 for(const item of (value as {participants:unknown[]}).participants.slice(0,200)){
  if(!item||typeof item!=='object')continue;const row=item as Record<string,unknown>;
  if(typeof row.userId!=='string'||!/^[-\w]{1,128}$/.test(row.userId))continue;
  result[row.userId]={userId:row.userId,name:presenceName(row.name),avatarUrl:userAvatar(row.avatarUrl),museName:presenceName(row.museName||'Muse'),museAvatarUrl:museAvatar(row.museAvatarUrl,boardId,row.userId),museAvatarVersion:typeof row.museAvatarVersion==='string'?row.museAvatarVersion.slice(0,160):null,musePoses:row.musePoses===15?15:9,museSheet:row.museSheet===true};
 }
 return result;
}
