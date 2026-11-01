export const NAME_PREFIX='Hello, my name is ';
export function validMuseName(value:unknown):string {
 if(typeof value!=='string')throw new Error('Choose a name.');
 const name=value.trim().normalize('NFC');
 if(!name||[...name].length>40||/[\u0000-\u001f\u007f<>]/.test(name))throw new Error('Use a name of 1–40 characters without markup or control characters.');
 return name;
}
export function nameFromText(text:unknown){if(typeof text!=='string'||!text.startsWith(NAME_PREFIX)||!text.endsWith('.'))throw new Error('Keep “Hello, my name is” and edit only the name.');return validMuseName(text.slice(NAME_PREFIX.length,-1));}
export function museNameStyles(name:string){return {0:Object.fromEntries([...name].map((_,i)=>[NAME_PREFIX.length+i,{fontFamily:'Shantell Sans',fill:'#4266a9',underline:true}]))};}
