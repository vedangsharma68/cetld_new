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
async function scrollPage(page,top,by=false){
  await page.locator('.content').evaluate((e,{top,by})=>e[by?'scrollBy':'scrollTo']({top,behavior:'instant'}),{top,by});
}
for(const [width,height] of [[390,844],[768,1024]])for(const theme of ['light','dark'])test(`Assistant launcher clears navigation and content at ${width}x${height} in ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height});await boot(page);
  await scrollPage(page,0);
  await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
  const fab=page.locator('.assistant-fab');
  await expect(fab).toBeVisible();
  const target=await fab.boundingBox();expect(target.width).toBeGreaterThanOrEqual(44);expect(target.height).toBeGreaterThanOrEqual(44);
  await layout(page);
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await expect(page.locator('.nav-scrim')).toHaveClass(/open/);await expect(fab).toBeHidden();
  await page.screenshot({path:info.outputPath('navigation.png')});
  await page.keyboard.press('Escape');await expect(fab).toBeVisible();
  // Put the reported Live badge where the fixed launcher would cover it.
  await page.locator('.collections-pulse .live-label').evaluate(e=>{const content=e.closest('.content');content.scrollTo({top:Math.max(120,e.getBoundingClientRect().top+content.scrollTop-content.clientHeight+100),behavior:'instant'})});
  await expect.poll(()=>page.locator('.content').evaluate(e=>e.scrollTop)).toBeGreaterThan(64);await expect(fab).toBeHidden();
  await page.screenshot({path:info.outputPath('scroll-down.png')});
  await scrollPage(page,-80,true);await expect(fab).toBeVisible();
  // A rerender must preserve the scroll visibility state.
  await scrollPage(page,120,true);await expect(fab).toBeHidden();
  await page.evaluate(()=>__ui.render());await expect(fab).toBeHidden();
  await scrollPage(page,20);await expect(fab).toBeVisible();
  await scrollPage(page,40);
  await expect(fab).toBeHidden();await expect(fab).toBeVisible();
  await expect(fab).toHaveCSS('transition-duration','0s');
  await page.emulateMedia({reducedMotion:'no-preference'});await expect(fab).toHaveCSS('transition-duration','0.16s');
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const update of [false,true]){
    if(update)await page.evaluate(()=>{const bar=document.createElement('div');bar.className='app-update';bar.textContent='A new version is ready';document.body.append(bar)});
    if(update)await expect(fab).toHaveCSS('bottom','100px');
    await scrollPage(page,1e7);await expect(fab).toBeHidden();
    await scrollPage(page,-1,true);await expect(fab).toBeVisible();
    const clearance=await page.evaluate(()=>{
      const fab=document.querySelector('.assistant-fab'),content=document.querySelector('.content'),footer=document.querySelector('.app-footer');
      return {padding:parseFloat(getComputedStyle(document.querySelector('.main')).paddingBottom),footprint:fab.getBoundingClientRect().height+parseFloat(getComputedStyle(fab).bottom),footerBottom:footer.getBoundingClientRect().bottom,lastCardBottom:document.querySelector('.page').getBoundingClientRect().bottom,fabTop:fab.getBoundingClientRect().top};
    });
    expect(clearance.padding).toBeGreaterThanOrEqual(clearance.footprint);
    expect(clearance.footerBottom).toBeLessThan(clearance.fabTop);expect(clearance.lastCardBottom).toBeLessThan(clearance.fabTop);
    await layout(page);await page.screenshot({path:info.outputPath(update?'footer-update.png':'footer.png')});
  }
});
test('Assistant launcher preserves desktop placement and overlay stacking',async({page})=>{
  await page.setViewportSize({width:1280,height:900});await boot(page);
  const fab=page.locator('.assistant-fab');await expect(fab).toHaveCSS('bottom','22px');await expect(fab).toHaveCSS('right','22px');
  await page.evaluate(()=>scrollTo({top:300,behavior:'instant'}));await expect(fab).toBeVisible();
  await page.evaluate(()=>document.querySelector('.nav-scrim').classList.add('open'));await expect(fab).toBeHidden();
  await page.evaluate(()=>document.querySelector('.nav-scrim').classList.remove('open'));
  for(const [className,zIndex] of [['show',100],['invoice-ledger-drop-overlay is-visible',90],['app-update',50]]){
    const result=await page.evaluate(({className,zIndex})=>{
      const overlay=document.createElement('div');overlay.className=className;if(zIndex===100)overlay.id='toast';document.body.append(overlay);
      const fab=document.querySelector('.assistant-fab'),r=fab.getBoundingClientRect();
      Object.assign(overlay.style,{position:'fixed',inset:'auto',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',transform:'none',pointerEvents:'auto'});
      const stack=document.elementsFromPoint(r.left+r.width/2,r.top+r.height/2),overlayIndex=stack.indexOf(overlay),fabIndex=stack.indexOf(fab);
      const result={overlayZ:Number(getComputedStyle(overlay).zIndex),fabZ:Number(getComputedStyle(fab).zIndex),above:overlayIndex>=0&&fabIndex>overlayIndex};
      overlay.remove();return result;
    },{className,zIndex});
    expect(result.overlayZ).toBe(zIndex);expect(result.fabZ).toBe(42);expect(result.above).toBe(true);
  }
  await page.evaluate(()=>__ui.detail(__ui.state.invoices[0].id));
  await expect(page.locator('dialog')).toBeVisible();
  expect(await fab.evaluate(e=>{const r=e.getBoundingClientRect();return !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('dialog')})).toBe(true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:801,height:900});await expect(fab).toHaveCSS('bottom','22px');await expect(fab).toBeVisible();
});
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
    const dialog=document.querySelector('dialog');dialog.className='';dialog.innerHTML='<div class="dialog-head"><h2 id="dialog-title">Review reminder delivery</h2><button class="btn" data-action="close">Close</button></div>'+ui.reminderReviewForm({text:'Please pay invoice 123.',tone:'firm',customer:'Customer',number:'123',sendNow:true});dialog.showModal();
    globalThis.reviewRequests=[];globalThis.savedDraft=null;globalThis.approvedResult=null;
    ui.mountReminderReview(document.querySelector('#draft-form'),{
      requestPreview:async input=>{reviewRequests.push(input);return {eligible:true,approvalToken:'bound-token',expiresAt:new Date(Date.now()+60000).toISOString(),delivery:kind==='blocked'?null:kind==='template'?{form:'template',text:'The approved firm template words.',templateName:'cetld_invoice_details_firm_v1'}:{form:'service',text:input.text,windowExpiresAt:new Date(Date.now()+120000).toISOString(),windowClosedPolicy:'hold'}}},
      approve:async input=>{globalThis.approvedResult=input;return {approved:true}},
      onApproved:()=>{},onSaveDraft:async input=>{globalThis.savedDraft=input},
    });
  },kind);
}
for(const width of [360,390,800,1280])test(`reminder exact-word approval at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:740});await reviewFixture(page);
  const timing=page.getByRole('combobox',{name:'Delivery timing'});
  for(const value of ['false','true']){
    await timing.selectOption(value);
    expect(await timing.evaluate(e=>{
      const style=getComputedStyle(e),canvas=document.createElement('canvas'),context=canvas.getContext('2d');
      context.font=style.font;
      return context.measureText(e.selectedOptions[0].textContent).width<=e.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    })).toBe(true);
  }
  const approve=page.locator('[data-approve-reminder]');await expect(approve).toBeDisabled();
  await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await expect(page.locator('[data-delivery-preview]')).toContainText('Will send as your message');
  await expect(approve).toBeDisabled();await page.locator('[data-delivery-ack]').check();await expect(approve).toBeEnabled();
  await page.locator('[name=message]').fill('My new exact words.');await expect(approve).toBeDisabled();await expect(page.locator('[data-delivery-preview]')).toContainText('needs updating');
  await page.getByRole('button',{name:'Preview delivery',exact:true}).click();await page.locator('[data-delivery-ack]').check();await approve.click();
  expect(await page.evaluate(()=>approvedResult)).toEqual({text:'My new exact words.',tone:'firm',sendNow:true,approveFallback:false,approvalToken:'bound-token',windowClosedPolicy:'hold'});
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

test('optional reply style preserves form values, visible confirmation, and validation',async({page})=>{
  await boot(page);
  for(const width of [390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{__ui.state.page='Settings';__ui.render()});
    const form=page.locator('#owner-bot-preferences-form'),summary=form.locator('.reply-style-disclosure>summary');
    await expect(form.locator('[name=confirmationMode]')).toBeVisible();
    await expect(form.getByText('Required business approvals still apply.')).toBeVisible();
    await expect(form.locator('[type=submit]')).toBeVisible();
    await expect(form.locator('[name=assistantName]')).toBeVisible();
    await expect(form.locator('[name=tone]')).toBeHidden();
    await summary.focus();await page.keyboard.press('Enter');
    await form.locator('[name=assistantName]').fill('QA <assistant>');
    await form.locator('[name=tone]').selectOption('formal');
    await form.locator('[name=replyLength]').selectOption('short');
    await form.locator('[name=confirmationMode]').selectOption('buttons');
    await form.locator('[name=customInstruction]').fill('Use brief replies.');
    await summary.focus();await page.keyboard.press('Enter');
    await form.locator('[type=submit]').click();
    await expect(page.locator('.reply-style-disclosure>summary')).toContainText('QA <assistant>');
    await expect(page.locator('.reply-style-disclosure>summary')).toContainText('Formal');
    await expect(page.locator('[name=confirmationMode]')).toHaveValue('buttons');
    expect(await page.evaluate(()=>__ui.state.settings.owner_bot_preferences.customInstruction)).toBe('Use brief replies.');
    await page.locator('.reply-style-disclosure>summary').click();
    await page.locator('[name=assistantName]').fill('');
    await page.locator('.reply-style-disclosure>summary').click();
    await page.locator('#owner-bot-preferences-form [type=submit]').click();
    // Required identity stays outside disclosure so native validation can focus it.
    await expect(page.locator('[name=assistantName]')).toBeVisible();
    await expect(page.locator('[name=assistantName]')).toBeFocused();
    await page.locator('[name=assistantName]').fill('QA <assistant>');
    await page.locator('#owner-bot-preferences-form [name=tone]').evaluate(e=>{e.add(new Option('Invalid test tone','invalid'));e.value='invalid'});
    await page.locator('.reply-style-disclosure>summary').click();
    await page.locator('#owner-bot-preferences-form [type=submit]').click();
    await expect(page.locator('#owner-bot-preferences-form [data-error]')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
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

for(const width of [390,1280])test(`Overview and Collections Pulse separate issued outstanding from unissued drafts at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844});await boot(page);
  await page.evaluate(async()=>{
    const {receivablesLedger}=await import('/tests/fixtures/receivables.mjs');
    __ui.state.invoices=receivablesLedger.map(row=>({...row,number:row.invoice_number,client:'Test customer',amount_minor:Math.round(Number(row.total_amount)*100),paid_minor:Math.round(Number(row.amount_paid)*100)}));
    __ui.state.payments=[];__ui.state.page='Overview';__ui.render();
  });
  const card=page.locator('.stats .stat').first();
  await expect(card).toContainText('Issued outstanding');
  await expect(card.locator('[data-counter]')).toHaveAttribute('data-counter','100');
  await expect(card).toContainText('1 INR issued invoice plus');
  await expect(card).toContainText(/plus.*20,496(?:\.00)? in unissued drafts \(not yet receivable\)/);
  await expect(page.locator('.currency-caption')).toHaveText('Top cards show INR only. Other currencies appear in Collections Pulse.');
  const primary=page.locator('.pulse-metric.is-primary');
  await expect(primary).toContainText('Issued outstanding');
  await expect(primary.locator('strong[data-currency=INR]')).toHaveText('₹1');
  await expect(primary.locator('strong[data-currency=USD]')).toContainText('255.06');
  await expect(primary.locator('strong[data-currency=AUD]')).toContainText('0');
  await expect(primary).toContainText(/plus.*4,490(?:\.00)? in unissued drafts/);
  await expect(page.locator('.pulse-currency-note')).toContainText('Currencies are shown separately. No FX conversion is applied. Unissued drafts are not yet receivable.');
  await layout(page);
});

test('auth loading ends on the sign-in screen and when an account renders',async({page})=>{
  await boot(page);
  await expect(page.locator('body')).not.toHaveClass(/auth-loading/);
  await page.evaluate(()=>{document.body.classList.add('auth-loading','preserved-body-class');__ui.state.demo=false;__ui.render()});
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/auth-loading/);
  await expect(page.locator('body')).toHaveClass(/preserved-body-class/);
  await page.evaluate(()=>{document.body.classList.add('auth-loading');__ui.state.user=null;__ui.render()});
  await expect(page.locator('#auth-form')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/auth-loading/);
});

for(const theme of ['light','dark'])test(`idle mobile content clears the Assistant launcher at 390px in ${theme}`,async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await boot(page);
  await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');__ui.state.demo=false;__ui.render()},theme);
  const fab=page.locator('.assistant-fab'),action=page.getByRole('button',{name:'What needs my attention today?',exact:true});
  await expect(fab).toBeVisible();
  expect(await page.locator('.content').evaluate(e=>e.scrollTop)).toBe(0);
  const clear=()=>page.evaluate(()=>document.querySelector('.content').getBoundingClientRect().bottom<document.querySelector('.assistant-fab').getBoundingClientRect().top);
  expect(await clear()).toBe(true);
  expect(await page.locator('.content').evaluate(e=>e.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await page.screenshot({path:info.outputPath('overview-idle.png'),animations:'disabled'});
  await action.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.evaluate(()=>document.body.classList.remove('assistant-fab-hidden'));
  await expect(fab).toBeVisible();await action.click({trial:true});expect(await clear()).toBe(true);
  expect(await action.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('.content').getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom})).toBe(true);
});
