import {serveBoardTool} from '@/server/boards/mcp';
import {readToolBoard} from '@/server/boards/mcp-access';

export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = {params: Promise<{id: string}>};
async function handle(request: Request, {params}: Context) {return serveBoardTool(request, (await params).id, readToolBoard);}
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
