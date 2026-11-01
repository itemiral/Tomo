import { NextRequest } from 'next/server';
import { boardFailure } from '@/server/boards/api';
import { participantAvatar } from '@/server/boards/profiles';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; userId: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try { const { id, userId } = await params; return await participantAvatar(request, id, userId); } catch (error) { return boardFailure(error); }
}
