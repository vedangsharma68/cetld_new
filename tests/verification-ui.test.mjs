import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createOwnerTemplateTestUI,zohoDiscoveryView} from '../verification-ui.mjs';

const workspaceId='9a83b58d-6b02-4b17-8de5-c67136f26434',userId='40ff343c-4334-4aec-b49a-ca772f0cf8ad',invoiceId='f86e28bd-16a8-4c83-a03d-05302f7f3ff6';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const preview={test:true,audience:'owner',workspaceId,ownerId:userId,invoiceId,recipient:'+919871367051',
  template:{name:'cetld_invoice_update_v2',language:{code:'en'}},text:'Hi, this is CETLD test. Invoice TEST ONLY - INV-2026-6771 for owner test only has an update.',previewToken:'fixture-preview-secret'};
function setup({reply=preview,request}={}){
  const state={demo:false,user:{id:userId},workspace:{id:workspaceId,owner_id:userId},invoices:[{id:invoiceId,total:140,paid:40,paused:true}]};
  const snapshots=[],errors=[],toasts=[],calls=[];let head={};
  const dialog={open:false,querySelector(selector){return selector==='.dialog-head'?head:selector==='.dialog-body'?{removeAttribute(){}}:null;}};
  const ui=createOwnerTemplateTestUI({state,escape,dialog:()=>dialog,button:(action,label)=>`<button data-action="${action}">${label}</button>`,
    openDialog(title,body){snapshots.push({title,body});head={};dialog.open=true;},showError(_dialog,error){errors.push(error.message);},toast:message=>toasts.push(message),
    request:async(id,options)=>{calls.push({id,options});return request?request(id,options):options.method==='POST'?{status:'accepted'}:reply;}});
  return {state,ui,snapshots,errors,toasts,calls,dialog,control:()=>({disabled:false,dataset:{},textContent:'',setAttribute(key,value){this[key]=value;}})};
}

test('visible owner review shows exact recipient/message and does not render tokens or send',async()=>{
  const f=setup(),before=structuredClone(f.state.invoices);assert.equal(f.ui.canReview(f.state.invoices[0]),true);
  await f.ui.review(f.control(),invoiceId);assert.equal(f.snapshots.length,2);assert.equal(f.calls.length,1);
  const html=f.snapshots[1].body;assert.ok(html.includes(preview.text));assert.ok(html.includes(preview.recipient));
  assert.ok(html.includes('Send one owner test'));assert.ok(!html.includes(preview.previewToken));assert.ok(!html.includes('approved-template-test'));
  assert.notEqual(f.calls[0].options.method,'POST');assert.deepEqual(f.errors,[]);assert.deepEqual(f.state.invoices,before);
});

test('visible send consumes one reviewed preview, remains disabled and reports acceptance separately from delivery',async()=>{
  const f=setup(),control=f.control();await f.ui.review(f.control(),invoiceId);await f.ui.send(control);
  assert.equal(control.disabled,true);assert.equal(control.dataset.keepDisabled,'true');assert.equal(control.textContent,'Accepted by Meta');
  assert.equal(control['aria-label'],'Accepted by Meta');
  const posts=f.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].options.previewToken,preview.previewToken);
  assert.match(f.toasts[0],/accepted.*Conversations.*delivery status/i);
  await assert.rejects(f.ui.send(f.control()),/fresh owner test preview/);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});

for(const result of ['unknown','network-error'])test(`visible ${result} result never retries or reenables send`,async()=>{
  const f=setup({request:async(_id,options)=>{if(options.method!=='POST')return preview;if(result==='network-error')throw Error('Fixture network unavailable');return {status:'unknown'};}});
  await f.ui.review(f.control(),invoiceId);const control=f.control();await f.ui.send(control);
  assert.equal(control.disabled,true);assert.equal(control.textContent,'Result unconfirmed');
  await assert.rejects(f.ui.send(f.control()),/fresh owner test preview/);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});

for(const change of ['demo','foreign-user','foreign-workspace','foreign-owner','different-invoice'])test(`owner test visibility and review reject ${change}`,async()=>{
  const f=setup();if(change==='demo')f.state.demo=true;if(change==='foreign-user')f.state.user.id='other';
  if(change==='foreign-workspace')f.state.workspace.id='other';if(change==='foreign-owner')f.state.workspace.owner_id='other';
  if(change==='different-invoice')f.state.invoices[0].id='other';
  assert.equal(f.ui.canReview(f.state.invoices[0]),false);await assert.rejects(f.ui.review(f.control(),invoiceId));assert.equal(f.calls.length,0);
});

for(const patch of [{recipient:'+919818685252'},{workspaceId:'other'},{audience:'customer'},{test:false},{template:{name:'other',language:{code:'en'}}}])
test(`mismatched server preview cannot expose send action ${JSON.stringify(patch)}`,async()=>{
  const f=setup({reply:{...preview,...patch}});await f.ui.review(f.control(),invoiceId);
  assert.match(f.snapshots.at(-1).body,/Preview unavailable/);
  assert.ok(f.snapshots.every(snapshot=>!snapshot.body.includes('data-action="owner-template-test-send"')));
  assert.equal(f.errors.length,1);
  await assert.rejects(f.ui.send(f.control()));assert.equal(f.calls.length,1);
});

for(const change of ['workspace','user','closed-dialog'])test(`late preview after ${change} change is discarded`,async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const f=setup({request:async()=>pending});
  const work=f.ui.review(f.control(),invoiceId);if(change==='workspace')f.state.workspace.id='other';if(change==='user')f.state.user.id='other';if(change==='closed-dialog')f.dialog.open=false;
  release(preview);await work;assert.equal(f.snapshots.length,1);await assert.rejects(f.ui.send(f.control()));assert.equal(f.calls.length,1);
});

test('account switching after preview blocks send before the application request helper',async()=>{
  const f=setup();await f.ui.review(f.control(),invoiceId);f.state.workspace.id='other';await assert.rejects(f.ui.send(f.control()));assert.equal(f.calls.length,1);
});

test('rejected owner preview replaces loading with a recoverable error and never exposes send',async()=>{
  const f=setup({request:async()=>{throw Error('APPROVED_TEST_TEMPLATE_MISMATCH');}}),control=f.control();
  await f.ui.review(control,invoiceId);
  const html=f.snapshots.at(-1).body;
  assert.doesNotMatch(html,/Preparing owner test preview|aria-busy="true"/);
  assert.match(html,/Preview unavailable/);
  assert.match(html,/data-action="owner-template-test-review"/);
  assert.doesNotMatch(html,/data-action="owner-template-test-send"/);
  assert.equal(control.disabled,false);
  assert.equal(f.errors.length,1);
  await assert.rejects(f.ui.send(f.control()),/fresh owner test preview/);
});

test('owner review displays the approved static opt-out footer',async()=>{
  const f=setup({reply:{...preview,footer:'Reply STOP to opt out'}});
  await f.ui.review(f.control(),invoiceId);
  assert.match(f.snapshots.at(-1).body,/Reply STOP to opt out/);
  assert.equal(f.errors.length,0);
});

test('Zoho diagnostics distinguish empty and error results, escape data and contain no connect/sync controls',()=>{
  for(const status of ['available','empty','error']){
    const html=zohoDiscoveryView({status,organizationCount:status==='error'?null:0,providerCode:'<img src=x onerror=alert(1)>',httpStatus:200},escape);
    assert.ok(html.includes('Organization check'));assert.ok(html.includes('HTTP status'));assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('data-action='));
  }
  assert.equal(zohoDiscoveryView(null,escape),'');assert.equal(zohoDiscoveryView({status:'forged'},escape),'');
});

test('app routes visible owner controls through existing session helper and Zoho check through status only',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(source,/ownerTemplateTestUI\.canReview\(x\)\?button\('owner-template-test-review','Review owner test'/);
  assert.match(source,/if\(action==='owner-template-test-review'\)return await ownerTemplateTestUI\.review\(b,id\)/);
  assert.match(source,/if\(action==='owner-template-test-send'\)return await ownerTemplateTestUI\.send\(b\)/);
  assert.match(source,/request:\(id,options=\{\}\)=>whatsappTestRequest\(id,\{\.\.\.options,action:'owner-template-test'\}\)/);
  const check=source.slice(source.indexOf("if(action==='check-zoho-status')"),source.indexOf("if(action==='select-zoho-organization')"));
  assert.match(check,/accountingRequest\('status'\)/);assert.doesNotMatch(check,/sync|start|select-organization|loadData|refreshZohoLedger/);
  assert.match(source,/zohoDiscoveryView\(status\.organizationDiscovery,escape\)/);
});

test('application helper uses its existing auth session internally and exact endpoint action/preview header',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function whatsappTestRequest('),source.indexOf('const ownerTemplateTestUI='));
  const calls=[],state={workspace:{id:workspaceId},invoices:[{id:invoiceId}]};
  const context={state,URL,location:{origin:'https://fixture.test'},accessToken:async()=>'fixture-app-session',readyReminderPreviewToken:()=>null,
    ownerTemplateTestUI:{canReview:()=>true},fetch:async(url,options)=>{calls.push({url:String(url),options});return Response.json(options.method==='POST'?{status:'accepted'}:preview);}};
  vm.runInNewContext(code+';globalThis.request=whatsappTestRequest;',context);
  await context.request(invoiceId,{action:'owner-template-test'});await context.request(invoiceId,{action:'owner-template-test',method:'POST',previewToken:preview.previewToken});
  assert.ok(calls[0].url.includes('action=owner-template-test'));assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-app-session');
  assert.deepEqual(JSON.parse(calls[1].options.body),{workspaceId,invoiceId,action:'owner-template-test'});
  assert.equal(calls[1].options.headers['X-WhatsApp-Test-Preview'],preview.previewToken);assert.equal(calls.length,2);
});
