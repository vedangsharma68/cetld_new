import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createReminderReviewNetwork} from '../fixtures/reminder-review-network.mjs';
let fixture,server,origin;
test.beforeAll(async()=>{
 fixture=await createReminderReviewNetwork();
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/ai'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const result=await fixture.api(url.searchParams.get('action'),chunks.length?JSON.parse(Buffer.concat(chunks)): {},req.method);
   res.writeHead(result.code,{'Content-Type':'application/json'});res.end(JSON.stringify(result.data));return;
  }
  if(url.pathname.startsWith('/rest/v1/')){
   await fixture.asUser();const result=await fixture.fetchImpl('https://fixture.supabase.test'+url.pathname+url.search,{method:req.method,headers:req.headers});
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;
  }
  let name=decodeURIComponent(url.pathname);if(name.endsWith('/'))name+='index.html';
  const file=name==='/fixture-supabase.js'?path.resolve('node_modules/@supabase/supabase-js/dist/umd/supabase.js'):path.resolve('.'+name);
  if(!file.startsWith(process.cwd()+path.sep))throw Error('Invalid fixture path');let body=await readFile(file);
  if(name==='/app.js')body+=`\nglobalThis.__reviewTest={async enter(data){
   db=globalThis.supabase.createClient(location.origin,'public-fixture-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:'Bearer fixture-owner-token'}}});
   db.auth.getSession=async()=>({data:{session:{access_token:'fixture-owner-token'}}});
   state.demo=false;state.user=data.user;state.workspace=data.workspace;state.settings=data.settings;state.customers=[data.customer];state.invoices=[invoiceFromRow(data.invoice,[data.customer])];state.payments=[];state.page='Conversations';state.conversationId=data.invoice.id;render();
  }};`;
  res.setHeader('Content-Type',/\.m?js$/.test(name)?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html');res.end(body);
 }catch(e){res.writeHead(500);res.end(String(e.message))}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await fixture.close()});
for(const width of [320,360,520,800,1280,1920,3840])test(`live review API and SQL approval at ${width}px`,async({page},info)=>{
 const data=JSON.parse(JSON.stringify(await fixture.seed()));
 await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'text/javascript',body:'export function createClient(){throw Error("Offline fixture login")}'}));
 await page.goto(origin+'/app/');await page.getByRole('button',{name:/Explore an interactive demo/}).click();
 await page.addScriptTag({url:origin+'/fixture-supabase.js'});await page.evaluate(data=>__reviewTest.enter(data),data);
 await page.locator('[data-action="draft"]').click();
 const form=page.locator('#draft-form');await form.locator('[name=tone]').selectOption('firm');await expect(form.locator('[name=message]')).toHaveValue(/expected payment date/);
 await form.locator('[name=sendNow]').selectOption('true');const text='My exact edited reminder — no regenerated words.';await form.locator('[name=message]').fill(text);
 const fallback=width===320||width===800||width===3840;if(fallback)await form.locator('[name=approveFallback]').check();
 await form.locator('[data-preview-reminder]').click();await expect(form.locator('[data-delivery-preview]')).toContainText('Will send as your message');await expect(form.locator('[data-delivery-preview] blockquote').first()).toHaveText(text);
 if(fallback){await expect(form.locator('[data-delivery-preview]')).toContainText('approved fallback template cetld_invoice_details_firm_v1');await expect(form.locator('[data-delivery-preview] blockquote')).toHaveCount(2)}
 await expect(form.locator('[data-approve-reminder]')).toBeDisabled();await form.locator('[data-delivery-ack]').check();
 await form.locator('[data-approve-reminder]').scrollIntoViewIfNeeded();expect(await form.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 for(const button of await form.locator('.dialog-foot button').all()){await button.scrollIntoViewIfNeeded();await button.click({trial:true});}
 await page.screenshot({path:info.outputPath('reviewed-delivery.png'),animations:'disabled'});
 await form.locator('[data-approve-reminder]').click();await expect(page.locator('dialog')).not.toBeVisible();
 await expect(page.locator('.approved-delivery-summary')).toContainText(text);if(fallback)await expect(page.locator('.approved-delivery-summary')).toContainText('Approved fallback: cetld_invoice_details_firm_v1');
 await page.screenshot({path:info.outputPath('queued-approval.png'),fullPage:true,animations:'disabled'});
 if(fallback)await fixture.expireWindow();const before=fixture.graph.length;const tick=await fixture.tick();const result=tick.results.find(x=>x.invoiceId===data.invoice.id);expect(result?.status,JSON.stringify({tick,errors:fixture.errors})).toBe('sent');
 expect(fixture.graph.length).toBe(before+1);const sent=fixture.graph.at(-1);expect(sent.type).toBe(fallback?'template':'text');if(fallback)expect(sent.template.name).toBe('cetld_invoice_details_firm_v1');else expect(sent.text.body).toBe(text);
});

async function enterReview(page){
 const data=JSON.parse(JSON.stringify(await fixture.seed()));
 await page.setViewportSize({width:360,height:800});await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'text/javascript',body:'export function createClient(){throw Error("Offline fixture login")}'}));
 await page.goto(origin+'/app/');await page.getByRole('button',{name:/Explore an interactive demo/}).click();await page.addScriptTag({url:origin+'/fixture-supabase.js'});await page.evaluate(data=>__reviewTest.enter(data),data);await page.locator('[data-action="draft"]').click();return data;
}
test('scheduled approval reviews a tone-selected template and retains the custom dashboard draft',async({page},info)=>{
 const data=await enterReview(page),form=page.locator('#draft-form');await expect(form.locator('[name=approveFallback]')).toBeDisabled();
 await form.locator('[name=tone]').selectOption('gentle');const custom='Custom dashboard draft, not approved template wording';await form.locator('[name=message]').fill(custom);
 await form.locator('[data-preview-reminder]').click();const preview=form.locator('[data-delivery-preview]');await expect(preview).toContainText('Will send as approved template: cetld_invoice_details_relaxed_v1');await expect(preview).toContainText('Cetld’s scheduled reminders');await expect(preview).toContainText('cannot be delivered as-is');
 await form.locator('[data-delivery-ack]').check();await form.locator('[data-approve-reminder]').click();await expect(page.locator('dialog')).not.toBeVisible();
 await expect(page.locator('.approved-delivery-summary')).toContainText('cetld_invoice_details_relaxed_v1');
 const row=(await fixture.db.query('select * from invoices where id=$1',[data.invoice.id])).rows[0];expect(row.metadata.reminder_draft_text).toBe(custom);
 await fixture.service();await fixture.db.query("update invoices set next_follow_up_at=clock_timestamp()-interval '1 minute' where id=$1",[data.invoice.id]);await fixture.expireWindow();const before=fixture.graph.length;const tick=await fixture.tick();expect(tick.results.find(x=>x.invoiceId===data.invoice.id).status).toBe('sent');expect(fixture.graph.length).toBe(before+1);expect(fixture.graph.at(-1).template.name).toBe('cetld_invoice_details_relaxed_v1');
 await page.screenshot({path:info.outputPath('scheduled-template.png'),fullPage:true});
});
test('expired free-form approval remains visible for re-review with the exact held words',async({page},info)=>{
 const data=await enterReview(page),form=page.locator('#draft-form');await form.locator('[name=sendNow]').selectOption('true');await form.locator('[name=message]').fill('Hold these exact words if the window closes.');
 await form.locator('[data-preview-reminder]').click();await form.locator('[data-delivery-ack]').check();await form.locator('[data-approve-reminder]').click();await expect(page.locator('dialog')).not.toBeVisible();
 await fixture.expireWindow();const before=fixture.graph.length;await fixture.tick();expect(fixture.graph.length).toBe(before);
 await page.locator('[data-action="refresh"]').click();await expect(page.locator('.approved-delivery-summary').first()).toContainText('Delivery needs re-review');await expect(page.locator('.approved-delivery-summary').first()).toContainText('24-hour service window closed');await expect(page.locator('.conversation-thread[aria-label^="Follow-up"]')).toContainText('Hold these exact words if the window closes.');
 await page.screenshot({path:info.outputPath('window-expired-review.png'),fullPage:true});
});
