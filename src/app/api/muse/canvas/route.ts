import { type NextRequest } from 'next/server';
import { checkOrigin, jsonBody, owner, privateFailure, privateJson } from '@/server/muse/private';
import { readMuseCanvas, saveMuseCanvas } from '../../../../../scripts/muse-canvas.mjs';
export const runtime='nodejs';
export async function GET(request:NextRequest) { try {return privateJson(await readMuseCanvas((await owner(request)).profile.ownerId));}catch(e){return privateFailure(e);} }
export async function PUT(request:NextRequest) { try {checkOrigin(request,true);const {profile}=await owner(request);const body=await jsonBody(request,22_000_000);if(body.ownerId!==profile.ownerId)return privateJson({error:'Your account changed. Reopen this notebook before saving.'},409);return privateJson(await saveMuseCanvas(profile.ownerId,body));}catch(e){return privateFailure(e);} }
