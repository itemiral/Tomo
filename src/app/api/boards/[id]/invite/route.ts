import { NextRequest } from 'next/server';
import { boardFailure, createInvite, revokeInvite } from '@/server/boards/api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, { params }: Context) {
  try { return await createInvite(request, (await params).id); } catch (error) { return boardFailure(error); }
}
export async function DELETE(request: NextRequest, { params }: Context) {
  try { return await revokeInvite(request, (await params).id); } catch (error) { return boardFailure(error); }
}
