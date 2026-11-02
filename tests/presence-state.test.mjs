import {test} from 'node:test';
import assert from 'node:assert/strict';
import {presenceName,readPerson,readCursor,readRoom,uniquePeople,worldPoint,screenPoint} from '../src/components/muze/presence-state.ts';
const person={userId:'user_one',name:'Izat',tabId:'tab_one',pageId:'page_one',muse:'idle'};
test('presence accepts only a bounded public description and drops private fields',()=>{
 const parsed=readPerson({...person,soul:'Private',memory:'Private',chat:['Private'],email:'private@example.test'});
 assert.deepEqual(parsed,person);assert.equal(readPerson({...person,muse:'Private thought'}),null);assert.equal(presenceName('x'.repeat(100)).length,40);assert.equal(presenceName('\u202eAda\u0000'),'Ada');
});
test('Muse targets contain only a bounded shared object ID while work is active',()=>{
 const working={...person,muse:'working',museTargetId:'muse-turn-0'};
 assert.deepEqual(readPerson({...working,request:'Private prompt',reasoning:'Private notes'}),working);
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
test('world coordinates stay accurate across different browsers pan and zoom',()=>{
 const point=worldPoint(500,350,[2,0,0,2,100,50]);assert.deepEqual(point,{x:200,y:150});
 assert.deepEqual(screenPoint(point.x,point.y,[.5,0,0,.5,80,40]),{x:180,y:115});
 assert.equal(worldPoint(0,0,[0,0,0,0,0,0]),null);
});
