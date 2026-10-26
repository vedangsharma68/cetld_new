import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prospectiveZohoExport} from '../automation/accounting/prospective-export.mjs';
import {createAccountingIntegration,TokenCipher,SupabaseAccountingStore,connectionAad} from '../automation/accounting/index.mjs';
import {createInvoiceReconcileStore} from '../automation/invoice-sync-reconciler.mjs';
import {retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('journal boundary never turns reserve/replay/duplicate/error into verified origin or reminder evidence',async()=>{
 const context={epochId:'fixture-epoch',accountId:'fixture-account',region:'in',apiDomain:'https://fixture.test',accountsDomain:'https://accounts.fixture.test'};
 const authorization={connection:{providerAccountId:context.accountId,region:context.region,apiDomain:context.apiDomain,accountsDomain:context.accountsDomain},token:{accessToken:'fixture-only'}};
 const identity={userId:'fixture-owner',workspaceId:'fixture-workspace'};
 for(const scenario of ['new','duplicate','error','before_switch','during_switch','lease_change','unknown_rpc','retry','legacy','no_epoch']){
  const calls=[];
  const store={zohoOperationContext:async()=>scenario==='before_switch'?{...context,epochId:'changed'}:context,
   reserveZohoExportOperation:async()=>{calls.push('reserve');return {state:scenario==='unknown_rpc'?'verified':scenario==='retry'?'retry_unverified':scenario==='legacy'?'not_admitted':'reserved',operationId:'10000000-0000-0000-0000-000000000001',provenance:'unverified'};},
   transitionZohoExportOperation:async(_identity,_invoice,_op,action,outcome)=>{calls.push([action,outcome]);return {state:action==='start'?'dispatched':['during_switch','lease_change'].includes(scenario)?'invalidated':'finished',provenance:'unverified'};}};
  const dispatch=async value=>{assert.equal(value,authorization);calls.push('provider');if(scenario==='error')throw Error('synthetic provider failure');return {externalId:'fixture-id',duplicate:scenario==='duplicate'};};
  const run=()=>prospectiveZohoExport({store,identity,invoiceId:'fixture-invoice',expectedContext:scenario==='no_epoch'?null:context,authorization,dispatch,
   legacyDispatch:async()=>{calls.push('unverified_legacy');return {externalId:'fixture-recovery'};}});
  if(['before_switch','during_switch','lease_change','unknown_rpc','error'].includes(scenario))await assert.rejects(run);
  else{const result=await run();assert.equal(Object.hasOwn(result,'provenance'),false);assert.equal(Object.hasOwn(result,'binding'),false);}
  if(['before_switch','unknown_rpc','retry','legacy','no_epoch'].includes(scenario))assert.ok(!calls.includes('provider'));
  if(scenario==='new')assert.deepEqual(calls,['reserve',['start',null],'provider',['finish','created_unverified']]);
  if(scenario==='duplicate')assert.deepEqual(calls.at(-1),['finish','duplicate_unverified']);
  if(scenario==='error')assert.deepEqual(calls.at(-1),['finish','unknown_unverified']);
 }
 for(const response of [()=>new Response('not-json'),()=>new Response(null,{status:204}),... [false,0,[],{},'unavailable'].map(value=>()=>Response.json(value))]){
  const store=new SupabaseAccountingStore({url:'https://fixture.test',serviceRoleKey:'fixture-only',fetchImpl:async()=>response()});
  await assert.rejects(store.zohoOperationContext(identity),error=>error.code==='ACCOUNTING_STORE_ERROR','malformed context cannot fall through as a legitimate missing epoch');
 }
});

test('real SQL plus actual integration/store: a first new export journals, links normally, and remains PR200 blocked',async()=>{
 const f=await createOfflineSqlNetwork(),owner=randomUUID();
 try{
  await f.db.query('insert into auth.users(id) values($1)',[owner]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
  const workspaceId=(await f.db.query('select (create_workspace($1,$2)).id',['Offline export foundation',randomUUID()])).rows[0].id;
  await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Offline fixture') returning id",[workspaceId])).rows[0].id;
  const create=async()=>(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
   values($1,$2,$3,'2026-10-01','2026-10-20','USD',5,'sent','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customer,'OFFLINE-'+randomUUID()])).rows[0];
  const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'offline-fixture-only',fetchImpl:f.fetchImpl});
  const cipher=new TokenCipher(Buffer.alloc(32,9));
  const token={accessToken:'offline-access',refreshToken:'offline-refresh',expiresAt:Date.now()+3600000,region:'in',apiDomain:'https://www.zohoapis.in',accountsDomain:'https://accounts.zoho.in'};
  const identity={userId:owner,workspaceId,provider:'zoho_books'};
  await store.insertConnection({...identity,providerAccountId:'offline-org',region:token.region,apiDomain:token.apiDomain,accountsDomain:token.accountsDomain,
   status:'connected',tokenExpiresAt:token.expiresAt,...cipher.encrypt(token,connectionAad('zoho_books',workspaceId))});
  const invoiceStore=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-fixture-only'},fetchImpl:f.fetchImpl}).scoped({workspace_id:workspaceId,owner_id:owner});
  let mode='new',calls=0;
  const integration=createAccountingIntegration({store,cipher,providers:{quickbooks:{},zoho_books:{createInvoice:async input=>{
   calls++;assert.equal(input.accountId,'offline-org');
   if(mode==='switch')await store.setOrganization(identity,{id:'other-offline-org',name:'Other fixture'});
   if(mode==='error')throw Error('Offline uncertain response');
   return {externalId:'offline-external-'+calls,duplicate:mode==='duplicate'};
  }}}});
  const rows=[];
  for(mode of ['new','duplicate','error','switch']){
   const row=await create();rows.push(row);
   const result=await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:row.id,accounting:integration});
   assert.equal(result.sync.status,['error','switch'].includes(mode)?'failed':'synced');
   const op=(await f.db.query('select * from app.zoho_export_operations where invoice_id=$1',[row.id])).rows[0];
   assert.equal(op.attempted_account_id,'offline-org');
   assert.equal(op.state,mode==='switch'?'invalidated':'finished');
   assert.equal(op.outcome,mode==='switch'?null:mode==='error'?'unknown_unverified':mode==='duplicate'?'duplicate_unverified':'created_unverified');
   if(['new','duplicate'].includes(mode)){
    assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[row.id])).rows[0].ok,false);
    assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[row.id,owner])).rows[0].ok,false);
   }else assert.equal((await invoiceStore.getAssistantInvoice(row.id)).external_invoice_id,null);
  }
  assert.equal(calls,4,'only fake adapter callbacks ran; fixture transport never forwards to providers');
  assert.equal((await f.db.query('select count(*) n from cetld_accounting_sync_records')).rows[0].n,0);
  assert.equal((await f.db.query('select count(*) n from cetld_core_automation_delivery_claims')).rows[0].n,0);
  assert.equal((await f.db.query('select count(*) n from owner_assistant_proposals')).rows[0].n,0);
  assert.equal((await f.db.query('select count(*) n from whatsapp_messages')).rows[0].n,0);
  assert.ok(f.requests.every(r=>new URL(r.url).origin==='https://fixture.supabase.test'));
 }finally{await f.close();}
});
