import 'server-only';
import {randomBytes} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import type {NextRequest} from 'next/server';
import {boardContext, boardJson, databaseFailure} from './api';
import {boardId, sharedBoard} from './validation';
import {BoardToolAccessError, type ToolBoardSnapshot} from './mcp';

export async function manageToolAccess(request: NextRequest, id: string, operation: 'status' | 'create' | 'revoke') {
  const {client} = await boardContext(request, operation !== 'status');
  const token = operation === 'create' ? `muze_${randomBytes(32).toString('base64url')}` : undefined;
  const {data, error} = await client.rpc('manage_board_tool_access', {operation, board_id: boardId(id), ...(token ? {access_token: token} : {})});
  if (error) databaseFailure(error);
  return boardJson({...data, ...(token ? {token} : {})});
}

export async function readToolBoard(id: string, token: string, signal: AbortSignal): Promise<ToolBoardSnapshot> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new BoardToolAccessError(503, 'Board access is unavailable.');
  const client = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}, db: {retry: false}, global: {fetch: (input, init) => fetch(input, {...init, cache: 'no-store'})}});
  const {data, error} = await client.rpc('read_board_for_tool', {board_id: id, access_token: token}).abortSignal(signal);
  if (error) throw new BoardToolAccessError(error.code === '42501' ? 401 : 503, error.code === '42501' ? 'This board access token is invalid or revoked.' : 'Board access is unavailable. Try again.');
  if (!data?.board || data.board.id !== id || !Array.isArray(data.board.pages)) throw new BoardToolAccessError(503, 'Board access is unavailable.');
  // Validate privacy and shape invariants without altering the exact export.
  try {sharedBoard(data.board, id);} catch {throw new BoardToolAccessError(503, 'This board could not be read.');}
  return data as ToolBoardSnapshot;
}
