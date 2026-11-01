const attempts=new WeakMap<object,number[]>();
export function reservePresenceUpdate(client:object,now=Date.now()):number{
 const recent=(attempts.get(client)||[]).filter(time=>time>now-32000);
 const wait=Math.max(0,(recent.at(-1)??now-2000)+2000-now,recent.length>=4?recent[0]+32001-now:0);
 if(!wait)recent.push(now);
 attempts.set(client,recent);return wait;
}
