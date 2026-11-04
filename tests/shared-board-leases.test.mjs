import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {removesProtectedObjects,restoreProtectedObjects} from '../src/lib/shared-board-leases.ts';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth to anon,authenticated;grant execute on function auth.jwt() to anon,authenticated;`);
for(const file of ['20261101191930_private_muse_storage.sql','20261101195930_shared_board_invitations.sql','20261101200407_board_conflict_responses.sql','20261103004650_validate_shared_board_scenes.sql','20261104035328_protect_active_muse_notes.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
after(()=>db.close());
const scene=()=>({id:randomUUID(),name:'Lease fixture',activePage:'page',pages:[{id:'page',name:'Page 1',objects:[{id:'one',type:'MuzeNote',text:'Original',left:10,top:10,width:200,height:100},{id:'other',type:'MuzeNote',text:'Other'}],viewport:[1,0,0,1,0,0]},{id:'second',name:'Page 2',objects:[{id:'group',type:'Group',objects:[{id:'nested',type:'Rect',width:20,height:20}]}],viewport:[1,0,0,1,0,0]}]});
const asUser=(user,run,role='authenticated')=>db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user})]);return run(tx);});
const write=async(user,operation,{id=null,board=null,revision=null,token=null}={})=>(await asUser(user,tx=>tx.query('select public.write_shared_board($1,$2,$3,$4,$5) value',[operation,id,board&&JSON.stringify(board),revision,token]))).rows[0].value;
const lease=async(user,operation,id,requestId=null,objects=[])=>(await asUser(user,tx=>tx.query('select public.shared_board_lease($1,$2,$3,$4) value',[operation,id,requestId,JSON.stringify(objects)]))).rows[0].value;
async function fixture(){const saved=await write('owner','create',{board:scene()}),id=saved.board.id,token=randomBytes(32).toString('base64url');await write('owner','invite',{id,token});await write('peer','join',{id,token});return saved;}
const protectedRefs=[{pageId:'page',objectId:'one'}];

test('two members can work independently but neither can delete a note used by an active prompt',async()=>{
 let saved=await fixture();const id=saved.board.id,request=randomUUID();await lease('owner','acquire',id,request,protectedRefs);
 for(const user of ['owner','peer']){const board=structuredClone(saved.board);board.pages[0].objects.shift();await assert.rejects(write(user,'save',{id,board,revision:saved.revision}),{code:'PT423'});}
 let board=structuredClone(saved.board);board.pages[0].objects[1].text='Peer edits another note';saved=await write('peer','save',{id,board,revision:saved.revision});
 board=structuredClone(saved.board);board.pages[0].objects[0].text='Human edits still win';saved=await write('owner','save',{id,board,revision:saved.revision});
 const listed=await lease('peer','list',id);assert.deepEqual(Object.keys(listed[0]).sort(),['expiresAt','objectId','pageId']);assert.equal(listed[0].objectId,'one');
 await lease('owner','release',id,request);board=structuredClone(saved.board);board.pages[0].objects.shift();saved=await write('peer','save',{id,board,revision:saved.revision});assert.equal(saved.board.pages[0].objects[0].text,'Peer edits another note');
});

test('nested-object, page-removal and whole-board deletion cannot bypass active protection',async()=>{
 const saved=await fixture(),id=saved.board.id;await lease('owner','acquire',id,randomUUID(),[{pageId:'second',objectId:'nested'}]);
 for(const kind of ['nested','page','clear']){const board=structuredClone(saved.board);if(kind==='nested')board.pages[1].objects=[];if(kind==='page')board.pages.pop();if(kind==='clear')board.pages.forEach(page=>page.objects=[]);await assert.rejects(write('peer','save',{id,board,revision:saved.revision}),{code:'PT423'});}
 await assert.rejects(db.query('delete from public.shared_boards where id=$1',[id]),{code:'PT423'});
});

test('concurrent requests hold independent leases and one user cannot release another’s protection',async()=>{
 const saved=await fixture(),id=saved.board.id,a=randomUUID(),b=randomUUID();await lease('owner','acquire',id,a,protectedRefs);await lease('peer','acquire',id,b,protectedRefs);
 await assert.rejects(lease('peer','release',id,a),{code:'42501'});await assert.rejects(lease('outsider','list',id),{code:'42501'});
 await lease('owner','release',id,a);assert.equal((await lease('owner','list',id)).length,1);await lease('peer','renew',id,b);await lease('peer','release',id,b);assert.deepEqual(await lease('owner','list',id),[]);
});

test('acquisition rejects already-deleted notes atomically and never creates phantom locks',async()=>{
 const saved=await fixture(),id=saved.board.id;await assert.rejects(lease('peer','acquire',id,randomUUID(),[{pageId:'page',objectId:'missing'}]),{code:'PT409'});assert.deepEqual(await lease('owner','list',id),[]);
});

test('expired or crashed requests release protection and cannot be renewed after their deadline',async()=>{
 const saved=await fixture(),id=saved.board.id,request=randomUUID();await lease('owner','acquire',id,request,protectedRefs);
 await db.query("update muze_board_internal.muse_object_leases set expires_at=clock_timestamp()-interval '1 second' where board_id=$1",[id]);
 await assert.rejects(lease('owner','renew',id,request),{code:'PT409'});
 const board=structuredClone(saved.board);board.pages[0].objects.shift();await write('peer','save',{id,board,revision:saved.revision});assert.deepEqual(await lease('owner','list',id),[]);
});

test('leases are inaccessible as raw table rows and anonymous callers cannot use the RPC',async()=>{
 const saved=await fixture();await assert.rejects(asUser('owner',tx=>tx.query('select * from muze_board_internal.muse_object_leases')),{code:'42501'});
 await assert.rejects(asUser('',tx=>tx.query("select public.shared_board_lease('list',$1)",[saved.board.id]),'anon'),{code:'42501'});
});

test('rejected deletion recovery restores protected nested notes and pages while preserving unrelated edits',()=>{
 const original=scene(),draft=structuredClone(original);draft.pages[0].objects.shift();draft.pages[0].objects[0].text='My unrelated edit';draft.pages[1].objects[0].objects=[];
 const protectedObjects=[{pageId:'page',objectId:'one',expiresAt:new Date(Date.now()+60000).toISOString()},{pageId:'second',objectId:'nested',expiresAt:new Date(Date.now()+60000).toISOString()}];
 assert.equal(removesProtectedObjects(original,draft,protectedObjects),true);
 const restored=restoreProtectedObjects(draft,original,protectedObjects);assert.equal(removesProtectedObjects(original,restored,protectedObjects),false);assert.equal(restored.pages[0].objects[0].text,'My unrelated edit');assert.equal(restored.pages[1].objects[0].objects[0].id,'nested');
 draft.pages.pop();assert.equal(restoreProtectedObjects(draft,original,protectedObjects).pages.length,2);
 assert.equal(removesProtectedObjects(original,draft,protectedObjects,Date.now()+120000),false);
});

test('generated-image usage records remain private to their owner',async()=>{
 await asUser('owner',tx=>tx.query("insert into public.muse_private_files(owner_id,name,content) values($1,'image-usage.json',$2)",['owner',JSON.stringify({day:'2026-11-03',count:1})]));
 assert.equal((await asUser('owner',tx=>tx.query("select content from public.muse_private_files where name='image-usage.json'"))).rows.length,1);
 assert.equal((await asUser('peer',tx=>tx.query("select content from public.muse_private_files where name='image-usage.json'"))).rows.length,0);
 await assert.rejects(asUser('peer',tx=>tx.query("insert into public.muse_private_files(owner_id,name,content) values('owner','image-usage.json','{}')")),{code:'42501'});
});

test('recovering a protected group does not duplicate its ungrouped descendants or lose their edits',async()=>{
 const original=scene();original.pages[0].objects=[{id:'protected-group',type:'Group',left:100,top:100,objects:[{id:'child',type:'MuzeNote',text:'Original child',left:20,top:30,width:200,height:100}]},{id:'unrelated',type:'MuzeNote',text:'Other'}];
 const draft=structuredClone(original);draft.pages[0].objects=[{...original.pages[0].objects[0].objects[0],left:120,top:130,text:'A newer child edit',fill:'#123456'},{...original.pages[0].objects[1],text:'My unrelated edit'}];
 const restored=restoreProtectedObjects(draft,original,[{pageId:'page',objectId:'protected-group',expiresAt:new Date(Date.now()+60000).toISOString()}]);
 assert.equal(restored.pages[0].objects.length,2);const group=restored.pages[0].objects.find(item=>item.id==='protected-group');assert.equal(group.objects[0].text,'A newer child edit');assert.equal(group.objects[0].fill,'#123456');assert.equal(group.objects[0].left,20);assert.equal(group.objects[0].top,30);assert.equal(restored.pages[0].objects.find(item=>item.id==='unrelated').text,'My unrelated edit');
 const valid=await db.query('select muze_board_internal.valid_scene($1,$2) valid',[JSON.stringify(restored),restored.id]);assert.equal(valid.rows[0].valid,true);
});
