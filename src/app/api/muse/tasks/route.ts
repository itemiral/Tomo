import {NextRequest} from 'next/server';
import {withOwner,checkOrigin,jsonBody,privateFailure,privateJson} from '@/server/muse/private';
import {readTask,taskAction} from '@/server/muse/tasks';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:NextRequest){try{return await withOwner(request,async profile=>privateJson({task:await readTask(profile.ownerId,request.nextUrl.searchParams.get('thread')),enabled:process.env.MUSE_AGENT_ENABLED!=='false'}));}catch(e){return privateFailure(e);}}
export async function POST(request:NextRequest){try{checkOrigin(request,true);return await withOwner(request,async profile=>privateJson({task:await taskAction(profile.ownerId,await jsonBody(request,60000),request.signal)}));}catch(e){return privateFailure(e);}}
