import 'server-only';
import { randomBytes } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { createAuthenticatedClient, SupabaseSessionError } from '@/utils/supabase/shared';
import { checkOrigin, jsonBody, PrivateError } from '@/server/muse/private';
import { BOARD_BODY_LIMIT, boardId, boardRevision, inviteToken, sharedBoard } from './validation';

const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie, Authorization', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export const boardJson = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
export function boardFailure(error: unknown) {
  if (error instanceof PrivateError || error instanceof SupabaseSessionError) return boardJson({ error: error.message }, error.status);
  console.error('Shared board request failed', { type: error instanceof Error ? error.name : 'UnknownError' });
  return boardJson({ error: 'Could not open this board. Try again.' }, 500);
}
function databaseFailure(error: { code?: string; message?: string }) {
  const status = error.code === '40001' ? 409 : error.code === '42501' ? 403
    : ['PGRST301', 'PGRST303'].includes(error.code || '') ? 401
    : error.code === '22023' || error.code === '23514' ? 400 : error.code === '54000' ? 429 : 503;
  const message = status === 401 ? 'Sign in to open this board.' : status === 503 ? 'Board storage is unavailable. Try again.'
    : error.message || 'This board is unavailable.';
  throw new PrivateError(status, message);
}
async function context(request: NextRequest, mutation = false) {
  checkOrigin(request, mutation);
  const { userId, getToken } = await auth();
  if (!userId) throw new PrivateError(401, 'Sign in to share a board.');
  return { userId, client: createAuthenticatedClient(() => getToken()) };
}
function snapshot(value: unknown) {
  const data = value as { board?: { id?: unknown }; revision?: unknown; role?: unknown };
  if (!data || !['owner', 'editor'].includes(String(data.role))) throw new PrivateError(503, 'This board could not be read.');
  return { board: sharedBoard(data.board, boardId(data.board?.id)), revision: boardRevision(data.revision), role: data.role as 'owner' | 'editor' };
}
type Client = ReturnType<typeof createAuthenticatedClient>;
async function write(client: Client, args: Record<string, unknown>) {
  const { data, error } = await client.rpc('write_shared_board', args);
  if (error) databaseFailure(error);
  return data;
}

export async function listBoards(request: NextRequest) {
  const { client, userId } = await context(request);
  const { data, error } = await client.from('shared_boards').select('id,name,owner_id,updated_at').order('updated_at', { ascending: false }).limit(200);
  if (error) databaseFailure(error);
  return boardJson({ boards: (data || []).map(row => ({ id: row.id, name: row.name, role: row.owner_id === userId ? 'owner' : 'editor', updatedAt: row.updated_at })) });
}
export async function publishBoard(request: NextRequest) {
  const { client } = await context(request, true);
  const body = await jsonBody(request, BOARD_BODY_LIMIT);
  const board = sharedBoard(body.board);
  return boardJson(snapshot(await write(client, { operation: 'create', board_scene: board })), 201);
}
export async function readBoard(request: NextRequest, id: string) {
  const { client, userId } = await context(request);
  const { data, error } = await client.from('shared_boards').select('scene,revision,owner_id').eq('id', boardId(id)).maybeSingle();
  if (error) databaseFailure(error);
  if (!data) throw new PrivateError(404, 'This board is unavailable or you do not have access.');
  return boardJson(snapshot({ board: data.scene, revision: data.revision, role: data.owner_id === userId ? 'owner' : 'editor' }));
}
export async function saveBoard(request: NextRequest, id: string) {
  const { client } = await context(request, true);
  const body = await jsonBody(request, BOARD_BODY_LIMIT);
  const key = boardId(id), board = sharedBoard(body.board, key);
  return boardJson(snapshot(await write(client, { operation: 'save', board_id: key, board_scene: board, expected_revision: boardRevision(body.revision) })));
}
export async function createInvite(request: NextRequest, id: string) {
  const { client } = await context(request, true);
  const token = randomBytes(32).toString('base64url');
  await write(client, { operation: 'invite', board_id: boardId(id), invite_token: token });
  return boardJson({ token });
}
export async function revokeInvite(request: NextRequest, id: string) {
  const { client } = await context(request, true);
  await write(client, { operation: 'revoke', board_id: boardId(id) });
  return boardJson({ revoked: true });
}
export async function joinBoard(request: NextRequest) {
  const { client } = await context(request, true);
  const body = await jsonBody(request, 1024);
  return boardJson(snapshot(await write(client, { operation: 'join', board_id: boardId(body.boardId), invite_token: inviteToken(body.token) })));
}
