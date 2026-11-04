import { test, expect, type Page } from '@playwright/test';
import { museFixture, exported, chat, send } from './muse-fixture';

async function openMuseEditor(page:Page) { await page.getByRole('button',{name:'Open Muse',exact:true}).click(); await page.getByRole('dialog',{name:'Muse',exact:true}).getByRole('button',{name:'Edit Muse',exact:true}).click(); }

const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3201';

test('Clerk exposes Google sign-in and keeps private Muse routes closed to anonymous requests', async ({ page, request }) => {
  for (const path of ['canvas', 'session', 'avatar', 'notes/soul', 'notes/memory', 'chat?thread=board:page','tasks?thread=board:page']) {
    const response = await request.get('/api/muse/' + path);
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toContain('no-store');
  }
  expect((await request.get('/api/muse/notes/soul', { headers: { 'x-clerk-auth-user-id': 'someone-else', 'x-clerk-auth-status': 'signed-in', Cookie: 'muze_muse_owner=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status()).toBe(401);
  expect((await request.put('/api/muse/notes/soul', { headers: { Origin: origin }, data: { content: 'Unauthorized' } })).status()).toBe(401);
  expect((await request.post('/api/muse/chat', { headers: { Origin: origin }, data: {} })).status()).toBe(401);
  expect((await request.put('/api/muse/avatar', { headers: { Origin: 'https://other.invalid' }, data: {} })).status()).toBe(403);
  expect((await request.post('/api/muse/session', { headers: { Origin: origin }, data: {} })).status()).toBe(405);
  const privateRequests: string[] = [];
  page.on('request', value => { if (new URL(value.url()).pathname.startsWith('/api/muse/')) privateRequests.push(value.url()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open Muse' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to share', exact: true }).click();
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  await page.locator('.cl-modalCloseButton').click();
  await openMuseEditor(page);
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  expect(privateRequests).toEqual([]);
  await page.screenshot({ path: 'verification/muze-clerk-sign-in.png' });
});

// These component fixtures replace network responses and Clerk UI only in the test bundle.
// The real server authorization boundary is exercised separately above.
test('Muse looks toward the pointer, floats through open space, and can be grabbed or moved with the keyboard', async ({ page }) => {
  await museFixture(page);
  const muse = page.getByRole('button', { name: 'Open Muse' });
  const face = muse.locator('.muse-portrait');
  const gaze = () => face.evaluate(el=>parseFloat(el.style.getPropertyValue('--motion-x')));
  await page.mouse.move(600, 400);
  await expect.poll(gaze).toBeGreaterThan(.5);
  await page.mouse.move(0, 650);
  await expect.poll(gaze).toBeLessThan(-.05);
  const start = (await muse.boundingBox())!;
  await page.mouse.move(700, 400);
  await expect.poll(async () => Math.abs((await muse.boundingBox())!.x - start.x), { timeout: 11000 }).toBeGreaterThan(45);
  const drifting = (await muse.boundingBox())!;
  const pointer = { x: drifting.x + 40, y: drifting.y + 35 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  const grabbed = (await muse.boundingBox())!;
  await page.mouse.move(pointer.x + 200, pointer.y - 100, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.muse-chat-messages')).toBeHidden();
  const dropped = (await muse.boundingBox())!;
  expect(Math.abs(dropped.x - grabbed.x - 200)).toBeLessThan(2);
  expect(Math.abs(dropped.y - grabbed.y + 100)).toBeLessThan(2);
  await muse.press('ArrowRight');
  await expect.poll(async () => (await muse.boundingBox())!.x).toBeCloseTo(dropped.x + 16, 0);
  await muse.press('Enter');
  await expect(page.getByRole('dialog',{name:'Muse',exact:true})).toBeVisible();
  await page.getByRole('dialog',{name:'Muse',exact:true}).getByRole('button',{name:'Edit Muse',exact:true}).click();
  await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','true');
});

test('canonical documents edit on the actual canvas and persist without entering ordinary exports', async ({page})=>{
 const fixture=await museFixture(page);
 await openMuseEditor(page);
 await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-ready','true');
 await page.mouse.dblclick(300,250);
 const input=page.locator('textarea[data-fabric="textarea"]');
 await expect(input).toBeAttached();await input.fill('# My own way\n\nKeep explanations brief.');await input.press('Escape');
 await expect.poll(()=>fixture.notes.get('owner-a:soul')?.content).toContain('My own way');
 await expect(page.locator('.muse-save-status')).toHaveText('Saved');
 await page.getByRole('button',{name:'Back to whiteboard'}).click();
 expect((await exported(page)).text).not.toContain('My own way');
 await openMuseEditor(page);
 expect((await exported(page)).text).toContain('My own way');
 await page.screenshot({path:'verification/muse-fabric-journal-desktop.png'});
});

test('account changes clear private canvas and chat',async({page})=>{
 const fixture=await museFixture(page);await openMuseEditor(page);
 await fixture.owner('owner-b');await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','false');
 await openMuseEditor(page);
 expect((await exported(page)).text).not.toContain('owner-a');
});

test('Muse moves to its work, adds spaced editable notes, and returns to its resting spot', async ({ page }) => {
  const fixture=await museFixture(page);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  fixture.response(async()=>{await gate;return {cards:[{id:'muse-test-0',title:'Direction',body:'Choose a goal.'},{id:'muse-test-1',title:'Resources',body:'Choose a first step.'},{id:'muse-test-2',title:'Review',body:'Check progress.'}],updates:[]};});
  const muse = page.getByRole('button', { name: 'Open Muse' });
  const initial = (await muse.boundingBox())!;
  await page.mouse.move(initial.x + 40, initial.y + 40); await page.mouse.down(); await page.mouse.move(410, 420, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await muse.boundingBox())!.x).toBeGreaterThan(300);
  await expect(page.locator('.muse-chat-messages')).toBeHidden();
  await chat(page); await send(page);
  await expect(page.locator('.muse-floating')).toHaveClass(/working/);
  release();
  await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
  await expect(page.getByText('Updated your board · Undo available', { exact: true })).toHaveCount(0);
  const plan = await exported(page);
  expect(plan.objects).toHaveLength(3);
  for (const [i, a] of plan.objects.entries()) for (const b of plan.objects.slice(i + 1)) expect(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top).toBe(true);
  await expect(page.locator('.muse-floating')).not.toHaveClass(/working/);
  await page.screenshot({ path: 'verification/muze-collaboration.png' });
  await page.getByRole('button', { name: 'Close Muse chat' }).click();
  // Leave the character's hover area so its intentional hover pause can release.
  await page.mouse.move(1400,100);
  await expect(page.locator('.muse-floating')).not.toHaveClass(/working/, { timeout: 9000 });
  await expect.poll(()=>muse.evaluate(el=>parseFloat(el.style.left))).toBe(24);
  await expect.poll(async()=>Math.abs((await muse.boundingBox())!.x-24)).toBeLessThan(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exported(page)).objects).toHaveLength(3);
});

test('follow-ups update the same plan and preserve edits made while Muse answers', async ({ page }) => {
  const fixture = await museFixture(page);
  const expectDirectChat = async () => {
    await expect(page.locator('.muse-task-panel')).toHaveCount(0);
    await expect(page.getByText('Work through a task', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add to board', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  };
  await chat(page); await expectDirectChat(); await send(page);
  await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
  const plan = await exported(page), first = plan.objects[0], second = plan.objects[1];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.response(async () => { await gate; return { cards: [], updates: [{ id: first.id, text: 'Muse revision', expectedText: first.text }, { id: second.id, text: 'Updated resources\n\nBring a notebook.', expectedText: second.text }] }; });
  await send(page, 'Refine this plan');
  await expect(page.locator('.muse-chat-thinking')).toBeVisible();
  const [zoom, , , , x, y] = plan.viewport;
  await page.mouse.dblclick(first.left * zoom + x + 70, first.top * zoom + y + 70);
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('My newer edit'); await page.keyboard.press('Escape');
  release();
  await expect(page.getByText('Kept 1 card you changed or locked.')).toBeVisible();
  const updated = await exported(page);
  expect(updated.objects).toHaveLength(3);
  expect(updated.objects.find(object => object.id === first.id)?.text).toBe('My newer edit');
  expect(updated.objects.find(object => object.id === second.id)?.text).toContain('Updated resources');
  const heading = { muzeLeading: 1.5, styles: expect.arrayContaining([expect.objectContaining({ start: 0, style: expect.objectContaining({ fontSize: 24, fontWeight: 600 }) })]) };
  expect(updated.objects.find(object => object.id === second.id)).toMatchObject(heading);
  await expectDirectChat();
  await page.reload(); await chat(page);
  await expect(page.locator('.muse-message.assistant')).toHaveCount(2);
  await expectDirectChat();
  const restored = await exported(page);
  expect(restored.objects).toHaveLength(3);
  expect(restored.objects.find(object => object.id === first.id)?.text).toBe('My newer edit');
  expect(restored.objects.find(object => object.id === second.id)?.text).toContain('Updated resources');
  expect(restored.objects.find(object => object.id === second.id)).toMatchObject(heading);
});

test('custom icons and the private editor work on a narrow screen', async ({ page }) => {
  await museFixture(page);
  await openMuseEditor(page);
  const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#d497ca'; ctx.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.getByLabel('Choose Muse icon', { exact: true }).setInputFiles({ name: 'muse.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await expect(page.locator('.muze-vector-surface [id="muse-appearance"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Back to whiteboard' })).toBeVisible();
  await expect(page.locator('.muze-drawing-surface canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: 'verification/muze-private-mobile.png' });
});

test('switching pages cancels pending work without adding it to the new page', async ({ page }) => {
  const fixture = await museFixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.response(async () => { await gate; return { cards: [{ id: 'late-card', title: 'Old page work', body: 'This belongs to the old page.' }], updates: [] }; });
  await chat(page); await send(page);
  await expect(page.locator('.muse-chat-thinking')).toBeVisible();
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pages', exact: true })).toContainText('Page 2');
  release();
  await expect(page.locator('.muse-chat-thinking')).toHaveCount(0);
  expect((await exported(page)).objects).toHaveLength(0);
});


test('bottom chat precedes More; comments persist on ordinary boards', async ({page}) => {
 await museFixture(page);
 const tools=page.getByRole('toolbar',{name:'Whiteboard tools',exact:true});
 await expect(tools.getByRole('button').last()).toHaveAttribute('aria-label','More tools');
 await page.getByRole('textbox',{name:'Message Muse',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Message Muse'})).toBeVisible();
 await page.getByRole('button',{name:'Close Muse chat'}).click();
 await page.getByRole('button',{name:'Comment',exact:true}).click();await page.mouse.click(1050,400);
 await page.getByRole('textbox',{name:'Write a comment'}).fill('Review this board Friday');
 await page.getByRole('button',{name:'Post comment'}).click();
 await expect(page.getByRole('dialog',{name:'Canvas comment'})).toContainText('Review this board Friday');
 expect((await exported(page)).text).toContain('Review this board Friday');
});

test('special notebook uses normal tools, local media, comments and visible unsupported-drop errors',async({page})=>{
 const fixture=await museFixture(page);await openMuseEditor(page);
 await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-ready','true');
 await page.getByRole('button',{name:'Rectangle',exact:true}).click();await page.mouse.move(950,450);await page.mouse.down();await page.mouse.move(1100,550);await page.mouse.up();
 await expect.poll(()=>fixture.canvases.get('owner-a')?.board.pages[0].objects.length).toBeGreaterThan(4);
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await expect.poll(()=>fixture.canvases.get('owner-a')?.board.pages[0].objects.length).toBe(4);
 await page.getByRole('button',{name:'Redo',exact:true}).click();
 await expect.poll(()=>fixture.canvases.get('owner-a')?.board.pages[0].objects.length).toBeGreaterThan(4);
 for(const target of ['.muze-drawing-surface','.muze-header','.muze-toolbar-dock']) {
   await page.locator(target).evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['pdf'],'scan.pdf',{type:'application/pdf'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});
   await expect(page.getByRole('alert')).toContainText('not supported');await page.getByRole('button',{name:'Dismiss message'}).click();
 }
 await page.getByRole('button',{name:'Comment',exact:true}).click();await page.mouse.click(1050,400);await page.getByRole('textbox',{name:'Write a comment'}).fill('Remember the Friday review');await page.getByRole('button',{name:'Post comment'}).click();
 await expect.poll(()=>JSON.stringify(fixture.canvases.get('owner-a')?.board.comments)).toContain('Friday review');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Close comment'}).click();await page.getByRole('button',{name:'Zoom',exact:true}).click();await page.getByRole('menuitem',{name:/^Fit to content/}).click();
 await expect(page.locator('.muse-save-status')).toHaveText('Saved');
  await page.screenshot({path:'verification/muse-fabric-journal-mobile.png'});
});

test('replacing an avatar automatically generates and activates without extra confirmation', async ({page}) => {
 await museFixture(page);await openMuseEditor(page);await page.getByRole('button',{name:'Back to whiteboard'}).click();await page.getByRole('button',{name:'Open Muse',exact:true}).click();await page.getByRole('dialog',{name:'Muse',exact:true}).getByRole('button',{name:'Change avatar'}).click();await expect(page.getByRole('button',{name:'Change Muse icon'})).toBeVisible();await expect(page.locator('.muse-appearance-actions')).toHaveCount(0);
 const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=96;const x=c.getContext('2d')!;x.fillStyle='#decfaa';x.fillRect(0,0,96,96);return c.toDataURL('image/png').split(',')[1];});let calls=0;page.on('request',r=>{if(r.url().endsWith('/api/muse/avatar')&&r.method()==='POST'){calls++;const b=r.postDataJSON();expect(b.action).toBe('replace');expect(b.maxCostUsd).toBe(.01);expect(b.shareWithMeta).toBe(true);}});
 await page.getByLabel('Choose Muse icon',{exact:true}).setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});await expect(page.locator('.muse-sr-only[role=status]')).toHaveText('Avatar updated.');expect(calls).toBe(1);await expect(page.getByRole('group',{name:'Confirm avatar generation'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Use these gaze frames'})).toHaveCount(0);await page.getByRole('button',{name:'Back to whiteboard'}).click();const portrait=page.locator('.muse-floating .muse-portrait');await expect(portrait).toHaveAttribute('data-portrait-source','/api/muse/avatar?sheet=true&v=gaze-test&display=portrait');await page.mouse.move(1400,100);await expect.poll(()=>portrait.evaluate(el=>parseFloat(el.style.getPropertyValue('--motion-x')))).toBeGreaterThan(.5);
});

test('shared documents create, edit, move, resize and survive reload on ordinary and Muse canvases',async({page})=>{
 const fixture=await museFixture(page);
 for(const special of [false,true]) {
  if(special)await openMuseEditor(page);
  await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-ready','true');
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Add document',exact:true}).click();
  let snapshot=await exported(page);let doc=snapshot.objects.find(o=>o.type==='MuzeDocument'&&!o.id.startsWith('muse-file-'))!;
  expect(doc).toBeTruthy();
  const viewport=snapshot.viewport;const x=doc.left*viewport[0]+viewport[4]+60,y=doc.top*viewport[0]+viewport[5]+60;
  await page.mouse.dblclick(x,y);const input=page.locator('textarea[data-fabric="textarea"]');await expect(input).toBeAttached();await input.fill('# A small plan\n\n**Remember** the picnic.');await input.press('Escape');
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+75,y+35,{steps:8});await page.mouse.up();
  snapshot=await exported(page);doc=snapshot.objects.find(o=>o.id===doc.id)!;expect(doc.left).toBeGreaterThan(100);
  // Textbox's right middle control changes document width without a separate editor.
  await page.mouse.click(doc.left*viewport[0]+viewport[4]+30,doc.top*viewport[0]+viewport[5]+30);

  const editing=page.locator('textarea[data-fabric="textarea"]');if(await editing.count())await editing.press('Escape');
  snapshot=await exported(page);doc=snapshot.objects.find(o=>o.id===doc.id)!;
  const rendered=(await page.locator('.muze-vector-surface [id="'+doc.id+'"]').boundingBox())!;
  const right=rendered.x+rendered.width,middle=rendered.y+rendered.height/2;
  await page.mouse.move(right,middle);await page.mouse.down();await page.mouse.move(right+55,middle,{steps:8});await page.mouse.up();
  const resized=(await exported(page)).objects.find(o=>o.id===doc.id)!;expect(resized.width).toBeGreaterThan(doc.width);
  if(special)await expect(page.locator('.muse-save-status')).toHaveText('Saved');
  await page.reload();await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-ready','true');
  if(special)await openMuseEditor(page);
  const restored=(await exported(page)).text;expect(restored).toContain('Remember');expect(restored).toContain('MuzeDocument');
  if(!special)expect(fixture.canvases.get('owner-a')?.board.pages[0].objects.length).toBe(4);
 }
});


test('Markdown imports use shared document elements and do not fetch embedded images',async({page})=>{
 const fixture=await museFixture(page);const external:string[]=[];page.on('request',r=>{if(r.url().includes('example.invalid'))external.push(r.url());});
 for(const special of [false,true]) {
  if(special)await openMuseEditor(page);
  await page.getByRole('button',{name:'More tools',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import document',exact:true}).click();
  await (await chooser).setFiles({name:'picnic.md',mimeType:'text/markdown',buffer:Buffer.from('# Picnic\n\n**Bring** sandwiches.\n![reference](https://example.invalid/photo.png)')});
  await expect.poll(async()=> (await exported(page)).text).toContain('picnic.md');
  const data=(await exported(page)).text;expect(data).toContain('**Bring**');expect(data).toContain('MuzeDocument');
  if(special)await expect(page.locator('.muse-save-status')).toHaveText('Saved');
  else expect(JSON.stringify(fixture.canvases.get('owner-a'))).not.toContain('sandwiches');
 }
 expect(external).toEqual([]);
});

 test('Muse popup opens before Edit, dismisses, and reopens after returning',async({page})=>{
  await museFixture(page);
  const character=page.getByRole('button',{name:'Open Muse',exact:true}), popup=page.getByRole('dialog',{name:'Muse',exact:true}), board=page.getByRole('main',{name:'Tomo'});
  await character.click();await expect(popup).toBeVisible();await expect(board).toHaveAttribute('data-muse-board','false');
  await page.keyboard.press('Escape');await expect(popup).toBeHidden();await expect(character).toBeFocused();
  await character.click();await page.mouse.click(700,100);await expect(popup).toBeHidden();
  await character.click();await popup.getByRole('button',{name:'Close Muse popup'}).click();await expect(popup).toBeHidden();
  await character.click();await popup.getByRole('button',{name:'Edit Muse',exact:true}).click();await expect(board).toHaveAttribute('data-muse-board','true');await expect(popup).toBeHidden();
  await page.getByRole('button',{name:'Back to whiteboard'}).click();await expect(board).toHaveAttribute('data-muse-board','false');await character.click();await expect(popup).toBeVisible();
  await page.setViewportSize({width:390,height:844});await expect(popup).toBeVisible();await page.screenshot({path:'verification/muse-popup-mobile.png'});
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'verification/muse-popup-desktop.png'});
 });

test('anchored comments follow pan and zoom, persist, edit, cancel and reopen on both boards',async({page})=>{
 await museFixture(page);
 for(const special of [false,true]){
  if(special)await openMuseEditor(page);
  if(special)await expect(page.locator('[data-comment-id="muse-welcome"]')).toBeVisible();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.getByRole('button',{name:'Hand',exact:true}).click();await page.mouse.move(700,500);await page.mouse.down();await page.mouse.move(760,540);await page.mouse.up();
  const before=await exported(page),[zoom,,,,tx,ty]=before.viewport;
  await page.getByRole('button',{name:'Comment',exact:true}).click();const origin=(await page.locator('.upper-canvas').boundingBox())!;await page.mouse.click(990,480);
  const dialog=page.getByRole('dialog',{name:'Canvas comment'});
  await dialog.getByRole('textbox',{name:'Write a comment'}).fill('An anchored thought '+special);await dialog.getByRole('button',{name:'Post comment'}).click();
  await dialog.getByRole('button',{name:'Close comment'}).click();
  const data=JSON.parse((await exported(page)).text), comment=data.board.comments.find((c:{text:string})=>c.text==='An anchored thought '+special);
  expect(comment.x).toBeCloseTo((990-origin.x-tx)/zoom,2);expect(comment.y).toBeCloseTo((480-origin.y-ty)/zoom,2);expect(comment.pageId).toBe(data.board.activePage);
  let pin=page.locator('[data-comment-id="'+comment.id+'"]');await pin.click();await dialog.getByRole('button',{name:'Edit comment'}).click();await dialog.getByRole('textbox').fill('Revised anchored thought '+special);await dialog.getByRole('button',{name:'Save comment'}).click();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Hand',exact:true}).click();await page.mouse.move(700,500);await page.mouse.down();await page.mouse.move(740,530);await page.mouse.up();
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();const after=await exported(page),[z,,,,x,y]=after.viewport,box=(await pin.boundingBox())!;
  const canvas=(await page.locator('.upper-canvas').boundingBox())!;expect(box.x+box.width/2).toBeCloseTo(comment.x*z+x+canvas.x,0);expect(box.y+box.height/2).toBeCloseTo(comment.y*z+y+canvas.y,0);
  await page.getByRole('button',{name:'Comment',exact:true}).click();await page.mouse.click(1000,600);await dialog.getByRole('textbox').fill('Cancel me');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect((await exported(page)).text).not.toContain('Cancel me');
  if(special)await expect(page.locator('.muse-save-status')).toHaveText('Saved');await page.reload();if(special)await openMuseEditor(page);
  pin=page.locator('[data-comment-id="'+comment.id+'"]');await pin.click();await expect(dialog).toContainText('Revised anchored thought '+special);await page.mouse.click(700,100);await expect(dialog).toBeHidden();
  await pin.click();await page.screenshot({path:'verification/anchored-comments-'+(special?'muse':'ordinary')+'.png'});await page.keyboard.press('Escape');
  if(special){
   await page.setViewportSize({width:390,height:844});
   await expect.poll(()=>page.locator('.upper-canvas').evaluate(canvas=>canvas.getBoundingClientRect().width)).toBe(390);
   // Mobile framing is scheduled after ResizeObserver over two animation frames.
   // Measure the pin after that viewport change, before calculating a pan delta.
   await page.evaluate(()=>new Promise<void>(resolve=>{let frames=4;const next=()=>--frames?requestAnimationFrame(next):resolve();requestAnimationFrame(next);}));
   const position=(await pin.boundingBox())!;await page.mouse.move(200,300);await page.mouse.wheel(position.x+position.width/2-160,position.y+position.height/2-300);
   await expect.poll(async()=>{const box=await pin.boundingBox();return box?Math.abs(box.x+box.width/2-160)+Math.abs(box.y+box.height/2-300):Infinity;}).toBeLessThan(2);
   await pin.click();await page.screenshot({path:'verification/anchored-comments-mobile.png'});await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'Back to whiteboard'}).click();
  }
 }
});

test('Muse popup exposes chat and opens avatar controls through its existing board',async({page})=>{
 await museFixture(page);const character=page.getByRole('button',{name:'Open Muse',exact:true}),popup=page.getByRole('dialog',{name:'Muse',exact:true});
 await character.click();await expect(popup.getByRole('button',{name:'Edit Muse',exact:true})).toBeVisible();await expect(popup.getByRole('button',{name:'Change avatar',exact:true})).toBeVisible();
 await popup.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.locator('.muse-chat-messages')).toBeVisible();await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','false');await page.getByRole('button',{name:'Close Muse chat'}).click();
 await character.click();await popup.getByRole('button',{name:'Change avatar',exact:true}).click();await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','true');await expect(page.getByRole('button',{name:'Change Muse icon',exact:true})).toBeVisible();await expect(page.locator('.muze-vector-surface [id="muse-appearance"]')).toBeVisible();
 await page.getByRole('button',{name:'Back to whiteboard'}).click();await character.click();await page.screenshot({path:'verification/muse-actions-desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'verification/muse-actions-mobile.png'});
});

test('document name colors survive rename, editing and reload on both boards',async({page})=>{
 await museFixture(page);
 for(const special of [false,true]){
  if(special)await openMuseEditor(page);
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Add document',exact:true}).click();
  const before=JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:{type:string;id:string})=>o.type==='MuzeDocument'&&!o.id.startsWith('muse-file-'));
  await page.getByRole('button',{name:'Selection actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename document',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Rename document'});await dialog.getByRole('textbox',{name:'Document name'}).fill('Picnic.md');await dialog.getByRole('button',{name:'Save name'}).click();
  const named=JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:{id:string})=>o.id===before.id);expect(named.documentTitle).toBe('Picnic.md');expect(named.backgroundColor).not.toBe(before.backgroundColor);
  const bounds=(await page.locator('.muze-vector-surface [id="'+before.id+'"]').boundingBox())!;await page.mouse.dblclick(bounds.x+60,bounds.y+70);const input=page.locator('textarea[data-fabric="textarea"]');await input.fill('# A picnic\n\nBring a blanket.');await input.press('Escape');
  if(special)await expect(page.locator('.muse-save-status')).toHaveText('Saved');await page.reload();if(special)await openMuseEditor(page);
  const loaded=JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:{id:string})=>o.id===before.id);expect(loaded.documentTitle).toBe('Picnic.md');expect(loaded.backgroundColor).toBe(named.backgroundColor);expect(loaded.markdown).toContain('Bring a blanket.');
  const app=await page.locator('.muze-app').evaluate(el=>{const s=getComputedStyle(el);return {canvas:s.getPropertyValue('--canvas'),blue:s.getPropertyValue('--blue')};});expect(app).toEqual({canvas:'#f9fafb',blue:'#2e70d6'});
  await page.screenshot({path:'verification/document-colors-'+(special?'muse':'ordinary')+'.png'});
 }
});

test('composer stays aligned with the drawing toolbar and grows for multiline text',async({page})=>{
 await museFixture(page);await page.getByRole('button',{name:'Rectangle',exact:true}).click();await page.mouse.move(300,300);await page.mouse.down();await page.mouse.move(400,400);await page.mouse.up();
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);const input=page.getByRole('textbox',{name:'Message Muse'});await input.fill('A single line');
  const metrics=await input.evaluate(el=>{const s=getComputedStyle(el);return {height:el.getBoundingClientRect().height,min:parseFloat(s.minHeight),line:parseFloat(s.lineHeight),top:parseFloat(s.paddingTop),bottom:parseFloat(s.paddingBottom),border:parseFloat(s.borderTopWidth)+parseFloat(s.borderBottomWidth)};});expect(metrics.top).toBe(metrics.bottom);expect(metrics.height).toBeCloseTo(Math.max(metrics.min,metrics.line+metrics.top+metrics.bottom+metrics.border),0);
  await expect(page.getByRole('button',{name:'Attach image',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Send to Muse',exact:true})).toBeVisible();await expect(page.locator('.muse-history-controls')).toHaveCount(0);
  const toolbar=page.getByRole('toolbar',{name:'Whiteboard tools',exact:true});await expect(toolbar.getByRole('button',{name:'Undo',exact:true})).toBeEnabled();await expect(toolbar.getByRole('button',{name:'Redo',exact:true})).toBeVisible();
  const dock=(await page.locator('.muze-toolbar-dock').boundingBox())!,box=(await page.locator('.muse-chat').boundingBox())!;expect(Math.abs(box.width-dock.width)).toBeLessThan(2);expect(Math.abs(box.x-dock.x)).toBeLessThan(2);expect(box.y+box.height).toBeLessThanOrEqual(dock.y);expect(dock.x).toBeGreaterThanOrEqual(0);expect(dock.x+dock.width).toBeLessThanOrEqual(viewport.width);
  await input.fill('Line one\nLine two\nLine three');const larger=(await input.boundingBox())!;expect(larger.height).toBeGreaterThan(metrics.height);expect(larger.height).toBeLessThanOrEqual(126);
  await page.screenshot({path:'verification/composer-'+viewport.width+'.png'});
 }
});

test('More stays anchored and preserves document drafts with keyboard and narrow layouts',async({page})=>{
 await museFixture(page);
 for(const special of [false,true]){
  if(special)await openMuseEditor(page);
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Add document',exact:true}).click();
  const doc=(await exported(page)).objects.find(o=>o.type==='MuzeDocument'&&!o.id.startsWith('muse-file-'))!,bounds=(await page.locator('.muze-vector-surface [id="'+doc.id+'"]').boundingBox())!;await page.mouse.dblclick(bounds.x+60,bounds.y+70);await page.locator('textarea[data-fabric="textarea"]').fill('Draft stays here');
  const more=page.getByRole('button',{name:'More tools',exact:true});await more.click();const panel=page.getByRole('toolbar',{name:'More drawing tools'});await expect(panel).toBeVisible();await page.keyboard.press('ArrowRight');await expect(panel.getByRole('button').nth(1)).toBeFocused();await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(more).toBeFocused();expect((await exported(page)).text).toContain('Draft stays here');
  await page.setViewportSize({width:390,height:844});await page.getByRole('textbox',{name:'Message Muse'}).fill('A thought while choosing tools');await more.click();const p=(await panel.boundingBox())!;expect(p.x).toBeGreaterThanOrEqual(0);expect(p.x+p.width).toBeLessThanOrEqual(390);expect(p.y).toBeGreaterThanOrEqual(70);await expect.poll(async()=>{const panelBox=(await panel.boundingBox())!,chatBox=(await page.locator('.muse-chat-stack').boundingBox())!;return chatBox.y+chatBox.height<panelBox.y;}).toBe(true);await page.screenshot({path:'verification/more-'+(special?'muse':'ordinary')+'-mobile.png'});
  await page.mouse.click(370,100);await expect(panel).toBeHidden();await more.click();await page.getByRole('button',{name:'Comment',exact:true}).click();await expect(panel).toBeHidden();await page.mouse.click(200,300);await expect(page.getByRole('dialog',{name:'Canvas comment'})).toBeVisible();await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});
 }
});

test('generated notes use stable organic poses and honor explicit aligned layouts',async({page})=>{
 const fixture=await museFixture(page);await send(page,'Brainstorm a project');await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);
 const first=JSON.parse((await exported(page)).text).board.pages[0].objects;expect(first.some((o:{angle:number})=>Math.abs(o.angle)>0)).toBe(true);await page.getByRole('button',{name:'Close Muse chat'}).click();await page.getByRole('button',{name:'Undo',exact:true}).click();expect((await exported(page)).objects).toHaveLength(0);await page.getByRole('button',{name:'Redo',exact:true}).click();const restored=JSON.parse((await exported(page)).text).board.pages[0].objects;expect(restored.map((o:any)=>[o.id,o.left,o.top,o.angle])).toEqual(first.map((o:any)=>[o.id,o.left,o.top,o.angle]));await page.reload();expect(JSON.parse((await exported(page)).text).board.pages[0].objects.map((o:any)=>[o.left,o.top,o.angle])).toEqual(first.map((o:any)=>[o.left,o.top,o.angle]));
 fixture.response(async()=>({cards:[{id:'aligned-a',title:'First',body:'A short note'},{id:'aligned-b',title:'Second',body:'Another short note'}],updates:[]}));await send(page,'Add two notes aligned in a grid');await expect.poll(async()=>JSON.parse((await exported(page)).text).board.pages[0].objects.length).toBe(5);const all=JSON.parse((await exported(page)).text).board.pages[0].objects;for(const o of all.filter((o:any)=>o.id.startsWith('aligned')))expect(o.angle).toBe(0);expect(all.filter((o:any)=>!o.id.startsWith('aligned')).map((o:any)=>[o.id,o.left,o.top,o.angle])).toEqual(first.map((o:any)=>[o.id,o.left,o.top,o.angle]));
});

for(const width of [1440,390])test(`generated notes keep readable hierarchy above the composer at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await museFixture(page);await send(page,'Outline a project');
 const notes=page.locator('.muze-vector-surface [id^="muse-test-"]');await expect(notes).toHaveCount(3);
 const snapshot=await exported(page),zoom=snapshot.viewport[0];
 for(const item of snapshot.objects){
  const note=item as typeof item & {fontSize:number;muzeLeading:number;styles:{start:number;end:number;style:{fontSize?:number;fontWeight?:number}}[]};
  expect(note.fontSize).toBe(18);expect(note.muzeLeading).toBeGreaterThanOrEqual(1.4);expect(note.fontSize*zoom).toBeGreaterThanOrEqual(13);
  expect(note.styles).toEqual(expect.arrayContaining([expect.objectContaining({start:0,style:expect.objectContaining({fontSize:24,fontWeight:600})})]));
 }
 const header=(await page.locator('.muze-header').boundingBox())!,composer=(await page.locator('.muse-chat-stack').boundingBox())!;
 const visible=width>700?await notes.all():[page.locator('.muze-vector-surface [id="muse-test-0"]')];
 for(const note of visible){const box=(await note.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(8);expect(box.x+box.width).toBeLessThanOrEqual(width-8);expect(box.y).toBeGreaterThanOrEqual(header.y+header.height);expect(box.y+box.height).toBeLessThanOrEqual(composer.y-8);}
 if(width<=700)await expect.poll(async()=>{const muse=await page.getByRole('button',{name:'Open Muse',exact:true}).boundingBox(),bounds=await Promise.all([visible[0],page.locator('.muze-toolbar-dock'),page.locator('.muse-chat-stack')].map(item=>item.boundingBox()));return !!muse&&bounds.every(box=>box&&!(muse.x<box.x+box.width&&muse.x+muse.width>box.x&&muse.y<box.y+box.height&&muse.y+muse.height>box.y));}).toBe(true);
 await page.screenshot({path:`/tmp/muze-clear-notes-${width}.png`});
});

test('mobile entry frames existing page content once and preserves a deliberate pan',async({page})=>{
 await museFixture(page);await send(page,'Outline a project');await expect(page.locator('.muze-vector-surface [id^="muse-test-"]')).toHaveCount(3);await page.getByRole('button',{name:'Close Muse chat',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 const first=page.locator('.muze-vector-surface [id="muse-test-0"]');
 const openingVisible=async()=>{const box=await first.boundingBox(),composer=await page.locator('.muse-chat-stack').boundingBox();return !!box&&!!composer&&box.x>=8&&box.x+box.width<=(page.viewportSize()!.width-8)&&box.y>=70&&box.y+box.height<composer.y;};
 await expect.poll(openingVisible).toBe(true);
 const initial=await exported(page);await page.getByRole('button',{name:'Hand',exact:true}).click();await expect(page.getByRole('button',{name:'Hand',exact:true})).toHaveAttribute('aria-pressed','true');await expect.poll(()=>page.evaluate(()=>document.elementFromPoint(190,300)?.tagName)).toBe('CANVAS');await page.mouse.move(190,300);await page.mouse.down();await page.mouse.move(270,370,{steps:8});await page.mouse.up();
 const panned=(await exported(page)).viewport;expect(panned[4]-initial.viewport[4]).toBeGreaterThan(60);expect(panned[5]-initial.viewport[5]).toBeGreaterThan(50);
 await page.getByRole('textbox',{name:'Message Muse',exact:true}).fill('Keep my place while I type');await page.getByRole('button',{name:'Close Muse chat',exact:true}).click();
 await page.setViewportSize({width:400,height:844});expect((await exported(page)).viewport).toEqual(panned);
 await page.reload();await expect.poll(openingVisible).toBe(true);
 await page.getByRole('button',{name:'Pages',exact:true}).click();await page.getByRole('menuitem',{name:'New page',exact:true}).click();
 await expect(page.getByRole('button',{name:'Pages',exact:true})).toContainText('Page 2');
 await page.getByRole('button',{name:'Pages',exact:true}).click();await page.getByRole('button',{name:'Open Page 1',exact:true}).click();await expect.poll(openingVisible).toBe(true);
});

test('pending notebook preferences save before leaving and remain available to workspace chat',async({page})=>{
 const fixture=await museFixture(page);await openMuseEditor(page);
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>release=resolve);fixture.canvasSave(async()=>{entered=true;await gate;});
 await page.getByRole('button',{name:'Note',exact:true}).click();await page.mouse.click(850,650);const input=page.locator('textarea[data-fabric="textarea"]');await input.fill('Please sound like a cat. Meow occasionally.');await input.press('Escape');
 await page.getByRole('button',{name:'Back to whiteboard'}).click();await expect.poll(()=>entered).toBe(true);await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','true');release();fixture.canvasSave(async()=>{});await expect(page.getByRole('main',{name:'Tomo'})).toHaveAttribute('data-muse-board','false');
 let contextIncluded=false;fixture.response(async()=>{contextIncluded=JSON.stringify(fixture.canvases.get('owner-a')?.board).includes('Please sound like a cat.');return {cards:[],updates:[]};});await send(page,'Hello');await expect.poll(()=>contextIncluded).toBe(true);await page.reload();await openMuseEditor(page);expect((await exported(page)).text).toContain('Please sound like a cat.');
});

test('appearance image is labeled, swappable and centered; hybrid portrait respects reduced motion',async({page})=>{
 await museFixture(page);const character=page.getByRole('button',{name:'Open Muse',exact:true}),portrait=character.locator('.muse-portrait');await expect.poll(()=>portrait.evaluate(el=>el.style.getPropertyValue('--motion-x'))).not.toBe('');
 const frame=await character.locator('.muse-avatar').evaluate(el=>{const s=getComputedStyle(el),b=el.getBoundingClientRect();return {width:b.width,height:b.height,radius:s.borderRadius,overflow:s.overflow};});expect(frame.width).toBeCloseTo(frame.height,1);expect(frame.overflow).toBe('hidden');expect(frame.radius).not.toBe('0px');
 const source=await portrait.getAttribute('data-portrait-source');for(const [x,y] of [[1400,100],[0,850],[1200,700],[100,100]])await page.mouse.move(x,y,{steps:3});await expect(portrait).toHaveAttribute('data-portrait-source',source!);await page.emulateMedia({reducedMotion:'reduce'});await expect.poll(()=>portrait.evaluate(el=>Number(el.style.getPropertyValue('--motion-x')))).toBe(0);await expect(portrait).toHaveAttribute('data-pose-cell','12');await page.emulateMedia({reducedMotion:'no-preference'});
 await character.click();await page.getByRole('dialog',{name:'Muse',exact:true}).getByRole('button',{name:'Change avatar'}).click();await expect(page.getByRole('button',{name:'Change Muse icon'})).toBeVisible();await expect(page.locator('.muse-appearance-label')).toHaveText('Muse’s avatar');
 const image=page.locator('.muze-vector-surface [id="muse-appearance"]'),label=page.locator('.muse-appearance-label');for(const action of [async()=>{},async()=>{await page.getByRole('button',{name:'Zoom out',exact:true}).click();}]){await action();await expect(image).toBeVisible();await expect(label).toBeVisible();await expect.poll(async()=>{const a=await image.boundingBox(),b=await label.boundingBox();return a&&b?Math.abs(b.x+b.width/2-a.x-a.width/2):Infinity;}).toBeLessThan(1);}
 const initial=JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:any)=>o.id==='muse-appearance').src;
 let paidCalls=0;page.on('request',req=>{if(req.url().endsWith('/api/muse/avatar')&&req.method()==='POST')paidCalls++;});const sourceImage=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d')!;ctx.fillStyle='#9bbbd3';ctx.fillRect(0,0,64,64);return c.toDataURL('image/png').split(',')[1];});await page.getByLabel('Choose Muse icon',{exact:true}).setInputFiles({name:'pet.png',mimeType:'image/png',buffer:Buffer.from(sourceImage,'base64')});await expect.poll(async()=>JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:any)=>o.id==='muse-appearance').src).not.toBe(initial);expect(paidCalls).toBe(1);await expect(page.locator('.muse-save-status')).toHaveText('Saved');await page.reload();await openMuseEditor(page);expect(JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:any)=>o.id==='muse-appearance').src).not.toBe(initial);
 await page.screenshot({path:'verification/muse-avatar-image-label.png'});await page.getByRole('button',{name:'Back to whiteboard'}).click();await expect(page.locator('.muse-floating .muse-portrait')).toBeVisible();await page.mouse.move(1400,100);await expect.poll(()=>page.locator('.muse-floating .muse-portrait').evaluate(el=>parseFloat(el.style.getPropertyValue('--motion-x')))).toBeGreaterThan(.5);await page.screenshot({path:'verification/muse-custom-portrait.png'});
});

test('selection actions stay attached to the toolbar with reachable history on mobile',async({page})=>{
 await museFixture(page);await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Add document',exact:true}).click();
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.getByRole('textbox',{name:'Message Muse'}).fill('Typing while an item is selected');
  const dock=page.locator('.muze-toolbar-dock'),row=dock.getByRole('toolbar',{name:'Selection tools',exact:true}),tools=dock.getByRole('toolbar',{name:'Whiteboard tools',exact:true});
  await expect(row.getByRole('button',{name:'Duplicate selected',exact:true})).toBeVisible();await expect(tools.getByRole('button',{name:'Undo',exact:true})).toBeEnabled();await expect(tools.getByRole('button',{name:'Redo',exact:true})).toBeVisible();
  const r=(await row.boundingBox())!,c=(await page.locator('.muse-chat-stack .muse-chat').boundingBox())!,toolbar=(await dock.boundingBox())!,main=(await tools.boundingBox())!;
  expect(r.y).toBeGreaterThanOrEqual(toolbar.y);expect(r.y+r.height).toBeLessThanOrEqual(main.y+1);expect(c.y+c.height).toBeLessThanOrEqual(toolbar.y);expect(Math.abs(c.width-toolbar.width)).toBeLessThan(2);await expect(page.locator('.muse-history-controls')).toHaveCount(0);
  await page.getByRole('button',{name:'More tools',exact:true}).click();await expect(page.getByRole('toolbar',{name:'More drawing tools'})).toBeVisible();await page.mouse.move(width-10,150);await page.screenshot({path:'verification/selection-controls-'+width+'.png'});await page.keyboard.press('Escape');
 }
});

test('canvas name edits confirm on blur, preserve identity on revert, and persist on rename',async({page})=>{
 const fixture=await museFixture(page);await openMuseEditor(page);await page.screenshot({path:'verification/muse-title-default.png'});const label=page.locator('.muze-vector-surface [id="muse-name"]');const select=async()=>{await expect(async()=>{const box=await label.boundingBox();expect(box).not.toBeNull();await page.mouse.click(box!.x+Math.min(80,box!.width/2),box!.y+box!.height/2);await expect(page.getByRole('textbox',{name:'Muse name',exact:true})).toBeVisible({timeout:300});}).toPass({timeout:5000,intervals:[100,250,500]});};await select();const input=page.getByRole('textbox',{name:'Muse name',exact:true});await expect(input).toBeVisible();await expect(page.locator('.muse-name-editor button')).toHaveCount(0);await expect(input).toHaveCSS('font-family',/Shantell Sans/);await input.fill('A long friendly companion name');await page.setViewportSize({width:390,height:844});await expect.poll(async()=>{const field=(await input.boundingBox())!;return field.x+field.width;}).toBeLessThanOrEqual(390);await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});await select();
 await input.fill('');await page.mouse.click(700,650);const dialog=page.getByRole('dialog',{name:'Confirm Muse name'});await dialog.getByRole('button',{name:'Rename',exact:true}).click();await expect(page.getByRole('alert')).toContainText('1–40');await dialog.getByRole('button',{name:'Revert',exact:true}).click();await select();await expect(input).toHaveValue('Muse');await input.fill('Never saved');await page.getByRole('button',{name:'Back to whiteboard',exact:true}).click();await expect(dialog).toBeVisible();await expect(page.getByRole('button',{name:'Back to whiteboard'})).toBeVisible();await page.keyboard.press('Escape');await select();await expect(input).toHaveValue('Muse');await input.fill('小月');await page.keyboard.press('Enter');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Rename',exact:true}).click();await expect.poll(()=>fixture.canvases.get('owner-a')?.board.museName).toBe('小月');await page.getByRole('button',{name:'Back to whiteboard',exact:true}).click();await expect(page.locator('.muse-floating-name')).toHaveText('小月');await page.reload();await expect(page.locator('.muse-floating-name')).toHaveText('小月');await openMuseEditor(page);await expect(page.locator('.muse-appearance-label')).toContainText('小月');await page.screenshot({path:'verification/muse-name-canvas.png'});
});

test('renaming Muse updates the canonical soul identity and undoes both together',async({page})=>{
 const original='# Soul\n\nMy name is Muse. I help make ideas clear.\n\n- Keep answers short.\n- My owner has a friend named Muse.';
 const fixture=await museFixture(page,{soul:original});
 await openMuseEditor(page);
 const memory=fixture.notes.get('owner-a:memory')!.content;
 const label=page.locator('.muze-vector-surface [id="muse-name"]'),soul=page.locator('.muze-vector-surface [id="muse-file-soul"]');
 const rename=async(name:string)=>{
   await expect(label).toBeVisible();const box=(await label.boundingBox())!;
   await page.mouse.click(box.x+80,box.y+box.height/2);
   await page.getByRole('textbox',{name:'Muse name',exact:true}).fill(name);await page.keyboard.press('Enter');
   await page.getByRole('dialog',{name:'Confirm Muse name'}).getByRole('button',{name:'Rename',exact:true}).click();
   await expect.poll(()=>fixture.canvases.get('owner-a')?.board.museName).toBe(name);
 };
 const expected=(name:string)=>original.replace('My name is Muse.','My name is '+name+'.');
 await rename('Kumo');await expect(soul).toContainText('My name is Kumo.');
 expect(fixture.notes.get('owner-a:soul')!.content).toBe(expected('Kumo'));
 await rename('Luna');await expect(soul).toContainText('My name is Luna.');
 expect(fixture.notes.get('owner-a:soul')!.content).toBe(expected('Luna'));
 const renamed=(await exported(page)).objects.find(object=>object.id==='muse-file-soul')!;
 expect(renamed.markdown).toBe(expected('Luna'));expect(renamed.text).toContain('My name is Luna.');
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await expect(label).toContainText('Hello, my name is Kumo.');await expect(soul).toContainText('My name is Kumo.');
 await expect.poll(()=>fixture.notes.get('owner-a:soul')?.content).toBe(expected('Kumo'));
 await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(soul).toContainText('My name is Luna.');
 await expect.poll(()=>fixture.notes.get('owner-a:soul')?.content).toBe(expected('Luna'));
 expect(fixture.notes.get('owner-a:memory')!.content).toBe(memory);
 await page.reload();await openMuseEditor(page);await expect(soul).toContainText('My name is Luna.');
 const box=(await soul.boundingBox())!;await page.mouse.dblclick(box.x+70,box.y+110);
 const input=page.locator('textarea[data-fabric="textarea"]');await expect(input).toHaveValue(expected('Luna'));await input.press('Escape');
});

test('automatic replacement uses image feedback, preserves the avatar on failure and only retries explicitly',async({page})=>{
 await museFixture(page);await page.getByRole('button',{name:'Open Muse',exact:true}).click();await page.getByRole('dialog',{name:'Muse',exact:true}).getByRole('button',{name:'Change avatar'}).click();const original=JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:any)=>o.id==='muse-appearance').src;let calls=0,release:()=>void=()=>{};
 const pending=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/muse/avatar?operation=*',route=>route.fulfill({json:{status:'failed-or-uncertain'}}));
 await page.route('**/api/muse/avatar',async route=>{if(route.request().method()!=='POST')return route.fallback();calls++;if(calls===1)await pending;await route.fulfill({status:502,json:{error:'Generation failed; current avatar unchanged.'}}).catch(()=>{});});
 const image=Buffer.from(original.split(',')[1],'base64');await page.getByLabel('Choose Muse icon',{exact:true}).setInputFiles({name:'pet.png',mimeType:'image/png',buffer:image});await expect(page.getByRole('progressbar',{name:'Updating Muse avatar'})).toBeVisible();await expect(page.locator('.muse-avatar-blur')).toHaveCSS('backdrop-filter','blur(8px)');await expect(page.getByRole('button',{name:'Cancel generation'})).toHaveCount(0);await expect(page.locator('.muse-avatar-feedback')).toHaveText('');
 await page.getByLabel('Choose Muse icon',{exact:true}).setInputFiles({name:'second.png',mimeType:'image/png',buffer:image});expect(calls).toBe(1);release();await expect(page.getByRole('button',{name:'Retry avatar update'})).toBeVisible();expect(calls).toBe(1);expect(JSON.parse((await exported(page)).text).board.pages[0].objects.find((o:any)=>o.id==='muse-appearance').src).toBe(original);
 await page.getByRole('button',{name:'Retry avatar update'}).click();await expect.poll(()=>calls).toBe(2);await expect(page.getByRole('button',{name:'Retry avatar update'})).toBeVisible();await expect(page.locator('.muse-avatar-feedback')).toHaveText('');
});

for(const width of [1440,390])test(`contextual styles stay editable and preserve color and font at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:844});await museFixture(page);const palette=page.getByRole('complementary',{name:'Drawing styles',exact:true}),controls=page.getByRole('group',{name:'Color and font',exact:true});await expect(palette).toBeHidden();
 await page.getByRole('button',{name:'Text',exact:true}).click();if(width>700)await expect(palette).toBeVisible();else await expect(palette).toBeHidden();
 await page.mouse.click(width===390?75:400,350);await page.keyboard.insertText('Editable style');await page.keyboard.press('Escape');
 if(width<=700){await expect(palette).toBeHidden();await page.getByRole('button',{name:'Styles',exact:true}).click();}
 await expect(controls).toBeVisible();await controls.getByRole('button',{name:'Blue',exact:true}).click();await controls.getByRole('button',{name:'Serif font',exact:true}).click();
 const bounds=(await palette.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);await page.screenshot({path:`verification/contextual-styles-${width}.png`});
 const text=(await exported(page)).objects.find(o=>o.type==='MuzeText');expect(text).toMatchObject({fill:'#4465e9',fontFamily:'IBM Plex Serif'});
 await page.getByRole('button',{name:'Undo',exact:true}).click();const reverted=(await exported(page)).objects.find(o=>o.id===text!.id) as {fill?:string;fontFamily?:string};expect(reverted.fill).toBe('#4465e9');expect(reverted.fontFamily).not.toBe('IBM Plex Serif');
 await page.getByRole('button',{name:'Redo',exact:true}).click();expect((await exported(page)).objects.find(o=>o.id===text!.id)).toMatchObject({fill:'#4465e9',fontFamily:'IBM Plex Serif'});
 await page.reload();await expect(palette).toBeHidden();expect((await exported(page)).objects.find(o=>o.id===text!.id)).toMatchObject({fill:'#4465e9',fontFamily:'IBM Plex Serif'});
 const rendered=page.locator('.muze-vector-surface [id="'+text!.id+'"]'),box=(await rendered.boundingBox())!;await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 if(width>700)await expect(palette).toBeVisible();else {await expect(palette).toBeHidden();await page.getByRole('button',{name:'Styles',exact:true}).click();await expect(palette).toBeVisible();await page.getByRole('button',{name:'Styles',exact:true}).click();}
 await page.getByRole('button',{name:'Hand',exact:true}).click();await expect(palette).toBeHidden();
});

test('normal chat inserts image-only actions with attribution and preserves them on reload',async({page})=>{
 const fixture=await museFixture(page);const {readFile}=await import('node:fs/promises');const src='data:image/png;base64,'+(await readFile('public/muse/default-avatar.png')).toString('base64');fixture.response(async()=>({cards:[],updates:[],images:[{id:'retrieved-image',src,sourceUrl:'https://commons.wikimedia.org/wiki/File:Cat.jpg',sourceTitle:'Cat photograph',imageUrl:'https://upload.wikimedia.org/cat.jpg',attribution:'Photographer · CC BY-SA 4.0',retrievedAt:'2026-11-01T00:00:00Z'}]}));await chat(page);await send(page,'Add a cat image to the board');await expect(page.locator('.muse-image-source')).toContainText('Photographer');let data=await exported(page);expect(data.objects).toHaveLength(1);expect(data.objects[0]).toMatchObject({id:'retrieved-image',type:'Image',sourceTitle:'Cat photograph',src});await page.reload();await expect(page.locator('.muse-image-source')).toHaveAttribute('href','https://commons.wikimedia.org/wiki/File:Cat.jpg');data=await exported(page);expect(data.objects[0]).toMatchObject({attribution:'Photographer · CC BY-SA 4.0',imageUrl:'https://upload.wikimedia.org/cat.jpg'});
});
