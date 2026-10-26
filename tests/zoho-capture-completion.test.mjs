import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {SupabaseAccountingStore,TokenCipher,connectionAad,createAccountingIntegration} from '../automation/accounting/index.mjs';
import {createInvoiceReconcileStore} from '../automation/invoice-sync-reconciler.mjs';
import {retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';

const file='20261026141000_zoho_capture_completion_protocol.sql';
const migration=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
async function fixture(){
 const f=await createOfflineSqlNetwork({excludeMigrations:[file]}),owner=randomUUID(),foreign=randomUUID();
 await f.db.query('insert into auth.users(id) values($1),($2)',[owner,foreign]);
 await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
 const ws=(await f.db.query('select (create_workspace($1,$2)).id',['Offline completion',randomUUID()])).rows[0].id;
 await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Offline client') returning id",[ws])).rows[0].id;
 const create=async(meta={})=>(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
 values($1,$2,$3,'2026-10-01','2026-10-20','USD',5,'sent',$4) returning *`,[ws,customer,'OFFLINE-'+randomUUID(),{invoice_direction:'receivable',...meta}])).rows[0];
 const legacy=await create();
 const cipher=new TokenCipher(Buffer.alloc(32,7)),token={accessToken:'offline-access',refreshToken:'offline-refresh',expiresAt:Date.now()+3600000,
  region:'in',apiDomain:'https://www.zohoapis.in',accountsDomain:'https://accounts.zoho.in'};
 const identity={userId:owner,workspaceId:ws,provider:'zoho_books'};
 let loseAck=false;
 const fetchImpl=async(input,options={})=>{
  assert.equal(new URL(String(input)).origin,'https://fixture.supabase.test','no actual network/provider transport');
  const response=await f.fetchImpl(input,options);
  if(loseAck&&new URL(String(input)).pathname.endsWith('/cetld_zoho_capture_completion_protocol')&&JSON.parse(options.body).p_action==='complete'){
   loseAck=false;throw Error('Offline lost acknowledgement after commit');
  }return response;
 };
 const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'offline-fixture',fetchImpl});
 await store.insertConnection({...identity,providerAccountId:'offline-A',status:'connected',region:token.region,apiDomain:token.apiDomain,
  accountsDomain:token.accountsDomain,tokenExpiresAt:token.expiresAt,...cipher.encrypt(token,connectionAad('zoho_books',ws))});
 const context=()=>store.zohoOperationContext(identity);
 const call=(row,action,extra={})=>store.captureCompletionProtocol(identity,row.id,action,extra);
 const reserve=async(row,extra={})=>call(row,'reserve',{p_expected_updated_at:row.updated_at,p_expected_version:row.automation_version,p_expected_epoch:(await context()).epochId,...extra});
 const state=async row=>(await f.db.query('select * from app.zoho_capture_completion where invoice_id=$1',[row.id])).rows[0];
 const read=async row=>(await f.db.query('select * from invoices where id=$1',[row.id])).rows[0];
 return {...f,owner,foreign,ws,customer,create,legacy,cipher,token,identity,store,context,call,reserve,state,read,fetchImpl,loseAck:()=>{loseAck=true;}};
}

test('new cutover has no backfill, cannot upgrade PR201 rows, and permanently excludes old-worker/metadata/direct-link attempts',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query("select oid,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('public'::regnamespace,'app'::regnamespace) order by oid")).rows;
  const oldRow=await f.read(f.legacy);
  await f.db.exec(await migration());
  assert.deepEqual(await f.read(f.legacy),oldRow);
  assert.equal((await f.db.query('select count(*) n from app.zoho_capture_completion')).rows[0].n,0);
  const after=(await f.db.query("select oid,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('public'::regnamespace,'app'::regnamespace) order by oid")).rows;
  for(const p of before)assert.deepEqual(after.find(q=>q.oid===p.oid),p,'no existing function/OID/security/ACL/source changes');
  assert.equal((await f.reserve(f.legacy)).state,'not_admitted');
  await f.db.query("update invoices set metadata=metadata||'{\"verified\":true,\"provider_account_binding\":{\"immutable\":true}}' where id=$1",[f.legacy.id]);
  assert.equal((await f.reserve(await f.read(f.legacy))).state,'not_admitted');
  for(const mode of ['metadata','link','old_journal']){
   const row=await f.create();assert.equal((await f.state(row)).state,'eligible');
   if(mode==='metadata'){
    await f.db.query("update invoices set metadata=metadata||'{\"bookkeeping_sync_attempts\":0,\"bookkeeping_sync_attempted_at\":\"unknown\"}' where id=$1",[row.id]);
    await f.db.query("update invoices set metadata=metadata-'bookkeeping_sync_attempts'-'bookkeeping_sync_attempted_at' where id=$1",[row.id]);
   }
   if(mode==='link'){
    await f.db.query("update invoices set external_provider='zoho_books',external_invoice_id='offline-id' where id=$1",[row.id]);
    await f.db.query('update invoices set external_provider=null,external_invoice_id=null where id=$1',[row.id]);
   }
   if(mode==='old_journal')await f.store.reserveZohoExportOperation(f.identity,row.id,(await f.context()).epochId,row);
   assert.equal((await f.state(row)).state,'excluded');assert.equal((await f.reserve(await f.read(row))).state,'unavailable');
  }
  for(const name of ['anon','authenticated','service_role']){
   await f.db.exec(`set role ${name}`);
   for(const table of ['zoho_capture_completion','zoho_capture_write_context'])for(const query of [`select * from app.${table}`,`delete from app.${table}`,`insert into app.${table} default values`])await assert.rejects(f.db.exec(query),/permission denied/);
   if(name!=='service_role')await assert.rejects(f.db.query("select cetld_zoho_capture_completion_protocol($1,$2,$3,'reserve')",[f.owner,f.ws,f.legacy.id]),/permission denied/);
   await f.db.exec('reset role');
  }
 }finally{await f.close();}
});

test('one-shot protocol checks scope/version/epoch/customer/lease, atomically links only unverified results, and recovers without writes',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());const row=await f.create();
  await assert.rejects(f.store.captureCompletionProtocol({...f.identity,userId:f.foreign},row.id,'reserve'),/Accounting storage request failed/);
  await assert.rejects(f.reserve(row,{p_expected_version:999}),/Accounting storage request failed/);
  const op=await f.reserve(row),extra={p_operation_id:op.operationId};
  assert.equal(op.originCaptured,false);assert.equal((await f.state(row)).state,'reserved');
  assert.equal((await f.read(row)).metadata.bookkeeping_sync_attempts,0,'token preparation has not spent a provider attempt');
  const lease=randomUUID(),connection=await f.store.getConnection(f.identity),epoch=(await f.context()).epochId;
  await f.store.claimRefresh(f.identity,lease,30000);
  await f.store.updateConnection(f.identity,f.cipher.encrypt(f.token,connectionAad('zoho_books',f.ws)),
   {tokenExpiresAt:f.token.expiresAt,apiDomain:f.token.apiDomain,providerAccountId:'offline-A',region:'in'},connection.revision,lease);
  assert.equal((await f.context()).epochId,epoch,'normal refresh retains the intended operation');
  await assert.rejects(f.call(row,'start',{p_operation_id:randomUUID()}),/Accounting storage request failed/);
  assert.equal((await f.call(row,'start',extra)).state,'started');
  assert.equal((await f.read(row)).metadata.bookkeeping_sync_attempts,1);
  await assert.rejects(f.call(row,'start',extra),/Accounting storage request failed/);
  await assert.rejects(f.call(row,'complete',{...extra,p_external_id:'offline-ID',p_outcome:'verified'}),/Accounting storage request failed/);
  // Failure after the invoice UPDATE must roll back both linkage and result.
  await f.db.exec("create function app.fixture_completion_failure() returns trigger language plpgsql as $$begin if new.external_invoice_id is not null then raise exception 'offline rollback sentinel';end if;return new;end;$$;create trigger zz_fixture_completion_failure after update on invoices for each row execute function app.fixture_completion_failure()");
  await assert.rejects(f.call(row,'complete',{...extra,p_external_id:'offline-ID',p_outcome:'created_unverified'}),/Accounting storage request failed/);
  assert.equal((await f.read(row)).external_invoice_id,null);assert.equal((await f.state(row)).state,'started');
  assert.equal((await f.db.query('select count(*) n from app.zoho_capture_write_context')).rows[0].n,0);
  await f.db.exec('drop trigger zz_fixture_completion_failure on invoices;drop function app.fixture_completion_failure()');
  const result=await f.call(row,'complete',{...extra,p_external_id:'offline-ID',p_outcome:'created_unverified'});
  assert.equal(result.state,'completed_unverified');assert.equal(result.originCaptured,false);
  const durable=await f.state(row),saved=await f.read(row);
  assert.equal((await f.call(row,'complete',{...extra,p_external_id:'offline-ID',p_outcome:'created_unverified'})).originCaptured,false);
  assert.deepEqual(await f.state(row),durable);assert.deepEqual(await f.read(row),saved);
  assert.equal((await f.store.recoverCaptureCompletion(f.identity,row.id,op.operationId)).invoice.external_invoice_id,'offline-ID');
  assert.equal(await f.store.recoverCaptureCompletion({...f.identity,userId:f.foreign},row.id,op.operationId),null);
  assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[row.id,f.owner])).rows[0].ok,false);
  for(const mode of ['lease','customer','away_back','reconnect','expiry','payable']){
   const i=await f.create(),o=await f.reserve(i),arg={p_operation_id:o.operationId};
   if(mode==='lease')await f.db.query("update invoices set metadata=metadata||'{\"bookkeeping_sync_attempts\":999}' where id=$1",[i.id]);
   if(mode==='customer')await f.db.query("update customers set name='Edited offline client' where id=$1",[f.customer]);
   if(mode==='away_back'){await f.store.setOrganization(f.identity,{id:'offline-B'});await f.store.setOrganization(f.identity,{id:'offline-A'});}
   if(mode==='reconnect'){const connection=await f.store.getConnection(f.identity);await f.store.deleteConnection(f.identity);await f.store.insertConnection(connection);}
   if(mode==='expiry')await f.db.query("update app.zoho_capture_completion set deadline=now()-interval '1 minute' where invoice_id=$1",[i.id]);
   if(mode==='payable')await f.db.query("update invoices set metadata=metadata||'{\"invoice_direction\":\"payable\"}' where id=$1",[i.id]);
   assert.equal((await f.call(i,'start',arg)).state,'excluded',mode);
   assert.equal((await f.read(i)).external_invoice_id,null);
  }
 }finally{await f.close();}
});

test('exact PR201 refresh successor and contained approved CRLF sources are accepted unchanged; source/ACL/default-grant drift aborts atomically',async()=>{
 const prior='20261026110000_zoho_prospective_operation_foundation.sql',contain='20261026090000_contain_unproven_external_reminders.sql';
 const f=await createOfflineSqlNetwork({excludeMigrations:[file,prior,contain]});
 const install=async name=>f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 try{
  await f.db.exec('set search_path=pg_catalog,public');
  for(const name of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql'])await install(name);
  for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)']){
   const p=(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
   await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replaceAll('\n','\r\n')));
  }
  await install(contain);await install(prior);
  const all=async()=>(await f.db.query("select oid,proname,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security,encode(sha256(convert_to(pg_get_functiondef(oid),'UTF8')),'hex') hash from pg_proc p where pronamespace in ('public'::regnamespace,'app'::regnamespace) order by oid")).rows;
  const before=await all(),refresh=before.find(p=>p.proname==='cetld_update_accounting_connection_tokens');
  assert.equal(refresh.hash,'fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110');
  const gate=before.find(p=>p.proname==='cetld_core_authorize_delivery');
  assert.equal(gate.hash,'a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df');
  for(const drift of ['refresh','CRLF','ACL','default_function','default_table']){
   if(drift==='refresh')await f.db.exec(refresh.d.replace('select * from','select /* unknown */ * from'));
   if(drift==='CRLF')await f.db.exec(gate.d.replace('\r\n','\n'));
   if(drift==='ACL')await f.db.exec('grant execute on function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to authenticated');
   if(drift.startsWith('default_')){
    await f.db.exec('create role unexpected_capture_grantee');
    await f.db.exec(`alter default privileges in schema app grant ${drift==='default_function'?'execute on functions':'select on tables'} to unexpected_capture_grantee`);
   }
   await assert.rejects(f.db.exec(await migration()),/capture protocol .*drift/);await f.db.exec('rollback');
   assert.equal((await f.db.query("select to_regclass('app.zoho_capture_completion') t")).rows[0].t,null);
   await f.db.exec(refresh.d);await f.db.exec(gate.d);await f.db.exec('revoke execute on function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) from authenticated');
   if(drift.startsWith('default_')){
    await f.db.exec(`alter default privileges in schema app revoke ${drift==='default_function'?'execute on functions':'select on tables'} from unexpected_capture_grantee`);
    await f.db.exec('drop role unexpected_capture_grantee');
   }
  }
  await f.db.exec(await migration());const after=await all();
  for(const p of before)assert.deepEqual(after.find(q=>q.oid===p.oid),p,'every installed predecessor, including CRLF/security, stays unchanged');
 }finally{await f.close();}
});

test('actual sync integration starts before fake provider writes, bypasses caller finisher, and recovers POST-success/completion-ack loss once',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());let mode='new',calls=0;
  const integration=createAccountingIntegration({store:f.store,cipher:f.cipher,providers:{quickbooks:{},zoho_books:{createInvoice:async()=>{
   calls++;const active=(await f.db.query("select state from app.zoho_capture_completion where state='started'")).rows;
   assert.equal(active.length,1,'server operation started before ANY fake provider work');
   if(mode==='unknown')throw Error('Offline unknown provider response');
   if(mode==='switch')await f.store.setOrganization(f.identity,{id:'offline-B'});
   return {externalId:'offline-result-'+calls,duplicate:mode==='duplicate'};
  }}}});
  const invoiceStore=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-fixture'},fetchImpl:f.fetchImpl}).scoped({workspace_id:f.ws,owner_id:f.owner});
  const accounting={...integration,finishInvoiceSync:()=>assert.fail('caller/metadata finisher must not run')};
  for(mode of ['new','duplicate','unknown','lost_ack','switch']){
   const row=await f.create();if(mode==='lost_ack')f.loseAck();
   const result=await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:row.id,accounting});
   assert.equal(result.sync.status,['unknown','switch'].includes(mode)?'failed':'synced');
   const record=await f.state(row);assert.notEqual(record.state,'eligible');
   assert.ok(!Object.hasOwn(record,'verified'));assert.equal((await f.db.query('select count(*) n from app.zoho_export_operations where invoice_id=$1',[row.id])).rows[0].n,0);
   if(result.sync.status==='synced'){
    const count=calls;await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:row.id,accounting});assert.equal(calls,count,'saved replay does not redispatch');
    assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[row.id])).rows[0].ok,false);
   }else assert.equal((await f.read(row)).external_invoice_id,null);
  }
  assert.equal(calls,5);
  for(const table of ['cetld_accounting_sync_records','cetld_core_automation_delivery_claims','whatsapp_messages','owner_assistant_proposals'])assert.equal((await f.db.query(`select count(*) n from ${table}`)).rows[0].n,0);
 }finally{await f.close();}
});
