import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID, randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseBoardFile} from '../src/components/muze/storage.ts';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;grant usage on schema auth to anon,authenticated;grant execute on function auth.jwt() to anon,authenticated;`);
for(const file of ['20261101191930_private_muse_storage.sql','20261101195930_shared_board_invitations.sql','20261101200407_board_conflict_responses.sql','20261103004650_validate_shared_board_scenes.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
after(()=>db.close());
const fixture=()=>({id:randomUUID(),name:'Collaboration fixture',activePage:'page',pages:[{id:'page',name:'Page 1',objects:[{id:'note',type:'MuzeNote',text:'Original content',left:10,top:20,width:280,height:160}],viewport:[1,0,0,1,0,0]}]});
const asUser=(id,operation,role='authenticated')=>db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role})]);return operation(tx);});
const action=async(user,operation,{id=null,scene=null,revision=null,token=null}={})=>(await asUser(user,tx=>tx.query('select public.write_shared_board($1,$2,$3,$4,$5) as result',[operation,id,scene&&JSON.stringify(scene),revision,token]))).rows[0].result;
const valid=async(scene)=>(await db.query('select muze_board_internal.valid_scene($1,$2) as valid',[JSON.stringify(scene),scene.id])).rows[0].valid;
const withObject=value=>{const scene=fixture();scene.pages[0].objects=[value];return scene;};

test('direct member RPC saves cannot poison the board and rejection preserves the prior revision',async()=>{
 const original=await action('owner','create',{scene:fixture()}),id=original.board.id,token=randomBytes(32).toString('base64url');
 await action('owner','invite',{id,token});await action('editor','join',{id,token});
 for(const pages of [[null],[{}],[{id:'page',name:'Bad',objects:[null],viewport:[1,0,0,1,0,0]}]]){
  await assert.rejects(action('editor','save',{id,scene:{...original.board,pages},revision:original.revision}),{code:'22023'});
  const saved=(await asUser('owner',tx=>tx.query('select scene,revision from public.shared_boards where id=$1',[id]))).rows[0];
  assert.deepEqual(saved.scene,original.board);assert.equal(saved.revision,original.revision);
 }
 const saved=await action('editor','save',{id,scene:{...original.board,name:'A valid edit'},revision:original.revision});
 assert.equal(saved.board.name,'A valid edit');assert.notEqual(saved.revision,original.revision);
});

test('SQL accepts normal geometry, text styles, groups, documents, media and comments',async()=>{
 const objects=[
  {id:'shape',type:'MuzeShape',geo:'rectangle',fill:'rgba(12,34,56,0.4)',stroke:'#123456',left:20,top:-50,width:200,height:180,scaleX:1,scaleY:1},
  {id:'styled',type:'Textbox',text:'Hello 😀',fontFamily:'IBM Plex Sans',fontSize:18,styles:[{start:0,end:5,style:{fill:'#123',fontSize:24,fontFamily:'Inter'}}]},
  {id:'legacy-styles',type:'Text',text:'Hello',styles:{0:{0:{fontSize:20,deltaY:-2,textBackgroundColor:'transparent'}}}},
  {id:'group',type:'Group',objects:[{type:'Rect',width:30,height:20},{id:'nested',type:'Ellipse',width:12,height:15}]},
  {id:'drawing',type:'Path',path:[['M',0,0],['l',15,16],['Q',12,14,30,40],['Z']],shadow:{color:'#00000044',blur:2}},
  {id:'line',type:'Polyline',points:[{x:0,y:2},{x:10,y:20}]},
  {id:'document',type:'MuzeDocument',documentTitle:'Plan.md',markdown:'# Outline\n\nA readable plan.',text:'Outline'},
  {id:'image',type:'Image',src:'data:image/png;base64,fixture',sourceUrl:'https://example.com:000443/source?q=abc',imageUrl:'https://example.com/photo.png',attribution:'A contributor',sourceTitle:'Reference'},
 ];
 for(const object of objects){const scene=withObject(object);parseBoardFile(JSON.stringify({format:'muze',version:1,board:scene}));assert.equal(await valid(scene),true,object.type);}
 const scene=fixture();scene.pages[0].objects=objects;scene.comments=[{id:'comment',pageId:'page',author:'Guest',text:'A useful comment 😀',x:10,y:20}];
 assert.equal(await valid(scene),true);
});

test('invalid page structure and duplicate merge identities are rejected at the database boundary',async()=>{
 const cases=[];
 for(const viewport of [null,[],[0,0,0,1,0,0],[9,0,0,1,0,0],[1,0,0,1,'not-number',0]]){const scene=fixture();scene.pages[0].viewport=viewport;cases.push(scene);}
 for(const id of ['',null,'x'.repeat(161)]){const scene=fixture();scene.pages[0].id=id;cases.push(scene);}
 const repeatPage=fixture();repeatPage.pages.push({...repeatPage.pages[0]});cases.push(repeatPage);
 const repeatNested=fixture();repeatNested.pages[0].objects.push({id:'group',type:'Group',objects:[{id:'note',type:'Rect'}]});cases.push(repeatNested);
 const repeatSiblings=fixture();repeatSiblings.pages[0].objects=[{id:'group',type:'Group',objects:[{id:'child',type:'Rect'},{id:'child',type:'Ellipse'}]}];cases.push(repeatSiblings);
 const missingId=fixture();delete missingId.pages[0].objects[0].id;cases.push(missingId);
 const repeatComment=fixture();repeatComment.comments=[{id:'same',text:'First',author:'One'},{id:'same',text:'Second',author:'Two'}];cases.push(repeatComment);
 for(const scene of cases)assert.equal(await valid(scene),false);
});

test('malformed or unsafe nested drawing properties cannot bypass API checks through the RPC',async()=>{
 const invalid=[
  null,{id:'bad',type:'UnknownShape'},{id:'bad',type:['Rect']},
  {id:'bad',type:'Rect',width:'200'},{id:'bad',type:'Rect',width:1000001},
  {id:'bad',type:'Text',text:null},{id:'bad',type:'MuzeDocument',markdown:{}},
  {id:'bad',type:'Text',fontFamily:'url(https://example.com)'},{id:'bad',type:'Rect',fill:'url(https://example.com)'},
  {id:'bad',type:'Image',src:'https://example.com/tracker.png'},
  {id:'bad',type:'Image',src:'data:image/svg+xml;base64,fixture'},
  {id:'bad',type:'Image',sourceUrl:'javascript:alert(1)'},{id:'bad',type:'Image',sourceUrl:'https://user:password@example.com/'},
  {id:'bad',type:'Image',sourceUrl:'https://example.com:99999/'},{id:'bad',type:'Image',sourceUrl:'https://[not-an-address]/'},
  {id:'bad',type:'Image',sourceUrl:'https://example.com:abc/'},{id:'bad',type:'Image',sourceUrl:'https://exam[ple.com/'},
  {id:'bad',type:'Path',path:[['Q',1,2]]},{id:'bad',type:'Path',path:[['L','1',2]]},
  {id:'bad',type:'Polyline',points:[{x:2}]},
  {id:'bad',type:'Textbox',styles:[{start:0,end:3,style:{fontSize:'large'}}]},
  {id:'bad',type:'Textbox',styles:{0:{0:'not-a-style'}}},
  {id:'bad',type:'Rect',clipPath:{type:'Rect'}},{id:'bad',type:'Image',filters:[{type:'Resize'}]},
  {id:'bad',type:'Rect',resizeFilter:{type:'Resize'}},{id:'bad',type:'Rect',shadow:{color:'url(x)'}},
  {id:'bad',type:'Group',objects:'not-an-array'},{id:'bad',type:'MuzeNote',muzeLeading:3},
 ];
 for(const object of invalid){const scene=withObject({id:'outer',type:'Group',objects:[object]});assert.equal(await valid(scene),false,JSON.stringify(object));}
 let deep={type:'Rect'};for(let depth=0;depth<14;depth++)deep={type:'Group',objects:[deep]};
 assert.equal(await valid(withObject({id:'root',...deep})),false);
});

test('text limits match browser UTF-16 units and private file cards remain excluded',async()=>{
 assert.equal(await valid(withObject({id:'text',type:'Textbox',text:'😀'.repeat(50000)})),true);
 assert.equal(await valid(withObject({id:'text',type:'Textbox',text:'😀'.repeat(50001)})),false);
 const scene=fixture();scene.comments=[{id:'comment',text:'😀'.repeat(2001),author:'One'}];assert.equal(await valid(scene),false);
 assert.equal(await valid(withObject({id:'group',type:'Group',objects:[{id:'muse-file-memory',type:'MuzeDocument',markdown:'Private'}]})),false);
});

test('internal validators are unavailable to public and authenticated callers and private data stays owner-scoped',async()=>{
 await assert.rejects(asUser('editor',tx=>tx.query("select muze_board_internal.valid_drawing_object('{\"type\":\"Rect\"}')")),{code:'42501'});
 await assert.rejects(asUser(null,tx=>tx.query("select muze_board_internal.text_units('hello')"),'anon'),{code:'42501'});
 await asUser('private-owner',tx=>tx.query("insert into public.muse_private_files(owner_id,name,content) values ('private-owner','soul.md','cHJpdmF0ZQ==')"));
 assert.equal((await asUser('editor',tx=>tx.query('select * from public.muse_private_files'))).rows.length,0);
});
