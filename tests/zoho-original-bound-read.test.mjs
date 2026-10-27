import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {SupabaseAccountingStore,TokenCipher,connectionAad,createAccountingIntegration,createZohoBooksProvider,createAccountingProviders} from '../automation/accounting/index.mjs';
import {inspectOriginalBoundInvoice,originalReadJson} from '../automation/accounting/original-bound-read.mjs';
import {reminderPaymentRpc,externalReminderRead} from '../automation/external-reminder-verification.mjs';
const file='20261027050000_zoho_original_bound_read.sql';
const sql=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
async function fixture({crlf=false}={}){
 const f=await createOfflineSqlNetwork({excludeMigrations:[file,'20261026090000_contain_unproven_external_reminders.sql']}),owner=randomUUID(),other=randomUUID();
 const install=async name=>f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 for(const name of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql'])await install(name);
 if(crlf)for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)']){
  const p=(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
  await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replaceAll('\n','\r\n')));
 }
 for(const name of ['20261026090000_contain_unproven_external_reminders.sql','20261026110000_zoho_prospective_operation_foundation.sql','20261026141000_zoho_capture_completion_protocol.sql'])await install(name);
 await f.db.query('insert into auth.users(id) values($1),($2)',[owner,other]);
 await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
 const ws=(await f.db.query("select (create_workspace('Original read fixture',$1)).id",[randomUUID()])).rows[0].id;
 await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 const cust=(await f.db.query("insert into customers(workspace_id,name) values($1,'Offline client') returning id",[ws])).rows[0].id;
 const row=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'ORIGIN-1','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning *",[ws,cust])).rows[0];
 const store=new SupabaseAccountingStore({url:'https://fixture.supabase.test',serviceRoleKey:'offline-service',fetchImpl:f.fetchImpl}),cipher=new TokenCipher(Buffer.alloc(32,7));
 const identity={userId:owner,workspaceId:ws,provider:'zoho_books'},input={userId:owner,workspaceId:ws,invoiceId:row.id};
 const token={accessToken:'offline-secret-access',refreshToken:'offline-secret-refresh',expiresAt:Date.now()+3600000,region:'in',apiDomain:'https://www.zohoapis.in',accountsDomain:'https://accounts.zoho.in'};
 await store.insertConnection({...identity,providerAccountId:'90001',status:'connected',region:'in',apiDomain:token.apiDomain,accountsDomain:token.accountsDomain,tokenExpiresAt:token.expiresAt,...cipher.encrypt(token,connectionAad('zoho_books',ws))});
 const epoch=(await store.zohoOperationContext(identity)).epochId;
 const op=await store.captureCompletionProtocol(identity,row.id,'reserve',{p_expected_updated_at:row.updated_at,p_expected_version:row.automation_version,p_expected_epoch:epoch});
 const started=await store.captureCompletionProtocol(identity,row.id,'start',{p_operation_id:op.operationId});
 await store.captureCompletionProtocol(identity,row.id,'complete',{p_operation_id:op.operationId,p_capture_nonce:started.captureNonce,p_outcome:'captured',p_external_id:'99001',p_customer_external_id:'88001',p_currency:'USD',p_total:5,p_paid:0,p_balance:5,p_status:'sent',p_date:row.issue_date,p_due_date:row.due_date,p_reference:`cetld:${row.id}`,p_remote_number:row.invoice_number});
 const integration=createAccountingIntegration({store,cipher});let calls=0;
 const remote=()=>({invoice_id:'99001',customer_id:'88001',currency_code:'USD',total:5,payment_made:0,balance:5,status:'sent',date:'2026-10-01',due_date:'2026-10-20',reference_number:`cetld:${row.id}`,credits_applied:0,write_off_amount:0});
 const fetchImpl=async(url,options)=>{calls++;assert.equal(String(url),`https://www.zohoapis.in/books/v3/invoices/99001?organization_id=90001`);assert.equal(options.method||'GET','GET');assert.equal(options.redirect,'error');return Response.json({code:0,invoice:remote()});};
 const inspect=(overrides={},scope=input)=>inspectOriginalBoundInvoice({store,accessToken:integration.accessToken,fetchImpl,...overrides},scope);
 const context=()=>store.originalBoundReadContext(identity,row.id);
 const read=async()=>(await f.db.query('select * from invoices where id=$1',[row.id])).rows[0];
 return {...f,owner,other,ws,cust,row,store,cipher,identity,input,token,integration,remote,fetchImpl,inspect,context,read,calls:()=>calls};
}

test('protected origin exact read uses actual SQL and auth, redacts output and grants no reminder authority or side effects',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query("select oid,pg_get_functiondef(oid) source,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('public'::regnamespace,'app'::regnamespace) order by oid")).rows;
  const saved=await f.read(),origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  await f.db.exec(await sql());const after=(await f.db.query("select oid,pg_get_functiondef(oid) source,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('public'::regnamespace,'app'::regnamespace) order by oid")).rows;
  for(const p of before)assert.deepEqual(after.find(q=>q.oid===p.oid),p,'every existing gate/ACL/OID/source unchanged');
  const result=await f.inspect({fetchImpl:async(url,opts)=>{const r=await f.fetchImpl(url,opts);const b=await r.json();return Response.json({...b,secret:'must-not-leak',invoice:{...b.invoice,customer_name:'PRIVATE CLIENT',contact_persons:['PRIVATE EMAIL']}});}});
  assert.equal(result.existence,'verified');assert.equal(result.reminderAuthority,false);assert.equal(result.originalAccountId,'90001');assert.equal(f.calls(),1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret|fingerprint|epochId|access|refresh/);
  assert.deepEqual(await f.read(),saved);assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);
  await assert.rejects(externalReminderRead({invoice:saved}),/unsupported/);
  const gate=await reminderPaymentRpc({supabase:{rpc:()=>assert.fail('no reminder RPC')},invoice:saved,name:'cetld_core_authorize_first_party_reminder',args:{},accounting:f.integration});
  assert.equal(gate.data.authorized,false);
  const payment=(await f.db.query('select cetld_core_check_local_reminder_payment($1,$2,$3) value',[f.owner,f.ws,f.row.id])).rows[0].value;
  assert.equal(payment.ok,false);assert.equal((await f.db.query('select app.reminder_external_read_matches(i,$2) ok from invoices i where id=$1',[f.row.id,f.owner])).rows[0].ok,false);
  for(const table of ['payments','cetld_accounting_sync_records','cetld_core_automation_delivery_claims','owner_assistant_proposals','whatsapp_messages'])assert.equal((await f.db.query(`select count(*) n from ${table}`)).rows[0].n,0);
 }finally{await f.close();}
});

test('unbound/forged/wrong-scope/unsupported requests refuse before token or provider access',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());const noToken=()=>assert.fail('preflight must refuse before token');
  const legacy=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,status,external_provider,external_invoice_id,metadata) values($1,$2,'LEGACY','2026-10-01','USD',5,'sent','zoho_books','99002','{\"invoice_direction\":\"receivable\",\"originCaptured\":true,\"provenance\":\"verified\"}') returning id",[f.ws,f.cust])).rows[0].id;
  for(const input of [{...f.input,userId:f.other},{...f.input,workspaceId:randomUUID()},{...f.input,invoiceId:legacy},{...f.input,invoiceId:'bad'},
   {...f.input,externalId:'99001'},{...f.input,provider:'quickbooks'},{...f.input,accountId:'90001'},{...f.input,organizationId:'90001'}])await assert.rejects(f.inspect({accessToken:noToken},input),/unavailable/);
  await f.store.setOrganization(f.identity,{id:'90002'});await assert.rejects(f.inspect({accessToken:noToken}),/unavailable/);
  await f.store.setOrganization(f.identity,{id:'90001'});
  for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);await assert.rejects(f.context(),/unavailable/);await f.db.exec('reset role');}
  assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('strict remote identity, credits, amounts, dates, states and errors never become a reminder grant or local payment',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());const saved=await f.read();
  for(const patch of [{invoice_id:'99002'},{customer_id:'88002'},{organization_id:'90002'},{currency_code:'INR'},{total:6},{total:'5.001'},{payment_made:1},{balance:4},{credits_applied:1},{write_off_amount:1},{status:'paid'},{status:'draft'},{status:'void'},{status:'unknown'},{date:'2026-10-02'},{due_date:null},{reference_number:'forged'},{balance:null},{customer_id:[]},{credits_applied:undefined}]){
   await assert.rejects(f.inspect({fetchImpl:async()=>Response.json({code:0,invoice:{...f.remote(),...patch}})}),/unavailable/);assert.deepEqual(await f.read(),saved);
  }
  for(const status of [401,403,404,429,500])await assert.rejects(f.inspect({fetchImpl:async()=>Response.json({code:1000,message:'PRIVATE secret'},{status})}),e=>e.message==='Protected original-account read unavailable');
  assert.equal((await f.db.query('select count(*) n from payments')).rows[0].n,0);
 }finally{await f.close();}
});

test('ordinary protected refresh survives; switch/away-back/reconnect and saved-row/customer changes invalidate the in-flight read',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());
  const prior=await f.store.getConnection(f.identity),expired={...f.token,expiresAt:Date.now()-1000};
  await f.store.replaceConnection({...prior,...f.cipher.encrypt(expired,connectionAad('zoho_books',f.ws)),tokenExpiresAt:expired.expiresAt},prior.revision);
  const initial=await f.context();let refreshes=0;
  const adapter=createZohoBooksProvider({clientId:'offline-id',clientSecret:'offline-secret',fetchImpl:async(url,options)=>{
   refreshes++;assert.equal(String(url),'https://accounts.zoho.in/oauth/v2/token');assert.equal(options.method,'POST');assert.ok(options.signal);
   return Response.json({access_token:'offline-refreshed-access',refresh_token:'offline-refreshed-refresh',expires_in:3600,api_domain:f.token.apiDomain});
  }});
  const integration=createAccountingIntegration({store:f.store,cipher:f.cipher,providers:{...createAccountingProviders(),zoho_books:adapter}});
  assert.equal((await f.inspect({accessToken:integration.accessToken})).existence,'verified');assert.equal(refreshes,1);
  assert.deepEqual(await f.context(),initial,'ordinary refresh keeps protected incarnation');
  const oldConnection=await f.store.getConnection(f.identity);
  for(const mode of ['switch','away-back','reconnect','invoice-edit','customer-edit']){
   const mutate=async()=>{
    if(mode==='switch'||mode==='away-back'){await f.store.setOrganization(f.identity,{id:'90002'});if(mode==='away-back')await f.store.setOrganization(f.identity,{id:'90001'});}
    if(mode==='reconnect'){await f.store.deleteConnection(f.identity);await f.store.insertConnection(oldConnection);}
    if(mode==='invoice-edit')await f.db.query("update invoices set notes='Concurrent local edit' where id=$1",[f.row.id]);
    if(mode==='customer-edit')await f.db.query("update customers set name='Concurrent client edit' where id=$1",[f.cust]);
   };
   const snapshot=await f.read();
   await assert.rejects(f.inspect({fetchImpl:async()=>{await mutate();return Response.json({code:0,invoice:f.remote()});}}),/unavailable/,mode);
   if(mode==='switch')await f.store.setOrganization(f.identity,{id:'90001'});
   assert.equal((await f.read()).external_invoice_id,snapshot.external_invoice_id,'read never restores or rewrites linkage');
  }
  let reads=0;
  await assert.rejects(f.inspect({accessToken:async(identity,options)=>{await f.store.setOrganization(f.identity,{id:'90002'});return f.integration.accessToken(identity,options);},fetchImpl:()=>{reads++;assert.fail('no wrong-account request');}}),/unavailable/);
  assert.equal(reads,0);
 }finally{await f.close();}
});

test('owner dates/deletion/test/payable and owner revocation never turn captured origin into a read or reminder grant',async()=>{
 for(const mode of ['dates','deletion','test','payable','owner']){
  const f=await fixture();try{
   await f.db.exec(await sql());assert.ok(await f.context());
   const before=await f.read(),origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
   if(mode==='dates'||mode==='deletion'){
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}';set role authenticated`);
    if(mode==='dates'){
     const r=(await f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,f.row.id,before.updated_at,randomUUID(),{due_date:'2026-11-01'}])).rows[0].value;assert.equal(r.ok,true);
    }else{
     const act=async(action,p=null)=>(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",[action,f.ws,p?null:f.row.id,p,`dashboard_delete_${randomUUID()}`,`delete-${randomUUID()}`])).rows[0].value;
     const p=await act('prepare');assert.equal(p.ok,true);assert.equal((await act('confirm',p.proposalId)).action,'deleted');
    }
    await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
   }
   if(mode==='owner'){
    await assert.rejects(f.db.query('update workspaces set owner_id=$2 where id=$1',[f.ws,f.other]),/owner/i);
    await assert.rejects(f.inspect({accessToken:()=>assert.fail('forged owner before token')},{...f.input,userId:f.other}),/unavailable/);
    assert.ok(await f.context(),'existing workspace owner is immutable');
   }else if(mode==='test'||mode==='payable'){
    const assignment=mode==='test'?"metadata=metadata||'{\"test_invoice\":true}'":"metadata=metadata||'{\"invoice_direction\":\"payable\"}'";
    await assert.rejects(f.db.query(`update invoices set ${assignment} where id=$1`,[f.row.id]),/TEST_INVOICE_IMMUTABLE|ZOHO_BOUND_IMPORT_UNSUPPORTED/);
    assert.ok(await f.context(),'protected rows cannot be converted to a test/payable invoice');
   }else{
    await assert.rejects(f.inspect({accessToken:()=>assert.fail('ineligible state before token')}),/unavailable/);
    assert.equal(await f.context(),null);
   }
   assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);
   assert.equal((await f.db.query('select app.reminder_local_status_payable(i) ok from invoices i where id=$1',[f.row.id])).rows[0].ok,false);
  }finally{await f.close();}
 }
});

test('single end-to-end deadline, body/redirect/UTF8 bounds and late auth cannot initiate a provider read',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());let reads=0;
  const timeoutMs=300,start=Date.now();
  await assert.rejects(f.inspect({timeoutMs,accessToken:()=>new Promise(()=>{}),fetchImpl:()=>{reads++;assert.fail('no post-timeout read');}}),/unavailable/);
  assert.ok(Date.now()-start<1000);assert.equal(reads,0);
  let resolveAuth;
  const pending=f.inspect({timeoutMs,accessToken:()=>new Promise(r=>{resolveAuth=r;}),fetchImpl:()=>{reads++;assert.fail('late auth cannot read');}});
  await assert.rejects(pending,/unavailable/);resolveAuth(await f.integration.accessToken(f.identity));await new Promise(r=>setTimeout(r,10));assert.equal(reads,0);
  for(const fetchImpl of [async()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}}),
   async()=>new Response('x',{headers:{'content-type':'application/json','content-length':'262145'}}),async()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),
   async()=>{const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;}])await assert.rejects(f.inspect({timeoutMs:300,fetchImpl}),/unavailable/);
  assert.equal((await f.db.query('select count(*) n from cetld_core_automation_delivery_claims')).rows[0].n,0);
 }finally{await f.close();}
});

test('audited CRLF and source/ACL/default-grant drift fail closed atomically; no old function/security is changed',async()=>{
 const f=await fixture({crlf:true});try{
  await f.db.exec('set search_path=pg_catalog,public');
  const saved=(await f.db.query("select pg_get_functiondef(oid) d from pg_proc where oid='app.guard_zoho_origin()'::regprocedure")).rows[0].d;
  const gate=(await f.db.query("select prosrc from pg_proc where oid='cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure")).rows[0].prosrc;
  assert.equal(gate.split('\r\n').length-1,31);
  const gateDefinition=(await f.db.query("select pg_get_functiondef(oid) d from pg_proc where oid='cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure")).rows[0].d;
  for(const mode of ['source','CRLF','ACL','column','trigger','constraint','default']){
   if(mode==='CRLF')await f.db.exec(gateDefinition.replace('\r\n','\n'));
   if(mode==='source')await f.db.exec(saved.replace('begin','begin /* unknown drift */'));
   if(mode==='ACL')await f.db.exec('grant select on app.zoho_invoice_origins to service_role');
   if(mode==='column')await f.db.exec('grant select(account_id) on app.zoho_customer_origins to authenticated');
   if(mode==='trigger')await f.db.exec('alter table app.zoho_invoice_origins disable trigger zoho_origin_immutable');
   const constraint=(await f.db.query("select conname,pg_get_constraintdef(oid) d from pg_constraint where conrelid='app.zoho_customer_origins'::regclass and contype='p'")).rows[0];
   if(mode==='constraint')await f.db.exec(`alter table app.zoho_customer_origins drop constraint ${constraint.conname}`);
   if(mode==='default')await f.db.exec('create role unexpected_read_grantee;alter default privileges in schema public grant execute on functions to unexpected_read_grantee');
   await assert.rejects(f.db.exec(await sql()),/drift/);await f.db.exec('rollback');
   assert.equal((await f.db.query("select to_regprocedure('public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid)') p")).rows[0].p,null);
   if(mode==='constraint')await f.db.exec(`alter table app.zoho_customer_origins add constraint ${constraint.conname} ${constraint.d}`);
   await f.db.exec(gateDefinition);
   await f.db.exec(saved+';revoke select on app.zoho_invoice_origins from service_role;revoke select(account_id) on app.zoho_customer_origins from authenticated;alter table app.zoho_invoice_origins enable trigger zoho_origin_immutable');
   if(mode==='default')await f.db.exec('alter default privileges in schema public revoke execute on functions from unexpected_read_grantee;drop role unexpected_read_grantee');
  }
  await f.db.exec(await sql());assert.equal((await f.inspect()).reminderAuthority,false);
  assert.equal((await f.db.query("select prosrc from pg_proc where oid='cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure")).rows[0].prosrc,gate);
 }finally{await f.close();}
});

test('scoped Zoho refresh and SQL response bodies are bounded, abortable and redacted',async()=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),500);
 try{
  for(const response of [new Response('x',{headers:{'content-type':'application/json','content-length':'16385'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),Response.json({secret:'private'},{status:403})]){
   const adapter=createZohoBooksProvider({clientId:'offline-id',clientSecret:'offline-secret',fetchImpl:async(url,options)=>{
    assert.equal(String(url),'https://accounts.zoho.in/oauth/v2/token');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.ok(options.signal);return response;
   }});
   await assert.rejects(adapter.refreshToken({refreshToken:'offline-refresh',region:'in',signal:controller.signal}),e=>!e.message.includes('private'));
  }
  const pending=new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});
  await assert.rejects(originalReadJson(pending,controller.signal));
 }finally{clearTimeout(timer);controller.abort();}
});
