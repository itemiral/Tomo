import {expect,test,type Page} from '@playwright/test';
import {chat,exported,museFixture,send} from './muse-fixture';

async function selectNote(page:Page,id:string,extend=false){
 const note=page.locator(`.muze-vector-surface [id="${id}"]`);await expect(note).toBeVisible();const box=(await note.boundingBox())!;
 if(extend)await page.keyboard.down('Shift');
 await page.mouse.click(box.x+35,box.y+45);
 if(extend)await page.keyboard.up('Shift');
}

for(const width of [1440,390])test(`selected revisions stay scoped and preserve the view at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const fixture=await museFixture(page);await send(page);
 await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
 const original=await exported(page),first=original.objects[0],other=original.objects[1];
 await selectNote(page,first.id);
 await expect(page.getByRole('textbox',{name:'Message Muse'})).toHaveAttribute('placeholder','Ask about your selection…');
 const before=await exported(page);
 let release!:()=>void,captured:any;const gate=new Promise<void>(resolve=>{release=resolve;});
 fixture.response(async(body)=>{captured=JSON.parse(body.board);await gate;return {cards:[],updates:[{id:first.id,text:'One achievable step\n\nChoose a date.',expectedText:first.text},{id:other.id,text:'This must stay unchanged',expectedText:other.text}]};});
 await send(page,'Make this achievable in a week');
 await expect.poll(()=>captured?.selectedIds).toEqual([first.id]);
 expect(captured.objects.find((o:any)=>o.id===first.id).bounds.w).toBeGreaterThan(0);
 await expect(page.locator(`.muse-working-target[data-target-id="${first.id}"]`)).toBeVisible();
 await expect(page.locator('.muse-floating')).toHaveClass(/working/);
 release();
 await expect(page.getByRole('button',{name:'Stop response',exact:true})).toHaveCount(0);
 await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/);await chat(page);
 await expect(page.getByText('Kept 1 card you changed or locked.')).toBeVisible();
 await expect(page.locator('.muse-floating')).not.toHaveClass(/working/);
 const revised=await exported(page);
 expect(revised.objects.find(o=>o.id===first.id)?.text).toBe('One achievable step\n\nChoose a date.');
 expect(revised.objects.filter(o=>o.id!==first.id)).toEqual(original.objects.filter(o=>o.id!==first.id));
 expect(revised.viewport).toEqual(before.viewport);
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 expect((await exported(page)).objects.find(o=>o.id===first.id)?.text).toBe(first.text);
});

test('a request includes current text and both selected notes',async({page})=>{
 const fixture=await museFixture(page);await send(page);await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
 const original=await exported(page),first=original.objects[0],second=original.objects[1];
 const box=(await page.locator(`.muze-vector-surface [id="${first.id}"]`).boundingBox())!;
 await page.mouse.dblclick(box.x+50,box.y+80);await page.locator('textarea[data-fabric="textarea"]').fill('The latest wording');
 await page.getByRole('textbox',{name:'Message Muse'}).fill('Compare these');
 await selectNote(page,first.id);await selectNote(page,second.id,true);
 let context:any;fixture.response(async(body)=>{context=JSON.parse(body.board);return {cards:[],updates:[]};});
 await page.getByRole('button',{name:'Send to Muse'}).click();
 await expect.poll(()=>context?.selectedIds?.length).toBe(2);
 expect(context.selectedIds).toEqual(expect.arrayContaining([first.id,second.id]));
 expect(context.objects.find((o:any)=>o.id===first.id).text).toBe('The latest wording');
});

test('next moves require a click, preserve drafts, and clear when selection changes',async({page})=>{
 const fixture=await museFixture(page);let calls=0,request='';
 fixture.response(async(body)=>{calls++;request=body.message;return {cards:[{id:'followup-note',title:'First step',body:'Pick one outcome.'}],updates:[],suggestions:['Find what is missing','Make the next step smaller']};});
 await send(page,'Help me get started');
 await expect(page.getByRole('button',{name:'Stop response',exact:true})).toHaveCount(0);
 await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/);await chat(page);
 const next=page.getByRole('button',{name:'Find what is missing',exact:true});await expect(next).toBeVisible();expect(calls).toBe(1);
 const input=page.getByRole('textbox',{name:'Message Muse'});await input.fill('My own next step');await expect(next).toBeHidden();await expect(input).toHaveValue('My own next step');
 await input.fill('');await expect(next).toBeVisible();
 fixture.response(async(body)=>{calls++;request=body.message;return {cards:[],updates:[],suggestions:['Choose a deadline']};});
 await next.click();await expect.poll(()=>calls).toBe(2);expect(request).toBe('Find what is missing');
 await expect(page.getByRole('button',{name:'Stop response',exact:true})).toHaveCount(0);
 await expect(page.locator('.muse-chat')).toHaveClass(/collapsed/);await chat(page);
 await expect(page.getByRole('button',{name:'Choose a deadline',exact:true})).toBeVisible();
 expect((await exported(page)).text).not.toContain('Choose a deadline');
 await selectNote(page,'followup-note');await expect(page.getByRole('button',{name:'Choose a deadline',exact:true})).toHaveCount(0);
 await fixture.owner('owner-b');await expect(page.getByRole('button',{name:'Choose a deadline',exact:true})).toHaveCount(0);
});

test('a late reply cannot suggest work for a selection the person has left',async({page})=>{
 const fixture=await museFixture(page);await send(page);await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
 await exported(page);
 await selectNote(page,'muse-test-0');let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 fixture.response(async()=>{entered=true;await gate;return {cards:[],updates:[],suggestions:['Expand the old selection']};});
 await send(page,'What could improve this?');await expect.poll(()=>entered).toBe(true);await selectNote(page,'muse-test-1');release();
 await expect(page.getByRole('textbox',{name:'Message Muse'})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Expand the old selection',exact:true})).toHaveCount(0);
});

test('stopping while the notebook saves prevents the model request',async({page})=>{
 const fixture=await museFixture(page);await page.getByRole('button',{name:'Open Muse',exact:true}).click();await page.getByRole('button',{name:'Edit Muse',exact:true}).click();
 await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','true');
 let release!:()=>void,entered=false,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 fixture.canvasSave(async()=>{entered=true;await gate;});fixture.response(async()=>{calls++;return {cards:[],updates:[]};});
 await page.getByRole('button',{name:'Note',exact:true}).click();await page.mouse.click(850,650);const note=page.locator('textarea[data-fabric="textarea"]');await note.fill('Keep my next steps short.');await note.press('Escape');
 await send(page,'Use my newest preference');await expect.poll(()=>entered).toBe(true);await page.getByRole('button',{name:'Stop response',exact:true}).click();release();
 await expect(page.locator('.muse-save-status')).toHaveText('Saved');await expect(page.locator('.muse-chat-thinking')).toHaveCount(0);expect(calls).toBe(0);
 await send(page,'Answer now');await expect.poll(()=>calls).toBe(1);
});
