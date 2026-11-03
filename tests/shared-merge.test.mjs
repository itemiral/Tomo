import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeSharedBoard, sameScene, equalBoardValues, BoardConflict} from '../src/components/muze/shared-merge.ts';
const board = () => ({id:'board',name:'Board',activePage:'a',pages:[{id:'a',name:'Page',viewport:[1,0,0,1,0,0],objects:[{id:'one',text:'Hello',left:0},{id:'two',text:'World',left:50}]}],comments:[]});
test('independent edits, added notes, and comments survive concurrent saves',()=>{
 const base=board(),a=structuredClone(base),b=structuredClone(base);a.pages[0].objects[0].left=20;a.pages[0].objects.push({id:'new',text:'New'});b.pages[0].objects[1].text='Changed';b.comments.push({id:'comment',text:'Hi'});
 const next=mergeSharedBoard(base,a,b);assert.equal(next.pages[0].objects[0].left,20);assert.equal(next.pages[0].objects[1].text,'Changed');assert.equal(next.pages[0].objects.length,3);assert.equal(next.comments.length,1);
});
test('deletions stay deleted and do not remove another new note',()=>{const base=board(),a=structuredClone(base),b=structuredClone(base);a.pages[0].objects.pop();b.pages[0].objects.push({id:'new',text:'New'});assert.deepEqual(mergeSharedBoard(base,a,b).pages[0].objects.map(o=>o.id),['one','new']);});
test('editing a deleted note or the same text produces an explicit conflict',()=>{const base=board(),a=structuredClone(base),b=structuredClone(base);a.pages[0].objects[0].text='Mine';b.pages[0].objects[0].text='Theirs';assert.throws(()=>mergeSharedBoard(base,a,b),BoardConflict);b.pages[0].objects.shift();assert.throws(()=>mergeSharedBoard(base,a,b),BoardConflict);});
test('remote navigation cannot move a local viewport or trigger a save',()=>{const base=board(),a=structuredClone(base),b=structuredClone(base);a.pages[0].viewport=[2,0,0,2,40,80];b.pages[0].viewport=[.5,0,0,.5,900,900];assert.ok(sameScene(base,a));assert.deepEqual(mergeSharedBoard(base,a,b).pages[0].viewport,a.pages[0].viewport);});
test('different properties on the same note merge without losing its text or position',()=>{const base=board(),a=structuredClone(base),b=structuredClone(base);a.pages[0].objects[0].text='Edited';b.pages[0].objects[0].left=200;const merged=mergeSharedBoard(base,a,b);assert.equal(merged.pages[0].objects[0].text,'Edited');assert.equal(merged.pages[0].objects[0].left,200);});
test('concurrent page removals cannot leave a board without any pages',()=>{const base=board();base.pages.push({...structuredClone(base.pages[0]),id:'b'});const a=structuredClone(base),b=structuredClone(base);a.pages.shift();b.pages.pop();assert.throws(()=>mergeSharedBoard(base,a,b),BoardConflict);});
test('database key ordering does not create scene changes or conflicts',()=>{
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
 const base=board();base.pages[0].objects[0].styles={'0':{'0':{fontWeight:'bold',fill:'#123456',fontSize:24}}};
 const remote=JSON.parse(JSON.stringify(reorder(base)));
 assert.ok(sameScene(base,remote));assert.ok(equalBoardValues(base.pages[0].objects,remote.pages[0].objects));
 const local=structuredClone(base);local.pages[0].objects[0].text='My edit';
 assert.equal(mergeSharedBoard(base,local,remote).pages[0].objects[0].text,'My edit');
 assert.equal(equalBoardValues(base.pages[0].objects,[...remote.pages[0].objects].reverse()),false);
});

test('incompatible concurrent layer orders produce a conflict instead of dropping a peer reorder',()=>{
 const base=board();base.pages[0].objects.push({id:'three',text:'Third',left:100});
 const local=structuredClone(base),remote=structuredClone(base);
 local.pages[0].objects=[local.pages[0].objects[0],local.pages[0].objects[2],local.pages[0].objects[1]];
 remote.pages[0].objects=[remote.pages[0].objects[1],remote.pages[0].objects[0],remote.pages[0].objects[2]];
 assert.throws(()=>mergeSharedBoard(base,local,remote),BoardConflict);
 assert.throws(()=>mergeSharedBoard(base,remote,local),BoardConflict);
});

test('one peer reorder still merges another peer text edit or deletion',()=>{
 const base=board();base.pages[0].objects.push({id:'three',text:'Third',left:100});
 const local=structuredClone(base),remote=structuredClone(base);
 local.pages[0].objects.reverse();remote.pages[0].objects[1].text='Remote wording';
 const merged=mergeSharedBoard(base,local,remote);
 assert.deepEqual(merged.pages[0].objects.map(value=>value.id),['three','two','one']);
 assert.equal(merged.pages[0].objects[1].text,'Remote wording');
 remote.pages[0].objects.shift();
 assert.deepEqual(mergeSharedBoard(base,local,remote).pages[0].objects.map(value=>value.id),['three','two']);
});

test('drawing deltas preserve a peer insertion that the local canvas has not rendered yet',async()=>{
 const {mergeSharedDrawing}=await import('../src/components/muze/shared-merge.ts');
 const previous=board().pages[0],local=structuredClone(previous),remote=structuredClone(previous);
 local.objects[0].left=120;local.viewport=[2,0,0,2,80,40];remote.objects.push({id:'peer-note',text:'Keep this peer work'});
 const merged=mergeSharedDrawing(previous,local,remote);
 assert.equal(merged.objects[0].left,120);assert.equal(merged.objects.at(-1).id,'peer-note');assert.deepEqual(merged.viewport,local.viewport);
 assert.equal(remote.objects[0].left,0);assert.equal(previous.objects.length,2);
 remote.objects[0].text='Peer wording';local.objects[0].text='My wording';
 assert.throws(()=>mergeSharedDrawing(previous,local,remote),BoardConflict);
});

test('two first comments on a board without a comments array merge independently',()=>{
 const base=board();delete base.comments;
 const local={...structuredClone(base),comments:[{id:'mine',author:'One',text:'My first comment'}]};
 const remote={...structuredClone(base),comments:[{id:'peer',author:'Two',text:'Peer first comment'}]};
 const merged=mergeSharedBoard(base,local,remote);
 assert.deepEqual(new Set(merged.comments.map(value=>value.id)),new Set(['mine','peer']));
 assert.ok(sameScene(base,{...base,comments:[]}));
});
