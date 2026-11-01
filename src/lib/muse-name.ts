import type { Board } from '../components/muze/storage';

export const NAME_PREFIX='Hello, my name is ';
export function validMuseName(value:unknown):string {
 if(typeof value!=='string')throw new Error('Choose a name.');
 const name=value.trim().normalize('NFC');
 if(!name||[...name].length>40||/[\u0000-\u001f\u007f<>]/.test(name))throw new Error('Use a name of 1–40 characters without markup or control characters.');
 return name;
}
export function nameFromText(text:unknown){if(typeof text!=='string'||!text.startsWith(NAME_PREFIX)||!text.endsWith('.'))throw new Error('Keep “Hello, my name is” and edit only the name.');return validMuseName(text.slice(NAME_PREFIX.length,-1));}
export function museNameStyles(name:string){return {0:Object.fromEntries([...name].map((_,i)=>[NAME_PREFIX.length+i,{fontFamily:'Shantell Sans',fill:'#4266a9',underline:true}]))};}

export function renameMuseInSoul(content:string,previousName:string,nextName:string):string {
 const name=validMuseName(nextName);
 if(previousName===name)return content;
 const names=[...new Set([previousName,'Muse',name])].filter(Boolean).map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const declaration=new RegExp('(^|\\n)([ \\t]*(?:I[’\u0027]m |I am |My name is |Name:[ \\t]*))('+names+')(?=$|[\\s,.!;:])','gu');
 let found=false;
 const updated=content.replace(declaration,(_match,start,prefix)=>{found=true;return start+prefix+name;});
 return found?updated:'My name is '+name+'.\n\n'+content;
}
type SavedMuseName={name?:string;soul?:string};
export function reconcileMuseNameSave(latest:Board,submitted:Board,result:SavedMuseName):Board {
 const find=(objects:Record<string,unknown>[],id:string):Record<string,unknown>|undefined=>{
  for(const object of objects){if(object.id===id)return object;if(Array.isArray(object.objects)){const child=find(object.objects,id);if(child)return child;}}
 };
 const findOnBoard=(board:Board,id:string)=>board.pages.map(page=>find(page.objects,id)).find(Boolean);
 const original=findOnBoard(submitted,'muse-file-soul');
 const originalText=original?.markdown??original?.text;
 const apply=(objects:Record<string,unknown>[]):Record<string,unknown>[]=>objects.map(object=>{
  if(object.id==='muse-file-soul'&&typeof result.soul==='string'&&(object.markdown??object.text)===originalText)return {...object,markdown:result.soul,text:result.soul};
  return Array.isArray(object.objects)?{...object,objects:apply(object.objects)}:object;
 });
 let name=result.name;
 const title=findOnBoard(latest,'muse-name');
 if(title)try{name=nameFromText(title.text);}catch{name=undefined;}
 return {...latest,...(name?{museName:name}:{}),pages:latest.pages.map(page=>({...page,objects:apply(page.objects)}))};
}
