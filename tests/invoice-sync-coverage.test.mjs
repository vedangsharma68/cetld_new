import {APIError} from '../ai/http.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {syncInvoiceRow,MAX_SYNC_ATTEMPTS,SYNC_LEASE_MS,syncRetryDelay} from '../automation/invoice-sync.mjs';
import {invoiceSyncPersistence} from '../automation/invoice-sync-store.mjs';
import {createInvoiceReconcileStore,reconcileInvoiceSync,createInvoiceReconcileHandler} from '../automation/invoice-sync-reconciler.mjs';
import {retryAssistantInvoiceSync,saveAssistantInvoice} from '../ai/invoice-ops.mjs';
import {canRetryInvoiceSync,retryInvoiceBookkeeping,syncCreatedInvoice,invoiceSyncMessage} from '../invoice/bookkeeping-client.mjs';
import {createWhatsAppProcessHandler} from '../api/whatsapp-process.js';
import {createAIHandler} from '../ai/routes.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111',invoiceId='22222222-2222-4222-8222-222222222222';
const ownerId='33333333-3333-4333-8333-333333333333';
const invoice={direction:'receivable',invoiceNumber:'INV-1',total:118,currency:'INR',clientName:'Client',invoiceDate:'2026-10-01',dueDate:'2026-10-20'};
const initial={id:invoiceId,workspace_id:workspaceId,customer_id:'44444444-4444-4444-8444-444444444444',invoice_number:'INV-1',issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:'INR',total_amount:118,amount_paid:0,status:'draft',updated_at:'v0',metadata:{invoice_direction:'receivable',bookkeeping_sync_status:'pending',followup_state:'draft'}};
function memory(row={...initial,metadata:{...initial.metadata}}) {
  let current=structuredClone(row),version=0;
  const read=async()=>structuredClone(current);
  const patch=async(expected,body)=>{
    if(expected.updated_at!==current.updated_at || current.deleted_at)return null;
    current={...current,...structuredClone(body),updated_at:`v${++version}`};return read();
  };
  const store={workspaceId,userId:ownerId,getAssistantInvoice:read,query:async()=>[{id:initial.customer_id,workspace_id:workspaceId,name:'Client'}],
    ...invoiceSyncPersistence({read,patch}),
    async updateAssistantInvoiceMetadata(id,metadata,fields={}){return patch(await read(),{metadata,...fields})},
    edit(body){current={...current,...body,updated_at:`v${++version}`}},get row(){return structuredClone(current)}};
  return store;
}
const ok={syncInvoice:async()=>({provider:'zoho_books',externalId:'zoho-1'})};
const failure={syncInvoice:async()=>{throw Object.assign(Error('upstream'),{code:'ACCOUNTING_SYNC_FAILED'})}};
const response=()=>({code:0,body:null,setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}});

test('all legacy creation sources sync through the authenticated retry API with saved row facts',async()=>{
  for(const status of ['not_configured','pending','failed']) {
    const store=memory({...initial,metadata:{...initial.metadata,bookkeeping_sync_status:status}});
    let exported;
    const handler=createAIHandler({authorize:async()=>store,accountingFactory:()=>({async syncInvoice(input){exported=input;return ok.syncInvoice()}})});
    const request=async(action,{body})=>{
      const res=response();await handler({method:'POST',query:{action},body,headers:{}},res);
      assert.equal(res.code,200);return res.body;
    };
    const result=await syncCreatedInvoice({request,workspaceId,invoiceId,idempotencyKey:'dashboard_sync_1'});
    assert.equal(result.sync.status,'synced');assert.equal(exported.invoice.invoiceNumber,'INV-1');
    assert.equal(exported.invoice.clientName,'Client');assert.equal(store.row.sync_status,'synced');
    assert.equal(store.row.metadata.followup_state,'draft');
  }
});

test('backoff and five-attempt cap apply to scheduled retries; explicit retry can restart after cooldown',async()=>{
  const store=memory();let now=Date.parse('2026-10-22T00:00:00Z'),calls=0;
  const accounting={syncInvoice:async()=>{calls++;return failure.syncInvoice()}};
  for(let attempt=1;attempt<=MAX_SYNC_ATTEMPTS;attempt++) {
    const result=await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});
    assert.equal(result.sync.status,'failed');assert.equal(store.row.metadata.bookkeeping_sync_attempts,attempt);
    await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});
    assert.equal(calls,attempt,'waiting row must not call Zoho');
    now+=syncRetryDelay(attempt)+1;
  }
  for(let run=0;run<3;run++)await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});
  assert.equal(calls,5);assert.equal(store.row.metadata.bookkeeping_sync_exhausted,true);
  const result=await retryAssistantInvoiceSync({store,invoiceId,accounting:ok,clock:()=>new Date(now)});
  assert.equal(result.sync.status,'synced');assert.equal(store.row.metadata.bookkeeping_sync_attempts,1);
});

test('overlapping retries claim once and completion merges concurrent reminder metadata',async()=>{
  const store=memory();let release,calls=0;
  const gate=new Promise(resolve=>release=resolve);
  const accounting={async syncInvoice(){calls++;await gate;store.edit({metadata:{...store.row.metadata,followup_state:'paused',owner_note:'keep'}});return ok.syncInvoice()}};
  const row=store.row;
  const runs=[syncInvoiceRow({store,row,invoice,accounting}),syncInvoiceRow({store,row,invoice,accounting})];
  await new Promise(resolve=>setImmediate(resolve));release();await Promise.all(runs);
  assert.equal(calls,1);assert.equal(store.row.metadata.followup_state,'paused');assert.equal(store.row.metadata.owner_note,'keep');
  assert.equal(store.row.metadata.bookkeeping_sync_status,'synced');
});

test('crashed pending lease is retried later and consumes an attempt; linked/deleted/payable rows never export',async()=>{
  let now=Date.now(),calls=0;
  const row={...initial,metadata:{...initial.metadata,bookkeeping_sync_attempts:1,bookkeeping_sync_next_at:new Date(now+SYNC_LEASE_MS).toISOString()}};
  const store=memory(row),accounting={async syncInvoice(){calls++;return ok.syncInvoice()}};
  await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});assert.equal(calls,0);
  now+=SYNC_LEASE_MS+1;
  await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});assert.equal(calls,1);assert.equal(store.row.metadata.bookkeeping_sync_attempts,2);
  for(const patch of [{external_invoice_id:'existing',external_provider:'zoho_books'},{deleted_at:new Date().toISOString()},{status:'cancelled'},{metadata:{invoice_direction:'payable'}}]) {
    const excluded=memory({...initial,...patch});await syncInvoiceRow({store:excluded,row:excluded.row,invoice,accounting});
  }
  assert.equal(calls,1);
});

test('reconciler processes bot and dashboard rows, isolates failures, and bounds a run',async()=>{
  const stores=Array.from({length:30},()=>memory());let count=0;
  const data={connections:async()=>[{workspace_id:workspaceId,owner_id:ownerId}],
    candidates:async()=>stores.map((s,i)=>({id:invoiceId,workspace_id:workspaceId,index:i})),scoped(){return stores[count++]}};
  const result=await reconcileInvoiceSync({store:data,accounting:ok});
  assert.equal(result.processed,25);assert.equal(count,25);
  assert.ok(stores.slice(0,25).every(s=>s.row.metadata.bookkeeping_sync_status==='synced'));
  assert.equal(stores[25].row.metadata.bookkeeping_sync_status,'pending');
});

test('REST candidate queries select only connected workspaces and due non-exhausted local invoices',async()=>{
  const requests=[];
  const store=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only'},fetchImpl:async(url,options)=>{
    const u=new URL(url);requests.push({u,options});
    return new Response(JSON.stringify(u.pathname.endsWith('cetld_accounting_connections')?[{owner_id:ownerId,workspace_id:workspaceId}]:[]));
  }});
  const connections=await store.connections();await store.candidates(connections,'2026-10-22T00:00:00.000Z');
  assert.equal(requests[0].u.searchParams.get('select'),'owner_id,workspace_id');
  assert.equal(requests[0].u.searchParams.get('status'),'eq.connected');
  assert.equal(requests[0].u.searchParams.get('provider'),'eq.zoho_books');
  const params=requests[1].u.searchParams;
  assert.equal(params.get('workspace_id'),`in.(${workspaceId})`);assert.equal(params.get('deleted_at'),'is.null');
  assert.match(params.get('and'),/pending,failed,not_configured/);assert.match(params.get('and'),/bookkeeping_sync_exhausted/);
  assert.match(params.get('or'),/bookkeeping_sync_next_at.lte.2026-10-22/);
  assert.equal(params.get('limit'),'25');assert.equal(params.get('order'),'created_at.asc,id.asc');
});

test('accounting cron authenticates independently and never invokes WhatsApp or reminder sends',async()=>{
  let calls=0;
  const invoiceSyncHandler=createInvoiceReconcileHandler({env:{CRON_SECRET:'test'},storeFactory:()=>{calls++;return{connections:async()=>[],candidates:async()=>[]}},accountingFactory:()=>ok});
  const route=createWhatsAppProcessHandler({invoiceSyncHandler,processHandler:()=>assert.fail('WhatsApp send path'),reminderHandler:()=>assert.fail('reminder send path')});
  let res=response();await route({method:'GET',query:{accounting:'1'},headers:{}},res);assert.equal(res.code,401);assert.equal(calls,0);
  res=response();await route({method:'GET',query:{accounting:'1'},headers:{authorization:'Bearer test'}},res);assert.equal(res.code,200);assert.equal(calls,1);
  res=response();await invoiceSyncHandler({method:'POST',headers:{authorization:'Bearer test'}},res);assert.equal(res.code,405);
});

test('drawer retry uses the same API, refreshes saved status, and displays escaped errors',async()=>{
  for(const status of ['pending','failed'])assert.equal(canRetryInvoiceSync({bookkeeping_sync_status:status},false),true);
  assert.equal(canRetryInvoiceSync({bookkeeping_sync_status:'not_configured'},false),false);
  assert.equal(canRetryInvoiceSync({bookkeeping_sync_status:'not_configured'},true),true);
  assert.equal(canRetryInvoiceSync({bookkeeping_sync_status:'synced'},true),false);
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function retryDrawerSync('),app.indexOf('\n}',app.indexOf('async function retryDrawerSync('))+2);
  const calls=[];
  await vm.runInNewContext(source+'retryDrawerSync("invoice")',{state:{workspace:{id:workspaceId}},
    retryInvoiceBookkeeping:async options=>{calls.push(options);return{sync:{status:'synced'}}},aiRequest:()=>{},
    loadData:async()=>calls.push('reload'),detail:id=>calls.push(id),toast:message=>calls.push(message),invoiceSyncMessage});
  assert.equal(calls[0].workspaceId,workspaceId);assert.equal(calls[0].invoiceId,'invoice');assert.deepEqual(calls.slice(1),['reload','invoice','Bookkeeping sync completed.']);
  assert.match(app,/Sync error: \$\{escape\(x.bookkeeping_sync_error\)\}/);
  assert.match(app,/canRetryInvoiceSync\(x,state.invoiceSyncConnected\|\|state.accountingStatus\?\.status==='connected'\)/);
  assert.match(app,/if\(!x\)\{const synced=await syncCreatedInvoice/);
});

test('a browser sync outage keeps the saved invoice and leaves retry to the reconciler',async()=>{
  const result=await syncCreatedInvoice({request:async()=>{throw Error('offline')},workspaceId,invoiceId});
  assert.equal(result.sync.status,'pending');assert.equal(result.sync.retryable,true);
  let input;
  await retryInvoiceBookkeeping({request:async(...args)=>input=args,workspaceId,invoiceId,idempotencyKey:'explicit-retry'});
  assert.equal(input[0],'retry-invoice-sync');assert.equal(input[1].body.idempotencyKey,'explicit-retry');
});

test('real dashboard New Invoice handler saves then syncs, including paid creation and upload-free fallback',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function saveInvoice(e,x){'),app.indexOf('\nfunction paymentForm('));
  for(const alreadyPaid of [false,true]) {
    const calls=[],form={dataset:{},querySelector:()=>({disabled:false})};
    const values=new Map(Object.entries({direction:'receivable',client:'Client',currency:'INR',amount:'118',invoice_date:'2026-10-01',due_date:'2026-10-20',...(alreadyPaid?{alreadyPaid:'on'}:{})}));
    const db={from(table){return{insert(payload){calls.push({table,payload});return{select(){return{single:async()=>({data:table==='invoices'?{...initial,...payload}: {id:'customer',name:'Client'}})}}}}}},rpc:async()=>({data:{}})};
    await vm.runInNewContext(source+'saveInvoice(event)',{event:{preventDefault(){},currentTarget:form},state:{workspace:{id:workspaceId},invoices:[],customers:[]},
      FormData:class{get(key){return values.get(key)}has(key){return values.has(key)}},db,cents:value=>Math.round(Number(value)*100),terminalInvoice:()=>false,
      saveAndSettleInvoice:async({state,saveInvoice,recordPayment})=>{const row=await saveInvoice();state.invoiceId=row.id;await recordPayment({invoiceId:row.id,idempotencyKey:'settle'});calls.push('settled')},
      syncCreatedInvoice:async options=>{calls.push({sync:options.invoiceId});return{sync:{status:'synced'}}},aiRequest:()=>{},
      $:()=>({close(){calls.push('closed')}}),loadData:async()=>{},toast:message=>calls.push(message),showError:(_,error)=>{throw error}});
    const saved=calls.find(c=>c?.table==='invoices');assert.equal(saved.payload.metadata.bookkeeping_sync_status,'pending');
    const synced=calls.find(c=>c?.sync);assert.equal(synced.sync,invoiceId);
    assert.ok(calls.indexOf(saved)<calls.indexOf(synced));
    if(alreadyPaid)assert.ok(calls.indexOf('settled')<calls.indexOf(synced));
  }
});

test('real drawer renders retry on eligible states with connection and escapes sync errors',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('function detail(id){'),app.indexOf('function invoiceDeleteStatus('));
  for(const status of ['pending','failed','not_configured','synced'])for(const connected of [false,true]) {
    let html;
    const row={...initial,id:invoiceId,number:'INV-1',client:'Client',invoice_direction:'receivable',bookkeeping_sync_status:status,bookkeeping_sync_error:'<failure>'};
    const context={state:{invoices:[row],accountingStatus:{status:connected?'connected':'not_connected'}},remaining:()=>11800,terminalInvoice:()=>false,activeException:()=>null,followupStage:()=>['Draft',''],
      openDialog:(_,content)=>html=content,escape:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),status:()=> 'Open',money:()=>'',tag:String,day:()=>'',deliveryState:()=>'',invoiceBusinessDetails:()=>'',customFieldsView:()=>'',icon:()=>'',
      canRetryInvoiceSync,ownerTemplateTestUI:{canReview:()=>false},isExternallyManagedInvoice:()=>false,
      button:(action,label)=>`<button data-action="${action}">${label}</button>`,whatsappTestRequest:async()=>{throw Error('unused')}};
    vm.runInNewContext(source+`detail('${invoiceId}')`,context);
    assert.equal(html.includes('data-action="retry-invoice-sync"'),['pending','failed'].includes(status)||status==='not_configured'&&connected);
    assert.match(html,/&lt;failure&gt;/);assert.doesNotMatch(html,/<failure>/);
  }
});

test('drawer connection lookup is workspace-authorized and returns only a boolean',async()=>{
  let authorized=false,lookups=0;
  const handler=createAIHandler({authorize:async(req,id)=>{assert.equal(id,workspaceId);authorized=true;return{}},invoiceConnectionLookup:async({workspaceId:id})=>{assert.equal(authorized,true);assert.equal(id,workspaceId);lookups++;return{owner_id:'private'}}});
  const res=response();await handler({method:'GET',query:{action:'invoice-sync-status',workspaceId},headers:{}},res);
  assert.equal(res.code,200);assert.deepEqual(res.body,{connected:true});assert.equal(lookups,1);
  const denied=createAIHandler({authorize:async()=>{throw new APIError(403,'WORKSPACE_ACCESS_DENIED')},invoiceConnectionLookup:()=>assert.fail('lookup before authorization')});
  const rejected=response();await denied({method:'GET',query:{action:'invoice-sync-status',workspaceId},headers:{}},rejected);assert.equal(rejected.code,403);
});

test('reconciler stops a rate-limited workspace without spending attempts on its remaining rows',async()=>{
  const store=memory();let exports=0;
  const data={connections:async()=>[{workspace_id:workspaceId,owner_id:ownerId}],candidates:async()=>[{id:invoiceId,workspace_id:workspaceId},{id:invoiceId,workspace_id:workspaceId}],scoped:()=>store};
  const accounting={syncInvoice:async()=>{exports++;throw Object.assign(Error('rate limited'),{code:'ACCOUNTING_PROVIDER_ERROR',status:429})}};
  const result=await reconcileInvoiceSync({store:data,accounting});
  assert.equal(result.processed,1);assert.equal(exports,1);assert.equal(store.row.metadata.bookkeeping_sync_http_status,429);
});

test('malformed legacy attempt counts fail closed rather than retrying forever',async()=>{
  const store=memory({...initial,metadata:{...initial.metadata,bookkeeping_sync_attempts:'invalid'}});
  const result=await retryAssistantInvoiceSync({store,invoiceId,accounting:{syncInvoice:()=>assert.fail('exhausted')},manualRetry:false});
  assert.equal(result.sync.status,'failed');assert.equal(store.row.metadata.bookkeeping_sync_exhausted,true);
});

test('workspace member exports use the connected owner identity and never another workspace org',async()=>{
  const {InMemoryAccountingStore,TokenCipher,connectionAad,createAccountingIntegration}=await import('../automation/accounting/index.mjs');
  const store=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,7));
  await store.insertConnection({userId:ownerId,workspaceId,provider:'zoho_books',providerAccountId:'org-for-workspace',apiDomain:'https://www.zohoapis.com',status:'connected',tokenExpiresAt:Date.now()+3600_000,...cipher.encrypt({accessToken:'test-token',refreshToken:'test-refresh'},connectionAad('zoho_books',workspaceId))});
  store.getWorkspaceInvoiceConnection=async id=>id===workspaceId?{owner_id:ownerId}:null;
  let selectedOrg;
  const accounting=createAccountingIntegration({store,cipher,providers:{quickbooks:{},zoho_books:{createInvoice:async({accountId})=>{selectedOrg=accountId;return{externalId:'exported'}}}}});
  const result=await accounting.syncInvoice({userId:'member',workspaceId,provider:'zoho_books',invoice,invoiceId});
  assert.equal(result.externalId,'exported');assert.equal(selectedOrg,'org-for-workspace');
  await assert.rejects(accounting.syncInvoice({userId:'member',workspaceId:'other-workspace',provider:'zoho_books',invoice,invoiceId}),error=>error.code==='ACCOUNTING_NOT_CONNECTED');
});

test('missing customer rows and blank customer names never spend a provider attempt',async()=>{
  for(const kind of ['missing-id','missing-row','blank-name']) {
    const store=memory(kind==='missing-id'?{...initial,customer_id:null}:initial);
    store.query=async()=>kind==='blank-name'?[{id:initial.customer_id,workspace_id:workspaceId,name:'   '}]:[];
    let now=Date.now();
    const accounting={syncInvoice:()=>assert.fail('missing customer must never reach Zoho')};
    for(let n=1;n<=5;n++) {
      const result=await retryAssistantInvoiceSync({store,invoiceId,accounting,manualRetry:false,clock:()=>new Date(now)});
      assert.equal(result.sync.status,'failed');assert.equal(result.invoice.metadata.bookkeeping_sync_error,'INVOICE_CUSTOMER_REQUIRED');
      assert.equal(result.invoice.metadata.bookkeeping_sync_attempts,0);now+=syncRetryDelay(1)+1;
    }
    assert.equal(store.row.metadata.bookkeeping_sync_exhausted,false);
    store.edit({customer_id:initial.customer_id});
    store.query=async()=>[{id:initial.customer_id,workspace_id:workspaceId,name:'Client'}];
    const recovered=await retryAssistantInvoiceSync({store,invoiceId,accounting:ok,manualRetry:false,clock:()=>new Date(now)});
    assert.equal(recovered.sync.status,'synced');assert.equal(recovered.invoice.metadata.bookkeeping_sync_attempts,1);
  }
});

test('foreign invoice or customer rows fail closed before a provider request or sync write',async()=>{
  const foreign='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for(const entity of ['invoice','customer']) {
    const store=memory(entity==='invoice'?{...initial,workspace_id:foreign}:initial);
    if(entity==='customer')store.query=async()=>[{id:initial.customer_id,workspace_id:foreign,name:'Other workspace'}];
    await assert.rejects(retryAssistantInvoiceSync({store,invoiceId,accounting:{syncInvoice:()=>assert.fail('foreign export')}}),error=>error.code==='WORKSPACE_SCOPE_VIOLATION');
    assert.equal(store.row.metadata.bookkeeping_sync_attempts,undefined);
  }
});

test('deletion before or just after claim prevents provider work and late completion cannot resurrect a deleted row',async()=>{
  for(const timing of ['before-claim','after-claim','after-provider']) {
    const store=memory();let calls=0;
    if(timing==='before-claim') {
      const claim=store.claimInvoiceSync;
      store.claimInvoiceSync=async(...args)=>{store.edit({deleted_at:'2026-10-22T00:00:00Z'});return claim(...args)};
    } else if(timing==='after-claim') {
      const claim=store.claimInvoiceSync;
      store.claimInvoiceSync=async(...args)=>{const saved=await claim(...args);store.edit({deleted_at:'2026-10-22T00:00:00Z'});return saved};
    }
    const accounting={async syncInvoice(){calls++;store.edit({deleted_at:'2026-10-22T00:00:00Z'});return ok.syncInvoice()}};
    const run=retryAssistantInvoiceSync({store,invoiceId,accounting});
    if(timing==='after-provider')await assert.rejects(run,/lease changed/);else if(timing==='after-claim')await assert.rejects(run,error=>error.code==='INVOICE_NOT_FOUND');else await run;
    assert.equal(calls,timing==='after-provider'?1:0);assert.ok(store.row.deleted_at);assert.notEqual(store.row.metadata.bookkeeping_sync_status,'synced');
  }
});

test('payables, cancelled, deleted and already-linked invoices skip the customer lookup as well as provider work',async()=>{
  for(const patch of [{metadata:{invoice_direction:'payable'}},{status:'cancelled'},{deleted_at:'2026-10-22T00:00:00Z'},{external_invoice_id:'existing'}]) {
    const store=memory({...initial,...patch});store.query=()=>assert.fail('excluded customer query');
    await retryAssistantInvoiceSync({store,invoiceId,accounting:{syncInvoice:()=>assert.fail('excluded export')}});
  }
  assert.equal(canRetryInvoiceSync({metadata:{invoice_direction:'payable',bookkeeping_sync_status:'pending'}},true),false);
});

test('shared-org invoice-number deduplication refuses a cetld reference belonging to a different local invoice',async()=>{
  const {createZohoBooksProvider}=await import('../automation/accounting/index.mjs');
  for(const reference of [`cetld:${invoiceId}`,'cetld:other-workspace-invoice']) {
    let requests=0;
    const adapter=createZohoBooksProvider({fetchImpl:async()=>{requests++;return Response.json({invoices:[{invoice_id:'remote',invoice_number:invoice.invoiceNumber,customer_name:invoice.clientName,currency_code:'INR',date:invoice.invoiceDate,due_date:invoice.dueDate,total:118,balance:118,reference_number:reference}]})}});
    const run=adapter.createInvoice({token:{accessToken:'test',apiDomain:'https://www.zohoapis.com'},accountId:'org',invoice:{...invoice,localInvoiceId:invoiceId}});
    if(reference===`cetld:${invoiceId}`)assert.equal((await run).duplicate,true);
    else await assert.rejects(run,error=>error.code==='ACCOUNTING_INVOICE_CONFLICT');
    assert.equal(requests,reference===`cetld:${invoiceId}`?1:2);
  }
});

test('token expiry between reconciled invoices refreshes once and preserves workspace/account identity',async()=>{
  const {InMemoryAccountingStore,TokenCipher,connectionAad,createAccountingIntegration}=await import('../automation/accounting/index.mjs');
  let now=Date.now(),refreshes=0;const tokens=[],records=[];
  const connections=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,7));
  const token={accessToken:'first',refreshToken:'refresh',expiresAt:now+3600_000,apiDomain:'https://www.zohoapis.com'};
  await connections.insertConnection({userId:ownerId,workspaceId,provider:'zoho_books',providerAccountId:'org',apiDomain:token.apiDomain,status:'connected',tokenExpiresAt:token.expiresAt,...cipher.encrypt(token,connectionAad('zoho_books',workspaceId))});
  connections.getWorkspaceInvoiceConnection=async id=>{assert.equal(id,workspaceId);return{owner_id:ownerId}};
  const accounting=createAccountingIntegration({store:connections,cipher,now:()=>now,providers:{quickbooks:{},zoho_books:{
    async refreshToken(){refreshes++;return{accessToken:'rotated',expiresAt:now+3600_000}},
    async createInvoice({token,accountId,invoice}){tokens.push(token.accessToken);assert.equal(accountId,'org');now+=3600_000;return{externalId:invoice.localInvoiceId}}
  }}});
  const secondId='55555555-5555-4555-8555-555555555555';
  const scoped=[memory(),memory({...initial,id:secondId})];let index=0;
  const result=await reconcileInvoiceSync({store:{connections:async()=>[{owner_id:ownerId,workspace_id:workspaceId}],candidates:async()=>[invoiceId,secondId].map(id=>({id,workspace_id:workspaceId})),scoped:()=>scoped[index++]},accounting});
  records.push(...result.results);assert.deepEqual(tokens,['first','rotated']);assert.equal(refreshes,1);assert.ok(records.every(r=>r.status==='synced'));
});

test('a rejected token refresh stops that workspace without blocking a healthy workspace',async()=>{
  const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherInvoice='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const first=memory(),healthy=memory({...initial,id:otherInvoice,workspace_id:other});
  healthy.workspaceId=other;healthy.query=async()=>[{id:initial.customer_id,workspace_id:other,name:'Client'}];
  let attempts=0;
  const store={connections:async()=>[{owner_id:ownerId,workspace_id:workspaceId},{owner_id:ownerId,workspace_id:other}],candidates:async()=>[{id:invoiceId,workspace_id:workspaceId},{id:invoiceId,workspace_id:workspaceId},{id:otherInvoice,workspace_id:other}],scoped:connection=>connection.workspace_id===workspaceId?first:healthy};
  const result=await reconcileInvoiceSync({store,accounting:{syncInvoice:async input=>{attempts++;if(input.workspaceId===workspaceId)throw Object.assign(Error('revoked token'),{code:'ACCOUNTING_PROVIDER_ERROR',status:401});return ok.syncInvoice()}}});
  assert.equal(attempts,2);assert.deepEqual(result.results.map(r=>r.status),['failed','synced']);
});

test('concurrent assistant creates with the same save key export the single saved invoice once',async()=>{
  const store=memory();let inserted=false,creates=0,exports=0;
  store.findAssistantInvoice=async()=>inserted?store.row:null;
  store.findCustomer=async()=>({id:initial.customer_id});
  store.createAssistantInvoice=async()=>{if(inserted)return null;inserted=true;creates++;return store.row};
  const accounting={async syncInvoice(){exports++;return ok.syncInvoice()}};
  await Promise.all([1,2].map(()=>saveAssistantInvoice({store,invoice:{...invoice,subtotal:118,tax:0},confirmed:true,idempotencyKey:'concurrent_save_1',accounting})));
  assert.equal(creates,1);assert.equal(exports,1);assert.equal(store.row.metadata.bookkeeping_sync_attempts,1);
});

test('an idempotent assistant replay exports saved facts rather than changed replay input',async()=>{
  const store=memory();store.findAssistantInvoice=async()=>store.row;
  let exported;
  await saveAssistantInvoice({store,invoice:{...invoice,total:119,subtotal:119,tax:0},confirmed:true,idempotencyKey:'replay_saved_facts',accounting:{async syncInvoice(input){exported=input.invoice;return ok.syncInvoice()}}});
  assert.equal(exported.total,118);assert.equal(exported.invoiceNumber,initial.invoice_number);
});

test('a successful Zoho write followed by local persistence failure recovers by deduplication after its lease',async()=>{
  const {createZohoBooksProvider}=await import('../automation/accounting/index.mjs');
  const store=memory();let remote=null,creates=0,now=Date.now();
  const adapter=createZohoBooksProvider({fetchImpl:async(url,options={})=>{
    if(options.method==='POST') {
      creates++;const body=JSON.parse(options.body);
      remote={invoice_id:'remote-created',invoice_number:body.invoice_number,reference_number:body.reference_number,customer_name:'Client',date:body.date,due_date:body.due_date,currency_code:'INR',total:118,balance:118};
      return Response.json({invoice:{invoice_id:remote.invoice_id}});
    }
    if(String(url).includes('/contacts'))return Response.json({contacts:[{contact_id:'contact',contact_name:'Client'}]});
    return Response.json({invoices:remote?[remote]:[]});
  }});
  const accounting={async syncInvoice({invoice,invoiceId}) {
    const result=await adapter.createInvoice({token:{accessToken:'test',apiDomain:'https://www.zohoapis.com'},accountId:'org',invoice:{...invoice,localInvoiceId:invoiceId}});
    return {provider:'zoho_books',...result};
  }};
  const finish=store.finishInvoiceSync;store.finishInvoiceSync=async()=>{throw Error('database interrupted')};
  await assert.rejects(retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now)}),/database interrupted/);
  assert.equal(creates,1);assert.equal(store.row.metadata.bookkeeping_sync_status,'pending');
  store.finishInvoiceSync=finish;now+=SYNC_LEASE_MS+1;
  const recovered=await retryAssistantInvoiceSync({store,invoiceId,accounting,clock:()=>new Date(now),manualRetry:false});
  assert.equal(creates,1);assert.equal(recovered.sync.status,'synced');assert.equal(recovered.sync.externalId,'remote-created');assert.equal(store.row.metadata.bookkeeping_sync_attempts,2);
});

test('the Zoho adapter itself refuses payable bills and empty customers before any network call',async()=>{
  const {createZohoBooksProvider}=await import('../automation/accounting/index.mjs');
  const adapter=createZohoBooksProvider({fetchImpl:()=>assert.fail('invalid sales export')});
  for(const patch of [{direction:'payable'},{clientName:''}])await assert.rejects(adapter.createInvoice({token:{accessToken:'test'},accountId:'org',invoice:{...invoice,...patch}}),error=>['ACCOUNTING_INVOICE_DIRECTION_UNSUPPORTED','INVOICE_CUSTOMER_REQUIRED'].includes(error.code));
});

test('preflight accepts numeric wire formatting but rejects invoice facts changed after reservation',async()=>{
  for(const changed of [false,true]) {
    const store=memory();let calls=0;
    if(changed) {
      const claim=store.claimInvoiceSync;
      store.claimInvoiceSync=async(...args)=>{const saved=await claim(...args);store.edit({total_amount:119});return saved};
    } else store.getAssistantInvoice=async()=>({...store.row,total_amount:'118.00'});
    const result=await retryAssistantInvoiceSync({store,invoiceId,accounting:{async syncInvoice(){calls++;return ok.syncInvoice()}}});
    assert.equal(calls,changed?0:1);assert.equal(result.sync.status,changed?'failed':'synced');
    if(changed){assert.equal(result.invoice.total,119);assert.equal(result.invoice.metadata.bookkeeping_sync_error,'INVOICE_CHANGED_DURING_SYNC');assert.equal(result.invoice.metadata.bookkeeping_sync_attempts,0);}
  }
});

test('connection preparation holds a lease without an attempt and rechecks edits before dispatch',async()=>{
  for(const changed of [false,true]) {
    const store=memory();let prepare,release,calls=0;
    const entered=new Promise(resolve=>prepare=resolve),gate=new Promise(resolve=>release=resolve);
    const accounting={...ok,async prepareInvoiceSync(){prepare();await gate;return async()=>{calls++;return ok.syncInvoice()}}};
    const pending=retryAssistantInvoiceSync({store,invoiceId,accounting});await entered;
    assert.equal(store.row.metadata.bookkeeping_sync_attempts,0);
    assert.equal((await retryAssistantInvoiceSync({store,invoiceId,accounting})).sync.status,'pending');
    if(changed)store.edit({total_amount:119,metadata:{...store.row.metadata,owner_note:'keep'}});
    release();const result=await pending;
    assert.equal(calls,changed?0:1);assert.equal(result.invoice.metadata.bookkeeping_sync_attempts,changed?0:1);
    if(changed){assert.equal(result.invoice.metadata.owner_note,'keep');assert.equal(result.invoice.metadata.bookkeeping_sync_error,'INVOICE_CHANGED_DURING_SYNC');}
  }
});
