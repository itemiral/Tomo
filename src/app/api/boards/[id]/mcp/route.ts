import type {NextRequest} from 'next/server';
import {boardFailure} from '@/server/boards/api';
import {manageToolAccess} from '@/server/boards/mcp-access';

export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
export async function GET(request: NextRequest, {params}: Context) {try {return await manageToolAccess(request, (await params).id, 'status');} catch (error) {return boardFailure(error);}}
export async function POST(request: NextRequest, {params}: Context) {try {return await manageToolAccess(request, (await params).id, 'create');} catch (error) {return boardFailure(error);}}
export async function DELETE(request: NextRequest, {params}: Context) {try {return await manageToolAccess(request, (await params).id, 'revoke');} catch (error) {return boardFailure(error);}}
