import {test, expect} from '@playwright/test';
import {museFixture} from './muse-fixture';
import type {Board} from '../src/components/muze/storage';

test('hosted tool requests reach MCP without a Clerk session while management stays protected',async({request})=>{
  const id='659aff2a-2f70-462a-ae93-303be0600bb5',path='/api/mcp/boards/'+id;
  const headers={accept:'application/json, text/event-stream'};
  const missing=await request.post(path,{headers,data:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  expect(missing.status()).toBe(401);expect((await missing.json()).error.message).toBe('A board access token is required.');
  const invalid=await request.post(path,{headers:{...headers,Authorization:'Bearer muze_'+'x'.repeat(43)},data:{jsonrpc:'2.0',id:1,method:'tools/list'},maxRedirects:0});
  // A fresh local checkout may not have the migration applied yet. Either case
  // must reach our board-token verifier rather than Clerk's session redirect.
  expect([401,503]).toContain(invalid.status());expect(invalid.headers().location).toBeUndefined();
  const body=await invalid.json();expect(body.jsonrpc).toBe('2.0');expect(body.error.message).toMatch(/This board access token is invalid or revoked|Board access is unavailable/);
  expect((await request.get('/api/boards/'+id+'/mcp')).status()).toBe(401);
});

test('only a published board owner can create, copy and revoke a private tool connection', async ({page}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const id='a79ba852-b736-4c6f-befb-d40ef17a36af';let board:Board|null=null,enabled=false,issued=0,revoked=0;
  await page.route('**/api/boards{,/**}',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice('/api/boards'.length),method=request.method();
    if(!path&&method==='GET')return route.fulfill({json:{boards:board?[{id,name:board.name,role:'owner',updatedAt:new Date().toISOString()}]:[]}});
    if(!path&&method==='POST'){board={...request.postDataJSON().board,id};return route.fulfill({json:{board,revision:'one',role:'owner'}});}
    if(path.endsWith('/mcp')){
      if(method==='POST'){issued++;enabled=true;return route.fulfill({json:{enabled,token:'muze_'+String(issued).repeat(43)}});}
      if(method==='DELETE'){revoked++;enabled=false;}
      return route.fulfill({json:{enabled}});
    }
    if(path.endsWith('/invite'))return route.fulfill({json:{token:'i'.repeat(43)}});
    if(path.endsWith('/profile'))return route.fulfill({json:{profiles:[]}});
    if(method==='PUT')board=request.postDataJSON().board;
    return route.fulfill({json:{board,revision:'one',role:'owner',protectedObjects:[]}});
  });
  await museFixture(page);
  await page.getByRole('button',{name:'Share',exact:true}).click();
  const share=page.getByRole('dialog',{name:'Share board',exact:true});
  await expect(share.getByRole('button',{name:'Connect a tool',exact:true})).toHaveCount(0);
  await share.getByRole('button',{name:'Create invite link',exact:true}).click();
  await share.getByRole('button',{name:'Connect a tool',exact:true}).click();
  await share.getByRole('button',{name:'Create connection',exact:true}).click();
  const field=share.getByRole('textbox',{name:'Tool connection configuration'});
  await expect(field).toBeVisible();
  const configuration=JSON.parse(await field.inputValue());
  expect(configuration.mcpServers.tomo.url).toBe(new URL('/api/mcp/boards/'+id,page.url()).href);
  expect(configuration.mcpServers.tomo.headers.Authorization).toBe('Bearer muze_'+'1'.repeat(43));
  await share.getByRole('button',{name:'Copy configuration',exact:true}).click();
  expect(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()))).toEqual(configuration);
  await share.getByRole('button',{name:'Connect a tool',exact:true}).click();
  await share.getByRole('button',{name:'Connect a tool',exact:true}).click();
  await expect(field).toHaveCount(0);
  await share.getByRole('button',{name:'Replace connection',exact:true}).click();
  await expect(field).toContainText('Bearer muze_'+'2'.repeat(43));
  await share.getByRole('button',{name:'Revoke tool access',exact:true}).click();
  await expect(field).toHaveCount(0);expect(revoked).toBe(1);expect(enabled).toBe(false);
  const persisted=await page.evaluate(()=>JSON.stringify({...localStorage}));expect(persisted).not.toContain('Bearer muze_');
});

test('tool management is absent for invited editors',async({page})=>{
  const id='4ae038bb-16cc-41e6-bf9a-f94209f0f093',board={id,name:'A friend’s board',activePage:'page',pages:[{id:'page',name:'Page 1',objects:[],viewport:[1,0,0,1,0,0]}]};
  let requested=false;
  await page.route('**/api/boards{,/**}',async route=>{
    const path=new URL(route.request().url()).pathname.slice('/api/boards'.length);if(path.endsWith('/mcp'))requested=true;
    return route.fulfill({json:!path?{boards:[{id,name:board.name,role:'editor',updatedAt:new Date().toISOString()}]}:{board,revision:'one',role:'editor',protectedObjects:[]}});
  });
  await museFixture(page);
  await page.evaluate(id=>{history.pushState(null,'','/__muse-fixture?board='+id);window.dispatchEvent(new PopStateEvent('popstate'));},id);
  await page.getByRole('button',{name:'Share',exact:true}).click();
  const share=page.getByRole('dialog',{name:'Share board',exact:true});
  await expect(share.getByText('You can edit this board. Its owner manages invitations.')).toBeVisible();
  await expect(share.getByRole('button',{name:'Connect a tool',exact:true})).toHaveCount(0);expect(requested).toBe(false);
});
