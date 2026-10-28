'use client';

import { useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { ArrowRight, Check, X } from 'lucide-react';
import { COLORS, type CardData, type Preferences } from '@/lib/muse/types';

export function MuseDialog({ title, description, children, close }: { title: string; description?: string; children: ReactNode; close: () => void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}><Dialog.Portal><Dialog.Overlay className="muse-dialog-overlay"/><Dialog.Content className="muse-dialog">
    <Dialog.Title>{title}</Dialog.Title>
    {description ? <Dialog.Description>{description}</Dialog.Description> : <Dialog.Description className="muse-sr-only">Edit your Muse workspace.</Dialog.Description>}
    <Dialog.Close className="muse-dialog-close" aria-label="Close dialog"><X size={18}/></Dialog.Close>
    {children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function CardEditor({ data, save, close }: { data: CardData; save: (data: CardData) => void; close: () => void }) {
  const [draft, setDraft] = useState(data);
  const [items, setItems] = useState(data.items.join('\n'));
  return <MuseDialog title="A thought, in your words." close={close}>
    <form onSubmit={event => { event.preventDefault(); const nextItems = items.split('\n').map(item => item.trim()).filter(Boolean); save({ ...draft, items: nextItems, checked: draft.checked.filter(item => nextItems.includes(item)) }); }}>
      <label>Title<input autoFocus maxLength={160} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
      <label>Your thought<textarea rows={4} maxLength={4000} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })}/></label>
      {!['heading', 'photo'].includes(data.kind) && <label>{data.kind === 'checklist' ? 'Checklist · one item per line' : 'Outline · one item per line'}<textarea rows={4} maxLength={8000} value={items} onChange={event => setItems(event.target.value)}/></label>}
      <div className="muse-dialog-footer"><div className="muse-color-options">{COLORS.map(color => <button type="button" key={color} className={`color-${color}`} aria-label={`${color} card`} aria-pressed={draft.color === color} onClick={() => setDraft({ ...draft, color })}>{draft.color === color && <Check size={14}/>}</button>)}</div><button className="muse-primary" type="submit">Save thought<Check size={14}/></button></div>
    </form>
  </MuseDialog>;
}

export function PreferencesEditor({ preferences, save, close }: { preferences: Preferences; save: (value: Preferences) => void; close: () => void }) {
  const [draft, setDraft] = useState(preferences);
  return <MuseDialog title="A little more you." description="Give your Muses a sense of how you think. They’ll carry it into every board." close={close}>
    <form onSubmit={event => { event.preventDefault(); save(draft); }}>
      <label>What should we call you?<input autoFocus maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>Things you’re drawn to<textarea rows={2} maxLength={2000} placeholder="Small coffee shops, the outdoors, design, learning by doing…" value={draft.interests} onChange={event => setDraft({ ...draft, interests: event.target.value })}/></label>
      <label>How you like to work<select value={draft.workingStyle} onChange={event => setDraft({ ...draft, workingStyle: event.target.value })}>{['A clear outline, then room to explore', 'Big ideas first, details later', 'Small steps and practical checklists', 'Show me options side by side'].map(style => <option key={style}>{style}</option>)}</select></label>
      <label>Anything else to keep in mind?<textarea rows={2} maxLength={2000} placeholder="Your priorities, constraints, or a goal you’re working toward…" value={draft.details} onChange={event => setDraft({ ...draft, details: event.target.value })}/></label>
      <div className="muse-dialog-footer"><span/><button className="muse-primary" type="submit">Save preferences<Check size={14}/></button></div>
    </form>
  </MuseDialog>;
}

export function NewBoardDialog({ create, close }: { create: (template: 'blank' | 'trip' | 'project', title: string) => void; close: () => void }) {
  const [title, setTitle] = useState('');
  return <MuseDialog title="What’s on your mind?" description="A fresh whiteboard. Your Muses build the plan together." close={close}>
    <form onSubmit={event => { event.preventDefault(); create('blank', title); }}>
      <label>Board name<input autoFocus value={title} maxLength={100} placeholder="The beginning of something…" onChange={event => setTitle(event.target.value)}/></label>

      <div className="muse-dialog-footer"><span/><button className="muse-primary" type="submit">Open a new board<ArrowRight size={15}/></button></div>
    </form>
  </MuseDialog>;
}
