import {NextRequest} from 'next/server';
import {owner,checkOrigin,jsonBody,privateFailure,privateJson,PrivateError} from '@/server/muse/private';
import {importImage} from '../../../../../scripts/muse-image-import.mjs';
export const runtime='nodejs';
export async function POST(request:NextRequest){try{checkOrigin(request,true);await owner(request);const body=await jsonBody(request,4096);return privateJson(await importImage(body.url,request.signal));}catch(e){return privateFailure(e instanceof Error&&'status' in e?e:new PrivateError(502,'Could not fetch this image. Use a direct public PNG, JPEG or WebP URL.'));}}
