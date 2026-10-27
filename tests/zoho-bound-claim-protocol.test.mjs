import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {SupabaseAccountingStore,TokenCipher,connectionAad,createAccountingIntegration,createAccountingProviders,createZohoBooksProvider} from '../automation/accounting/index.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {createDisabledZohoClaimProtocol} from '../automation/accounting/bound-claim-protocol.mjs';
const file='20261027070000_zoho_bound_claim_protocol.sql';
const sql=()=>readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
async function fixture({crlf=false}={}){
 const f=await createOfflineSqlNetwork({excludeMigrations:[file,'20261026090000_contain_unproven_external_reminders.sql']}),owner=randomUUID(),other=randomUUID();
 const install=async name=>f.db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 for(const name of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql'])await install(name);
 if(crlf)for(const sig of ['cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)','cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)']){
  const p=(await f.db.query('select pg_get_functiondef(oid) d,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
  await f.db.exec(p.d.replace(p.prosrc,()=>p.prosrc.replaceAll('\n','\r\n')));
 }
 for(const name of ['20261026090000_contain_unproven_external_reminders.sql','20261026110000_zoho_prospective_operation_foundation.sql','20261026141000_zoho_capture_completion_protocol.sql','20261027050000_zoho_original_bound_read.sql'])await install(name);
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
 const context=()=>store.originalBoundReadContext(identity,row.id);
 const read=async()=>(await f.db.query('select * from invoices where id=$1',[row.id])).rows[0];
 await f.db.query("update workspace_settings set business_name='Offline company',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[ws,{contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3}]);
 await f.db.query('update customers set phone=$2 where id=$1',[cust,'+15550001111']);
 const setting=(await f.db.query('select updated_at from workspace_settings where workspace_id=$1',[ws])).rows[0];
 await f.db.query("update invoices set customer_phone='+15550001111' where id=$1",[row.id]);
 await f.db.query("update invoices set followup_state='approved',next_follow_up_at=clock_timestamp()-interval '1 second',metadata=metadata||jsonb_build_object('followup_state','approved','next_follow_up_at',clock_timestamp()-interval '1 second','approved_reminder_text','Offline approved fixture'||chr(10)||chr(10)||'Offline company','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=invoices.workspace_id)) where id=$1",[row.id]);
 await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,categories,source,consent_text_version) values($1,$2,'+15550001111',array['invoice_updates'],'verbal','offline-v1')",[ws,cust]);
 const execute=async(action,args,options={})=>{options.signal?.throwIfAborted();const keys=Object.keys(args);return (await f.db.query(`select app.zoho_bound_claim_protocol(p_action=>$1,${keys.map((k,n)=>`${k}=>$${n+2}`).join(',')}) value`,[action,...keys.map(k=>args[k])])).rows[0].value;};
 const protocol=createDisabledZohoClaimProtocol({executor:execute,store,accessToken:integration.accessToken,fetchImpl});
 return {...f,dbFetch:f.fetchImpl,execute,protocol,owner,other,ws,cust,row,store,cipher,identity,input,token,integration,remote,fetchImpl,context,read,calls:()=>calls};
}


test('disabled protected claim -> fresh challenge -> opaque one-use final permit -> scoped receipt journal; old gates remain closed',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query("select oid,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('app'::regnamespace,'public'::regnamespace) order by oid")).rows;
  const invoice=await f.read(),origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  await f.db.exec(await sql());
  const after=(await f.db.query("select oid,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('app'::regnamespace,'public'::regnamespace) order by oid")).rows;
  for(const p of before)assert.deepEqual(after.find(q=>q.oid===p.oid),p,'every prior OID/source/security/ACL preserved');
  const handle=await f.protocol.claim(f.input),permit=await f.protocol.reserve(handle);
  assert.equal(f.calls(),1);assert.equal(JSON.stringify(handle),'{}');assert.equal(JSON.stringify(permit),'{}');
  await assert.rejects(f.protocol.reserve(handle),/unavailable/);await assert.rejects(f.protocol.beginDispatch({...permit}),/unavailable/);
  const begun=await f.protocol.beginDispatch(permit);assert.equal(begun.deliveryAuthority,false);
  await assert.rejects(f.protocol.beginDispatch(permit),/unavailable/);
  // Trusted callback fixture ONLY. This is a private journal proof, not an
  // engine/Graph positive path; deliveryAuthority:false never permits a POST.
  const ack={id:'offline-message-1'};
  assert.equal((await f.protocol.recordReceipt(begun.receipt,{messageId:ack.id,status:'accepted'})).state,'accepted');
  await f.protocol.recordReceipt(begun.receipt,{messageId:ack.id,status:'accepted'});
  await f.protocol.recordReceipt(begun.receipt,{messageId:ack.id,status:'delivered'});
  await f.protocol.recordReceipt(begun.receipt,{messageId:ack.id,status:'failed'});
  assert.equal((await f.protocol.recover(handle)).state,'accepted','delivered outranks later failure');
  assert.equal((await f.db.query('select count(*) n from app.zoho_bound_claim_receipts')).rows[0].n,3);
  await assert.rejects(f.protocol.recordReceipt(begun.receipt,{messageId:'wrong-message',status:'read'}),/unavailable/);
  await assert.rejects(f.protocol.claim(f.input),/unavailable/,'same version/schedule cannot be replayed');
  assert.deepEqual(await f.read(),invoice);assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);
  const payment=(await f.db.query('select cetld_core_check_local_reminder_payment($1,$2,$3) value',[f.owner,f.ws,f.row.id])).rows[0].value;
  assert.equal(payment.ok,false);
  const claims=(await f.db.query('select * from cetld_core_claim_due_followups($1,$2,clock_timestamp(),1,$3)',[f.owner,f.ws,f.row.id])).rows;assert.equal(claims.length,0);
  for(const table of ['payments','cetld_accounting_sync_records','cetld_core_automation_delivery_claims','owner_assistant_proposals','whatsapp_messages'])assert.equal((await f.db.query(`select count(*) n from ${table}`)).rows[0].n,0);
  assert.equal((await f.db.query('select count(*) n from app.zoho_bound_claim_write_context')).rows[0].n,0);
 }finally{await f.close();}
});

test('owner-only disabled surface rejects service/table/GUC/metadata/diagnostic forgeries before provider access',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());
  for(const role of ['anon','authenticated','service_role']){
   await f.db.exec(`set role ${role}`);
   for(const table of ['zoho_bound_claims','zoho_bound_claim_receipts','zoho_bound_claim_write_context']){
    await assert.rejects(f.db.exec(`select * from app.${table}`),/permission denied/);
    await assert.rejects(f.db.exec(`insert into app.${table} default values`),/permission denied/);
   }
   await f.db.exec("set app.reminder_external_read='{}';set app.zoho_bound_permit='verified'");
   await assert.rejects(f.execute('claim',{p_owner:f.owner,p_workspace:f.ws,p_invoice:f.row.id}),/permission denied/);
   await f.db.exec('reset role');
  }
  for(const bad of [{...f.input,userId:f.other},{...f.input,workspaceId:randomUUID()},{...f.input,provider:'zoho_books'},
   {...f.input,accountId:'90001'},{...f.input,externalId:'99001'}])await assert.rejects(f.protocol.claim(bad),/unavailable/);
  const legacy=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,currency,total_amount,status,external_provider,external_invoice_id,metadata) values($1,$2,'UNBOUND','2026-10-01','USD',5,'sent','zoho_books','99002','{\"invoice_direction\":\"receivable\",\"verified\":true,\"originCaptured\":true}') returning id",[f.ws,f.cust])).rows[0].id;
  await assert.rejects(f.protocol.claim({...f.input,invoiceId:legacy}),/unavailable/);
  const handle=await f.protocol.claim(f.input),c=(await f.db.query('select * from app.zoho_bound_claims')).rows[0];
  await assert.rejects(f.db.query("update app.zoho_bound_claims set state='posting' where id=$1",[c.id]),/BOUND_CLAIM_PRIVATE_WRITE/);
  const scope={p_owner:f.owner,p_workspace:f.ws,p_invoice:f.row.id,p_claim:c.id};
  const challenge=await f.execute('challenge',scope);
  for(const patch of [{p_nonce:randomUUID(),p_facts:{}},{p_facts:{...challenge.context,provenance:'provenance_unverified',currentAccountId:'90001'}},
   {p_facts:{...challenge.context,originCaptured:true,reminderAuthority:true}}])await assert.rejects(f.execute('reserve',{...scope,p_nonce:challenge.nonce,p_attempt:randomUUID(),...patch}),/BOUND_CLAIM/);
  assert.equal(f.calls(),0);assert.equal((await f.protocol.recover(handle)).state,'challenged');
 }finally{await f.close();}
});

test('switch/away-back/reconnect and invoice/customer/preferences/STOP changes permanently invalidate pending claims',async()=>{
 for(const mode of ['switch','away-back','reconnect','invoice','dates','deleted','customer','preferences','stop','consent']){
  const f=await fixture();try{
   await f.db.exec(await sql());const handle=await f.protocol.claim(f.input);
   if(mode==='switch'||mode==='away-back'){await f.store.setOrganization(f.identity,{id:'90002'});if(mode==='away-back')await f.store.setOrganization(f.identity,{id:'90001'});}
   if(mode==='reconnect'){const c=await f.store.getConnection(f.identity);await f.store.deleteConnection(f.identity);await f.store.insertConnection(c);}
   if(mode==='invoice')await f.db.query("update invoices set notes='Changed' where id=$1",[f.row.id]);
   if(mode==='dates'||mode==='deleted'){
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}'`);
    if(mode==='dates'){
     const current=await f.read(),r=(await f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,f.row.id,current.updated_at,randomUUID(),{due_date:'2026-11-01'}])).rows[0].value;assert.equal(r.ok,true,JSON.stringify(r));
    }else{
     const act=async(action,p=null)=>(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",[action,f.ws,p?null:f.row.id,p,`dashboard_delete_${randomUUID()}`,`delete-${randomUUID()}`])).rows[0].value;
     const p=await act('prepare');assert.equal(p.ok,true);assert.equal((await act('confirm',p.proposalId)).action,'deleted');
    }
    await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
   }
   if(mode==='customer')await f.db.query("update customers set name='Changed' where id=$1",[f.cust]);
   if(mode==='preferences')await f.db.query("update workspace_settings set business_name='Changed' where workspace_id=$1",[f.ws]);
   if(mode==='stop'){
    await f.db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,'+15550001111','stop')",[f.ws]);
    await f.db.query("delete from whatsapp_suppressions where workspace_id=$1 and phone='+15550001111'",[f.ws]);
   }
   if(mode==='consent'){
    await f.db.query("update whatsapp_consents set revoked_at=clock_timestamp(),revoked_via='stop' where workspace_id=$1",[f.ws]);
    await f.db.query('update whatsapp_consents set revoked_at=null,revoked_via=null where workspace_id=$1',[f.ws]);
   }
   assert.equal((await f.protocol.recover(handle)).state,'cancelled',mode);
   await assert.rejects(f.protocol.reserve(handle),/unavailable/);assert.equal(f.calls(),0,'invalidated before any provider GET');
  }finally{await f.close();}
 }
});

test('races during read and before final, remote mismatches/errors and expired permits cannot reserve a POST',async()=>{
 for(const mode of ['during-switch','during-edit','before-final','bad-customer','bad-id','wrong-org','currency','balance','unknown','writeoff','paid','credits','dates','403','404','429','oversize','redirect','timeout','expired']){
  const f=await fixture();try{
   await f.db.exec(await sql());let gets=0;
   const fetchImpl=async()=>{
    gets++;
    if(mode==='during-switch')await f.store.setOrganization(f.identity,{id:'90002'});
    if(mode==='during-edit')await f.db.query("update invoices set notes='During read' where id=$1",[f.row.id]);
    if(['403','404','429'].includes(mode))return Response.json({code:1000,message:'PRIVATE secret'},{status:Number(mode)});
    if(mode==='oversize')return new Response('x',{headers:{'content-type':'application/json','content-length':'262145'}});
    if(mode==='redirect'){const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;}
    if(mode==='timeout')return new Promise(()=>{});
    const r=f.remote();if(mode==='bad-id')r.invoice_id='99002';if(mode==='wrong-org')r.organization_id='90002';if(mode==='currency')r.currency_code='INR';if(mode==='balance')r.balance=4;if(mode==='unknown')r.status='unknown';if(mode==='writeoff')r.write_off_amount=1;if(mode==='bad-customer')r.customer_id='88002';if(mode==='paid')r.payment_made=1;if(mode==='credits')r.credits_applied=1;if(mode==='dates')r.due_date='2026-11-01';
    return Response.json({code:0,invoice:r});
   };
   const protocol=createDisabledZohoClaimProtocol({executor:f.execute,store:f.store,accessToken:f.integration.accessToken,fetchImpl});
   const handle=await protocol.claim(f.input);
   if(['before-final','expired'].includes(mode)){
    const permit=await protocol.reserve(handle);
    if(mode==='before-final')await f.db.query("update customers set name='Before final' where id=$1",[f.cust]);
    else await new Promise(r=>setTimeout(r,2100));
    await assert.rejects(protocol.beginDispatch(permit),/unavailable/);
   }else await assert.rejects(protocol.reserve(handle),/unavailable/);
   assert.equal(gets,1);assert.notEqual((await protocol.recover(handle)).state,'posting');
   assert.equal((await f.db.query('select count(*) n from app.zoho_bound_claim_receipts')).rows[0].n,0);
   assert.equal((await f.db.query('select count(*) n from payments')).rows[0].n,0);
  }finally{await f.close();}
 }
});

test('atomic rollback/lost reserve acknowledgement/unknown POST never recover a permit or redispatch; late scoped receipt is audit only',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());let loseAck=true;
  const execute=async(action,args,options)=>{const r=await f.execute(action,args,options);if(action==='reserve'&&loseAck){loseAck=false;throw Error('Offline ack lost after commit');}return r;};
  const protocol=createDisabledZohoClaimProtocol({executor:execute,store:f.store,accessToken:f.integration.accessToken,fetchImpl:f.fetchImpl});
  const handle=await protocol.claim(f.input);await assert.rejects(protocol.reserve(handle),/unavailable/);
  const recovered=await protocol.recover(handle);assert.equal(recovered.state,'quarantined');assert.doesNotMatch(JSON.stringify(recovered),/permit|nonce|token/);
  await assert.rejects(protocol.reserve(handle),/unavailable/);await assert.rejects(protocol.beginDispatch({}),/unavailable/);assert.equal(f.calls(),1);
  assert.equal((await f.db.query('select count(*) n from app.zoho_bound_claim_receipts')).rows[0].n,0);
 }finally{await f.close();}
 const g=await fixture();try{
  await g.db.exec(await sql());const handle=await g.protocol.claim(g.input),permit=await g.protocol.reserve(handle),begun=await g.protocol.beginDispatch(permit);
  await g.protocol.quarantine(begun.receipt);assert.equal((await g.protocol.recover(handle)).state,'quarantined');
  await assert.rejects(g.protocol.beginDispatch(permit),/unavailable/);await assert.rejects(g.protocol.claim(g.input),/unavailable/);
  await g.store.setOrganization(g.identity,{id:'90002'});
  await g.protocol.recordReceipt(begun.receipt,{messageId:'offline-late-receipt',status:'delivered'});
  assert.equal((await g.protocol.recover(handle)).state,'accepted');
  assert.equal((await g.db.query('select count(*) n from whatsapp_messages')).rows[0].n,0,'no business receipt/count/scheduling effect');
  assert.equal((await g.db.query('select reminder_count from invoices where id=$1',[g.row.id])).rows[0].reminder_count,0);
 }finally{await g.close();}
});

test('private reservation is atomic and cannot be replayed, expired or used for a receipt before posting',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());const handle=await f.protocol.claim(f.input),c=(await f.db.query('select * from app.zoho_bound_claims')).rows[0];
  const scope={p_owner:f.owner,p_workspace:f.ws,p_invoice:f.row.id,p_claim:c.id};
  const r=await f.execute('challenge',scope),facts={...r.context,creditsApplied:'0',writeOff:'0'};
  for(const k of ['fingerprint','epochId','apiDomain','accountsDomain','reminderAuthority','workspaceId','invoiceId'])delete facts[k];
  await f.db.exec("create function app.fixture_claim_abort() returns trigger language plpgsql as $$begin if new.state='reserved' then raise exception 'Offline atomic rollback';end if;return new;end;$$;create trigger zz_fixture_claim_abort after update on app.zoho_bound_claims for each row execute function app.fixture_claim_abort()");
  const attempt=randomUUID(),args={...scope,p_attempt:attempt,p_nonce:r.nonce,p_facts:facts};
  await assert.rejects(f.execute('reserve',args),/Offline atomic rollback/);
  const failed=(await f.db.query('select * from app.zoho_bound_claims where id=$1',[c.id])).rows[0];
  assert.equal(failed.state,'challenged');assert.equal(failed.permit_hash,null);assert.equal(failed.attempt_id,null);
  assert.equal((await f.db.query('select count(*) n from app.zoho_bound_claim_write_context')).rows[0].n,0);
  await f.db.exec('drop trigger zz_fixture_claim_abort on app.zoho_bound_claims;drop function app.fixture_claim_abort()');
  const permit=await f.execute('reserve',args);assert.equal(permit.deliveryAuthority,false);
  await assert.rejects(f.execute('reserve',args),/BOUND_CLAIM/);
  await assert.rejects(f.execute('receipt',{...scope,p_attempt:attempt,p_permit:permit.permit,p_message_id:'invented-before-post',p_status:'accepted'}),/BOUND_CLAIM_RECEIPT/);
  await assert.rejects(f.execute('begin_post',{...scope,p_attempt:attempt,p_permit:'0'.repeat(64)}),/BOUND_CLAIM_PERMIT/);
  assert.equal((await f.protocol.recover(handle)).state,'reserved');
 }finally{await f.close();}
});

test('actual engine and approved provider remain fail closed: foundation rows cannot bypass the existing queue/final gates',async()=>{
 const f=await fixture();try{
  await f.db.exec(await sql());const store=new CoreAutomationStore({url:'https://fixture.supabase.test',key:'offline-service',fetchImpl:f.dbFetch});
  let posts=0;const graph=()=>{posts++;assert.fail('disabled foundation cannot reach Graph');};
  const provider=createApprovedReminderProvider({env:{WHATSAPP_REMINDERS_ENABLED:'true',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',
   WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_GRAPH_API_VERSION:'v24.0',WHATSAPP_ACCESS_TOKEN:'offline-token'},
   supabase:f.supabase,store,ownerId:f.owner,workspaceId:f.ws,fetchImpl:graph});
  const handle=await f.protocol.claim(f.input);const permit=await f.protocol.reserve(handle);await f.protocol.beginDispatch(permit);
  const engine=new FollowUpEngine({store,provider,paymentChecker:()=>assert.fail('core claim must refuse before payment checker')});
  const outcome=await engine.run({ownerId:f.owner,workspaceId:f.ws,invoiceId:f.row.id});
  assert.equal(outcome.reason,'not_claimed',JSON.stringify(outcome));
  const sent=await provider.sendReminder({workspaceId:f.ws,invoiceId:f.row.id,customerId:f.cust,to:'+15550001111',body:'Offline body',idempotencyKey:`reminder:${f.ws}:${randomUUID()}`});
  assert.equal(sent.status,'blocked');assert.equal(posts,0);
  assert.equal((await f.db.query('select count(*) n from cetld_core_automation_delivery_claims')).rows[0].n,0);
 }finally{await f.close();}
});

test('normal actual token refresh preserves an in-flight claim epoch and never grants delivery authority',async()=>{
 const f=await fixture();try{
  const prior=await f.store.getConnection(f.identity),expired={...f.token,expiresAt:Date.now()-1000};
  await f.store.replaceConnection({...prior,...f.cipher.encrypt(expired,connectionAad('zoho_books',f.ws)),tokenExpiresAt:expired.expiresAt},prior.revision);
  await f.db.exec(await sql());let refreshes=0;
  const adapter=createZohoBooksProvider({clientId:'offline-id',clientSecret:'offline-secret',fetchImpl:async(url,options)=>{refreshes++;assert.equal(String(url),'https://accounts.zoho.in/oauth/v2/token');assert.equal(options.method,'POST');return Response.json({access_token:'offline-new-access',refresh_token:'offline-new-refresh',expires_in:3600,api_domain:f.token.apiDomain});}});
  const integration=createAccountingIntegration({store:f.store,cipher:f.cipher,providers:{...createAccountingProviders(),zoho_books:adapter}});
  const protocol=createDisabledZohoClaimProtocol({executor:f.execute,store:f.store,accessToken:integration.accessToken,fetchImpl:f.fetchImpl});
  const handle=await protocol.claim(f.input),epoch=(await f.store.zohoOperationContext(f.identity)).epochId;
  const permit=await protocol.reserve(handle),result=await protocol.beginDispatch(permit);
  assert.equal(refreshes,1);assert.equal(result.deliveryAuthority,false);assert.equal((await f.store.zohoOperationContext(f.identity)).epochId,epoch);
 }finally{await f.close();}
});

test('new schema accepts audited CRLF, rejects source/attribute/ACL/default-grant drift and installs no business DML',async()=>{
 const f=await fixture({crlf:true});try{
  await f.db.exec('set search_path=pg_catalog,public');
  const read=(await f.db.query("select pg_get_functiondef(oid) d from pg_proc where oid='cetld_zoho_original_bound_read_context(uuid,uuid,uuid)'::regprocedure")).rows[0].d;
  const gate=(await f.db.query("select prosrc from pg_proc where oid='cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure")).rows[0].prosrc;
  const before=await f.read();assert.equal(gate.split('\r\n').length-1,31);
  for(const mode of ['source','notnull','ACL','default']){
   if(mode==='source')await f.db.exec(read.replace('select jsonb_build_object','select /* unknown */ jsonb_build_object'));
   if(mode==='notnull')await f.db.exec('alter table app.zoho_invoice_origins alter column reference drop not null');
   if(mode==='ACL')await f.db.exec('grant select on app.zoho_invoice_origins to service_role');
   if(mode==='default')await f.db.exec('create role unexpected_claim_grantee;alter default privileges in schema app grant execute on functions to unexpected_claim_grantee');
   await assert.rejects(f.db.exec(await sql()),/drift/);await f.db.exec('rollback');
   assert.equal((await f.db.query("select to_regclass('app.zoho_bound_claims') t")).rows[0].t,null);
   await f.db.exec(read+';alter table app.zoho_invoice_origins alter column reference set not null;revoke select on app.zoho_invoice_origins from service_role');
   if(mode==='default')await f.db.exec('alter default privileges in schema app revoke execute on functions from unexpected_claim_grantee;drop role unexpected_claim_grantee');
  }
  await f.db.exec(await sql());assert.deepEqual(await f.read(),before);
  assert.equal((await f.db.query("select prosrc from pg_proc where oid='cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)'::regprocedure")).rows[0].prosrc,gate);
 }finally{await f.close();}
});
