import { NextRequest } from 'next/server';
import { boardFailure, listBoards, publishBoard } from '@/server/boards/api';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try { return await listBoards(request); } catch (error) { return boardFailure(error); }
}
export async function POST(request: NextRequest) {
  try { return await publishBoard(request); } catch (error) { return boardFailure(error); }
}
