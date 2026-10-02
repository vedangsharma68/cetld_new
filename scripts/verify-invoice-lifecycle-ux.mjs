import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const playwrightPath=process.env.CETLD_PLAYWRIGHT_PATH
  ||'playwright';
const {chromium}=require(playwrightPath);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspaceId='22222222-2222-4222-8222-222222222222';
const ownerId='33333333-3333-4333-8333-333333333333';
const memberId='44444444-4444-4444-8444-444444444444';
const customerId='55555555-5555-4555-8555-555555555555';
const ids={
  ordinary:'11111111-1111-4111-8111-111111111111',
  paid:'11111111-1111-4111-8111-111111111112',
  failed:'11111111-1111-4111-8111-111111111113',
  stale:'11111111-1111-4111-8111-111111111114',
  hidden:'11111111-1111-4111-8111-111111111115',
};
const customer={id:customerId,workspace_id:workspaceId,name:'Cached Customer',company_name:'Cached Customer',email:'qa@example.test',phone:null};
const now='2026-09-20T10:00:00.000Z';
const invoices=[
  {id:ids.ordinary,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-1001-CURRENT',issue_date:'2026-09-01',due_date:'2026-10-01',currency:'INR',total_amount:'100.00',amount_paid:'0.00',status:'sent',created_at:now,updated_at:now,metadata:{client_name:'Cached Ordinary',invoice_direction:'receivable',followup_state:'draft',reminder_count:0}},
  {id:ids.paid,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-PAID-2',issue_date:'2026-09-02',due_date:'2026-10-02',currency:'INR',total_amount:'80.00',amount_paid:'80.00',status:'paid',created_at:now,updated_at:now,metadata:{client_name:'Paid Customer',invoice_direction:'receivable',followup_state:'cancelled',reminder_count:1,last_follow_up_at:now}},
  {id:ids.failed,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-FAIL-3',issue_date:'2026-09-03',due_date:'2026-10-03',currency:'INR',total_amount:'20.00',amount_paid:'0.00',status:'draft',created_at:now,updated_at:now,metadata:{client_name:'Failure Customer',invoice_direction:'receivable',followup_state:'draft',reminder_count:0}},
  {id:ids.stale,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-STALE-4',issue_date:'2026-09-04',due_date:'2026-10-04',currency:'INR',total_amount:'35.00',amount_paid:'0.00',status:'sent',created_at:now,updated_at:now,metadata:{client_name:'Stale Customer',invoice_direction:'receivable',followup_state:'draft',reminder_count:0}},
  {id:ids.hidden,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-DELETED-5',issue_date:'2026-09-05',due_date:'2026-10-05',currency:'INR',total_amount:'700.00',amount_paid:'0.00',status:'sent',deleted_at:'2026-09-10T10:00:00.000Z',created_at:now,updated_at:now,metadata:{client_name:'Hidden Customer',invoice_direction:'receivable'}},
];
const payments=[
  {id:'66666666-6666-4666-8666-666666666661',workspace_id:workspaceId,invoice_id:ids.paid,amount:'80.00',paid_at:now,created_at:now,reference:'paid receipt'},
  {id:'66666666-6666-4666-8666-666666666662',workspace_id:workspaceId,invoice_id:ids.hidden,amount:'70.00',paid_at:now,created_at:now,reference:'deleted receipt'},
];
const users={owner:{id:ownerId,email:'owner@example.test',user_metadata:{full_name:'QA Owner'}},member:{id:memberId,email:'member@example.test',user_metadata:{full_name:'QA Member'}}};
const fixture={workspaceId,ownerId,customerId,customer,invoices,payments,users,settings:{workspace_id:workspaceId,business_name:'Lifecycle QA',default_currency:'INR',default_timezone:'Asia/Kolkata',follow_up_preferences:{}}};

function mockSupabaseModule(){
  return `
const fixture=${JSON.stringify(fixture)};
const user=window.__invoiceLifecycleMember?fixture.users.member:fixture.users.owner;
const session={access_token:'browser-fixture-access-token-long-enough',refresh_token:'browser-fixture-refresh-token',user};
window.__mockSupabase={writes:[],rpcCalls:[],failInvoiceRead:false};
class Query{
  constructor(table){this.table=table;this.filters=[];this.max=null;this.start=0;this.end=null;this.operation='select';}
  select(){return this;}
  eq(column,value){this.filters.push(row=>String(row?.[column])===String(value));return this;}
  is(column,value){this.filters.push(row=>value===null?row?.[column]==null:row?.[column]===value);return this;}
  in(column,values){this.filters.push(row=>values.map(String).includes(String(row?.[column])));return this;}
  order(){return this;}
  limit(value){this.max=value;return this;}
  range(start,end){this.start=start;this.end=end;return Promise.resolve(this.table==='invoices'&&window.__mockSupabase.failInvoiceRead
    ?{data:null,error:{message:'fixture ledger refresh failed'}}
    :{data:this.rows().slice(start,end+1),error:null});}
  or(){return this;}
  gte(){return this;}
  upsert(value){return this.write('upsert',value);}
  insert(value){return this.write('insert',value);}
  update(value){return this.write('update',value);}
  delete(){return this.write('delete',null);}
  write(operation,value){this.operation=operation;window.__mockSupabase.writes.push({table:this.table,operation,value});return this;}
  rows(){let rows=this.table==='profiles'?[{user_id:user.id,full_name:user.user_metadata.full_name}]
    :this.table==='workspaces'?[{id:fixture.workspaceId,owner_id:fixture.ownerId,name:'Lifecycle QA',created_at:'2026-01-01T00:00:00.000Z'}]
    :this.table==='workspace_settings'?[fixture.settings]
    :this.table==='customers'?[fixture.customer]
    :this.table==='invoices'?fixture.invoices
    :this.table==='payments'?fixture.payments:[];
    for(const filter of this.filters)rows=rows.filter(filter);
    return this.max==null?rows:rows.slice(0,this.max);
  }
  maybeSingle(){return Promise.resolve({data:this.rows()[0]||null,error:null});}
  single(){return Promise.resolve({data:this.rows()[0]||null,error:null});}
  then(resolve,reject){return Promise.resolve({data:this.rows(),error:null}).then(resolve,reject);}
}
export function createClient(){return {auth:{
  onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},
  async getSession(){return {data:{session},error:null};},
  async getUser(){return {data:{user},error:null};},
  async signOut(){return {error:null};},
},from(table){return new Query(table);},async rpc(name,args){window.__mockSupabase.rpcCalls.push({name,args});return {data:null,error:null};}};}
`;
}

const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host}`);
    const relative=url.pathname==='/app/'?'app/index.html':decodeURIComponent(url.pathname.replace(/^\/+/,''));
    const target=path.resolve(root,relative||'index.html');
    if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
    const info=await stat(target);
    if(info.isDirectory()){res.writeHead(404);res.end('Not found');return;}
    const type=target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.js')||target.endsWith('.mjs')?'text/javascript; charset=utf-8':target.endsWith('.css')?'text/css; charset=utf-8':target.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
    createReadStream(target).pipe(res);
  }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;

const state={calls:[],proposals:new Map(),deleted:new Set(),failOnce:new Set(),staleIds:new Set([ids.stale]),nextProposal:1,memberMode:false};
function response(status,body){return {status,contentType:'application/json',body:JSON.stringify(body)};}
async function installMocks(page,{member=false}={}){
  state.memberMode=member;
  await page.addInitScript(value=>{window.__invoiceLifecycleMember=value;},member);
  await page.route('**/*',route=>{
    const requestUrl=new URL(route.request().url());
    if(requestUrl.origin===origin)return route.continue();
    return route.abort();
  });
  await page.route(/^https:\/\/esm\.sh\/\@supabase\/supabase-js@2\.116\.0$/,route=>route.fulfill({status:200,contentType:'application/javascript',body:mockSupabaseModule()}));
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON()||{}:{};
    state.calls.push({path:url.pathname,method:req.method(),body,authorization:req.headers().authorization||''});
    if(url.pathname==='/api/ai'&&url.searchParams.get('action')==='models')return route.fulfill(response(200,{models:[],fallbackModels:[],extractionModels:[]}));
    if(url.pathname==='/api/ai'&&url.searchParams.get('action')==='settings')return route.fulfill(response(200,{primary_model:'space-bunny-free',fallback_model:null,role:member?'member':'owner'}));
    if(url.pathname==='/api/whatsapp-test-send')return route.fulfill(response(403,{error:'TEST preview unavailable in this fixture'}));
    if(url.pathname!=='/api/invoice-lifecycle')return route.fulfill(response(404,{ok:false,code:'INVALID_REQUEST'}));
    if(req.headers().authorization!=='Bearer browser-fixture-access-token-long-enough')return route.fulfill(response(401,{ok:false,code:'OWNER_REQUIRED'}));
    if(body.workspaceId!==workspaceId)return route.fulfill(response(403,{ok:false,code:'OWNER_REQUIRED'}));
    if(body.action==='capabilities')return route.fulfill(response(member?403:200,member?{ok:false,code:'OWNER_REQUIRED'}:{ok:true,action:'capabilities',available:true}));
    if(member)return route.fulfill(response(403,{ok:false,code:'OWNER_REQUIRED'}));
    if(body.action==='prepareDelete'){
      const invoice=invoices.find(row=>row.id===body.invoiceId&&row.workspace_id===body.workspaceId&&!state.deleted.has(row.id));
      if(!invoice)return route.fulfill(response(404,{ok:false,code:'INVOICE_NOT_FOUND'}));
      const proposalId=`77777777-7777-4777-8777-${String(state.nextProposal++).padStart(12,'0')}`;
      const exact=invoice.id===ids.paid||Number(invoice.metadata.reminder_count||0)>0;
      const proposal={proposalId,workspaceId:body.workspaceId,invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,requiresExact:exact,state:'pending'};
      state.proposals.set(proposalId,proposal);
      const snapshot=invoice.id===ids.ordinary?{invoiceNumber:'INV-1001-CURRENT',customerName:'Server Current Customer',totalAmount:'1250.50',currency:'INR',status:'sent'}:{invoiceNumber:invoice.invoice_number,customerName:invoice.metadata.client_name,totalAmount:invoice.total_amount,currency:invoice.currency,status:invoice.status};
      return route.fulfill(response(200,{ok:true,action:'proposal_created',proposalId,invoiceId:invoice.id,...snapshot,requiresExactConfirmation:exact,expectedUpdatedAt:invoice.updated_at,expiresAt:'2026-10-02T12:00:00.000Z'}));
    }
    if(body.action==='confirmDelete'){
      const proposal=state.proposals.get(body.proposalId);
      if(!proposal||proposal.workspaceId!==body.workspaceId)return route.fulfill(response(404,{ok:false,code:'PROPOSAL_NOT_FOUND'}));
      if(proposal.invoiceId===ids.failed&&!state.failOnce.has(proposal.invoiceId)){state.failOnce.add(proposal.invoiceId);return route.fulfill(response(503,{ok:false,code:'DATABASE_UNAVAILABLE'}));}
      if(state.staleIds.has(proposal.invoiceId))return route.fulfill(response(409,{ok:false,code:'ACTION_STALE'}));
      const expected=proposal.requiresExact?`DELETE ${proposal.invoiceNumber}`:'yes';
      if(body.userMessage!==expected)return route.fulfill(response(400,{ok:false,code:proposal.requiresExact?'EXACT_CONFIRMATION_REQUIRED':'INVALID_CONFIRMATION'}));
      if(!body.confirmationMessageId||!body.confirmationMessageId.startsWith('dashboard:'))return route.fulfill(response(400,{ok:false,code:'INVALID_CONFIRMATION'}));
      proposal.state='deleted';state.deleted.add(proposal.invoiceId);
      return route.fulfill(response(200,{ok:true,action:'deleted',proposalId:proposal.proposalId,invoiceId:proposal.invoiceId,invoiceNumber:proposal.invoiceNumber}));
    }
    if(body.action==='cancelDelete'){
      const proposal=state.proposals.get(body.proposalId);
      if(!proposal||proposal.workspaceId!==body.workspaceId)return route.fulfill(response(404,{ok:false,code:'PROPOSAL_NOT_FOUND'}));
      proposal.state='cancelled';
      return route.fulfill(response(200,{ok:true,action:'cancelled',proposalId:proposal.proposalId,invoiceId:proposal.invoiceId}));
    }
    if(body.action==='undoDelete'){
      const invoice=invoices.find(row=>row.id===body.invoiceId&&row.workspace_id===body.workspaceId);
      if(!invoice||!state.deleted.has(invoice.id))return route.fulfill(response(404,{ok:false,code:'NOT_DELETED'}));
      state.deleted.delete(invoice.id);
      return route.fulfill(response(200,{ok:true,action:'restored',invoiceId:invoice.id,invoiceNumber:invoice.invoice_number}));
    }
    return route.fulfill(response(400,{ok:false,code:'INVALID_REQUEST'}));
  });
}

async function openInvoice(page,id){
  await page.locator(`.invoice-open[data-id="${id}"]`).click();
  await page.locator('#dialog [data-action="delete-invoice"]').waitFor();
}
async function navigateTo(page,name){
  const menu=page.locator('.mobile-menu');
  if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();
  await page.locator(`.nav button[data-page="${name}"]`).click();
}
async function prepareDelete(page,id){
  await openInvoice(page,id);
  await page.locator('#dialog [data-action="delete-invoice"]').click();
  await page.locator('#invoice-delete-form').waitFor();
  await page.locator('.invoice-delete-facts').waitFor();
}
async function submitDelete(page){await page.locator('#invoice-delete-form [type="submit"]').click();}
async function waitForRow(page,id,visible){
  await page.waitForFunction(({id,visible})=>{
    const row=document.querySelector(`.invoice-open[data-id="${id}"]`);
    return Boolean(row)===visible;
  },{id,visible},{timeout:6000});
}

const browser=await chromium.launch({headless:true,...(process.env.CETLD_CHROMIUM_EXECUTABLE?{executablePath:process.env.CETLD_CHROMIUM_EXECUTABLE}:{})});
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',colorScheme:'light'});
  const page=await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await installMocks(page);
  await page.goto(`${origin}/app/`,{waitUntil:'domcontentloaded'});
  await page.locator('.nav button[data-page="Invoices"]').waitFor({timeout:20000});
  await page.waitForFunction(()=>document.querySelector('.nav button[data-page="Invoices"] small')?.textContent==='4',{},{timeout:10000});
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  await navigateTo(page,'Invoices');
  await page.locator('.invoice-table').waitFor();
  assert.equal(await page.locator('.invoice-open').count(),4,'legacy or soft-deleted rows must not enter the active invoice list');
  assert.equal(await page.getByText('INV-DELETED-5',{exact:false}).count(),0);

  await prepareDelete(page,ids.ordinary);
  const review=await page.locator('.invoice-delete-facts').innerText();
  assert.match(review,/INV-1001-CURRENT/,'confirmation must use the server invoice snapshot');
  assert.match(review,/Server Current Customer/);
  assert.match(review,/1,250\.5/);
  assert.match(review,/Sent/);
  assert.equal(await page.locator('#invoice-delete-form input[name="confirmation"]').count(),0,'ordinary deletion must not ask for typed DELETE');
  await page.evaluate(()=>{window.__mockSupabase.failInvoiceRead=true;});
  await submitDelete(page);
  try{await page.getByRole('button',{name:'Undo deletion of invoice INV-1001-CURRENT'}).waitFor({timeout:5000});}
  catch{throw Error(JSON.stringify({dialog:await page.locator('#dialog').innerText(),toast:await page.locator('#toast').innerText(),calls:state.calls.slice(-5),deleted:[...state.deleted],pageErrors}));}
  await waitForRow(page,ids.ordinary,false);
  const ordinaryProposal=[...state.proposals.values()].find(proposal=>proposal.invoiceId===ids.ordinary);
  const ordinaryConfirm=state.calls.find(call=>call.body.action==='confirmDelete'&&call.body.proposalId===ordinaryProposal?.proposalId);
  assert.equal(ordinaryConfirm?.body.userMessage,'yes','ordinary confirmation must send the server-required yes text');
  assert.match(await page.locator('#toast .toast-message').innerText(),/deleted\. The ledger could not refresh, but the deletion is complete/i);
  await page.locator('.toast-action').click();
  await page.getByRole('status').getByText(/INV-1001-CURRENT was restored\. Refresh the ledger to load it/).waitFor({timeout:6000});
  await page.evaluate(()=>{window.__mockSupabase.failInvoiceRead=false;});
  await page.locator('.topbar [data-action="refresh"]').click();
  await waitForRow(page,ids.ordinary,true);
  await navigateTo(page,'Overview');
  await page.waitForFunction(()=>document.querySelector('.stat.dark [data-counter]')?.getAttribute('data-counter')==='15500');
  await navigateTo(page,'Payments');
  await page.locator('.payment-table').waitFor();
  assert.equal(await page.locator('.payment-table tbody tr').count(),1,'payments attached to initially deleted invoices must stay hidden');
  await navigateTo(page,'Invoices');
  await prepareDelete(page,ids.paid);
  assert.match(await page.locator('.invoice-delete-facts').innerText(),/Paid/);
  const exactInput=page.locator('#invoice-delete-form input[name="confirmation"]');
  assert.equal(await exactInput.count(),1,'paid/payment-bearing invoices require exact typed confirmation');
  const confirmCountBefore=state.calls.filter(call=>call.body.action==='confirmDelete').length;
  await exactInput.fill('DELETE wrong');
  await submitDelete(page);
  assert.match(await page.locator('[data-delete-error]').innerText(),/exactly/);
  assert.equal(state.calls.filter(call=>call.body.action==='confirmDelete').length,confirmCountBefore,'a wrong typed phrase must not reach the server');
  await exactInput.fill('DELETE INV-PAID-2');
  await submitDelete(page);
  await page.getByRole('button',{name:'Undo deletion of invoice INV-PAID-2'}).waitFor();
  await waitForRow(page,ids.paid,false);
  await navigateTo(page,'Payments');
  await page.locator('.empty').waitFor();
  assert.equal(await page.locator('.payment-table').count(),0,'deleted invoice payment history must disappear');
  await page.locator('.toast-action').click();
  await page.getByRole('status').getByText(/INV-PAID-2 was restored/).waitFor({timeout:6000});
  await navigateTo(page,'Invoices');
  await waitForRow(page,ids.paid,true);

  await navigateTo(page,'Invoices');
  await prepareDelete(page,ids.failed);
  await submitDelete(page);
  await page.locator('[data-delete-error]').filter({hasText:'temporarily unavailable'}).waitFor();
  await waitForRow(page,ids.failed,true);
  assert.equal(await page.locator('#dialog').evaluate(dialog=>dialog.open),true,'a failed confirmation must preserve the open review for safe retry');
  await submitDelete(page);
  await page.getByRole('button',{name:'Undo deletion of invoice INV-FAIL-3'}).waitFor();
  await waitForRow(page,ids.failed,false);
  await page.locator('.toast-action').click();
  await page.getByRole('status').getByText(/INV-FAIL-3 was restored/).waitFor({timeout:6000});

  await navigateTo(page,'Invoices');
  await prepareDelete(page,ids.stale);
  await submitDelete(page);
  await page.locator('[data-delete-error]').filter({hasText:'changed while you were reviewing'}).waitFor();
  assert.equal(await page.locator('#invoice-delete-form [type="submit"]').count(),0,'a stale review must not be confirmable');
  await page.locator('#invoice-delete-form [data-action="refresh-invoice-delete"]').click();
  await waitForRow(page,ids.stale,true);
  assert.equal(state.deleted.has(ids.stale),false,'stale proposal must never delete the invoice');

  const toastTransition=await page.evaluate(()=>getComputedStyle(document.querySelector('#toast')).transitionDuration);
  assert.equal(toastTransition,'0s','undo toast honors reduced motion');
  assert.deepEqual(await page.evaluate(()=>window.__mockSupabase.writes),[],'browser fixture must make no Supabase writes');
  assert.equal(state.calls.some(call=>call.path==='/api/invoice-lifecycle'&&call.authorization!=='Bearer browser-fixture-access-token-long-enough'),false);
  assert.deepEqual(pageErrors,[],'invoice lifecycle UI raised no browser errors');
  await context.close();

  const memberContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const memberPage=await memberContext.newPage();
  await installMocks(memberPage,{member:true});
  await memberPage.goto(`${origin}/app/`,{waitUntil:'domcontentloaded'});
  await memberPage.locator('.nav button[data-page="Invoices"]').waitFor({timeout:20000});
  await navigateTo(memberPage,'Invoices');
  await memberPage.locator('.invoice-open').first().click();
  await memberPage.locator('#dialog').waitFor({state:'visible'});
  assert.equal(await memberPage.locator('#dialog [data-action="delete-invoice"]').count(),0,'workspace members cannot delete invoices');
  assert.deepEqual(await memberPage.evaluate(()=>window.__mockSupabase.writes),[]);
  await memberContext.close();

  console.log(JSON.stringify({passed:true,viewport:{width:390,height:844},reducedMotion:true,flows:['ordinary server snapshot and yes confirmation','paid exact phrase','undo from toast','failed confirmation retry','stale proposal refresh','deleted payment and invoice exclusion','member delete restriction'],lifecycleCalls:state.calls.filter(call=>call.path==='/api/invoice-lifecycle').length,environment:'local worktree page with mocked Supabase and lifecycle API; no provider calls or real data writes'},null,2));
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
