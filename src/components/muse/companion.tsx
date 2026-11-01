'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { UserButton, useClerk, useUser } from '@clerk/nextjs';
import { ArrowLeft, BookOpen, Check, Cloud, FileText, Heart, LockKeyhole, Maximize2, Pencil, RefreshCw, SquarePen, X } from 'lucide-react';
import { MuseIcon, MuseMarkdown, museRequest as request, RequestError, type MuseProfile } from './shared';
import { MuseChat } from './chat';
import { FloatingMuse, type Obstacle, type MuseActivity } from './floating';
import type { MuseActions, MuseApplyResult } from '@/lib/muse-board';
import './muse.css';

type NoteKey = 'soul' | 'memory';
type Note = { key: NoteKey; content: string; revision: string; updatedAt: number };
type Draft = { content: string; revision: string };
type Activity = MuseActivity;
type Props = { open: boolean; onOpenChange: (open: boolean) => void; obstacles: Obstacle[]; thread: string; boardContext: string; addToBoard: (text: string) => void; applyActions: (actions: MuseActions) => MuseApplyResult };
const noteNames = { soul: 'Soul.md', memory: 'Memory.md' };

function NoteCard({ noteKey, value, draft, error, expanded, saving, onExpand, onEdit, onChange, onSave, onCancel }: { noteKey: NoteKey; value?: Note; draft?: Draft; error?: string; expanded: boolean; saving: boolean; onExpand: () => void; onEdit: () => void; onChange: (content: string) => void; onSave: () => void; onCancel: () => void }) {
  const Icon = noteKey === 'soul' ? Heart : BookOpen;
  return <article className={'muse-note muse-note-' + noteKey + (expanded ? ' expanded' : '')} aria-label={noteNames[noteKey]}>
    <header className="muse-note-header"><span className="muse-note-symbol"><Icon size={19} strokeWidth={1.5}/></span><div><h2>{noteNames[noteKey]}</h2><span>{noteKey === 'soul' ? 'Personality & working style' : 'Preferences & context'}</span></div><button className="muse-icon-button" aria-label={(expanded ? 'Close ' : 'Expand ') + noteNames[noteKey]} title={expanded ? 'Show both notes' : 'Open a larger reading view'} onClick={onExpand}>{expanded ? <X size={17}/> : <Maximize2 size={16}/>}</button></header>
    {draft ? <textarea className="muse-note-editor" aria-label={'Edit ' + noteNames[noteKey]} autoFocus value={draft.content} disabled={saving} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!saving) onCancel(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!saving) onSave(); } }}/> : <div className="muse-note-content" tabIndex={0} aria-label={noteNames[noteKey] + ' content'}>{!value ? <p className="muse-note-loading">Opening note…</p> : value.content.trim() ? <MuseMarkdown text={value.content}/> : <p className="muse-note-loading">Add a few things you want Muse to know.</p>}</div>}
    {error && <p className="muse-note-error" role="alert">{error}</p>}
    <footer className="muse-note-footer"><span><LockKeyhole size={11}/>Only you</span>{draft ? <><button className="muse-note-cancel" aria-label={'Cancel editing ' + noteNames[noteKey]} disabled={saving} onClick={onCancel}>Cancel</button><button className="muse-note-save" aria-label={'Save ' + noteNames[noteKey]} disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button></> : <><time dateTime={value ? new Date(value.updatedAt).toISOString() : undefined}>{value && new Date(value.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><button className="muse-note-edit" aria-label={'Edit ' + noteNames[noteKey]} disabled={!value} onClick={onEdit}><Pencil size={12}/>Edit</button></>}</footer>
  </article>;
}

export function MuseCompanion(props: Props) {
  const { isLoaded, isSignedIn, user } = useUser();
  const clerk = useClerk();
  useEffect(() => { props.onOpenChange(false); }, [user?.id, props.onOpenChange]);
  if (!isSignedIn || !user) return <div data-muse-ui="true" className="muse-interface"><FloatingMuse obstacles={props.obstacles} activity={{ label: '' }} open={() => { if (isLoaded) clerk.openSignIn(); }}/></div>;
  return <OwnedMuse key={user.id} {...props} userId={user.id}/>;
}

function OwnedMuse({ open, onOpenChange, obstacles, thread, boardContext, addToBoard, applyActions, userId }: Props & { userId: string }) {
  const [profile, setProfile] = useState<MuseProfile | null>(null), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [notes, setNotes] = useState<Partial<Record<NoteKey, Note>>>({}), [drafts, setDrafts] = useState<Partial<Record<NoteKey, Draft>>>({}), [noteErrors, setNoteErrors] = useState<Partial<Record<NoteKey, string>>>({});
  const [expanded, setExpanded] = useState<NoteKey | null>(null), [saving, setSaving] = useState<NoteKey | null>(null), [refreshing, setRefreshing] = useState(false), [iconBusy, setIconBusy] = useState(false), [chatOpen, setChatOpen] = useState(false);
  const [activity, setActivity] = useState<Activity>({ label: '' });
  const workTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const version = useRef(0), ownerVersion = useRef(0), iconInput = useRef<HTMLInputElement>(null);
  const stopActivity = useCallback(() => { workTimers.current.forEach(clearTimeout); workTimers.current = []; setActivity({ label: '' }); }, []);
  const thinking = useCallback((value: boolean) => { stopActivity(); if (value) setActivity({ label: 'Thinking…' }); }, [stopActivity]);
  useEffect(() => { stopActivity(); return () => { workTimers.current.forEach(clearTimeout); }; }, [thread, stopActivity]);
  const clear = useCallback(() => { ownerVersion.current++; version.current++; setProfile(null); setNotes({}); setDrafts({}); setNoteErrors({}); setExpanded(null); setSaving(null); setRefreshing(false); setIconBusy(false); setChatOpen(false); setError(''); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void request<MuseProfile>('session', { signal: abort.signal }).then(value => { if (!abort.signal.aborted && value.ownerId === userId) setProfile(value); }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); }).finally(() => { if (!abort.signal.aborted) setReady(true); });
    return () => { abort.abort(); ownerVersion.current++; version.current++; };
  }, [userId]);
  useEffect(() => {
    if (!profile && ready && open) onOpenChange(false);
  }, [profile, open, ready, onOpenChange]);
  const loadNotes = useCallback(async () => {
    const generation = ++version.current; setRefreshing(true); setNoteErrors({});
    const results = await Promise.allSettled((['soul', 'memory'] as const).map(key => request<Note>('notes/' + key)));
    if (generation !== version.current) return;
    if (results.some(result => result.status === 'rejected' && result.reason instanceof RequestError && result.reason.status === 401)) { clear(); return; }
    results.forEach((result, index) => { const key: NoteKey = index === 0 ? 'soul' : 'memory'; if (result.status === 'fulfilled') setNotes(values => ({ ...values, [key]: result.value })); else setNoteErrors(values => ({ ...values, [key]: result.reason.message })); });
    setRefreshing(false);
  }, [clear]);
  useEffect(() => {
    if (!open || !profile) return;
    void loadNotes(); setChatOpen(false);
    return () => { version.current++; };
  }, [open, profile?.muse.id, loadNotes]);
  useEffect(() => {
    if (expanded && !drafts[expanded]) document.querySelector<HTMLElement>('.muse-note.expanded .muse-note-content')?.focus();
  }, [expanded]);
  useEffect(() => {
    if (!open) setExpanded(null);
    const key = (event: KeyboardEvent) => { if (open && event.key === 'Escape') { if (expanded) setExpanded(null); else onOpenChange(false); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, expanded, onOpenChange]);
  async function save(key: NoteKey) {
    const draft = drafts[key], generation = ownerVersion.current; if (!draft || saving) return;
    setSaving(key); setNoteErrors(values => ({ ...values, [key]: undefined }));
    try {
      const value = await request<Note>('notes/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (generation === ownerVersion.current) { setNotes(values => ({ ...values, [key]: value })); setDrafts(values => { const next = { ...values }; delete next[key]; return next; }); }
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 401) clear();
      else if (generation === ownerVersion.current) setNoteErrors(values => ({ ...values, [key]: (cause as Error).message }));
    } finally { if (generation === ownerVersion.current) setSaving(null); }
  }
  async function changeIcon(file: File) {
    const generation = ownerVersion.current; setIconBusy(true); setError('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10_000_000) throw new Error('Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
      const bitmap = await createImageBitmap(file), size = Math.min(bitmap.width, bitmap.height), canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256); bitmap.close();
      const result = await request<{ iconVersion: string }>('avatar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: canvas.toDataURL('image/png') }) });
      if (generation === ownerVersion.current) setProfile(value => value ? { ...value, muse: { ...value.muse, iconVersion: result.iconVersion } } : value);
    } catch (cause) { if (cause instanceof RequestError && cause.status === 401) clear(); else if (generation === ownerVersion.current) setError(cause instanceof RequestError ? cause.message : 'That image could not be opened. Choose a PNG, JPEG, WebP, or GIF under 10 MB.'); }
    finally { if (generation === ownerVersion.current) setIconBusy(false); }
  }
  function apply(actions: MuseActions) {
    stopActivity();
    const result = applyActions(actions);
    result.ids.forEach((id, index) => {
      const show = () => setActivity({ label: 'Working here', targetId: id });
      if (!index) show(); else workTimers.current.push(setTimeout(show, index * 1100));
    });
    if (result.ids.length) workTimers.current.push(setTimeout(() => setActivity({ label: '' }), result.ids.length * 1100 + 1600));
    return result;
  }
  if (!profile) return <div data-muse-ui="true" className="muse-interface"><nav className="muse-tabs" aria-label="Your account"><span className="muse-account"><UserButton/></span></nav><FloatingMuse obstacles={obstacles} activity={activity} open={() => setChatOpen(true)}/>{error && <div className="muze-toast" role="alert">{error}</div>}</div>;
  return <div data-muse-ui="true" className="muse-interface">
    <nav className="muse-tabs" aria-label="Workspace views"><button aria-current={!open ? 'page' : undefined} onClick={() => onOpenChange(false)}><SquarePen size={15}/><span>Whiteboard</span></button><button aria-current={open ? 'page' : undefined} aria-label="Edit my Muse" onClick={() => onOpenChange(true)}><Cloud size={16}/><span>Edit my Muse</span></button><span className="muse-account"><UserButton/></span></nav>
    {!open && <FloatingMuse profile={profile} open={() => setChatOpen(value => !value)} obstacles={obstacles} activity={activity} chatOpen={chatOpen}/>}
    {!open && <MuseChat key={thread} hidden={!chatOpen} profile={profile} thread={thread} boardContext={boardContext} close={() => setChatOpen(false)} edit={() => onOpenChange(true)} locked={clear} onThinking={thinking} applyActions={apply} addToBoard={text => { addToBoard(text); setChatOpen(false); }}/ >}
    {open && <section className="muse-space" aria-label="Muse private space">
      <header className="muse-space-top"><button className="muse-back" onClick={() => onOpenChange(false)}><ArrowLeft size={16}/><span>Back to whiteboard</span></button><span className="muse-owner"><span>{profile.ownerName.slice(0, 1)}</span>{profile.ownerName}</span></header>
      <div className="muse-space-content">
        <header className="muse-identity"><button className="muse-change-icon" aria-label="Change Muse icon" title="Change Muse icon" disabled={iconBusy} onClick={() => iconInput.current?.click()}><MuseIcon profile={profile}/><span><Pencil size={12}/></span></button><div><span className="muse-eyebrow">YOUR MUSE</span><h1>Muse</h1><p>Personality, preferences, and memory.</p></div><span className="muse-private-badge"><LockKeyhole size={12}/>Only you</span></header>
        <div className="muse-notes-heading"><span><FileText size={15}/>Notes<span className="muse-note-count">2</span></span><div><button aria-label="Refresh Muse notes" title="Reload your two notes" disabled={refreshing || !!saving || Object.keys(drafts).length > 0} onClick={() => void loadNotes()}><RefreshCw size={14} className={refreshing ? 'spinning' : ''}/><span>Refresh</span></button></div></div>
        {error && <p className="muse-space-error" role="alert">{error}</p>}
        <div className={'muse-notes' + (expanded ? ' has-expanded' : '')}>{(['soul', 'memory'] as const).filter(key => !expanded || expanded === key).map(key => <NoteCard key={key} noteKey={key} value={notes[key]} draft={drafts[key]} error={noteErrors[key]} saving={saving === key} expanded={expanded === key} onExpand={() => setExpanded(value => value === key ? null : key)} onEdit={() => { if (notes[key]) setDrafts(values => ({ ...values, [key]: { content: notes[key]!.content, revision: notes[key]!.revision } })); }} onChange={content => setDrafts(values => ({ ...values, [key]: { ...values[key]!, content } }))} onSave={() => void save(key)} onCancel={() => { setDrafts(values => { const next = { ...values }; delete next[key]; return next; }); void loadNotes(); }}/>)}</div>
        <p className="muse-space-footnote"><Check size={12}/>Private to {profile.ownerName === 'You' ? 'you' : profile.ownerName}. Kept separate from your whiteboards.</p>
      </div>
      <input type="file" ref={iconInput} hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose Muse icon" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void changeIcon(file); }}/>
    </section>}
  </div>;
}
