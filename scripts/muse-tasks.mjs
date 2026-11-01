import {readFile,writeFile,rename} from './muse-storage.mjs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensureMuse,museDirectory,validThread,withMuseOwner,MuseStoreError} from './muse-store.mjs';
import {digest} from './muse-local.mjs';
export function imageLinks(goal){return [...new Set((goal.match(/https:\/\/[^\s<>"']+/g)||[]).map(url=>url.replace(/[),.!?]+$/,'')))].filter(url=>/\.(png|jpe?g|webp)(?:[?#]|$)/i.test(url)).slice(0,3);}
const path=(owner,thread)=>join(museDirectory(owner),'task-'+digest(validThread(thread))+'.json');
export async function readTask(owner,thread){await ensureMuse(owner);try{return JSON.parse(await readFile(path(owner,thread),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(owner,thread,task){const file=path(owner,thread),temp=file+'.'+randomUUID();task.updatedAt=Date.now();await writeFile(temp,JSON.stringify(task),{mode:0o600,flag:'wx'});await rename(temp,file);return task;}
export async function createTask(owner,thread,goal,research){
 if(typeof goal!=='string'||!goal.trim()||goal.length>4000)throw new MuseStoreError(400,'Keep the task under 4,000 characters.');
 await ensureMuse(owner);return withMuseOwner(owner,async()=>{const previous=await readTask(owner,thread);if(previous&&!['done','cancelled'].includes(previous.status))throw new MuseStoreError(409,'Finish or cancel the saved task first.');return write(owner,thread,{id:randomUUID(),goal:goal.trim(),research:research===true,status:'paused',cursor:0,attempts:0,steps:[{name:'Plan',status:'pending'},...(research?[{name:'Research',status:'pending'}]:[]),{name:'Compose',status:'pending'},...(imageLinks(goal).length?[{name:'Images',status:'pending'}]:[])],sources:[],notes:[],actions:null});});
}
export async function changeTask(owner,thread,fn){return withMuseOwner(owner,async()=>{const task=await readTask(owner,thread);if(!task)throw new MuseStoreError(404,'No saved task.');await fn(task);return write(owner,thread,task);});}
