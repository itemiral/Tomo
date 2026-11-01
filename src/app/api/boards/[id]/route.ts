import { NextRequest } from 'next/server';
import { boardFailure, readBoard, saveBoard } from '@/server/boards/api';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try { return await readBoard(request, (await params).id); } catch (error) { return boardFailure(error); }
}
export async function PUT(request: NextRequest, { params }: Context) {
  try { return await saveBoard(request, (await params).id); } catch (error) { return boardFailure(error); }
}
