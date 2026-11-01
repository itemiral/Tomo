import { normalizeImageFile } from './image-upload';

export function normalizeAvatarImage(file:File,signal?:AbortSignal):Promise<string>{
  return normalizeImageFile(file,{maxSourceLength:3_700_000,maxDimension:1024},signal);
}
