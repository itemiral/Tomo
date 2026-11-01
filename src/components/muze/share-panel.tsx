'use client';
import {useState, type ReactNode} from 'react';
import {SignInButton} from '@clerk/nextjs';
import {Check, Copy, Link2, X} from 'lucide-react';
import {boardRequest, type SharedSnapshot} from './use-shared-board';
import type {Board} from './storage';

type Props={board:Board; signedIn:boolean; privateNotebook:boolean; role?:'owner'|'editor'; flush:()=>Promise<void>; publish:()=>Promise<SharedSnapshot>; close:()=>void; children:ReactNode};
export function SharePanel({board,signedIn,privateNotebook,role,flush,publish,close,children}:Props){
  const [link,setLink]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false),[disabled,setDisabled]=useState(false);
  async function create(){
    setBusy(true);setError('');setCopied(false);
    try{await flush();const shared=role?{board}:await publish();const {token}=await boardRequest<{token:string}>('/'+shared.board.id+'/invite',{method:'POST'});const url=new URL(location.origin+location.pathname);url.searchParams.set('board',shared.board.id);url.hash=new URLSearchParams({invite:token}).toString();setLink(url.toString());setDisabled(false);}
    catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  async function copy(){try{const url=new URL(location.origin+location.pathname);url.searchParams.set('board',board.id);await navigator.clipboard.writeText(link||url.toString());setCopied(true);}catch{setError('Copy the link from the field below.');}}
  async function disable(){setBusy(true);setError('');try{await boardRequest('/'+board.id+'/invite',{method:'DELETE'});setLink('');setDisabled(true);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  return <section className="muze-popover muze-share-panel" role="dialog" aria-label="Share board" data-muse-ui="true" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}event.stopPropagation();}}>
    <header><strong>Share board</strong><button aria-label="Close sharing" onClick={close}><X size={16}/></button></header>
    {privateNotebook?<p>Your Muse’s notebook is private. Open a whiteboard to invite people.</p>:!signedIn?<><p>Invite people to work on this board with you.</p><SignInButton mode="modal"><button className="muze-share-primary">Sign in to share</button></SignInButton></>:<>
      <p>{role==='editor'?'You can edit this board. Its owner manages invitations.':'People with an invite link can sign in and edit this board.'}</p>
      {role==='editor'?<button className="muze-share-primary" onClick={()=>void copy()}>{copied?<Check size={16}/>:<Copy size={16}/>}Copy board link</button>:<>
        {link?<><label>Invite link<input aria-label="Invite link" readOnly value={link} onFocus={event=>event.target.select()}/></label><button className="muze-share-primary" onClick={()=>void copy()}>{copied?<Check size={16}/>:<Copy size={16}/>}Copy invite link</button><small>Expires in 7 days. Each person’s Muse stays private.</small></>:<button className="muze-share-primary" disabled={busy} onClick={()=>void create()}><Link2 size={16}/>{busy?'Creating link…':'Create invite link'}</button>}
        {role==='owner'&&<div className="muze-share-links"><button disabled={busy} onClick={()=>void create()}>Reset invite link</button><button disabled={busy} onClick={()=>void disable()}>Disable invite link</button></div>}
        {disabled&&<small role="status">Invitations disabled. People who already joined keep access.</small>}
      </>}
      {copied&&<small role="status">Link copied</small>}
    </>}
    {error&&<p role="alert">{error}</p>}
    <div className="muze-menu-rule"/><p className="muze-menu-heading">Export</p>{children}
  </section>;
}
