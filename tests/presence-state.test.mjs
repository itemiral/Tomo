import {test} from 'node:test';
import assert from 'node:assert/strict';
import {presenceName,readPerson,readActivity,readCursor,readRoom,updateCursor,uniquePeople,worldPoint,screenPoint} from '../src/components/muze/presence-state.ts';
const person={userId:'user_one',name:'Izat',tabId:'tab_one',pageId:'page_one',muse:'idle'};
test('presence accepts only a bounded public description and drops private fields',()=>{
 const parsed=readPerson({...person,soul:'Private',memory:'Private',chat:['Private'],email:'private@example.test'});
 assert.deepEqual(parsed,person);assert.equal(readPerson({...person,muse:'Private thought'}),null);assert.equal(presenceName('x'.repeat(100)).length,40);assert.equal(presenceName('\u202eAda\u0000'),'Ada');
});
test('Muse targets contain only a bounded shared object ID while work is active',()=>{
 const working={...person,muse:'working',museTargetId:'muse-turn-0'};
 assert.deepEqual(readPerson({...working,request:'Private prompt',reasoning:'Private notes'}),working);
 assert.deepEqual(readPerson({...working,activityRevision:2}),{...working,activityRevision:2});
 assert.equal(readPerson({...working,activityRevision:Infinity}).activityRevision,undefined);
 assert.deepEqual(readPerson({...person,museTargetId:'muse-turn-0'}),person);
 for(const value of ['', 'x'.repeat(101), {text:'Private'}, 'a\nb', '<script>', '../../soul.md'])assert.equal(readPerson({...working,museTargetId:value}).museTargetId,undefined);
});
test('presence keys must match each tab and multiple tabs count as one person',()=>{
 const result=readRoom({tab_one:[person],tab_two:[{...person,tabId:'tab_two',muse:'working'}],wrong:[person]});
 assert.equal(result.length,2);assert.equal(uniquePeople(result).length,1);assert.equal(uniquePeople(result)[0].muse,'working');
});
test('cursors reject invalid coordinates and carry no personal context',()=>{
 assert.equal(readCursor({...person,x:Infinity,y:20}),null);assert.equal(readCursor({...person,x:1_000_001,y:20}),null);
 assert.deepEqual(readCursor({...person,x:12,y:20,soul:'hidden'}),{tabId:'tab_one',pageId:'page_one',x:12,y:20});
 assert.deepEqual(readCursor({...person,x:null,y:null}),{tabId:'tab_one',pageId:'page_one',x:null,y:null});
});
test('stationary cursor replays do not outrank movement in another tab',()=>{
 const position={tabId:person.tabId,pageId:person.pageId,x:12,y:20};
 const first=updateCursor(person,position,undefined,100);
 const otherPerson={...person,tabId:'tab_two'},other=updateCursor(otherPerson,{...position,tabId:'tab_two',x:80},undefined,200);
 const replay=updateCursor({...person,name:'Izat T.'},position,first,300);
 assert.equal(replay.receivedAt,100);assert.equal(replay.name,'Izat T.');assert.ok(other.receivedAt>replay.receivedAt);
 const moved=updateCursor(person,{...position,x:14},replay,400);
 assert.equal(moved.receivedAt,400);assert.ok(moved.receivedAt>other.receivedAt);
 const returned=updateCursor(person,position,moved,500);
 assert.equal(returned.receivedAt,500);
 assert.equal(updateCursor(person,{...position,x:null,y:null},returned,600),null);
});
test('cursor recency resets for a different page, tab or owner',()=>{
 const position={tabId:person.tabId,pageId:person.pageId,x:12,y:20},previous=updateCursor(person,position,undefined,100);
 for(const changes of [{pageId:'page_two'},{tabId:'tab_two'},{userId:'user_two'}]){
  assert.equal(updateCursor({...person,...changes},{...position,...changes},previous,200).receivedAt,200);
 }
});
test('world coordinates stay accurate across different browsers pan and zoom',()=>{
 const point=worldPoint(500,350,[2,0,0,2,100,50]);assert.deepEqual(point,{x:200,y:150});
 assert.deepEqual(screenPoint(point.x,point.y,[.5,0,0,.5,80,40]),{x:180,y:115});
 assert.equal(worldPoint(0,0,[0,0,0,0,0,0]),null);
});


test('activity accepts only bounded public work metadata and a monotonic revision',()=>{
 const value={tabId:'tab_one',pageId:'page_two',muse:'working',museTargetId:'note-one',revision:2};
 assert.deepEqual(readActivity({...value,name:'Another owner',userId:'forged-owner',memory:'PRIVATE'}),value);
 assert.deepEqual(readActivity({...value,muse:'idle'}),{tabId:'tab_one',pageId:'page_two',muse:'idle',revision:2});
 for(const revision of [0,-1,1.5,Infinity,'2',Number.MAX_SAFE_INTEGER+1])assert.equal(readActivity({...value,revision}),null);
 assert.equal(readActivity({...value,pageId:'../../private'}),null);
});
