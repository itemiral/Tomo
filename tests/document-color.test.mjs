import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentColor} from '../src/components/muze/document-color.ts';
const luminance=hex=>hex.slice(1).match(/../g).map(n=>parseInt(n,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
test('document colors are stable for equivalent names, distinct for the starter files, and readable',()=>{
 assert.equal(documentColor(' Soul.md '),documentColor('soul.md'));
 assert.equal(documentColor('Cafe\u0301.md'),documentColor('Café.md'));
 assert.notEqual(documentColor('soul.md'),documentColor('memory.md'));
 const colors=new Set(Array.from({length:100},(_,i)=>documentColor('Page '+i)));
 for(const color of colors)for(const ink of ['#202124','#606975']) assert.ok((luminance(color)+.05)/(luminance(ink)+.05)>=4.5);
});
