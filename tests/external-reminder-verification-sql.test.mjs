import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {approveReviewedReminder} from './fixtures/reviewed-reminder.mjs';
import {applyNoFooterMigration} from './fixtures/no-footer-reminders.mjs';
import {createOwnerReminderRuntime} from '../automation/whatsapp/owner-reminders.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAccountingIntegration} from '../automation/accounting/integration.mjs';
import {createAccountingProviders} from '../automation/accounting/providers.mjs';
import {externalReminderRead} from '../automation/external-reminder-verification.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {selectInvoiceReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {buildInvoiceReminderParameters,buildDefaultInvoiceReminderDraft} from '../automation/whatsapp/reminder-parameters.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';

const migration=()=>readFile(new URL('../supabase/migrations/20261024094013_fresh_external_reminder_reads.sql',import.meta.url),'utf8');
const overdueMigration='20261024124500_unlinked_overdue_reminder_eligibility.sql';
const containmentMigration='20261026090000_contain_unproven_external_reminders.sql';
for(const fullReview of [false,true])test(`linked reminder provenance containment through executable SQL (full review: ${fullReview})`,async t=>{
 const sends=[];let remoteStatus='sent',qboStatus=undefined,remoteBalance=125,remoteTotal=125,unreachable=false,stalled=false,missingCredentials=false,reads=0;
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261024094013_fresh_external_reminder_reads.sql',overdueMigration,containmentMigration],externalFetch:async(url,options)=>{
   assert.equal(url.origin,'https://graph.facebook.com');sends.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.external.'+sends.length}]});
 }}),{db,supabase}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  if(fullReview)for(const file of ['20261023083356_per_message_reminder_review.sql','20261023164251_exact_reminder_approval_artifact.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const protections=()=>db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in
   ('owner_assistant_reminder_template_gate','owner_assistant_reminder','whatsapp_owner_reminder','cetld_core_authorize_first_party_reminder','record_invoice_payment',
    'guard_external_invoice_local_payment','guard_external_invoice_owner_update','cetld_core_claim_due_followups',
    'cetld_core_authorize_delivery','cetld_core_quarantine_first_party_leases','cetld_core_record_first_party_receipt') order by n.nspname,p.proname`);
  const originalProtections=(await protections()).rows;
  await db.exec(await migration());
  const statusOnlyPatch=row=>({...row,definition:['owner_assistant_reminder_template_gate','owner_assistant_reminder','whatsapp_owner_reminder'].includes(row.proname)?
    row.definition.replaceAll("i.status::text<>'sent'",'not app.reminder_local_status_payable(i)'):
    row.proname==='cetld_core_authorize_first_party_reminder'?
    row.definition.replaceAll("i.status<>'sent'",'not app.reminder_local_status_payable(i)'):
    row.proname==='cetld_core_record_first_party_receipt'?
    row.definition.replaceAll("i.status='sent'",'app.reminder_local_status_payable(i)'):row.definition});
  assert.deepEqual((await protections()).rows,originalProtections.map(statusOnlyPatch),'original bodies and ACLs unchanged except the exact scoped status predicates');
  const beforeOverdue=(await protections()).rows;
  const businessProtections=()=>db.query(`select p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl
   from pg_proc p where p.proname in ('business_name_reminder_pause_count','invalidate_core_followup_approvals') order by p.proname`);
  const beforeBusiness=(await businessProtections()).rows;
  const helperAcl=(await db.query("select proacl::text acl from pg_proc where oid='app.reminder_local_status_payable(public.invoices)'::regprocedure")).rows[0];
  await db.exec(await readFile(new URL('../supabase/migrations/'+overdueMigration,import.meta.url),'utf8'));
  assert.deepEqual((await protections()).rows,beforeOverdue,'all installed queue/authorization/receipt wrappers and protected bodies/ACLs stay identical');
  assert.deepEqual((await businessProtections()).rows,beforeBusiness.map(row=>({...row,definition:row.definition.replaceAll("status='sent'","status in ('sent','overdue')")})));
  assert.deepEqual((await db.query("select proacl::text acl from pg_proc where oid='app.reminder_local_status_payable(public.invoices)'::regprocedure")).rows[0],helperAcl);
  await db.exec(await readFile(new URL('../supabase/migrations/'+containmentMigration,import.meta.url),'utf8'));
  const ownerId=randomUUID(),phone='+12025550107',recipient='+919871367051';
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (create_workspace('External fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'External client',$2) returning id",[workspaceId,recipient])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture',array['invoice_updates'])",[workspaceId,customerId,recipient]);
  await db.query("update workspace_settings set default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,{tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3,firstReminderDays:0}]);
  await db.exec('set role service_role');
  const scope={ownerId,workspaceId,phone};
  const connection={status:'connected',providerAccountId:'fixture-org'};
  const accounting=createAccountingIntegration({store:{async getConnection(){return connection;}},
   cipher:{decrypt(){if(missingCredentials)return null;return {accessToken:'fixture',refreshToken:'fixture',expiresAt:Date.now()+3600000,apiDomain:'https://www.zohoapis.in'};}},
   providers:createAccountingProviders({zoho_books:{fetchImpl:async(url,options)=>{
    reads++;assert.equal(options.method||'GET','GET');assert.match(new URL(url).pathname,/^\/books\/v3\/invoices\/remote-/);
    if(unreachable)throw Error('Offline provider');
    if(stalled)await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('Aborted provider read')),{once:true}));
    return Response.json({invoice:{invoice_id:new URL(url).pathname.split('/').at(-1),status:remoteStatus,total:remoteTotal,balance:remoteBalance,currency_code:'USD'}});
   }},quickbooks:{fetchImpl:async(url,options)=>{
    reads++;assert.equal(options.method||'GET','GET');const path=new URL(url).pathname;assert.match(path,/^\/v3\/company\/fixture-org\/invoice\/remote-/);
    return Response.json({Invoice:{Id:path.split('/').at(-1),TotalAmt:remoteTotal,Balance:remoteBalance,CurrencyRef:{value:'USD'},EmailStatus:'NotSet',...(qboStatus===undefined?{}:{invoiceStatus:qboStatus})}});
   }}})});
  const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',
   AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:recipient,
   WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const automation=createAutomationRuntime({env,store,supabase,accounting,fetchImpl:f.fetchImpl});
  const invoice=async(provider='zoho_books')=>{
   // Keep each case's target inside the scheduler's bounded batch even after
   // earlier cases deliberately quarantine their own claims. Fixture-only cleanup.
   await db.query("update invoices set followup_state='paused',next_follow_up_at=null where workspace_id=$1 and deleted_at is null",[workspaceId]);
   // A refused confirmation remains pending until explicitly canceled. Isolate
   // later cases from that separate pending-action guard.
   await db.query('update whatsapp_pending_actions set consumed_at=now() where workspace_id=$1 and consumed_at is null',[workspaceId]);
   const remoteId='remote-'+randomUUID();return (await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,external_provider,external_invoice_id,metadata)
   values($1,$2,$3,current_date-2,current_date-1,'USD',125,'sent',$4,$5,$6) returning *`,[workspaceId,customerId,'EXT-'+randomUUID().slice(0,6),provider==='tally'?null:provider,provider?remoteId:null,{invoice_direction:'receivable',...(provider?{accounting_provider:provider,bookkeeping_record_id:remoteId}:{})}])).rows[0];};
  let seq=0;
  const runtime=async(message)=>{
   const messageId='external-reminder-'+(++seq);
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
   return createOwnerReminderRuntime({supabase,scope,message,messageId,authorize:async()=>true,accounting,env,fetchImpl:f.fetchImpl});
  };
  const prepare=async i=>(await runtime('send reminder')).execute({operation:'sendReminderNow',filters:[{column:'id',operator:'eq',value:i.id}]});
  const confirm=async()=>{
   const pending=(await db.query("select * from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null order by generation desc limit 1",[workspaceId])).rows[0];
   return (await runtime('yes')).decide({pending,decision:'confirm'});
  };
  const resetRemote=()=>{remoteStatus='sent';qboStatus=undefined;remoteBalance=125;remoteTotal=125;unreachable=false;stalled=false;missingCredentials=false;connection.status='connected';};
  const check=async i=>(await db.query('select cetld_core_check_local_reminder_payment($1,$2,$3) value',[ownerId,workspaceId,i.id])).rows[0].value;
  for(const status of ['sent','overdue'])await t.test(`unlinked ${status} queues, revalidates approval and dispatches without provider reads`,async()=>{
   let i=await invoice(null);i=(await db.query('update invoices set status=$2 where id=$1 returning *',[i.id,status])).rows[0];
   const before=reads,count=sends.length;assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   const result=await automation.tick(scope);assert.equal(result.results[0]?.status,'sent',JSON.stringify({result,errors:f.errors}));assert.equal(reads,before);
   assert.equal(sends.length,count+1);
   const saved=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   assert.equal(saved.status,status);assert.equal(saved.reminder_count,1);assert.ok(new Date(saved.next_follow_up_at)>new Date());
  });
  const mutate=async(i,scenario)=>{
   if(scenario==='deleted'){
    await db.exec('reset role;begin');
    await db.query('insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id) values(pg_backend_pid(),txid_current(),$1)',[i.id]);
    await db.query('update invoices set deleted_at=now(),deleted_by=$2 where id=$1',[i.id,ownerId]);
    await db.exec('delete from app.invoice_lifecycle_write_context;commit;set role service_role');
   }else if(scenario==='non-receivable')await db.query("update invoices set metadata=jsonb_set(metadata,'{invoice_direction}','\"payable\"') where id=$1",[i.id]);
   else if(scenario==='zero')await db.query('update invoices set total_amount=0 where id=$1',[i.id]);
   else if(scenario==='fully-paid')await db.query('update invoices set amount_paid=total_amount where id=$1',[i.id]);
   else await db.query('update invoices set status=$2 where id=$1',[i.id,scenario]);
  };
  for(const scenario of ['paid','void','cancelled','draft','deleted','non-receivable','zero','fully-paid'])
   for(const stage of ['queue','approval','dispatch'])await t.test(`unlinked overdue still refuses ${scenario} at ${stage}`,async()=>{
    let i=await invoice(null);i=(await db.query("update invoices set status='overdue' where id=$1 returning *",[i.id])).rows[0];
    const before=reads,count=sends.length;
    if(stage==='queue'){
     await mutate(i,scenario);assert.notEqual((await prepare(i)).ok,true);
    }else if(stage==='approval'){
     assert.equal((await prepare(i)).ok,true);await mutate(i,scenario);assert.notEqual((await confirm()).completed,true);
    }else{
     assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
     f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await mutate(i,scenario);});
     try{await automation.tick(scope);}finally{f.intercept(null);}
    }
    assert.equal(sends.length,count);assert.equal(reads,before);
   });
  await t.test('a sent invoice edited overdue needs fresh approval, then signed receipts continue and can pause its chain',async()=>{
   const i=await invoice(null),before=reads;
   assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   assert.equal((await automation.tick(scope)).results.find(r=>r.invoiceId===i.id)?.status,'sent');
   await db.query("update invoices set status='overdue' where id=$1",[i.id]);
   const edited=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   assert.equal(edited.next_follow_up_at,null);assert.equal(edited.followup_state,'draft');
   assert.equal(edited.metadata.approved_reminder_text,undefined);
   const receipt=async(token,messageId,status)=>(await supabase.rpc('cetld_core_record_first_party_receipt',{
    p_callback_token:token,p_waba_id:env.WHATSAPP_WABA_ID,p_phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID,
    p_phone:recipient,p_message_id:messageId,p_status:status})).data;
   // A delayed receipt for the pre-edit snapshot must not restore the old approval.
   const previous=sends.at(-1);
   assert.equal((await receipt(previous.biz_opaque_callback_data,'wamid.external.'+sends.length,'delivered')).ok,true);
   assert.deepEqual((await db.query('select * from invoices where id=$1',[i.id])).rows[0],edited);
   assert.equal((await prepare(edited)).ok,true);assert.equal((await confirm()).completed,true);
   // Reserve/send without the engine's count write, so the signed receipt must
   // exercise its own continuation predicate rather than reuse engine cadence.
   const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   assert.equal(claim.invoice_id??claim.invoiceId,i.id);
   const settings=await store.getWorkspacePreferences(scope);
   assert.equal((await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at})).authorized,true);
   const provider=createApprovedReminderProvider({env,supabase,store,...scope,fetchImpl:f.fetchImpl});
   const input={workspaceId,invoiceId:i.id,customerId,to:recipient,idempotencyKey:`reminder:${workspaceId}:${claim.id}`};
   input.body=(await provider.prepareReminder(input)).body;
   const sent=await provider.sendReminder(input);assert.equal(sent.status,'accepted',JSON.stringify({sent,errors:f.errors}));
   assert.equal((await receipt(sent.callbackToken,sent.providerMessageId,'delivered')).ok,true);
   const continued=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   assert.equal(continued.status,'overdue');assert.equal(continued.reminder_count,2);
   assert.ok(new Date(continued.next_follow_up_at)>new Date(),'signed overdue receipt advances cadence');
   // A late signed failure applies to the exact reconciled overdue dispatch.
   assert.equal((await receipt(sent.callbackToken,sent.providerMessageId,'failed')).ok,true);
   // Delivered is conclusive and wins over failure. Test the failure branch on
   // a separate accepted dispatch before any delivered/read receipt.
   let failure=await invoice(null);failure=(await db.query("update invoices set status='overdue' where id=$1 returning *",[failure.id])).rows[0];
   assert.equal((await prepare(failure)).ok,true);assert.equal((await confirm()).completed,true);
   assert.equal((await automation.tick(scope)).results.find(r=>r.invoiceId===failure.id)?.status,'sent');
   const last=sends.at(-1);assert.equal((await receipt(last.biz_opaque_callback_data,'wamid.external.'+sends.length,'failed')).ok,true);
   const paused=(await db.query('select * from invoices where id=$1',[failure.id])).rows[0];
   assert.equal(paused.status,'overdue');assert.equal(paused.followup_state,'paused');assert.equal(paused.next_follow_up_at,null);
   assert.equal(reads,before);
  });
  // These formerly permissive status/fact matrices now deliberately prove
  // containment: matching facts in any current account cannot establish origin.
  for(const provider of ['zoho_books','quickbooks'])
   for(const localStatus of ['sent','overdue'])
    for(const remoteState of provider==='zoho_books'?['sent','overdue','partially_paid','paid','void','voided','draft','viewed','unpaid','mystery','',null]:
      ['DUE_VIEWED','DUE_NOT_SENT','DUE_SENT','OVERDUE_VIEWED','OVERDUE_NOT_SENT','OVERDUE_SENT','PARTIALLY_PAID','VOIDED','REVERSED','PAID','PAID_NOT_DEPOSITED','DEPOSITED','UNKNOWN','DUE_BOGUS','unpaid','',null])
   await t.test(`${provider} ${JSON.stringify(remoteState)} / local ${localStatus} cannot queue, approve or dispatch`,async()=>{
    resetRemote();remoteStatus=remoteState;qboStatus=remoteState;
    let i=await invoice(provider);i=(await db.query('update invoices set status=$2 where id=$1 returning *',[i.id,localStatus])).rows[0];
    const before=reads,count=sends.length;
    assert.equal((await prepare(i)).code,'external_accounting_required');
    assert.equal((await check(i)).ok,false);
    assert.deepEqual((await db.query('select * from invoices where id=$1',[i.id])).rows[0],i);
    // Simulate a pre-containment approval only inside this disposable fixture.
    await db.exec('reset role');await approveReviewedReminder(db,{workspaceId,invoiceId:i.id});await db.exec('set role service_role');
    assert.equal((await store.claimDueFollowups({...scope,now:new Date().toISOString(),invoiceId:i.id,limit:1})).length,0);
    await automation.tick({...scope,invoiceId:i.id});
    assert.equal(reads,before);assert.equal(sends.length,count);
    assert.equal((await db.query('select count(*)::int n from cetld_core_automation_delivery_claims where invoice_id=$1',[i.id])).rows[0].n,0);
   });
  for(const scenario of ['same-facts','org-switched','switch-during-read','paid','error','timeout','credentials','amount','status','unsupported','unconnected'])await t.test(scenario+' is unavailable before provider access',async()=>{
   resetRemote();const i=await invoice(scenario==='unsupported'?'tally':'zoho_books');
   if(scenario==='paid'){remoteStatus='paid';remoteBalance=0;}
   if(scenario==='error')unreachable=true;
   if(scenario==='timeout')stalled=true;
   if(scenario==='credentials')missingCredentials=true;
   if(scenario==='amount')remoteTotal=126;
   if(scenario==='status')remoteStatus='void';
   if(scenario==='unconnected')connection.status='disconnected';
   if(scenario==='org-switched')connection.providerAccountId='another-org';
   const before=reads,count=sends.length;
   assert.equal((await prepare(i)).code,'external_accounting_required');assert.equal((await check(i)).ok,false);
   assert.deepEqual((await db.query('select * from invoices where id=$1',[i.id])).rows[0],i);
   assert.equal(reads,before);assert.equal(sends.length,count);
  });
  await t.test('crafted legacy evidence, forged account metadata and diagnostics cannot bypass independent SQL gates',async()=>{
   resetRemote();let i=await invoice();
   i=(await db.query(`update invoices set metadata=metadata||$2::jsonb where id=$1 returning *`,[i.id,{provider_account_id:'fixture-org',provenance:'verified',provider_account_binding:{immutable:true,accountId:'fixture-org'}}])).rows[0];
   const old={ownerId,workspaceId,invoiceId:i.id,provider:i.external_provider,externalId:i.external_invoice_id,startedAt:new Date().toISOString(),
    invoiceVersion:String(i.automation_version),invoiceUpdatedAt:i.updated_at,status:i.status,currency:i.currency,total:'125',paid:'0',
    linkage:[i.external_provider,i.external_invoice_id,i.metadata.accounting_provider,i.metadata.bookkeeping_record_id]};
   const evidence=[old,{...old,currentAccountId:'fixture-org',verified:true,immutable:true},null,[],{},'malformed',
    {workspaceId,invoiceId:i.id,provider:i.external_provider,currentAccountId:'fixture-org',exactId:i.external_invoice_id,checkedAt:new Date().toISOString(),existence:'present',provenance:'provenance_unverified',status:'sent',currency:'USD',totalMinor:12500,balanceMinor:12500,paidMinor:0}];
   for(const e of evidence){
    const result=await supabase.rpc('cetld_core_check_local_reminder_payment_with_external_read',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:i.id,p_external_read:e});
    if(typeof e==='string')assert.equal(result.error?.code,'22P02');else assert.equal(result.error,null);
    assert.notEqual(result.data?.ok,true);
   }
   assert.equal((await check(i)).ok,false,'unwrapped RPC stays fail closed');
   await db.exec('reset role');
   for(const apply of [false,true]){
    const direct=(await db.query("select app.owner_assistant_reminder($1,$2,$3,true,'fixture','fixture','{}'::jsonb,'{}'::jsonb,$4) value",[workspaceId,ownerId,i.id,apply])).rows[0].value;
    assert.equal(direct.ok,false,'private owner prepare/apply variants cannot approve linked rows');
   }
   assert.deepEqual((await db.query('select * from invoices where id=$1',[i.id])).rows[0],i);
   await db.exec('reset role');const delivery=await approveReviewedReminder(db,{workspaceId,invoiceId:i.id});
   i=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   const settings=(await db.query('select * from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
   const claim=(await db.query(`insert into cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
     values($1,$2,now()-interval '1 minute',$3,$4,'claimed',now()+interval '2 minutes') returning *`,[workspaceId,i.id,i.automation_version,settings.updated_at])).rows[0];
   await db.exec('set role service_role');
   const gate=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at});
   assert.equal(gate.authorized,false);
   assert.deepEqual((await db.query('select * from cetld_core_automation_delivery_claims where id=$1',[claim.id])).rows[0],claim);
   // Simulate an old worker that already obtained generic authorization, using
   // complete matching facts rather than relying on a malformed snapshot denial.
   await db.query("update cetld_core_automation_delivery_claims set status='sending',delivery_token=$2 where id=$1",[claim.id,randomUUID()]);
   const customer=(await db.query('select * from customers where id=$1',[customerId])).rows[0];
   const consent=(await db.query('select * from whatsapp_consents where workspace_id=$1 and customer_id=$2',[workspaceId,customerId])).rows[0];
   const entry=selectInvoiceReminderTemplate(settings.follow_up_preferences,customer.reminder_tone??null);
   const normalized={...i,due_date:new Date(i.due_date).toISOString().slice(0,10)};
   const parameters=buildInvoiceReminderParameters({invoice:normalized,settings,customer});
   const snapshot={invoiceId:i.id,customerId,phone:recipient,body:delivery.body,delivery,
    invoiceVersion:String(i.automation_version),invoiceUpdatedAt:i.updated_at,preferencesUpdatedAt:settings.updated_at,
    consentId:consent.id,consentCreatedAt:consent.created_at,
    template:{name:entry.name,language:entry.language,body:entry.body,revision:entry.revision,wabaId:env.WHATSAPP_WABA_ID,phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,parameters},
    ...(entry.parameterCount===5?{defaultDraft:buildDefaultInvoiceReminderDraft({invoice:normalized,settings,customer})}:{})};
   const currentEvidence={...old,invoiceVersion:String(i.automation_version),invoiceUpdatedAt:i.updated_at,startedAt:new Date().toISOString()};
   for(const e of [currentEvidence,...evidence]){
    const final=await supabase.rpc('cetld_core_authorize_first_party_reminder_with_external_read',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claim.id,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot),p_external_read:e});
    assert.notEqual(final.data?.authorized,true);
   }
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
   await assert.rejects(db.query('select cetld_core_check_local_reminder_payment_with_external_read($1,$2,$3,$4)',[ownerId,workspaceId,i.id,old]),/permission denied/);
   await assert.rejects(db.query("select record_invoice_payment($1,$2,1,'local','fixture',false)",[workspaceId,i.id]),/EXTERNAL_ACCOUNTING/);
  });
 }finally{await f.close();}
});

test('unsupported provenance refuses even before timeout or credential preparation',async()=>{
 const invoice={id:randomUUID(),external_provider:'zoho_books',external_invoice_id:'remote-id',metadata:{},currency:'USD',total_amount:125,amount_paid:0,status:'sent'};
 await assert.rejects(externalReminderRead({invoice,ownerId:randomUUID(),workspaceId:randomUUID(),accounting:{reminderInvoiceState:()=>new Promise(()=>{})},timeoutMs:10}),/provenance is unsupported/);
 await assert.rejects(externalReminderRead({invoice,ownerId:randomUUID(),workspaceId:randomUUID(),env:{}}));
});
