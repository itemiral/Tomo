'use client';

import { useState } from 'react';
import { MusePortrait } from './portrait';
import { MuseOrb } from './orb';
import { MuseAvatarLoading } from './avatar-loading';
import { AvatarProgress } from './avatar-feedback';

type Props = { src: string | null; sheet: boolean; poses: 9 | 15; follow?: boolean; pending?: boolean; cacheOwner?: string };
export function MuseAvatarImage(props: Props) {
  return <AvatarFrame key={JSON.stringify([props.cacheOwner, props.src, props.sheet, props.poses])} {...props}/>;
}
function AvatarFrame({ src, sheet, poses, follow = false, pending = false, cacheOwner }: Props) {
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  return <span className={'muse-avatar' + (failed ? ' muse-avatar-orb' : '') + (pending ? ' pending' : '')} aria-hidden="true">
    {src && (failed ? <MuseOrb followCursor={follow}/> : <MusePortrait src={src} sheet={sheet} poses={poses} follow={follow} cacheOwner={cacheOwner} onLoad={() => setReady(true)} onError={() => setFailed(true)}/>)}
    {(!src || (!ready && !failed)) && <MuseAvatarLoading/>}
    {pending && <AvatarProgress/>}
  </span>;
}
