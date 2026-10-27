import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createZohoBoundReminderFixture} from './fixtures/zoho-bound-reminder.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
const migration='20261027100000_zoho_first_party_reminder_bridge.sql';
const rawRpc=(f,action,claim=null,payload={})=>f.supabase.rpc('cetld_zoho_bound_reminder',{p_owner_id:f.owner,p_workspace_id:f.ws,p_invoice_id:f.row.id,p_action:action,p_claim_id:claim,p_payload:payload});
const sqlValue=async(f,sql,args=[])=>(await f.db.query(sql,args)).rows[0];
async function callback(f,{status='delivered',id='wamid.offline.capture.1',token=f.postBodies[0]?.biz_opaque_callback_data,signature=true,waba=f.env.WHATSAPP_WABA_ID}={}){
 const payload={object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:f.env.WHATSAPP_PHONE_NUMBER_ID},statuses:[{id,status,recipient_id:f.customerPhone.slice(1),biz_opaque_callback_data:token}]}}]}]};
 const rawBody=Buffer.from(JSON.stringify(payload)),env={...f.env,SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-service',WHATSAPP_APP_SECRET:'offline-signature'};
 const h=createWhatsAppWebhookHandler({env,fetchImpl:f.transport,logger:{log(){},error(){}}});
 const response={statusCode:null,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;},send(body){this.body=body;return this;}};
 await h({method:'POST',rawBody,headers:{'x-hub-signature-256':signature?'sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex'):'sha256='+'0'.repeat(64)}},response);return response;
}

for(const installedShape of [false,true])test(`actual owner confirmation -> engine/core claim -> bounded exact GET -> atomic approved final -> fake POST -> SQL receipt and signed callback (installedShape=${installedShape})`,async()=>{
 const f=await createZohoBoundReminderFixture({installedShape});try{
  const origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  await f.approve();const before=await f.read();
  const result=await f.run();assert.equal(result.status,'sent');assert.deepEqual(f.counts(),{gets:1,posts:1});
  const after=await f.read();assert.equal(Number(after.reminder_count),1);assert.equal(Number(after.amount_paid),0);assert.equal(after.total_amount,before.total_amount);
  assert.ok(new Date(after.next_follow_up_at)>new Date(before.next_follow_up_at).getTime()+86400000,'versionless cadence reconciles to a future day');
  assert.equal((await sqlValue(f,'select state from app.zoho_bound_claims')).state,'accepted');
  assert.equal((await sqlValue(f,'select status from cetld_core_automation_delivery_claims')).status,'sent');
  await assert.rejects(f.db.exec("update cetld_core_automation_delivery_claims set status='sending',delivery_token=gen_random_uuid()"),/ZOHO_CORE_CLAIM_PROTECTED/);
  await assert.rejects(f.db.exec("delete from cetld_core_automation_delivery_claims"),/ZOHO_CORE_CLAIM_PROTECTED/);
  const final=f.requests.findIndex(r=>r.body?.p_action==='final'),post=f.requests.findIndex(r=>r.url.startsWith('https://graph.facebook.com/'));
  assert.equal(post,final+1,'no asynchronous HTTP work between final SQL reservation and POST');
  assert.equal((await callback(f,{signature:false})).statusCode,403);assert.equal((await callback(f)).statusCode,200);assert.equal((await callback(f)).statusCode,200);
  assert.equal(Number((await f.read()).reminder_count),1);assert.equal((await sqlValue(f,'select state from app.first_party_reminder_dispatches')).state,'delivered');
  assert.equal((await callback(f,{id:'other-attempt-message'})).statusCode,200);assert.equal(Number((await f.read()).reminder_count),1);
  assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);
  for(const table of ['payments','cetld_accounting_sync_records','app.zoho_reminder_transaction_context','app.zoho_bound_claim_write_context'])assert.equal(Number((await sqlValue(f,`select count(*) n from ${table}`)).n),0);
  assert.notEqual((await f.run()).status,'sent');assert.equal(f.counts().posts,1,'same schedule/version never resends');
 }finally{await f.close();}
});

test('immutable origin, scope, private privileges and old-worker evidence cannot be replaced by metadata/diagnostic/GUC/service patches',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();const initial=await f.read(),origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  for(const role of ['anon','authenticated','service_role'])await t.test(role+' cannot forge journal/transaction/binding',async()=>{
   await f.db.exec(`set role ${role}`);
   try{for(const table of ['app.zoho_reminder_transaction_context','app.zoho_reminder_core_bindings','app.zoho_bound_claims']){
    await assert.rejects(f.db.exec(`select * from ${table}`),/permission denied/);await assert.rejects(f.db.exec(`insert into ${table} default values`),/permission denied/);
   }}finally{await f.db.exec('reset role');}
  });
  for(const [field,value] of [['p_owner_id',randomUUID()],['p_workspace_id',randomUUID()],['p_invoice_id',randomUUID()]]){
   const r=await f.supabase.rpc('cetld_zoho_bound_reminder',{p_owner_id:f.owner,p_workspace_id:f.ws,p_invoice_id:f.row.id,p_action:'claim',[field]:value});assert.notEqual(r.data?.ok,true);
  }
  for(const payload of [{accountId:'90001'},{provider:'zoho_books'},{externalId:'99001'},{userId:f.owner},{reminderAuthority:true},{provenance_unverified:true}])assert.notEqual((await rawRpc(f,'claim',null,payload)).data?.ok,true);
  await f.db.exec("set app.reminder_external_read='{\"provider\":\"zoho_books\",\"verified\":true}';set app.zoho_bound_permit='verified'");
  assert.equal((await sqlValue(f,'select app.reminder_external_read_matches(i,$1) value from invoices i where id=$2',[f.owner,f.row.id])).value,false);
  assert.equal((await f.db.query('select * from cetld_core_claim_due_followups($1,$2,clock_timestamp(),1,$3)',[f.owner,f.ws,f.row.id])).rows.length,0);
  for(const statement of ["update invoices set amount_paid=1 where id=$1","update invoices set status='void' where id=$1","update invoices set external_invoice_id='99002' where id=$1","update invoices set customer_id=$2 where id=$1"]){
   const args=statement.includes('$2')?[f.row.id,randomUUID()]:[f.row.id];await assert.rejects(f.db.query(statement,args),/ZOHO_/);
  }
  const saved=f.row.id;
  const legacy=(await f.db.query("insert into invoices(workspace_id,customer_id,customer_phone,invoice_number,issue_date,due_date,currency,total_amount,status,external_provider,external_invoice_id,metadata,followup_state,next_follow_up_at) select workspace_id,customer_id,customer_phone,'LEGACY',issue_date,due_date,currency,total_amount,status,'zoho_books','99002',metadata-'source_invoice_number','approved',clock_timestamp()-interval '1 second' from invoices where id=$1 returning id",[saved])).rows[0].id;
  f.row.id=legacy;try{assert.notEqual((await f.run()).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:0});}finally{f.row.id=saved;}
  await f.ast.setOrganization(f.identity,{id:'90002',name:'Offline other account'});
  assert.notEqual((await f.run()).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:0});
  assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);assert.deepEqual(await f.read(),initial);
 }finally{await f.close();}
});

test('each live claim race is independently final-blocked; STOP/START and edit/revert never revive a claim',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();const baseline=await f.read();
  const changes={
   switch:async()=>f.ast.setOrganization(f.identity,{id:'90002',name:'Other'}),
   awayback:async()=>{await f.ast.setOrganization(f.identity,{id:'90002',name:'Other'});await f.ast.setOrganization(f.identity,{id:'90001',name:'Back'});},
   reconnect:async()=>{const c=await f.ast.getConnection(f.identity);await f.ast.deleteConnection(f.identity);await f.ast.insertConnection(c);},
   stopstart:async()=>{await f.db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,'manual')",[f.ws,f.customerPhone]);await f.db.query('delete from whatsapp_suppressions where workspace_id=$1 and phone=$2',[f.ws,f.customerPhone]);},
   consent:async()=>{await f.db.query("update whatsapp_consents set revoked_at=clock_timestamp(),revoked_via='stop' where workspace_id=$1 and customer_id=$2",[f.ws,f.cust]);await f.db.query('update whatsapp_consents set revoked_at=null,revoked_via=null where workspace_id=$1 and customer_id=$2',[f.ws,f.cust]);},
   editrevert:async()=>{await f.db.query("update invoices set notes='changed' where id=$1",[f.row.id]);await f.db.query('update invoices set notes=$2 where id=$1',[f.row.id,baseline.notes]);},
   preferences:async()=>f.db.query("update workspace_settings set business_name='Changed' where workspace_id=$1",[f.ws]),
   customer:async()=>f.db.query("update customers set name='Changed client' where id=$1",[f.cust]),
   phone:async()=>f.db.query("update customers set phone='+15550002222' where id=$1",[f.cust]),
   pause:async()=>f.db.query("update invoices set followup_state='paused',next_follow_up_at=null where id=$1",[f.row.id]),
   membership:async()=>{const other=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[other]);await f.db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'owner')",[f.ws,other]);await f.db.query("update workspace_members set role='member' where workspace_id=$1 and user_id=$2",[f.ws,f.owner]);await f.db.query("update workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[f.ws,f.owner]);},
   owner:async()=>{await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}'`);try{assert.equal((await sqlValue(f,'select owner_unbind_whatsapp($1) value',[f.ws])).value,true);}finally{await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");}},
  };
  for(const phase of ['afterclaim','duringread','beforefinal'])for(const [name,change] of Object.entries(changes))await t.test(`${phase}/${name}`,async()=>{
   await f.db.exec('begin;savepoint case_start');f.reset();let changed=false,mutationError;const mutate=async()=>{try{await change();changed=true;}catch(e){mutationError=e;throw e;}};
   try{
    if(phase==='duringread')f.controls.onGet=async()=>{await mutate();};
    else f.intercept(async(url,{body})=>{if(!changed&&url.pathname.endsWith('/rpc/cetld_zoho_bound_reminder')&&JSON.parse(body).p_action===(phase==='afterclaim'?'payment':'final')){await mutate();}});
    const r=await f.run().catch(()=>({status:'blocked'}));assert.equal(mutationError,undefined);assert.notEqual(r.status,'sent');assert.equal(changed,true);assert.equal(f.counts().posts,0);
    assert.equal(Number((await f.read()).amount_paid),0);assert.equal(Number((await f.read()).reminder_count),0);
    const j=await sqlValue(f,'select state from app.zoho_bound_claims');assert.ok(['cancelled','quarantined'].includes(j.state),j.state);
    assert.equal(Number((await sqlValue(f,'select count(*) n from app.zoho_reminder_transaction_context')).n),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

test('strict remote identities, original financial/date facts, transport bounds and expiring permits independently deny POST',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();
  const cases=[['id',{invoice_id:'99002'}],['customer',{customer_id:'88002'}],['account',{organization_id:'90002'}],['currency',{currency_code:'INR'}],['total',{total:6}],['paid',{payment_made:1,balance:4}],['balance',{balance:4}],['draft',{status:'draft'}],['paidstatus',{status:'paid'}],['void',{status:'void'}],['unknown',{status:'writeoff'}],['credits',{credits_applied:1}],['writeoff',{write_off_amount:1}],['date',{date:'2026-10-02'}],['due',{due_date:'2026-10-21'}],['reference',{reference_number:'other'}],['malformed',{payment_made:null}],['unsafe',{total:'9007199254740993'}],
   ...[401,403,404,429,503].map(status=>['http'+status,()=>Response.json({code:status,invoice:{}},{status})]),
   ['oversize',()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}})],['redirect',()=>new Response('{}',{status:302,headers:{location:'https://forbidden.invalid','content-type':'application/json'}})]];
  for(const [name,remote] of cases)await t.test(name,async()=>{
   await f.db.exec('begin;savepoint case_start');f.reset();try{
    f.controls.remote=typeof remote==='function'?remote():remote;const r=await f.run();assert.notEqual(r.status,'sent');assert.deepEqual(f.counts(),{gets:1,posts:0});
    assert.equal(Number((await f.read()).reminder_count),0);assert.equal(Number((await f.read()).amount_paid),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
  await t.test('deadline includes body/auth and cannot retry',async()=>{
   await f.db.exec('begin;savepoint case_start');f.reset();let timer;
   try{f.controls.onGet=()=>new Promise(resolve=>{timer=setTimeout(resolve,5500);});const r=await f.run();assert.notEqual(r.status,'sent');assert.deepEqual(f.counts(),{gets:1,posts:0});}
   finally{clearTimeout(timer);f.reset();await f.db.exec('rollback');}
  });
  await t.test('two-second final permit expiry',async()=>{
   await f.db.exec('begin;savepoint case_start');f.reset();try{f.intercept(async(url,{body})=>{if(url.pathname.endsWith('/rpc/cetld_zoho_bound_reminder')&&JSON.parse(body).p_action==='final')await new Promise(resolve=>setTimeout(resolve,2100));});assert.notEqual((await f.run()).status,'sent');assert.equal(f.counts().posts,0);}
   finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

for(const mode of ['reserve_ack','final_ack','post_unknown','receipt_ack'])test(`durable ${mode} uncertainty cannot redispatch, recover a permit or fabricate a receipt`,async()=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();let lost=false;
  f.controls.afterHttp=async(url,options)=>{
   const body=options?.body&&JSON.parse(options.body),action=body?.p_action;
   if(!lost&&((mode==='reserve_ack'&&action==='reserve')||(mode==='final_ack'&&action==='final')||(mode==='receipt_ack'&&url.pathname.endsWith('/rpc/cetld_core_record_first_party_receipt')))){lost=true;throw Error('offline committed acknowledgement lost');}
  };
  if(mode==='post_unknown')f.controls.onPost=()=>{lost=true;throw Error('offline provider accepted, HTTP acknowledgement lost');};
  const result=await f.run();assert.equal(lost,true);assert.notEqual(result.status,'sent');assert.equal(f.counts().posts,['post_unknown','receipt_ack'].includes(mode)?1:0);
  const count=Number((await f.read()).reminder_count);assert.equal(count,mode==='receipt_ack'?1:0);
  f.controls.afterHttp=null;
  const journal=await sqlValue(f,'select id,state from app.zoho_bound_claims'),core=await sqlValue(f,'select id,status from cetld_core_automation_delivery_claims');
  const recovered=(await rawRpc(f,'recover',core.id)).data;assert.equal(recovered.deliveryAuthority,false);assert.equal('permit' in recovered,false);assert.equal('nonce' in recovered,false);
  const next=await f.run().catch(()=>({status:'blocked'}));assert.notEqual(next.status,'sent');assert.equal(f.counts().gets,1,'no second invoice GET');
  if(['post_unknown','receipt_ack'].includes(mode)){
   await callback(f);await callback(f);assert.equal(Number((await f.read()).reminder_count),1);
   assert.equal((await sqlValue(f,'select state from app.zoho_bound_claims')).state,'accepted');
  }else assert.ok(['cancelled','quarantined'].includes(journal.state));
 }finally{await f.close();}
});

test('actual final SQL independently rejects forged/replayed permits, changed templates and atomic reservation failures',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();
  for(const mode of ['forged','catalog','fault'])await t.test(mode,async()=>{
   await f.db.exec('begin;savepoint case_start');f.reset();try{
    if(mode==='forged'){
     const runtime=f.makeRuntime(),[claim]=await runtime.store.claimDueFollowups({...f.scope,invoiceId:f.row.id,limit:1,now:new Date().toISOString()});
     const r=(await rawRpc(f,'final',claim.id,{attempt:randomUUID(),permit:'f'.repeat(64),snapshot:{},hash:'f'.repeat(64)})).data;
     assert.notEqual(r.authorized,true);assert.deepEqual(f.counts(),{gets:0,posts:0});
    }else{
     if(mode==='catalog')f.intercept(async(url,{body})=>{if(url.pathname.endsWith('/rpc/cetld_zoho_bound_reminder')&&JSON.parse(body).p_action==='final')await f.db.exec('update app.first_party_reminder_templates set approved=false');});
     if(mode==='fault')await f.db.exec("create function app.offline_bound_fault() returns trigger language plpgsql as $$begin raise exception 'offline reservation failure';end$$;create trigger offline_bound_fault after insert on app.first_party_reminder_dispatches for each row execute function app.offline_bound_fault()");
     assert.notEqual((await f.run()).status,'sent');assert.equal(f.counts().posts,0);
    }
    for(const table of ['app.first_party_reminder_dispatches','app.zoho_reminder_transaction_context','app.zoho_bound_claim_write_context'])assert.equal(Number((await sqlValue(f,`select count(*) n from ${table}`)).n),0);
    assert.equal(Number((await f.read()).reminder_count),0);assert.equal(Number((await f.read()).amount_paid),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

test('normal actual OAuth refresh preserves the protected epoch and completes only the same bound attempt',async()=>{
 const f=await createZohoBoundReminderFixture();try{
  const {createAccountingIntegration,createAccountingProviders,createZohoBooksProvider,connectionAad}=await import('../automation/accounting/index.mjs');
  const c=await f.ast.getConnection(f.identity),expired={...f.token,expiresAt:Date.now()-1000};
  await f.ast.replaceConnection({...c,...f.cipher.encrypt(expired,connectionAad('zoho_books',f.ws)),tokenExpiresAt:expired.expiresAt},c.revision);
  const epoch=(await f.ast.zohoOperationContext(f.identity)).epochId;let refreshes=0;
  const adapter=createZohoBooksProvider({clientId:'offline-id',clientSecret:'offline-secret',fetchImpl:async(url,options)=>{
   refreshes++;assert.equal(String(url),'https://accounts.zoho.in/oauth/v2/token');assert.equal(options.method,'POST');return Response.json({access_token:'offline-refreshed',refresh_token:'offline-new-refresh',expires_in:3600,api_domain:f.token.apiDomain});
  }});
  const accounting=createAccountingIntegration({store:f.ast,cipher:f.cipher,providers:{...createAccountingProviders(),zoho_books:adapter}});
  await f.approve();assert.equal((await f.run({accounting})).status,'sent');assert.equal(refreshes,1);assert.equal((await f.ast.zohoOperationContext(f.identity)).epochId,epoch);
  assert.deepEqual(f.counts(),{gets:1,posts:1});
 }finally{await f.close();}
});

test('actual owner dates/delete and existing external financial/test guards remain intact, without rewriting origin',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();const origin=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}'`);
  const row=await f.read();
  const corrected=(await f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,f.row.id,row.updated_at,randomUUID(),{issue_date:'2026-09-30',due_date:'2026-11-01'}])).rows[0].value;
  assert.equal(corrected.ok,true,JSON.stringify(corrected));
  for(const full of [false,true])await assert.rejects(f.db.query('select record_invoice_payment($1,$2,1,$3,$4,$5)',[f.ws,f.row.id,randomUUID(),'offline owner payment',full]),/EXTERNAL_ACCOUNTING/);
  const badMoney=(await f.db.query('select owner_correct_invoice($1,$2,$3,$4,$5) value',[f.ws,f.row.id,(await f.read()).updated_at,randomUUID(),{total_amount:6}])).rows[0].value;assert.equal(badMoney.code,'EXTERNAL_ACCOUNTING');
  await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.notEqual((await f.run()).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:0});
  for(const patch of ["deleted_at=clock_timestamp()","metadata=metadata||'{\"test_invoice\":true}'","due_date='2026-12-01'","amount_paid=1","status='void'"])await assert.rejects(f.db.query(`update invoices set ${patch} where id=$1`,[f.row.id]),/ZOHO_|TEST_INVOICE_|owner lifecycle RPC/);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.owner}'`);
  const act=async(action,p=null)=>(await f.db.query("select invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",[action,f.ws,p?null:f.row.id,p,`dashboard_delete_${randomUUID()}`,`delete-${randomUUID()}`])).rows[0].value;
  const prepared=await act('prepare');assert.equal(prepared.ok,true);assert.equal((await act('confirm',prepared.proposalId)).action,'deleted');
  await f.db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");assert.notEqual((await f.run().catch(()=>({status:'blocked'}))).status,'sent');assert.equal(f.counts().gets,0);
  assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origin);
 }finally{await f.close();}
});

test('guarded migration accepts only exact canonical/audited CRLF chain and preserves OIDs/security/business rows; unknown drift aborts',async t=>{
 for(const crlf of [false,true])await t.test('CRLF='+crlf,async()=>{
  const f=await createZohoBoundReminderFixture({installBridge:false,crlf});try{
   await f.db.exec('set search_path=pg_catalog,public');
   const source=await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
   const before=(await f.db.query("select oid,oid::regprocedure::text sig,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('app'::regnamespace,'public'::regnamespace) order by oid")).rows;
   const row=await f.read(),origins=(await f.db.query('select * from app.zoho_invoice_origins')).rows;
   const variants=[
    ["alter table app.zoho_bound_claims alter column frame drop not null",'journal'],
    ["alter table app.zoho_bound_claims drop constraint zoho_bound_claims_attempt_id_key",'journal'],
    ["alter table app.zoho_invoice_origins alter column reference drop not null",'protection'],
    ["alter table invoices disable trigger zoho_claim_invoice_changed",'trigger'],
    ["alter table cetld_accounting_connections disable trigger accounting_connection_epoch",'trigger'],
    ["grant execute on function app.zoho_bound_claim_frame(uuid,uuid,uuid) to authenticated",'ACL'],
    ["create role unexpected_bridge_grantee;alter default privileges in schema app grant execute on functions to unexpected_bridge_grantee",'ACL'],
   ];
   for(const [drift,expected] of variants){
    await f.db.exec('begin');await f.db.exec(drift);
    await assert.rejects(f.db.exec(source),new RegExp(expected+'|drift'));await f.db.exec('rollback');
    assert.equal((await sqlValue(f,"select to_regclass('app.zoho_reminder_core_bindings') value")).value,null);
   }
   const changed=before.find(x=>x.sig.startsWith('app.evaluate_reviewed_reminder('));
   await f.db.exec('begin');await f.db.exec(changed.d.replace('begin','begin /* unknown */'));
   await assert.rejects(f.db.exec(source),/drift/);await f.db.exec('rollback');
   const coreSource=before.find(x=>x.sig.startsWith('cetld_core_authorize_delivery('));
   const body=(await sqlValue(f,'select prosrc from pg_proc where oid=$1',[coreSource.oid])).prosrc;
   await f.db.exec('begin');await f.db.exec(coreSource.d.replace(body,()=>body.replace(crlf?'\r\n':'\n',crlf?'\n':'\r\n')));
   await assert.rejects(f.db.exec(source),/drift/);await f.db.exec('rollback');
   await f.db.exec(source);
   const after=(await f.db.query("select oid,oid::regprocedure::text sig,pg_get_functiondef(oid) d,to_jsonb(p)-'prosrc' security from pg_proc p where pronamespace in ('app'::regnamespace,'public'::regnamespace) order by oid")).rows;
   const changedNames=['cetld_zoho_capture_completion_protocol(','app.zoho_bound_claim_protocol(','app.invalidate_zoho_bound_claims(','app.owner_assistant_reminder(','cetld_core_record_first_party_receipt('];
   for(const old of before){const current=after.find(x=>x.oid===old.oid);assert.ok(current);assert.deepEqual(current.security,old.security,old.sig);if(!changedNames.some(n=>old.sig.startsWith(n)))assert.equal(current.d,old.d,old.sig);}
   assert.deepEqual(await f.read(),row);assert.deepEqual((await f.db.query('select * from app.zoho_invoice_origins')).rows,origins);
   for(const name of ['cetld_core_claim_due_followups','cetld_core_authorize_delivery']){
    const old=before.find(x=>x.sig.startsWith(name+'(')),current=after.find(x=>x.oid===old.oid);assert.equal(current.d,old.d);if(crlf)assert.equal(current.d.split('\r\n').length-1,31);
   }
  }finally{await f.close();}
 });
});

test('real final RPC rejects each independently forged snapshot even with a genuine fresh candidate',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();const {reminderFingerprint}=await import('../automation/whatsapp/reminder-fingerprint.mjs');
  const cases={version:s=>s.invoiceVersion=Number(s.invoiceVersion)+1,updated:s=>s.invoiceUpdatedAt='2000-01-01T00:00:00Z',preferences:s=>s.preferencesUpdatedAt='2000-01-01T00:00:00Z',
   customer:s=>s.customerId=randomUUID(),invoice:s=>s.invoiceId=randomUUID(),phone:s=>s.phone='+15550002222',consent:s=>s.consentId=randomUUID(),consentTime:s=>s.consentCreatedAt='2000-01-01T00:00:00Z',
   words:s=>s.body='Forged words',parameters:s=>s.template.parameters[3]='USD 1.00',template:s=>s.template.revision='forged',templateBody:s=>s.template.body='Forged template',
   hash:s=>{},waba:s=>s.template.wabaId='999999999',draft:s=>s.defaultDraft='Forged default draft',freeform:s=>s.delivery={type:'freeform',body:s.body},extra:s=>s.currentAccountId='90001'};
  for(const [name,mutate] of Object.entries(cases))await t.test(name,async()=>{
   await f.db.exec('begin');f.reset();let tampered=false;try{
    f.controls.beforeHttp=(url,options)=>{if(url.pathname.endsWith('/rpc/cetld_zoho_bound_reminder')){const b=JSON.parse(options.body);if(b.p_action==='final'){mutate(b.p_payload.snapshot);b.p_payload.hash=name==='hash'?'f'.repeat(64):reminderFingerprint(b.p_payload.snapshot);tampered=true;return {...options,body:JSON.stringify(b)};}}};
    const r=await f.run();assert.notEqual(r.status,'sent');assert.equal(tampered,true);assert.deepEqual(f.counts(),{gets:1,posts:0});
    assert.equal(Number((await sqlValue(f,'select count(*) n from app.first_party_reminder_dispatches')).n),0);assert.equal(Number((await f.read()).reminder_count),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
  await t.test('slow final SQL rolls back the consumed permit and reservation',async()=>{
   await f.db.exec('begin');f.reset();try{
    await f.db.exec("create function app.offline_slow_final() returns trigger language plpgsql as $$begin perform pg_sleep(2.1);return new;end$$;create trigger offline_slow_final after insert on app.first_party_reminder_dispatches for each row execute function app.offline_slow_final()");
    assert.notEqual((await f.run()).status,'sent');assert.equal(f.counts().posts,0);assert.equal(Number((await sqlValue(f,'select count(*) n from app.first_party_reminder_dispatches')).n),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
  await t.test('late final HTTP response cannot authorize POST after the monotonic deadline',async()=>{
   await f.db.exec('begin');f.reset();try{
    f.controls.afterHttp=async(url,options)=>{if(url.pathname.endsWith('/rpc/cetld_zoho_bound_reminder')&&JSON.parse(options.body).p_action==='final')await new Promise(resolve=>setTimeout(resolve,2100));};
    assert.notEqual((await f.run()).status,'sent');assert.equal(f.counts().posts,0);assert.equal(Number((await sqlValue(f,'select count(*) n from app.first_party_reminder_dispatches')).n),1);
    assert.equal((await sqlValue(f,'select state from app.zoho_bound_claims')).state,'quarantined');
   }finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

for(const installedShape of [false,true])test(`local-only confirmation, native payment/final gate, counter and receipt remain functional under the complete migration (installedShape=${installedShape})`,async()=>{
 const f=await createZohoBoundReminderFixture({installedShape});try{
  const originId=f.row.id,local=(await f.db.query("insert into invoices(workspace_id,customer_id,customer_phone,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,'LOCAL-PROOF','2026-10-01','2026-10-20','USD',5,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[f.ws,f.cust,f.customerPhone])).rows[0].id;
  f.row.id=local;
  await f.approve();assert.equal((await f.run()).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:1});assert.equal(Number((await f.read()).reminder_count),1);
  assert.ok(new Date((await f.read()).next_follow_up_at)>Date.now()+86400000,'versionless local cadence is null-safe');
  assert.equal(Number((await sqlValue(f,'select count(*) n from app.zoho_reminder_core_bindings')).n),0);
  assert.equal(Number((await sqlValue(f,'select count(*) n from app.zoho_bound_claims')).n),0);
  assert.equal((await callback(f)).statusCode,200);assert.equal(Number((await f.read()).reminder_count),1);
  assert.equal(Number((await sqlValue(f,'select count(*) n from app.zoho_invoice_origins where invoice_id=$1',[originId])).n),1);
 }finally{await f.close();}
});

test('unmapped foundation journals and existing in-flight public claims cannot be promoted or retried',async t=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();
  for(const mode of ['foundation','inflight'])await t.test(mode,async()=>{
   await f.db.exec('begin');f.reset();try{
    if(mode==='foundation')assert.equal((await sqlValue(f,"select app.zoho_bound_claim_protocol($1,$2,$3,'claim') value",[f.owner,f.ws,f.row.id])).value.state,'claimed');
    else await f.db.query("insert into cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until) select workspace_id,id,next_follow_up_at,automation_version,(select updated_at from workspace_settings where workspace_id=invoices.workspace_id),'claimed',clock_timestamp()+interval '2 minutes' from invoices where id=$1",[f.row.id]);
    assert.notEqual((await f.run().catch(()=>({status:'blocked'}))).status,'sent');assert.deepEqual(f.counts(),{gets:0,posts:0});
    assert.equal(Number((await sqlValue(f,'select count(*) n from app.zoho_reminder_core_bindings')).n),0);
   }finally{f.reset();await f.db.exec('rollback');}
  });
 }finally{await f.close();}
});

test('linked v2/freeform/fallback approvals remain explicitly unavailable before any candidate read or claim',async()=>{
 const f=await createZohoBoundReminderFixture();try{
  f.controls.beforeHttp=(url,options)=>{if(url.pathname.endsWith('/rpc/whatsapp_owner_reminder')){const b=JSON.parse(options.body);if(b.p_action==='prepare'){b.p_template.reviewedDelivery={version:2,type:'template',body:b.p_preview};return {...options,body:JSON.stringify(b)};}}};
  const result=await (await f.rt('send reminder')).execute({operation:'sendReminderNow',filters:[{column:'id',operator:'eq',value:f.row.id}]});
  assert.equal(result.ok,false);assert.equal(result.code,'external_accounting_required');assert.deepEqual(f.counts(),{gets:0,posts:0});
  for(const table of ['whatsapp_pending_actions','cetld_core_automation_delivery_claims','app.zoho_bound_claims'])assert.equal(Number((await sqlValue(f,`select count(*) n from ${table}`)).n),0);
 }finally{await f.close();}
});

test('signed historical callback after unknown POST, STOP and account switch audits only its reserved attempt and never resumes sending',async()=>{
 const f=await createZohoBoundReminderFixture();try{
  await f.approve();f.controls.onPost=()=>{throw Error('offline accepted POST acknowledgement lost');};
  assert.equal((await f.run()).status,'quarantined');assert.deepEqual(f.counts(),{gets:1,posts:1});
  await f.ast.setOrganization(f.identity,{id:'90002',name:'Offline different account'});
  await f.db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,'stop')",[f.ws,f.customerPhone]);
  const paused=await f.read();assert.equal(paused.followup_state,'paused');
  await callback(f,{token:'a'.repeat(64)});await callback(f,{waba:'999999999'});assert.equal(Number((await f.read()).reminder_count),0);
  assert.equal((await callback(f)).statusCode,200);await callback(f);assert.equal(Number((await f.read()).reminder_count),1);
  assert.equal((await f.read()).followup_state,'paused');assert.equal((await f.read()).next_follow_up_at,null);
  assert.equal((await f.ast.getConnection(f.identity)).providerAccountId,'90002');assert.notEqual((await f.run()).status,'sent');assert.deepEqual(f.counts(),{gets:1,posts:1});
 }finally{await f.close();}
});
