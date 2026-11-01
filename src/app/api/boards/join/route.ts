import { NextRequest } from 'next/server';
import { boardFailure, joinBoard } from '@/server/boards/api';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try { return await joinBoard(request); } catch (error) { return boardFailure(error); }
}
