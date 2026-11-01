import { NextRequest } from 'next/server';
import { boardFailure } from '@/server/boards/api';
import { listParticipants, publishParticipant } from '@/server/boards/profiles';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try { return await listParticipants(request, (await params).id); } catch (error) { return boardFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try { return await publishParticipant(request, (await params).id); } catch (error) { return boardFailure(error); }
}
