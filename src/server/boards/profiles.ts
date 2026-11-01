import 'server-only';
import { randomUUID } from 'node:crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { createAuthenticatedClient } from '@/utils/supabase/shared';
import { serverSessionToken } from '@/utils/supabase/session';
import { checkOrigin, PrivateError, withOwner } from '@/server/muse/private';
import { ensureMuse, readMuseIcon } from '../../../scripts/muse-store.mjs';
import { readAvatar } from '../../../scripts/muse-avatar.mjs';
import { withMuseProfileSnapshot } from '../../../scripts/muse-storage.mjs';
import { boardId } from './validation';
import { boardJson } from './api';
import { clerkAvatarUrl, participantData, profileName, selectedMuseAppearance, sharedMuseImage, type ParticipantRow } from './profile-data';

const columns = 'user_id,name,avatar_url,muse_name,muse_avatar_version,muse_sheet,muse_poses,revision';
async function context(request: NextRequest, value: string, mutation = false) {
  checkOrigin(request, mutation);
  const id = boardId(value), { userId, sessionId, getToken } = await auth();
  if (!userId) throw new PrivateError(401, 'Sign in to open this board.');
  const client = createAuthenticatedClient(serverSessionToken(userId, sessionId, () => getToken()));
  const { data, error } = await client.from('shared_boards').select('id').eq('id', id).maybeSingle();
  if (error) throw new PrivateError(503, 'Board profiles are unavailable. Try again.');
  if (!data) throw new PrivateError(404, 'This board is unavailable or you do not have access.');
  return { id, userId, client };
}
async function profiles(client: ReturnType<typeof createAuthenticatedClient>, id: string) {
  const { data, error } = await client.from('shared_board_profiles').select(columns).eq('board_id', id).order('user_id').limit(100);
  if (error) throw new PrivateError(503, 'Board profiles are unavailable. Try again.');
  return (data || []).map(row => participantData(row as ParticipantRow, id));
}
export async function listParticipants(request: NextRequest, id: string) {
  const ctx = await context(request, id);
  return boardJson({ participants: await profiles(ctx.client, ctx.id) });
}
export async function publishParticipant(request: NextRequest, id: string) {
  const ctx = await context(request, id, true);
  const user = await currentUser();
  if (!user || user.id !== ctx.userId) throw new PrivateError(401, 'Sign in to open this board.');
  return withOwner(request, async owner => {
    if (owner.ownerId !== ctx.userId) throw new PrivateError(401, 'Sign in to open this board.');
    const { data: previous, error: readError } = await ctx.client.from('shared_board_profiles').select(columns).eq('board_id', ctx.id).eq('user_id', owner.ownerId).maybeSingle();
    if (readError) throw new PrivateError(503, 'Board profiles are unavailable. Try again.');
    const { identity, appearance } = await withMuseProfileSnapshot(async () => {
      const identity = await ensureMuse(owner.ownerId);
      const [avatar, icon] = await Promise.all([readAvatar(owner.ownerId), readMuseIcon(owner.ownerId)]);
      return { identity, appearance: selectedMuseAppearance(avatar, icon) };
    });
    const fields = { user_id: owner.ownerId, name: profileName(user.firstName || user.username, 'Guest'), avatar_url: clerkAvatarUrl(user.imageUrl), muse_name: profileName(identity.name, 'Muse'), muse_avatar_version: appearance.version, muse_sheet: appearance.bytes ? appearance.sheet : true, muse_poses: appearance.bytes ? 9 : 15 };
    if (!previous || Object.entries(fields).some(([key, value]) => previous[key as keyof typeof previous] !== value)) {
      // Only the selected appearance is copied. Source uploads, unused previews,
      // notebook files, and conversations remain in owner-only storage.
      const imageChanged = !previous || previous.muse_avatar_version !== fields.muse_avatar_version;
      const row = { ...fields, board_id: ctx.id, revision: randomUUID(), updated_at: new Date().toISOString(), ...(imageChanged ? { muse_avatar: await sharedMuseImage(appearance) } : {}) };
      const { data: saved, error } = previous ? await ctx.client.from('shared_board_profiles').update(row).eq('board_id', ctx.id).eq('user_id', owner.ownerId).eq('revision', previous.revision).select('user_id').maybeSingle() : await ctx.client.from('shared_board_profiles').insert(row).select('user_id').maybeSingle();
      if (error) {
        if (error.code === '23505') throw new PrivateError(409, 'Your profile changed. Try again.');
        throw new PrivateError(503, 'Your board profile could not be updated. Try again.');
      }
      if (!saved) throw new PrivateError(409, 'Your profile changed. Try again.');
    }
    return boardJson({ participants: await profiles(ctx.client, ctx.id) });
  });
}
export async function participantAvatar(request: NextRequest, id: string, userId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new PrivateError(404, 'This avatar is unavailable.');
  const ctx = await context(request, id);
  const { data, error } = await ctx.client.from('shared_board_profiles').select('muse_avatar,muse_avatar_version').eq('board_id', ctx.id).eq('user_id', userId).maybeSingle();
  if (error) throw new PrivateError(503, 'This avatar is unavailable. Try again.');
  if (!data?.muse_avatar || request.nextUrl.searchParams.get('v') !== data.muse_avatar_version) throw new PrivateError(404, 'This avatar is unavailable.');
  return new NextResponse(Buffer.from(data.muse_avatar, 'base64'), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' } });
}
