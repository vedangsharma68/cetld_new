import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

let server,origin;
const widths=[320,360,520,800,1280,1920,3840];
const pages=['Overview','Assistant','Business records','Invoices','Conversations','Payments','Connections','Settings','Onboarding'];
test.beforeAll(async()=>{
  server=createServer(async(req,res)=>{try{
    let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(name.endsWith('/'))name+='index.html';
    const file=path.resolve('.'+name);if(!file.startsWith(process.cwd()+path.sep))throw Error('Bad path');
    let body=await readFile(file);
    if(name==='/app.js')body+='\nglobalThis.__ui={state,render,detail,invoiceForm,draftForm,authPage,demo,paymentForm,exceptionForm};';
    res.setHeader('Content-Type',/\.m?js$/.test(name)?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.svg')?'image/svg+xml':'application/json');res.end(body);
  }catch{res.writeHead(404);res.end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(()=>server.close());
async function boot(page){
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('https://esm.sh/**',r=>r.fulfill({contentType:'text/javascript',body:'export function createClient(){throw Error("Offline test fixture")}'}));
  await page.goto(origin+'/app/');await page.getByRole('button',{name:/Explore an interactive demo/}).click();
  await page.evaluate(()=>{
    const s=__ui.state;s.customers=[{id:'c1',name:'A very long business name '.repeat(6),reminder_tone:'firm'}];
    Object.assign(s.invoices[0],{client:s.customers[0].name,customer_id:'c1',number:'INV-'+ 'X'.repeat(110),notes:'n'.repeat(400)});
    s.payments[0].reference='Ref'.repeat(150);
    s.businessRecords=[{id:'r1',record_type:'supplier',name:'Supplier'.repeat(25),custom_fields:{description:'Long'.repeat(150),['LongKey'.repeat(20)]:'Value'.repeat(80)}}];
    s.assistantMessages=[{role:'assistant',content:'VeryLongWord'.repeat(150)}];
    s.whatsappMessages=[{id:'1',audience:'customer',customer_id:'c1',phone:'+919000000001',direction:'inbound',status:'received',body:'CustomerMessage'.repeat(70),created_at:new Date().toISOString()},{id:'2',audience:'customer',customer_id:'c1',phone:'+919000000001',direction:'outbound',status:'accepted',body:'An outgoing reminder for review.',created_at:new Date().toISOString()},{id:'3',audience:'owner',phone:'+919000000002',direction:'inbound',status:'received',body:'Owner message',created_at:new Date().toISOString()}];
  });
}
async function layout(page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const overflow=await page.locator('.content').evaluate(root=>[...root.querySelectorAll('*')].filter(e=>{
    const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+2&&!e.closest('.table-wrap,.conversation-list,.settings-nav');
  }).map(e=>e.className||e.tagName).slice(0,10));
  expect(overflow).toEqual([]);
}
for(const width of widths)test(`all pages render and navigate at ${width}px`,async({page},info)=>{
  test.setTimeout(120000);
  await page.setViewportSize({width,height:900});const errors=[];page.on('pageerror',e=>errors.push(e.message));await boot(page);
  for(const name of pages){
    if(width<=800&&name!=='Onboarding'){await page.getByRole('button',{name:'Open navigation',exact:true}).click();}
    if(name==='Onboarding')await page.evaluate(()=>{__ui.state.page='Onboarding';__ui.render()});
    else await page.locator(`.sidebar [data-page="${name}"]`).click();
    await expect(page.locator('.crumb strong')).toHaveText(name);await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await layout(page);await expect(page.locator('.page')).toHaveCSS('opacity','1');
    await page.screenshot({path:info.outputPath(`${name.replaceAll(' ','-')}.png`),fullPage:true,animations:'disabled'});
    // All visible controls must fit the nearest clipping panel and have a hittable center after scrolling.
    const controls=page.locator('.content :is(button,input:not([type=hidden]),select,textarea):visible');
    for(let i=0;i<await controls.count();i++){
      const c=controls.nth(i);await c.scrollIntoViewIfNeeded();
      const clipped=await c.evaluate(e=>{const r=e.getBoundingClientRect();let a=e.parentElement;while(a&&a!==document.body){const s=getComputedStyle(a),p=a.getBoundingClientRect();if(/hidden|clip/.test(s.overflowX)&&(r.left<p.left-2||r.right>p.right+2))return true;a=a.parentElement}return false});
      expect(clipped,`${name}: clipped ${await c.getAttribute('name')}`).toBe(false);
      if(await c.evaluate(e=>e.tagName==='BUTTON')&&await c.isEnabled())await c.click({trial:true,timeout:3000});
    }
    await page.evaluate(()=>scrollTo(0,0));
  }
  expect(errors).toEqual([]);
});
for(const [width,height] of [[320,568],[360,640],[520,740],[800,900],[1280,900],[3840,1600],[640,360],[320,280]])test(`drawer maximum actions at ${width}x${height}`,async({page},info)=>{
  await page.setViewportSize({width,height});await boot(page);
  await page.evaluate(()=>{const s=__ui.state;s.demo=false;s.workspace={id:'test',owner_id:'demo'};s.ownerDeleteAvailable=true;s.invoiceSyncConnected=true;s.invoices[0].bookkeeping_sync_status='failed';__ui.detail(s.invoices[0].id);
    // The synthetic owner-test gate cannot coexist with this ordinary invoice; include its action as a layout stress case.
    const extra=document.createElement('button');extra.type='button';extra.className='btn';extra.textContent='Review owner test';document.querySelector('.drawer-actions').append(extra);
  });
  const actions=page.locator('.drawer-actions');expect(await actions.locator('button').count()).toBe(9);
  expect(await actions.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  for(const b of await actions.locator('button').all()){
    await b.scrollIntoViewIfNeeded();await b.click({trial:true});
    expect(await b.evaluate(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1&&e.scrollWidth<=e.clientWidth+1})).toBe(true);
  }
  await page.screenshot({path:info.outputPath('drawer.png')});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
});
test('token insertion replaces selection, preserves focus, and respects the limit',async({page})=>{
  await page.setViewportSize({width:360,height:800});await boot(page);
  await page.evaluate(()=>{__ui.state.page='Settings';__ui.render()});
  const editor=page.locator('[name="reminderTemplate"]');await editor.fill('Hi customer!');await editor.evaluate(e=>e.setSelectionRange(3,11));
  await page.getByRole('button',{name:'Insert {{customer_name}}',exact:true}).click();await expect(editor).toHaveValue('Hi {{customer_name}}!');await expect(editor).toBeFocused();
  await page.getByRole('button',{name:'Insert {{balance}}',exact:true}).focus();await page.keyboard.press('Enter');await expect(editor).toHaveValue('Hi {{customer_name}}{{balance}}!');
  await editor.fill('x'.repeat(1000));await page.getByRole('button',{name:'Insert {{due_date}}',exact:true}).click();expect((await editor.inputValue()).length).toBe(1000);
  await page.getByRole('button',{name:'Save follow-up preferences',exact:true}).click();await expect(page.locator('#follow-up-preferences-form [data-error]')).toBeHidden();
});
for(const width of [360,520,800,1280,1920])test(`auth and forms at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:740});await boot(page);
  for(const kind of ['invoiceForm','paymentForm','exceptionForm','draftForm']){
    await page.evaluate(kind=>__ui[kind](__ui.state.invoices[0].id),kind);
    await expect(page.locator('dialog')).toBeVisible();
    const submit=page.locator('dialog [type=submit]').first();await submit.scrollIntoViewIfNeeded();await submit.click({trial:true});
    expect(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(kind+'.png')});await page.keyboard.press('Escape');
  }
  await page.locator('.demo-mode [data-action=logout]').click();
  for(const action of ['auth-signup','auth-login','auth-reset']){
    await page.locator(`[data-action="${action}"]`).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.locator('#auth-form [type=submit]').scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath(action+'.png'),fullPage:true,animations:'disabled'});
  }
});

test('long-lived tab announces new deployments, keeps edits, and reloads only on confirmation',async({page})=>{
  let available=false;
  await page.route('**/app/',async r=>r.fulfill({contentType:'text/html',body:(await readFile('app/index.html','utf8')).replace(/name="app-version" content="[^"]+"/,`name="app-version" content="${'a'.repeat(64)}"`)}));
  await page.route('**/app-version.json?*',r=>r.fulfill({json:{version:(available?'b':'a').repeat(64)}}));
  await boot(page);await page.evaluate(()=>{__ui.state.page='Settings';__ui.render()});
  const editor=page.locator('[name=reminderTemplate]');await editor.fill('My unsaved draft');available=true;await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.locator('.app-update')).toContainText('Save your work');await expect(editor).toHaveValue('My unsaved draft');
  page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Refresh app',exact:true}).click();await expect(editor).toHaveValue('My unsaved draft');
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Refresh app',exact:true}).click();await expect(page.getByRole('button',{name:/Explore an interactive demo/})).toBeVisible();
});

async function reviewFixture(page,kind='service'){
  await boot(page);
  await page.evaluate(async kind=>{
    const ui=await import('/reminder-review-ui.mjs');
    const dialog=document.querySelector('dialog');dialog.className='';dialog.innerHTML='<div class="dialog-head"><h2 id="dialog-title">Review reminder delivery</h2><button class="btn" data-action="close">Close</button></div>'+ui.reminderReviewForm({text:'Please pay invoice 123.',tone:'firm',customer:'Customer',number:'123'});dialog.showModal();
    globalThis.reviewRequests=[];globalThis.savedDraft=null;globalThis.approvedResult=null;
    ui.mountReminderReview(document.querySelector('#draft-form'),{
      requestPreview:async input=>{reviewRequests.push(input);return {eligible:true,approvalToken:'bound-token',expiresAt:new Date(Date.now()+60000).toISOString(),delivery:kind==='blocked'?null:kind==='template'?{form:'template',text:'The approved firm template words.',templateName:'cetld_invoice_details_firm_v1'}:{form:'service',text:input.text,windowExpiresAt:new Date(Date.now()+120000).toISOString(),windowClosedPolicy:'hold'}}},
      approve:async input=>{globalThis.approvedResult=input;return {approved:true}},
      onApproved:()=>{},onSaveDraft:async input=>{globalThis.savedDraft=input},
    });
  },kind);
}
for(const width of [360,800,1280])test(`reminder exact-word approval at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:740});await reviewFixture(page);
  const approve=page.locator('[data-approve-reminder]');await expect(approve).toBeDisabled();
  await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await expect(page.locator('[data-delivery-preview]')).toContainText('Will send as your message');
  await expect(approve).toBeDisabled();await page.locator('[data-delivery-ack]').check();await expect(approve).toBeEnabled();
  await page.locator('[name=message]').fill('My new exact words.');await expect(approve).toBeDisabled();await expect(page.locator('[data-delivery-preview]')).toContainText('needs updating');
  await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await page.locator('[data-delivery-ack]').check();await approve.click();
  expect(await page.evaluate(()=>approvedResult)).toEqual({text:'My new exact words.',tone:'firm',approvalToken:'bound-token',windowClosedPolicy:'hold'});
  await page.screenshot({path:info.outputPath('service-approval.png')});
});
test('template delivery requires an explicit replacement choice, and errors never unlock approval',async({page})=>{
  await reviewFixture(page,'template');await page.getByRole('button',{name:'Preview delivery',exact:true}).click();
  await expect(page.locator('[data-delivery-preview]')).toContainText('Will send as approved template: cetld_invoice_details_firm_v1');
  await expect(page.locator('[data-delivery-preview]')).toContainText('cannot be delivered as-is');
  await expect(page.locator('[data-approve-reminder]')).toBeDisabled();await page.locator('[data-delivery-ack]').check();await page.locator('[name=tone]').selectOption('gentle');await expect(page.locator('[data-approve-reminder]')).toBeDisabled();
  await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await expect(page.locator('[data-error]')).toContainText('does not match');await expect(page.locator('[data-approve-reminder]')).toBeDisabled();
});
test('expired delivery preview cannot be approved',async({page})=>{
  await page.clock.install();await reviewFixture(page);await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await page.locator('[data-delivery-ack]').check();
  await page.clock.fastForward(61000);await expect(page.locator('[data-approve-reminder]')).toBeDisabled();await expect(page.locator('[data-error]')).toContainText('expired');
});

for(const width of [360,1280])test(`settings groups, theme, filters and keyboard at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await boot(page);
  await page.evaluate(()=>{__ui.state.page='Settings';__ui.render()});
  await expect(page.locator('.settings-content')).not.toContainText(/\bworkspace\b/i);
  await page.locator('#follow-up-preferences').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('follow-up-preferences.png')});
  for(const legend of ['Message style','Schedule','Stops & review'])await expect(page.locator('.preference-group>legend',{hasText:legend})).toBeVisible();
  await page.getByLabel('Dark mode',{exact:true}).check();await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({path:info.outputPath('settings-dark.png')});
  await page.evaluate(()=>{__ui.state.page='Invoices';__ui.render()});
  const filter=page.getByRole('combobox',{name:'Filter invoice status'});await filter.selectOption('Paid');await expect(page.locator('.invoice-table tbody tr')).toHaveCount(1);
  await filter.selectOption('All');await page.getByRole('textbox',{name:'Search invoices'}).fill('Morrow');await expect(page.locator('.invoice-table tbody tr')).toHaveCount(1);
  await page.locator('.invoice-open').focus();await page.keyboard.press('Enter');await expect(page.locator('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.invoice-open')).toBeFocused();
});

test('drawer actions remain reachable with 200% text zoom',async({page},info)=>{
  await page.setViewportSize({width:360,height:640});await boot(page);
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';const s=__ui.state;s.demo=false;s.workspace={id:'test',owner_id:'demo'};s.ownerDeleteAvailable=true;s.invoiceSyncConnected=true;s.invoices[0].bookkeeping_sync_status='failed';__ui.detail(s.invoices[0].id)});
  const buttons=page.locator('.drawer-actions button');
  for(const button of await buttons.all()){
    await button.scrollIntoViewIfNeeded();await button.click({trial:true});
    expect(await button.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  }
  expect(await page.locator('.drawer-actions').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('text-zoom.png')});
});

for(const width of [360,800,1280])test(`queued reminders show approved delivery at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:800});await boot(page);
  await page.evaluate(()=>{
    const s=__ui.state,x=s.invoices[0];
    x.followup_state='approved';x.status='sent';x.reminder_text='Later editable text that must not replace the receipt';
    x.metadata={approved_reminder_delivery:{type:'template',name:'cetld_invoice_details_firm_v1',body:'Exactly the words approved for this pending reminder.'},approved_reminder_delivery_reviewed_at:new Date().toISOString()};
    s.page='Conversations';s.conversationId=x.id;__ui.render();
  });
  await expect(page.locator('.draft-state')).toContainText('Reviewed · awaiting delivery');
  const summary=page.locator('.approved-delivery-summary');await expect(summary).toContainText('cetld_invoice_details_firm_v1');await expect(summary).toContainText('Exactly the words approved');await expect(summary).not.toContainText('Later editable text');
  await layout(page);await summary.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('queued-delivery.png'),animations:'disabled'});
  await page.evaluate(()=>__ui.detail(__ui.state.invoices[0].id));await expect(page.locator('dialog .approved-delivery-summary')).toContainText('Exactly the words approved');await page.keyboard.press('Escape');
});
