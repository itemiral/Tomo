/** Keep the completed turn protected until its canvas edits have been saved. */
export function museRequestLease(boardId: string, requestId: string, signal: AbortSignal) {
  const path = '/api/boards/' + encodeURIComponent(boardId) + '/leases';
  const body = JSON.stringify({requestId});
  let stopped = false;
  const request = (method: string) => fetch(path, {method, body, signal: AbortSignal.timeout(8000), cache: 'no-store', credentials: 'same-origin', keepalive: method === 'DELETE', headers: {'Content-Type':'application/json'}}).catch(()=>null);
  const timer = setInterval(()=>{if(!stopped)void request('POST');},15_000);
  const release = async () => {
    if (stopped) return; stopped=true; clearInterval(timer); signal.removeEventListener('abort',abort);
    await request('DELETE');
  };
  const abort = () => {void release();};
  signal.addEventListener('abort',abort,{once:true});
  return {release};
}
