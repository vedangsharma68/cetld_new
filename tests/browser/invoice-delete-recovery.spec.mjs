import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
let server,origin;
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{try{
  let name=new URL(req.url,'http://localhost').pathname;if(name.endsWith('/'))name+='index.html';
  const file=path.resolve('.'+name);if(!file.startsWith(process.cwd()+path.sep))throw Error('Bad path');
  let body=await readFile(file);
  if(name==='/app.js')body+=`\nglobalThis.__deleteTest={enter(){db={auth:{getSession:async()=>({data:{session:{access_token:'fixture-token'}}})}};state.demo=false;state.user={id:'owner-1'};state.workspace={id:'workspace-1',owner_id:'owner-1'};state.ownerDeleteAvailable=true;state.invoices=[{id:'invoice-1',number:'INV-42',client:'Customer A',currency:'INR',amount_minor:12550,paid_minor:0,status:'sent',invoice_direction:'receivable',metadata:{}}];detail('invoice-1');}};`;
  res.setHeader('Content-Type',/\.m?js$/.test(name)?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/json');res.end(body);
 }catch{res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(()=>server.close());
async function enter(page){
 await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'text/javascript',body:'export function createClient(){throw Error("Offline fixture login")}'}));
 await page.goto(origin+'/app/');await page.getByRole('button',{name:/Explore an interactive demo/}).click();await page.evaluate(()=>__deleteTest.enter());
}
const proposal={ok:true,proposalId:'proposal-1',invoiceId:'invoice-1',invoiceNumber:'INV-42',customerName:'Customer A',totalAmount:'125.50',currency:'INR',status:'sent',expiresAt:'2026-10-24T00:00:00Z',requiresExactConfirmation:true};
for(const expired of [false,true])test(`reload then delete again ${expired?'replaces an expired proposal':'resumes the pending proposal with exact confirmation'}`,async({page})=>{
 let pending=false;const calls=[];
 await page.route('**/api/invoice-lifecycle',async route=>{
  const body=route.request().postDataJSON();calls.push(body);let data,status=200;
  if(body.action==='prepareDelete'){
   if(pending){status=409;data={ok:false,code:'ACTION_PENDING'}}else{pending=true;data={...proposal,proposalId:expired&&calls.length>2?'fresh-proposal':'proposal-1'}}
  }else if(body.action==='pendingDelete'){
   data=expired?{ok:true,pending:false}:{...proposal,pending:true};if(expired)pending=false;
  }else if(body.action==='cancelDelete'){pending=false;data={ok:true,action:'cancelled'}}
  else{status=409;data={ok:false,code:'INVALID_CONFIRMATION'}}
  await route.fulfill({status,json:data});
 });
 await enter(page);await page.getByRole('button',{name:'Delete invoice',exact:true}).click();await expect(page.locator('#invoice-delete-form')).toBeVisible();
 await page.reload();await page.getByRole('button',{name:/Explore an interactive demo/}).click();await page.evaluate(()=>__deleteTest.enter());
 await page.getByRole('button',{name:'Delete invoice',exact:true}).click();
 const form=page.locator('#invoice-delete-form');await expect(form).toBeVisible();await expect(form).toHaveAttribute('data-proposal-id',expired?'fresh-proposal':'proposal-1');
 for(const text of ['INV-42','Customer A','125.50','Sent','DELETE INV-42'])await expect(form).toContainText(text);
 await expect(form.locator('[name=confirmation]')).toBeVisible();
 expect(calls.map(x=>x.action)).toEqual(expired?['prepareDelete','prepareDelete','pendingDelete','prepareDelete']:['prepareDelete','prepareDelete','pendingDelete']);
 await form.locator('[name=confirmation]').fill('wrong');await form.getByRole('button',{name:'Delete invoice',exact:true}).click();await expect(form.locator('[data-delete-error]')).toContainText('Type DELETE INV-42 exactly');expect(calls.some(x=>x.action==='confirmDelete')).toBe(false);
 await page.locator('#invoice-delete-form').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();expect(calls.at(-1).action).toBe('cancelDelete');
});
test('failed pending lookup shows an error and can be retried without reloading',async({page})=>{
 let fail=true;
 await page.route('**/api/invoice-lifecycle',route=>{const action=route.request().postDataJSON().action;return route.fulfill(fail?{status:409,json:{ok:false,code:action==='prepareDelete'?'ACTION_PENDING':'DATABASE_UNAVAILABLE'}}:{json:proposal})});
 await enter(page);await page.getByRole('button',{name:'Delete invoice',exact:true}).click();await expect(page.locator('#dialog [role=alert]')).toContainText('temporarily unavailable');
 await page.locator('#dialog').getByRole('button',{name:'Close',exact:true}).click();fail=false;
 await page.evaluate(()=>__deleteTest.enter());await page.getByRole('button',{name:'Delete invoice',exact:true}).click();await expect(page.locator('#invoice-delete-form')).toBeVisible();
});
