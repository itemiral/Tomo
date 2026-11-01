import {NextRequest} from 'next/server';
import {owner,checkOrigin,jsonBody,privateFailure,privateJson} from '@/server/muse/private';
import {readTask,taskAction} from '@/server/muse/tasks';
export const runtime='nodejs';
export async function GET(request:NextRequest){try{const {profile}=await owner(request);return privateJson({task:await readTask(profile.ownerId,request.nextUrl.searchParams.get('thread')),enabled:process.env.MUSE_AGENT_ENABLED!=='false'});}catch(e){return privateFailure(e);}}
export async function POST(request:NextRequest){try{checkOrigin(request,true);const {profile}=await owner(request);return privateJson({task:await taskAction(profile.ownerId,await jsonBody(request,60000),request.signal)});}catch(e){return privateFailure(e);}}
