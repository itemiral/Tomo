import {NextRequest} from 'next/server';
import {boardFailure} from '@/server/boards/api';
import {manageRequestLease} from '@/server/boards/leases';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function POST(request: NextRequest, {params}: Context) {
  try { return await manageRequestLease(request, (await params).id, 'renew'); } catch (error) { return boardFailure(error); }
}
export async function DELETE(request: NextRequest, {params}: Context) {
  try { return await manageRequestLease(request, (await params).id, 'release'); } catch (error) { return boardFailure(error); }
}
