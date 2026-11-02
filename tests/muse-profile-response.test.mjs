import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'muze-profile-response-'));
const require = createRequire(import.meta.url);
const modules = {
  'server-only': '',
  '@clerk/nextjs/server': `export const auth=async()=>({userId:globalThis.__displayProfile.owner});export const currentUser=async()=>{throw new Error('Unexpected account network lookup');};`,
  'next/server': 'export class NextResponse extends Response {}',
  '@/utils/supabase/shared': 'export const createAuthenticatedClient=()=>{throw new Error("Unexpected database client");};',
  '@/utils/supabase/session': 'export const serverSessionToken=()=>{};',
  'muse-storage.mjs': 'export class StorageError extends Error{};export const usesCloudStorage=()=>false;export const withMuseStorage=()=>{};export const withMuseProfileSnapshot=async run=>run();',
  'muse-store.mjs': `export class MuseStoreError extends Error{};
    export const ensureMuse=async owner=>{globalThis.__displayProfile.reads.push(owner);return {id:owner+'-muse',name:'Muse'};};
    export const readMuseIcon=async()=>({version:'current-icon'});
    export const readMuseNote=()=>{};export const saveMuseIcon=()=>{};export const saveMuseNote=()=>{};export const validNoteKey=key=>key;`,
  'muse-avatar.mjs': `export const readAvatar=async()=>({});export const avatarSummary=()=>({gazeVersion:'current-sheet'});`,
};
const compiled = await build({entryPoints:['src/app/api/muse/session/route.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'display-profile-fixture',setup(builder){
  builder.onResolve({filter:/.*/},args=>{
    const key=['muse-storage.mjs','muse-store.mjs','muse-avatar.mjs'].find(name=>args.path.endsWith('/'+name))||args.path;
    if(Object.hasOwn(modules,key))return {path:key,namespace:'fixture'};
    if(args.path==='sharp')return {path:require.resolve('sharp'),external:true};
  });
  builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'ts',resolveDir:resolve('.')}));
}}]});
await writeFile(join(directory,'route.cjs'),compiled.outputFiles[0].text);
const {GET}=require(join(directory,'route.cjs'));
after(async()=>{delete globalThis.__displayProfile;await rm(directory,{recursive:true,force:true});});
const request=()=>({url:'https://workspace.example/api/muse/session',headers:new Headers({host:'workspace.example'})});

test('display profile uses verified owner without a second account network request',async()=>{
  globalThis.__displayProfile={owner:'owner-a',reads:[]};
  const result=await GET(request());
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{ownerId:'owner-a',ownerName:'You',muse:{id:'owner-a-muse',name:'Muse',iconVersion:'current-icon',gazeVersion:'current-sheet'}});
  assert.deepEqual(globalThis.__displayProfile.reads,['owner-a']);
  assert.match(result.headers.get('cache-control'),/private.*no-store/);
});

test('unsigned requests never read a Muse and owner switches read the new owner only',async()=>{
  globalThis.__displayProfile={owner:null,reads:[]};
  assert.equal((await GET(request())).status,401);
  assert.deepEqual(globalThis.__displayProfile.reads,[]);
  globalThis.__displayProfile.owner='owner-b';
  assert.equal((await (await GET(request())).json()).ownerId,'owner-b');
  assert.deepEqual(globalThis.__displayProfile.reads,['owner-b']);
});
