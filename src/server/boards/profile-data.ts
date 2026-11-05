import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type ParticipantRow = {
  user_id: string; name: string; avatar_url: string | null; muse_name: string;
  muse_avatar_version: string | null; muse_sheet: boolean; muse_poses: 9 | 15;
};
type SavedAvatar = { preview?: string; activeSheet?: string; activeVersion?: string; active?: boolean; candidate?: string; candidateVersion?: string };

export function profileName(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || fallback : fallback;
}
export function clerkAvatarUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['img.clerk.com', 'images.clerk.dev'].includes(url.hostname) ? url.href : null; }
  catch { return null; }
}
export function participantData(row: ParticipantRow, boardId: string) {
  return {
    userId: row.user_id, name: profileName(row.name, 'Guest'), avatarUrl: clerkAvatarUrl(row.avatar_url),
    museName: profileName(row.muse_name, 'Muse'), museAvatarVersion: row.muse_avatar_version,
    museAvatarUrl: row.muse_avatar_version ? `/api/boards/${encodeURIComponent(boardId)}/participants/${encodeURIComponent(row.user_id)}/avatar?v=${row.muse_avatar_version}` : '/muse/default-gaze-15.png?v=fluffyblob-v1',
    museSheet: row.muse_avatar_version ? row.muse_sheet : true, musePoses: row.muse_avatar_version ? row.muse_poses : 15,
  };
}
export function selectedMuseAppearance(avatar: SavedAvatar | null, icon: { bytes: Uint8Array | string } | null) {
  const active = avatar?.activeVersion && avatar.activeSheet ? avatar.activeSheet : avatar?.active && avatar.candidateVersion ? avatar.candidate : null;
  const bytes = active ? Buffer.from(active, 'base64') : avatar?.preview ? Buffer.from(avatar.preview, 'base64') : icon ? Buffer.from(icon.bytes) : null;
  return { bytes, sheet: !!active, version: bytes ? createHash('sha256').update(bytes).digest('hex') : null };
}
export async function sharedMuseImage(appearance: ReturnType<typeof selectedMuseAppearance>) {
  if (!appearance.bytes) return null;
  const size = appearance.sheet ? 384 : 128;
  const bytes = await sharp(appearance.bytes, { limitInputPixels: 25_000_000, animated: false }).rotate().resize(size, size, { fit: 'contain', background: '#00000000' }).webp({ quality: 85 }).toBuffer();
  if (bytes.length > 300_000) throw new Error('Muse appearance is too large.');
  return bytes.toString('base64');
}
