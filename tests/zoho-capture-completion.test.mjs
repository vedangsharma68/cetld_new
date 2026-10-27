import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {SupabaseAccountingStore,TokenCipher,connectionAad,createAccountingIntegration,createZohoBooksProvider} from '../automation/accounting/index.mjs';
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
 await store.insertConnection({...identity,providerAccountId:'90001',status:'connected',region:token.region,apiDomain:token.apiDomain,
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
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,0);
  for(const name of ['anon','authenticated','service_role']){
   await f.db.exec(`set role ${name}`);
   for(const table of ['zoho_capture_completion','zoho_capture_write_context','zoho_customer_origins','zoho_invoice_origins'])for(const query of [`select * from app.${table}`,`delete from app.${table}`,`insert into app.${table} default values`])await assert.rejects(f.db.exec(query),/permission denied/);
   if(name!=='service_role')await assert.rejects(f.db.query("select cetld_zoho_capture_completion_protocol($1,$2,$3,'reserve')",[f.owner,f.ws,f.legacy.id]),/permission denied/);
   if(name!=='service_role')await assert.rejects(f.db.query('select cetld_recover_zoho_capture_completion($1,$2,$3,$4)',[f.owner,f.ws,f.legacy.id,randomUUID()]),/permission denied/);
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
   {tokenExpiresAt:f.token.expiresAt,apiDomain:f.token.apiDomain,providerAccountId:'90001',region:'in'},connection.revision,lease);
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
   if(mode==='away_back'){await f.store.setOrganization(f.identity,{id:'90002'});await f.store.setOrganization(f.identity,{id:'90001'});}
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
  const permit=before.find(p=>p.proname==='has_invoice_total_correction_context'),correction=before.find(p=>p.proname==='apply_owner_invoice_correction');
  assert.equal(permit.hash,'5b53eee3ad8c388ff0f29929e11b072efd1bb57fcc66f9373965640bad6155ad');
  assert.equal(correction.hash,'0f287de4b01b1a334d73e7d6e0e50ce292ad7419c1d6962167054d49d22d0449');
  for(const drift of ['refresh','CRLF','ACL','permit_source','correction_source','permit_ACL','permit_table_ACL','permit_column_ACL','default_function','default_table']){
   if(drift==='permit_source')await f.db.exec(permit.d.replace('select exists','select /* unknown */ exists'));
   if(drift==='correction_source')await f.db.exec(correction.d.replace('begin','begin /* unknown */'));
   if(drift==='permit_ACL')await f.db.exec('grant execute on function app.has_invoice_total_correction_context(uuid) to service_role');
   if(drift==='permit_table_ACL')await f.db.exec('grant insert on app.invoice_total_correction_context to service_role');
   if(drift==='permit_column_ACL')await f.db.exec('grant insert(invoice_id) on app.invoice_total_correction_context to service_role');
   if(drift==='refresh')await f.db.exec(refresh.d.replace('select * from','select /* unknown */ * from'));
   if(drift==='CRLF')await f.db.exec(gate.d.replace('\r\n','\n'));
   if(drift==='ACL')await f.db.exec('grant execute on function cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to authenticated');
   if(drift.startsWith('default_')){
    await f.db.exec('create role unexpected_capture_grantee');
    await f.db.exec(`alter default privileges in schema app grant ${drift==='default_function'?'execute on functions':'select on tables'} to unexpected_capture_grantee`);
   }
   await assert.rejects(f.db.exec(await migration()),/capture protocol .*drift/);await f.db.exec('rollback');
   assert.equal((await f.db.query("select to_regclass('app.zoho_capture_completion') t")).rows[0].t,null);
   await f.db.exec(permit.d);await f.db.exec(correction.d);
   await f.db.exec('revoke execute on function app.has_invoice_total_correction_context(uuid) from service_role;revoke insert on app.invoice_total_correction_context from service_role;revoke insert(invoice_id) on app.invoice_total_correction_context from service_role');
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
   if(mode==='switch')await f.store.setOrganization(f.identity,{id:'90002'});
   return {externalId:String(60000+calls),duplicate:mode==='duplicate',originCaptured:true,receipt:{verified:true,accountId:'90001'}};
  }}}});
  const invoiceStore=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-fixture'},fetchImpl:f.fetchImpl}).scoped({workspace_id:f.ws,owner_id:f.owner});
  const accounting={...integration,finishInvoiceSync:()=>assert.fail('caller/metadata finisher must not run')};
  for(mode of ['new','duplicate','unknown','lost_ack','token_mismatch','switch']){
   const row=await f.create({originCaptured:true,provider_account_binding:{verified:true,accountId:'90001'}});if(mode==='lost_ack')f.loseAck();
   if(mode==='token_mismatch'){
    const c=await f.store.getConnection(f.identity);
    await f.store.replaceConnection({...c,...f.cipher.encrypt({...f.token,region:'eu',apiDomain:'https://www.zohoapis.eu',accountsDomain:'https://accounts.zoho.eu'},connectionAad('zoho_books',f.ws))},c.revision);
   }
   const result=await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:row.id,accounting});
   assert.equal(result.sync.status,['unknown','switch','token_mismatch'].includes(mode)?'failed':'synced');
   const record=await f.state(row);assert.notEqual(record.state,'eligible');
   assert.ok(!Object.hasOwn(record,'verified'));assert.equal((await f.db.query('select count(*) n from app.zoho_export_operations where invoice_id=$1',[row.id])).rows[0].n,0);
   if(result.sync.status==='synced'){
    const count=calls;await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:row.id,accounting});assert.equal(calls,count,'saved replay does not redispatch');
    assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[row.id])).rows[0].ok,false);
   }else assert.equal((await f.read(row)).external_invoice_id,null);
   if(mode==='token_mismatch'){
    assert.equal((await f.read(row)).metadata.bookkeeping_sync_attempts,0,'token/endpoint mismatch fails before any invoice attempt');
    const c=await f.store.getConnection(f.identity);await f.store.replaceConnection({...c,...f.cipher.encrypt(f.token,connectionAad('zoho_books',f.ws))},c.revision);
   }
  }
  assert.equal(calls,5);
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,0,'caller JSON and fake adapter result fields cannot mint a branded receipt');
  for(const table of ['cetld_accounting_sync_records','cetld_core_automation_delivery_claims','whatsapp_messages','owner_assistant_proposals'])assert.equal((await f.db.query(`select count(*) n from ${table}`)).rows[0].n,0);
 }finally{await f.close();}
});

test('actual fresh POST receipt atomically captures immutable original identity; lost ack recovers binding without redispatch, and accountless writes cannot rebind',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());let currentRow,invoicePosts=0,contactPosts=0,mode='fresh';
  const adapter=createZohoBooksProvider({fetchImpl:async(input,options={})=>{
   const url=new URL(String(input));assert.equal(url.origin,'https://www.zohoapis.in');assert.equal(options.redirect,'error');
   assert.equal((await f.state(currentRow)).state,'started','all contact/invoice requests follow protected start');
   if(options.method==='POST'&&url.pathname.endsWith('/invoices')){
    invoicePosts++;const p=JSON.parse(options.body);assert.equal(p.customer_id,'30001');
    if(mode==='race_switch'){await f.store.setOrganization(f.identity,{id:'90002'});await f.store.setOrganization(f.identity,{id:'90001'});}
    if(mode==='race_reconnect'){const c=await f.store.getConnection(f.identity);await f.store.deleteConnection(f.identity);await f.store.insertConnection(c);}
    if(mode==='race_lease')await f.db.query("update invoices set metadata=metadata||'{\"bookkeeping_sync_attempts\":99}' where id=$1",[currentRow.id]);
    if(mode==='race_old_worker'){
     const saved=await f.store.getInvoiceExportState(f.ws,currentRow.id);
     const old=await f.store.reserveZohoExportOperation(f.identity,currentRow.id,(await f.context()).epochId,saved);
     assert.equal(old.operationId,null,'old runtime cannot dispatch without an operation ID');
     assert.equal((await f.db.query('select count(*) n from app.zoho_export_operations where invoice_id=$1',[currentRow.id])).rows[0].n,0);
    }
    if(mode==='race_financial')await f.db.query('update invoices set total_amount=6 where id=$1',[currentRow.id]);
    if(mode==='race_customer')await f.db.query("update customers set name='Changed offline client' where id=$1",[f.customer]);
    if(mode==='race_delete'){
     await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}'`);
     const act=async(action,proposal=null)=>(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",
      [action,f.ws,proposal?null:currentRow.id,proposal,`dashboard_capture_${randomUUID()}`,`capture-${randomUUID()}`])).rows[0].value;
     const p=await act('prepare');assert.equal((await act('confirm',p.proposalId)).action,'deleted');
     await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    }
    return Response.json({code:0,invoice:{invoice_id:mode==='collision'?'40001':String(40000+invoicePosts),invoice_number:p.invoice_number,
     customer_id:'30001',customer_name:'Offline client',currency_code:'USD',total:5,balance:5,payment_made:0,status:'sent',
     date:p.date,due_date:p.due_date,reference_number:p.reference_number}});
   }
   if(options.method==='POST'){contactPosts++;return Response.json({code:0,contact:{contact_id:'30001',contact_name:'Offline client'}});}
   if(url.pathname.endsWith('/contacts'))return Response.json({code:0,contacts:mode!=='fresh'?[{contact_id:'30001',contact_name:'Offline client'}]:[],page_context:{has_more_page:false}});
   return Response.json({code:0,invoices:[],page_context:{has_more_page:false}});
  }});
  const integration=createAccountingIntegration({store:f.store,cipher:f.cipher,providers:{quickbooks:{},zoho_books:adapter}});
  const invoiceStore=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-fixture'},fetchImpl:f.fetchImpl}).scoped({workspace_id:f.ws,owner_id:f.owner});
  currentRow=await f.create();f.loseAck();
  const result=await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:currentRow.id,accounting:integration});
  assert.equal(result.sync.status,'synced');assert.equal(invoicePosts,1);assert.equal(contactPosts,1);
  assert.equal((await f.state(currentRow)).state,'captured');
  const origin=(await f.db.query('select * from app.zoho_invoice_origins where invoice_id=$1',[currentRow.id])).rows[0];
  assert.equal(origin.owner_id,f.owner);assert.equal(origin.workspace_id,f.ws);assert.equal(origin.account_id,'90001');
  assert.equal(origin.region,'in');assert.equal(origin.customer_id,f.customer);assert.equal(origin.external_customer_id,'30001');assert.equal(origin.external_invoice_id,'40001');
  assert.equal(origin.provider_status,'sent');assert.equal(Number(origin.total),5);assert.equal(Number(origin.paid),0);assert.equal(Number(origin.balance),5);
  await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:currentRow.id,accounting:integration});assert.equal(invoicePosts,1);
  const o=await f.state(currentRow),recovered=await f.store.recoverCaptureCompletion(f.identity,currentRow.id,o.operation_id);
  assert.equal(o.capture_nonce,null,'the private first-operation nonce is consumed on completion');
  assert.equal(recovered.originCaptured,true);assert.equal(recovered.state,'captured');
  await f.store.setOrganization(f.identity,{id:'90002'});
  assert.equal((await f.store.recoverCaptureCompletion(f.identity,currentRow.id,o.operation_id)).originCaptured,true,'recovery reports the committed original binding, not current-account authority');
  await f.store.setOrganization(f.identity,{id:'90001'});
  assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins where invoice_id=$1',[currentRow.id])).rows[0],origin);
  for(const query of ["update app.zoho_invoice_origins set account_id='90002'",'delete from app.zoho_invoice_origins'])await assert.rejects(f.db.exec(query),/ZOHO_ORIGIN_IMMUTABLE/);
  await assert.rejects(f.db.query("insert into invoices(id,workspace_id,customer_id,invoice_number,total_amount,currency) values($1,$2,$3,'REUSED',5,'USD')",[origin.invoice_id,f.ws,f.customer]),/ZOHO_ORIGIN_LINK_IMMUTABLE/);
  const otherLocal=await f.create();
  await assert.rejects(f.db.query('update invoices set id=$1 where id=$2',[origin.invoice_id,otherLocal.id]),/ZOHO_ORIGIN_LINK_IMMUTABLE/);
  const otherContact=(await f.db.query("insert into customers(workspace_id,name) values($1,'Other local contact') returning id",[f.ws])).rows[0].id;
  await assert.rejects(f.db.query('update customers set id=$1 where id=$2',[f.customer,otherContact]),/ZOHO_ORIGIN_CUSTOMER_IMMUTABLE/);
  for(const patch of ["external_invoice_id='other'","customer_id=gen_random_uuid()","external_provider=null,external_invoice_id=null",
   "total_amount=6","last_synced_at=now()","metadata=metadata||'{\"invoice_direction\":\"payable\"}'","metadata=metadata||'{\"accounting_provider\":\"other\"}'"])
   await assert.rejects(f.db.query(`update invoices set ${patch} where id=$1`,[currentRow.id]),/ZOHO_ORIGIN_LINK_IMMUTABLE|ZOHO_BOUND_IMPORT_UNSUPPORTED/);
  await assert.rejects(f.db.query("update customers set external_provider='zoho_books',external_customer_id='wrong',last_synced_at=now() where id=$1",[f.customer]),/ZOHO_ORIGIN_CUSTOMER_IMMUTABLE/);
  await f.db.exec('set role service_role');
  await assert.rejects(f.db.exec('select * from app.zoho_invoice_origins'),/permission denied/);
  await assert.rejects(f.db.exec('insert into app.zoho_invoice_origins default values'),/permission denied/);await f.db.exec('reset role');
  // A genuine new invoice may reuse only the already protected same-account
  // customer ID. It is still a fresh POST, never an invoice dedup/retry.
  currentRow=await f.create();mode='reuse';
  assert.equal((await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:currentRow.id,accounting:integration})).sync.status,'synced');
  assert.equal((await f.state(currentRow)).state,'captured');assert.equal(contactPosts,1);assert.equal(invoicePosts,2);
  // Reusing an external invoice ID cannot overwrite either binding or link.
  const count=(await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n;
  currentRow=await f.create();mode='collision';
  await assert.rejects(retryAssistantInvoiceSync({store:invoiceStore,invoiceId:currentRow.id,accounting:integration}),/Export completion is unknown/);
  assert.equal((await f.read(currentRow)).external_invoice_id,null);
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,count);
  for(mode of ['race_switch','race_reconnect','race_lease','race_old_worker','race_financial','race_customer','race_delete']){
   currentRow=await f.create();const before=invoicePosts;
   const r=await retryAssistantInvoiceSync({store:invoiceStore,invoiceId:currentRow.id,accounting:integration});
   assert.equal(r.sync.status,'failed',mode);assert.equal(invoicePosts,before+1,'race never redispatches');
   assert.equal((await f.read(currentRow)).external_invoice_id,null);
   assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,count);
   if(mode==='race_customer')await f.db.query("update customers set name='Offline client' where id=$1",[f.customer]);
  }
  assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[origin.invoice_id,f.owner])).rows[0].ok,false);
  assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[origin.invoice_id])).rows[0].ok,false);
  for(const table of ['cetld_accounting_sync_records','cetld_core_automation_delivery_claims','owner_assistant_proposals','whatsapp_messages'])assert.equal((await f.db.query(`select count(*) n from ${table}`)).rows[0].n,0);
 }finally{await f.close();}
});

test('capture requires the private start nonce and exact SQL facts; binding insert/link failure rolls both back',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());const row=await f.create(),op=await f.reserve(row),arg={p_operation_id:op.operationId};
  const started=await f.call(row,'start',arg);
  const facts={...arg,p_outcome:'captured',p_external_id:'45001',p_capture_nonce:started.captureNonce,p_customer_external_id:'35001',
   p_currency:'USD',p_total:'5.00',p_paid:'0.00',p_balance:'5.00',p_status:'sent',p_date:row.issue_date,p_due_date:row.due_date,
   p_reference:`cetld:${row.id}`,p_remote_number:row.invoice_number};
  for(const patch of [{p_capture_nonce:null},{p_capture_nonce:randomUUID()},{p_total:'5.001'},{p_paid:1},{p_balance:4},{p_currency:'INR'},
   {p_status:'draft'},{p_customer_external_id:'bad'},{p_date:'2026-10-02'},{p_reference:'forged'},{p_remote_number:'different'},{p_outcome:'verified'}]){
   await assert.rejects(f.call(row,'complete',{...facts,...patch}),/Accounting storage request failed/);
   assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,0);assert.equal((await f.read(row)).external_invoice_id,null);
  }
  await f.db.exec("create function app.fixture_capture_rollback() returns trigger language plpgsql as $$begin if new.external_invoice_id is not null then raise exception 'offline capture rollback';end if;return new;end;$$;create trigger zz_capture_rollback after update on invoices for each row execute function app.fixture_capture_rollback()");
  await assert.rejects(f.call(row,'complete',facts),/Accounting storage request failed/);
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,0);assert.equal((await f.state(row)).state,'started');assert.equal((await f.read(row)).external_invoice_id,null);
  assert.equal((await f.db.query('select count(*) n from app.zoho_customer_origins')).rows[0].n,0,'mapping insertion rolls back with binding/link');
  await f.db.exec('drop trigger zz_capture_rollback on invoices;drop function app.fixture_capture_rollback()');
  assert.equal((await f.call(row,'complete',facts)).originCaptured,true);
  assert.equal((await f.call(row,'complete',facts)).originCaptured,true,'terminal replay only returns the committed original binding');
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,1);
  // Same external invoice ID under another current account cannot bind a
  // different local row/customer or overwrite the original account identity.
  await f.store.setOrganization(f.identity,{id:'90002'});
  const otherCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Other offline customer') returning id",[f.ws])).rows[0].id;
  const other=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'COLLISION','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[f.ws,otherCustomer])).rows[0];
  const second=await f.reserve(other),secondStart=await f.call(other,'start',{p_operation_id:second.operationId});
  await assert.rejects(f.call(other,'complete',{...facts,p_operation_id:second.operationId,p_capture_nonce:secondStart.captureNonce,
   p_customer_external_id:'35002',p_reference:`cetld:${other.id}`,p_remote_number:other.invoice_number}),/Accounting storage request failed/);
  assert.equal((await f.read(other)).external_invoice_id,null);
  assert.equal((await f.db.query('select account_id from app.zoho_invoice_origins where invoice_id=$1',[row.id])).rows[0].account_id,'90001');
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,1);
 }finally{await f.close();}
});

// This reproduces two genuine operations reserved/started before either knows
// a remote customer. A reserve-time NULL must never be an identity wildcard.
test('interleaved completion serializes immutable customer identity in both directions, without partial linkage',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());
  const prepare=async row=>{const op=await f.reserve(row),s=await f.call(row,'start',{p_operation_id:op.operationId});
   return {p_operation_id:op.operationId,p_capture_nonce:s.captureNonce,p_outcome:'captured',p_external_id:'99001',p_customer_external_id:'88001',
    p_currency:'USD',p_total:5,p_paid:0,p_balance:5,p_status:'sent',p_date:row.issue_date,p_due_date:row.due_date,p_reference:`cetld:${row.id}`,p_remote_number:row.invoice_number};};
  const a=await f.create(),b=await f.create();
  const fa=await prepare(a),fb={...await prepare(b),p_external_id:'99002'};
  assert.equal((await f.state(a)).expected_customer_id,null);assert.equal((await f.state(b)).expected_customer_id,null);
  assert.equal((await f.call(a,'complete',fa)).originCaptured,true);
  await assert.rejects(f.call(b,'complete',{...fb,p_customer_external_id:'88002'}),/Accounting storage request failed/);
  assert.equal((await f.read(b)).external_invoice_id,null);assert.equal((await f.state(b)).state,'started');
  assert.equal((await f.db.query('select count(*) n from app.zoho_customer_origins')).rows[0].n,1);
  assert.equal((await f.db.query('select count(*) n from app.zoho_invoice_origins')).rows[0].n,1);
  assert.equal((await f.call(b,'complete',fb)).originCaptured,true,'same remote identity can serve another invoice for the SAME local customer');
  const next=await f.create();assert.equal((await f.reserve(next)).customer.expectedExternalCustomerId,'88001');
  const otherCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Other identity') returning id",[f.ws])).rows[0].id;
  const other=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'OTHER-IDENTITY','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[f.ws,otherCustomer])).rows[0];
  const fo={...await prepare(other),p_external_id:'99003'};
  await assert.rejects(f.call(other,'complete',fo),/Accounting storage request failed/);
  assert.equal((await f.read(other)).external_invoice_id,null,'reverse mapping cannot merge local identities');
  assert.equal((await f.call(other,'complete',{...fo,p_customer_external_id:'88003'})).originCaptured,true);
  for(const role of ['anon','authenticated','service_role']){
   await f.db.exec(`set role ${role}`);
   for(const sql of ['select * from app.zoho_customer_origins','delete from app.zoho_customer_origins','insert into app.zoho_customer_origins default values'])await assert.rejects(f.db.exec(sql),/permission denied/);
   await f.db.exec('reset role');
  }
  await assert.rejects(f.db.query("update app.zoho_customer_origins set external_customer_id='forged'"),/ZOHO_CUSTOMER_ORIGIN_IMMUTABLE/);
  await f.store.setOrganization(f.identity,{id:'90002'});
  const changed=await f.create(),fc=await prepare(changed);
  await assert.rejects(f.call(changed,'complete',fc),/Accounting storage request failed/);
  assert.equal((await f.read(changed)).external_invoice_id,null);
  assert.equal((await f.db.query('select count(*) n from app.zoho_customer_origins')).rows[0].n,2);
 }finally{await f.close();}
});

test('genuinely captured invoices retain existing owner RPC boundaries and delete/undo without altering original identity',async()=>{
 const f=await fixture();try{
  await f.db.exec(await migration());const row=await f.create(),op=await f.reserve(row),s=await f.call(row,'start',{p_operation_id:op.operationId});
  await f.call(row,'complete',{p_operation_id:op.operationId,p_capture_nonce:s.captureNonce,p_outcome:'captured',p_external_id:'99101',p_customer_external_id:'88101',
   p_currency:'USD',p_total:5,p_paid:0,p_balance:5,p_status:'sent',p_date:row.issue_date,p_due_date:row.due_date,p_reference:`cetld:${row.id}`,p_remote_number:row.invoice_number});
  const origins=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  // Actual verified owner direct-write RPC: void/paid already belong to the
  // connected ledger. Exercise its authentication, not a privileged raw UPDATE.
  const phone='+15550001234';
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}';set role authenticated`);
  const verification=(await f.db.query('select * from owner_start_whatsapp_verification($1,$2)',[f.ws,phone])).rows[0];
  await f.db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[f.ws]);
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await f.db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  for(const status of ['paid','void']){
   const message=`captured-${status}-${randomUUID()}`,quote=`Set invoice status ${status}`;
   await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[message,phone,quote]);
   const result=(await f.db.query('select whatsapp_apply_direct_owner_write($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$10,null,null,null,$11::jsonb) value',
    [f.ws,f.owner,phone,message,`ownerwrite_${randomUUID()}`,'invoice.update',row.id,(await f.read(row)).updated_at,'instruction',quote,{status}])).rows[0].value;
   assert.equal(result.code,'EXTERNAL_ACCOUNTING',JSON.stringify(result));
  }
  await f.db.exec('reset role');
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}';set role authenticated`);
  for(const full of [false,true])await assert.rejects(f.db.query('select record_invoice_payment($1,$2,1,$3,$4,$5)',[f.ws,row.id,randomUUID(),'Offline actual owner payment',full]),/EXTERNAL_ACCOUNTING/);
  const correction=async patch=>(await f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,row.id,(await f.read(row)).updated_at,randomUUID(),patch])).rows[0].value;
  assert.equal((await correction({total_amount:6})).code,'EXTERNAL_ACCOUNTING');
  const beforeDate=await f.read(row),dateRequest=randomUUID(),datePatch={issue_date:'2026-09-30',due_date:'2026-11-01'};
  const dateCall=(expected=beforeDate.updated_at,request=dateRequest,patch=datePatch)=>(f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,row.id,expected,request,patch])).then(r=>r.rows[0].value);
  const dateResult=await dateCall();assert.equal(dateResult.ok,true,JSON.stringify(dateResult));
  assert.equal(dateResult.record.issue_date,'2026-09-30');assert.equal(dateResult.record.due_date,'2026-11-01');
  assert.ok(dateResult.record.automation_version>beforeDate.automation_version,'date edits retain invoice version invalidation');
  assert.equal((await dateCall()).replayed,true);
  assert.equal((await dateCall(beforeDate.updated_at,randomUUID())).code,'STALE');
  assert.equal((await dateCall(beforeDate.updated_at,dateRequest,{due_date:'2026-12-01'})).code,'REPLAY_MISMATCH');
  assert.equal((await f.db.query('select count(*) n from invoice_correction_audits where invoice_id=$1 and source_event_id=$2',[row.id,dateRequest])).rows[0].n,1);
  await f.db.exec('reset role');
  assert.equal((await f.db.query('select count(*) n from app.invoice_total_correction_context')).rows[0].n,0,'permit cleared after successful edit');
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  const message=`captured-date-${randomUUID()}`,quote='Correct the invoice dates',waPatch={issue_date:'2026-09-29',due_date:'2026-11-02'},waExpected=(await f.read(row)).updated_at;
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[message,phone,quote]);
  const waArgs=[f.ws,f.owner,phone,message,quote,`ownerwrite_${randomUUID()}`,row.id,waExpected,waPatch];
  const waCall=async(args=waArgs)=>(await f.db.query('select whatsapp_correct_owner_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9) value',args)).rows[0].value;
  assert.equal((await waCall([...waArgs.slice(0,1),f.foreign,...waArgs.slice(2)])).code,'DENIED');
  assert.equal((await waCall([randomUUID(),...waArgs.slice(1)])).code,'DENIED');
  const waDate=await waCall();assert.equal(waDate.ok,true,JSON.stringify(waDate));
  assert.equal(waDate.record.issue_date,'2026-09-29');assert.equal(waDate.record.due_date,'2026-11-02');
  assert.equal((await waCall()).replayed,true);
  assert.equal((await f.read(row)).external_invoice_id,'99101');
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal(await f.store.recoverCaptureCompletion(f.identity,row.id,op.operationId),null,'date edit invalidates immutable committed-row recovery; no origin rewrite');
  for(const role of ['anon','authenticated','service_role']){
   await f.db.exec(`set request.jwt.claim.role='${role}';set request.jwt.claim.sub='${role==='authenticated'?f.owner:''}';set role ${role}`);
   await assert.rejects(f.db.query('insert into app.invoice_total_correction_context values(pg_backend_pid(),txid_current(),$1)',[row.id]),/permission denied/);
   await assert.rejects(f.db.query('select app.has_invoice_total_correction_context($1)',[row.id]),/permission denied/);
   if(role!=='anon'){
    await f.db.exec("set app.owner_invoice_correction_id='forged';set app.invoice_total_correction_context='true'");
    for(const assignment of ["issue_date='2026-09-28'","due_date='2026-12-01'","amount_paid=1","status='void'"])
     await assert.rejects(f.db.query(`update invoices set ${assignment} where id=$1`,[row.id]),/ZOHO_BOUND_IMPORT_UNSUPPORTED|EXTERNAL_ACCOUNTING|permission denied/);
   }
   await f.db.exec('reset role');
  }
  // A real accountless import-shaped PATCH gets no private date authority.
  await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  await assert.rejects(f.db.query("update invoices set due_date='2026-12-01',last_synced_at=now(),sync_status='synced' where id=$1",[row.id]),/ZOHO_BOUND_IMPORT_UNSUPPORTED/);
  await f.db.exec('reset role');
  await f.db.query("insert into cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until) values($1,$2,now(),1,now(),'sending',now()-interval '1 hour')",[f.ws,row.id]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}';set role authenticated`);
  for(const status of ['sending','quarantined']){
   assert.equal((await dateCall((await f.read(row)).updated_at,randomUUID(),{due_date:'2026-12-01'})).code,'DELIVERY_IN_FLIGHT');
   await f.db.exec('reset role');await f.db.query("update cetld_core_automation_delivery_claims set status='quarantined' where invoice_id=$1",[row.id]);
   await f.db.exec('set role authenticated');
  }
  await f.db.exec('reset role');await f.db.query('delete from cetld_core_automation_delivery_claims where invoice_id=$1',[row.id]);
  await f.db.exec('set role authenticated');
  const benign=await correction({notes:'Owner local note'});assert.equal(benign.ok,true,JSON.stringify(benign));
  const action=async(type,proposal=null)=>(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",[type,f.ws,proposal?null:row.id,proposal,`dashboard_delete_${randomUUID()}`,`delete-${randomUUID()}`])).rows[0].value;
  const proposal=await action('prepare');assert.equal(proposal.ok,true,JSON.stringify(proposal));
  const deleted=await action('confirm',proposal.proposalId);assert.equal(deleted.action,'deleted',JSON.stringify(deleted));
  await f.db.exec('reset role');const deletedRow=await f.read(row);await f.db.exec('set role authenticated');
  assert.equal((await dateCall(deletedRow.updated_at,randomUUID(),{due_date:'2026-12-01'})).code,'TERMINAL');
  const restored=await action('undo');assert.equal(restored.action,'restored',JSON.stringify(restored));
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origins);
  assert.equal((await f.db.query('select count(*) n from payments where invoice_id=$1',[row.id])).rows[0].n,0);
  for(const sql of ["amount_paid=1","status='void'"])await assert.rejects(f.db.query(`update invoices set ${sql} where id=$1`,[row.id]),/ZOHO_BOUND_IMPORT_UNSUPPORTED/);
 }finally{await f.close();}
});
