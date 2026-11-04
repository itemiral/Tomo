import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from './muse-storage.mjs';
import {join} from 'node:path';
import {ensureMuse,museDirectory,withMuseOwner,MuseStoreError} from './muse-store.mjs';
import {researchGoal,publicUrl} from './muse-research.mjs';
import {importImage} from './muse-image-import.mjs';
import {imageLinks} from './muse-tasks.mjs';
import {generateBoardImage} from './muse-image-generate.mjs';
import {planMuseTools} from './muse-tool-plan.mjs';
import {readToolJson,publicToolText} from './muse-tool-http.mjs';

function needsPublicFacts(text){
 const currentFact=/\b(?:latest|current|today|live|real[- ]time|up[- ]to[- ]date)\b/i.test(text);
 const marketFact=/\b(?:prices?|costs?|fares?|rates?|availability|available|flights?|hotels?|tickets?)\b|\bin stock\b|\bopening hours\b/i.test(text);
 return currentFact||marketFact;
}

export function toolRestrictions(message){
 const text=message.replace(/[’‘]/g,"'");
 const offline=/\b(?:do not|don't|dont|never|avoid|skip|no need to)\s+(?:please\s+)?(?:search(?:ing)?|look(?:ing)?\s*up|brows(?:e|ing)|research(?:ing)?|(?:use|using)\s+(?:the\s+)?(?:web|internet|online))\b|\b(?:no|without)\s+(?:web(?:\s+search)?|internet|online\s+(?:search|research)|browsing|research|search(?:ing)?|looking\s*up)\b|\b(?:stay|work|remain|answer|keep it)\s+offline\b|\boffline\s+only\b|\b(?:(?:use|using)\s+(?:only|just)|only\s+use)\s+(?:(?:my|our|the|these|those|selected)\s+)?(?:notes|cards|board|text|documents?|selection)\b/i.test(text);

 const multilingualOffline=/不要(?:联网|上网|搜索)|(?:别|禁止)(?:联网|上网|搜索)|仅(?:用|使用).*(?:笔记|白板)|не (?:ищи|искать|используй интернет)|без (?:интернета|поиска)|no (?:busques|buscar|uses internet)|sin (?:internet|búsqueda)|sans (?:internet|recherche)|ne cherche pas|오프라인|검색하지|ネット検索しない|オフライン/iu.test(text);
 const explicitSearch=/\b(?:search|look\s*up|browse|research)\b|\b(?:generate|create|draw|render)\b[\s\S]*\b(?:image|picture|illustration|poster|logo)\b/i.test(text);
 const localEdit=/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:rewrite|rephrase|shorten|translate|format|rename|move|resize|delete)\b/i.test(text);
 const localEvidence=/\b(?:from|in|using|based on|according to)\s+(?:(?:just|only)\s+)?(?:these|those|my|our|the|selected)\s+(?:notes|cards|board|text|documents?|selection|table)\b/i.test(text);
 const preference=/^(?:(?:please\s+)?remember\s+(?:that\s+)?)?(?:I|we)\s+(?:prefer|like|love|usually|always|never)\b|^(?:please\s+)?(?:be (?:playful|concise|brief|friendly|formal)|always (?:use|keep|reply|speak)|(?:reply|speak|respond) (?:in|with))\b/i.test(text);
 const mixedRequest=/(?:[;.!?\n,]\s*|\b(?:and|so|but)\s+|\b(?:can|could|would)\s+you\s+)(?:please\s+)?(?:recommend|suggest|find|check|search|look\s*up|show|get|latest|current)\b/i.test(text);
 return {personal:preference,offline:offline||multilingualOffline,local:localEdit||preference&&!mixedRequest||localEvidence&&!explicitSearch&&!mixedRequest};
}
export function toolIntent(message){
 const {offline,local}=toolRestrictions(message);
 if(offline||local)return {images:false,search:false};
 const text=message.replace(/[’‘]/g,"'");
 const explicitSearch=/\b(?:search|look\s*up|browse|research)\b/i.test(text);
 const request=/\b(?:find|check|compare|show|tell me|give me|get|fetch|recommend|suggest)\b|^(?:please\s+)?(?:what|which|where|when|how|is|are|does|do|can|could|would)\b/i.test(text);
 const publicBrief=/^(?:latest|current|live|up[- ]to[- ]date)\b/i.test(text);
 const images=/\b(?:add|insert|find|fetch|get|show|search|put|place|bring)\b[\s\S]*\b(?:images?|photos?|pictures?)\b|\b(?:images?|photos?|pictures?)\b[\s\S]*\b(?:on|onto|to)\s+(?:the |my )?board\b/i.test(message)||imageLinks(message).length>0;
 return {images,search:explicitSearch||publicBrief||request&&needsPublicFacts(text)};
}

function imageRequestSubject(message){
 const match=message.trim().match(/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:generate|create|draw|make|design|render|illustrate)\s+(?:(?:me|for me)\s+)?(?:(?:an?|the)\s+)?(?:image|picture|illustration|logo|poster|artwork|photo)\s+(?:of|showing|depicting)\s+(.+)$/is);
 return match?.[1].replace(/[.!?]+$/,'').trim()||null;
}
function qualifiedImageRequest(subject){
 return /\b(?:if|unless|whether|instead|rather|but|then|also|capabilities|hypothetical|explain|describe|without|never)\b|[;.!?]\s+\w|\b(?:do not|don['’]?t)\b|\b(?:and)\s+(?:please\s+)?(?:search|research|find|look|check|tell|ask)\b|\b(?:can you|are you able|is it possible|how to|not now|not yet|no tools|just asking|just kidding)\b/i.test(subject)||/^(?:something|anything|any\s+(?:size|style|kind)|different\s+(?:sizes|styles))(?:\s|$)/i.test(subject);
}
function explicitImagePrompt(message){
 const subject=imageRequestSubject(message);
 if(!subject||subject.length<2||message.length>2000)return null;
 // The fast path requires the current message to supply the whole subject.
 // References, capability questions, conditions and mixed tasks need the planner.
 if(qualifiedImageRequest(subject)||/\b(?:this|that|these|those|it|them|here|there|above|same|again|selected|attached|previous|my|our|your|his|her|their)\b|https?:\/\//i.test(subject))return null;
 const prompt=publicToolText(subject,2000);
 return prompt&&prompt!=='[private]'?prompt:null;
}

export async function resolveToolPlan(message,context,signal,planner=planMuseTools){
 const restrictions=toolRestrictions(message);
 if(restrictions.offline||restrictions.local)return {action:'none',query:''};
 signal.throwIfAborted();
 const imagePrompt=explicitImagePrompt(message);
 if(imagePrompt)return {action:'image_generate',query:imagePrompt};
 const intent=toolIntent(message),urls=imageLinks(message);
 if(urls.length)return {action:'image_search',query:message};
 const contextual=/\b(?:this|that|these|those|it|them|here|there|above|same|again)\b/i.test(message);
 const nonEnglish=/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Symbol}\s]/u.test(message);
 const generation=/\b(?:generate|create|draw|make|design|render|illustrate)\b[\s\S]*\b(?:image|picture|illustration|logo|poster|artwork|photo)\b/i.test(message);
 // Clear public queries retain the quick path; a model resolves ambiguous subjects
 // and requests in other languages instead of extending a keyword dictionary.
 if(intent.search&&!intent.images&&!contextual&&!nonEnglish&&!restrictions.personal&&message.length<=600)return {action:'research',query:publicToolText(message)};
 const localChat=/^(?:hi|hello|hey|thanks|thank you|yes|no|ok|okay)[.! ]*$/i.test(message)||/^(?:please )?(?:outline|brainstorm|organize|summarize|explain|continue|make (?:this|it|these) (?:concise|shorter|clearer)|add (?:a )?(?:note|card))\b/i.test(message);
 const publicOptions=/\b(?:recommend|suggest|best|nearby|hotels?|restaurants?|flights?|venues?|tickets?|products?|destinations?|travel|trip|vacation|weather|prices?|latest|availability)\b/i.test(message);
 // A rough plan can still be useful without a lookup. This changes only failure
 // recovery: successful routing still researches public options as usual.
 const ordinaryPlanning=/\b(?:plan|planning|outline|organize|brainstorm)\b|\bmake\s+(?:a|the|our|my)\s+trip\b/i.test(message)&&!needsPublicFacts(message);
 const recentImageRequest=(context?.history||[]).slice(-4).some(item=>item.role==='user'&&(imageRequestSubject(item.content)||toolIntent(item.content).images||/\b(?:draw|illustrate|render)\b/i.test(item.content)));
 const imageContinuation=recentImageRequest&&!ordinaryPlanning;
 if(!intent.search&&!intent.images&&!generation&&!nonEnglish&&!imageContinuation&&localChat&&!publicOptions&&!needsPublicFacts(message))return {action:'none',query:''};
 try{
  const plan=await planner(message,context,signal);
  const subject=imageRequestSubject(message);
  // A concrete image request must not become an unsupported text-only success.
  if(plan.action==='none'&&subject&&!qualifiedImageRequest(subject)&&!/^(?:it|this|that|these|those)$/i.test(subject))throw new MuseStoreError(502,'Muse did not prepare an image for this request. Try again.');
  return plan;
 }catch(error){
  const unavailableAccount=['auth','configuration'].includes(error?.kind)||[401,403,429].includes(error?.status);
  if(signal.aborted||unavailableAccount||intent.search||intent.images||generation||nonEnglish||imageContinuation||needsPublicFacts(message)||publicOptions&&!ordinaryPlanning)throw error;
  return {action:'none',query:'',notice:'Tool selection was unavailable. No web search, image lookup or generation ran. Answer ordinary questions from the supplied context or general knowledge. Do not claim current facts were verified or images prepared; if this request needs a tool, explain that the lookup could not run.'};
 }
}
const plain=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,500);
export async function findCommonsImage(message,signal,fetcher=fetch,importer=importImage,normalized=false){
 const query=(normalized?message:message.replace(/\b(?:can|could|you|please|add|insert|find|fetch|get|show|search|put|place|bring|me|an?|some|the|images?|photos?|pictures?|of|for|on|onto|to|my|this|board|whiteboard|web|and)\b/gi,' ').replace(/\s+/g,' ').trim()).slice(0,240);
 if(!query)throw new MuseStoreError(400,'Tell me what you want a picture of.');
 const params=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:query+' filetype:bitmap',gsrnamespace:'6',gsrlimit:'5',prop:'imageinfo',iiprop:'url|mime|extmetadata',iiurlwidth:'800'});
 const response=await fetcher('https://commons.wikimedia.org/w/api.php?'+params,{redirect:'error',headers:{'User-Agent':'Tomo/1.0 (https://muze-board.vercel.app)','Accept':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!response.ok)throw new MuseStoreError(502,'Image search is unavailable. Try a direct public image link.');
 const data=await readToolJson(response);
 for(const page of Object.values(data.query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0))){
  const info=page.imageinfo?.[0],url=publicUrl(info?.thumburl||info?.url),sourceUrl=publicUrl(info?.descriptionurl);if(!url||!sourceUrl||!/^image\/(png|jpeg|webp)$/.test(info?.thumbmime||info?.mime||''))continue;
  try{const image=await importer(url,AbortSignal.any([signal,AbortSignal.timeout(6000)]));return {...image,imageUrl:url,sourceUrl,sourceTitle:plain(page.title).slice(0,200).replace(/^File:/,''),attribution:[plain(info.extmetadata?.Artist?.value),plain(info.extmetadata?.LicenseShortName?.value)].filter(Boolean).join(' · ')};}catch(error){if(signal.aborted)throw error;}
 }
 throw new MuseStoreError(502,'No downloadable image was found. Try a more specific subject or a direct public image link.');
}
export async function reserveSearch(owner){
 await ensureMuse(owner);return withMuseOwner(owner,async()=>{const path=join(museDirectory(owner),'search-usage.json'),day=new Date().toISOString().slice(0,10);let usage={day,count:0};try{const saved=JSON.parse(await readFile(path,'utf8'));if(saved.day===day)usage=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
 const cap=Number(process.env.MUSE_SEARCH_DAILY_REQUESTS??20);if(!Number.isFinite(cap)||usage.count>=cap)throw new MuseStoreError(429,'Today’s search limit has been reached.');usage.count++;const temp=path+'.'+randomUUID();await writeFile(temp,JSON.stringify(usage),{mode:0o600,flag:'wx'});await rename(temp,path);
 });
}
export async function findBoardImage(query,signal,fetcher=fetch,importer=importImage){
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(25_000)]);
 try{return await findCommonsImage(query,AbortSignal.any([deadline,AbortSignal.timeout(12_000)]),fetcher,importer,true);}catch(error){if(deadline.aborted)throw error;}
 const params=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:query.slice(0,240),gsrlimit:'4',prop:'pageimages|info',piprop:'thumbnail',pithumbsize:'800',inprop:'url'});
 const response=await fetcher('https://en.wikipedia.org/w/api.php?'+params,{redirect:'error',headers:{'User-Agent':'Tomo/1.0 (https://muze-board.vercel.app)','Accept':'application/json'},signal:deadline});
 if(response.ok){
  const data=await readToolJson(response);
  for(const page of Object.values(data.query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0))){
   const url=publicUrl(page.thumbnail?.source),sourceUrl=publicUrl(page.fullurl);if(!url||!sourceUrl)continue;
   try{return {...await importer(url,AbortSignal.any([deadline,AbortSignal.timeout(6000)])),imageUrl:url,sourceUrl,sourceTitle:plain(page.title).slice(0,200),attribution:'Source: '+plain(page.title)};}catch(error){if(deadline.aborted)throw error;}
  }
 }
 throw new MuseStoreError(502,'No downloadable image was found. Try a more specific subject or attach an image.');
}
export async function runChatTools(owner,message,signal,deps={},context){
 const intent=toolIntent(message);
 const plan=context?await resolveToolPlan(message,context,signal,deps.planner):{action:intent.images?'image_search':intent.search?'research':'none',query:publicToolText(message)};
 const images=[],sources=[];let research=null;
 if(plan.action!=='none')deps.onTool?.(plan.action);
 if(plan.action==='image_generate')images.push({id:randomUUID(),...await (deps.generate||generateBoardImage)(owner,plan.query,signal)});
 if(plan.action==='image_search'){
  const urls=[...new Set([...imageLinks(message),...(message.match(/https:\/\/[^\s<>"']+/g)||[]).map(url=>publicUrl(url.replace(/[),.!?]+$/,''))).filter(Boolean)])].slice(0,3);
  if(urls.length){for(const url of urls)images.push({id:randomUUID(),...await (deps.importer||importImage)(url,signal)});}
  else images.push({id:randomUUID(),...await (deps.findImage||findBoardImage)(plan.query,signal)});
  for(const image of images)if(image.sourceUrl)sources.push({url:image.sourceUrl,title:image.sourceTitle});
 }
 if(plan.action==='research'){await reserveSearch(owner);research=await (deps.research||researchGoal)(plan.query,signal);sources.push(...research.sources);}
 return {images,sources,research,...(plan.notice?{notice:plan.notice}:{})};
}
