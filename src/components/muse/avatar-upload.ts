const MAX_SOURCE_LENGTH=3_700_000;
const MAX_DIMENSION=1024;

export async function normalizeAvatarImage(file:File,signal?:AbortSignal):Promise<string>{
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>10_000_000)throw new Error('Choose a PNG, JPEG, WebP, or GIF under 10 MB.');
  signal?.throwIfAborted();
  const image=new Image(),url=URL.createObjectURL(file);
  try{
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{image.onload=null;image.onerror=null;signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();image.src='';reject(new DOMException('Image preparation cancelled.','AbortError'));};
      image.onload=()=>{cleanup();resolve();};
      image.onerror=()=>{cleanup();reject(new Error('Could not read that image.'));};
      signal?.addEventListener('abort',abort,{once:true});
      image.src=url;
    });
    signal?.throwIfAborted();
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('Could not read that image.');
    let scale=Math.min(1,MAX_DIMENSION/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    if(!context)throw new Error('Could not prepare that image.');
    for(let attempt=0;attempt<5;attempt++){
      signal?.throwIfAborted();
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const source=canvas.toDataURL('image/png');
      if(source.startsWith('data:image/png;base64,')&&source.length<=MAX_SOURCE_LENGTH)return source;
      scale*=.75;
    }
    throw new Error('Choose a smaller image.');
  }finally{URL.revokeObjectURL(url);}
}
