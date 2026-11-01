import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reservePresenceUpdate} from '../src/components/muze/presence-schedule.ts';
test('presence budget survives room restarts and never exceeds four attempts in thirty-two seconds',()=>{
 const client={},sent=[];let now=100_000;
 for(let index=0;index<20;index++){
  let wait=reservePresenceUpdate(client,now);
  while(wait){now+=wait;wait=reservePresenceUpdate(client,now);}
  sent.push(now);now+=10;
 }
 for(const time of sent)assert.ok(sent.filter(value=>value>time-32000&&value<=time).length<=4);
 assert.equal(reservePresenceUpdate({},now),0);
});
