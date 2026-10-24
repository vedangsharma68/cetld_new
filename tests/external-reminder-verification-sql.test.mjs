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

const migration=()=>readFile(new URL('../supabase/migrations/20261024094013_fresh_external_reminder_reads.sql',import.meta.url),'utf8');
const overdueMigration='20261024124500_unlinked_overdue_reminder_eligibility.sql';
for(const fullReview of [false,true])test(`linked reminder live reads fail closed through executable SQL (full review: ${fullReview})`,async t=>{
 const sends=[];let remoteStatus='sent',qboStatus=undefined,remoteBalance=125,remoteTotal=125,unreachable=false,stalled=false,missingCredentials=false,reads=0;
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261024094013_fresh_external_reminder_reads.sql',overdueMigration],externalFetch:async(url,options)=>{
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
  for(const localStatus of ['sent','overdue'])for(const remoteState of ['sent','overdue','partially_paid'])
   await t.test(`Zoho concrete ${remoteState} with local ${localStatus} queues and dispatches`,async()=>{
    resetRemote();remoteStatus=remoteState;const paid=remoteState==='partially_paid'?25:0;remoteBalance=125-paid;
    let i=await invoice();i=(await db.query('update invoices set status=$2,amount_paid=$3 where id=$1 returning *',[i.id,localStatus,paid])).rows[0];
    if(paid)await db.query(`insert into payments(workspace_id,invoice_id,amount,external_provider,external_payment_id,metadata)
      values($1,$2,$3,'zoho_books',$4,$5)`,[workspaceId,i.id,paid,randomUUID(),{external_invoice_id:i.external_invoice_id}]);
    const before=reads,count=sends.length;
    assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
    const result=await automation.tick(scope);assert.equal(sends.length,count+1,JSON.stringify({result,errors:f.errors}));
    assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'sent');assert.equal(reads,before+4);
    const saved=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
    assert.equal(saved.status,localStatus);assert.equal(Number(saved.amount_paid),paid);assert.equal(saved.reminder_count,1);
    assert.ok(new Date(saved.next_follow_up_at)>new Date(),'overdue receipts advance cadence too');
   });
  for(const remoteState of ['paid','void','voided','draft','viewed','unpaid','mystery','',null])
   await t.test(`Zoho ${JSON.stringify(remoteState)} refuses queue and final dispatch`,async()=>{
    resetRemote();const i=await invoice();remoteStatus=remoteState;
    assert.equal((await prepare(i)).code,'external_accounting_required');
    remoteStatus='sent';assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
    const before=reads,count=sends.length;
    f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_delivery'))remoteStatus=remoteState;});
    try{await automation.tick(scope);}finally{f.intercept(null);}
    assert.equal(sends.length,count);assert.equal(reads,before+2);
   });
  await t.test('terminal and draft statuses refuse linked and unlinked queue and dispatch',async()=>{
   resetRemote();
   for(const provider of ['zoho_books',null])for(const status of ['draft','paid','void','cancelled']){
    let i=await invoice(provider);i=(await db.query('update invoices set status=$2 where id=$1 returning *',[i.id,status])).rows[0];
    const before=reads;assert.equal((await prepare(i)).code,'ineligible_invoice');assert.equal(reads,before);
    await db.exec('reset role');await approveReviewedReminder(db,{workspaceId,invoiceId:i.id});await db.exec('set role service_role');
    const count=sends.length;await automation.tick(scope);assert.equal(sends.length,count);assert.equal(reads,before);
   }
  });
  for(const scenario of ['paid','error','timeout','credentials','amount','status','unsupported','unconnected'])await t.test(scenario+' blocks queue without mutations',async()=>{
   resetRemote();const i=await invoice(scenario==='unsupported'?'tally':'zoho_books');
   if(scenario==='paid'){remoteStatus='paid';remoteBalance=0;}
   if(scenario==='error')unreachable=true;
   if(scenario==='timeout')stalled=true;
   if(scenario==='credentials')missingCredentials=true;
   if(scenario==='amount')remoteTotal=126;
   if(scenario==='status')remoteStatus='void';
   if(scenario==='unconnected')connection.status='disconnected';
   assert.equal((await prepare(i)).code,'external_accounting_required');assert.equal((await check(i)).ok,false);
   assert.deepEqual((await db.query('select * from invoices where id=$1',[i.id])).rows[0],i);
  });
  await t.test('unsupported linkage cannot dispatch even with an existing reviewed approval',async()=>{
   resetRemote();const i=await invoice('tally'),before=reads,count=sends.length;
   await db.exec('reset role');await approveReviewedReminder(db,{workspaceId,invoiceId:i.id});await db.exec('set role service_role');
   const result=await automation.tick(scope);assert.equal(sends.length,count);assert.equal(reads,before);
   assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'quarantined');
  });
  for(const scenario of ['paid','error','amount','status','pass'])await t.test(scenario+' independently verified at dispatch',async()=>{
   resetRemote();const i=await invoice();const before=reads;
   assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);assert.equal(reads,before+2);
   if(scenario==='paid'){remoteStatus='paid';remoteBalance=0;}
   if(scenario==='error')unreachable=true;
   if(scenario==='timeout')stalled=true;
   if(scenario==='credentials')missingCredentials=true;
   if(scenario==='amount')remoteBalance=124;
   if(scenario==='status')remoteStatus='draft';
   const count=sends.length,result=await automation.tick({...scope,invoiceId:i.id});
   assert.equal(sends.length,count+(scenario==='pass'?1:0),JSON.stringify({result,errors:f.errors}));
   assert.ok(reads>before+2,'dispatch never trusts queue evidence');
   if(scenario==='pass')assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'sent',JSON.stringify({result,errors:f.errors}));
  });
  await t.test('QuickBooks uses the same read abstraction without connecting any production account',async()=>{
   resetRemote();const i=await invoice('quickbooks'),before=reads,count=sends.length;
   assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   const result=await automation.tick(scope);assert.equal(sends.length,count+1,JSON.stringify({result,errors:f.errors}));
   assert.equal(reads,before+4);assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'sent');
  });
  await t.test('past-due QuickBooks with local overdue passes by positive balance',async()=>{
   resetRemote();let i=await invoice('quickbooks');i=(await db.query("update invoices set status='overdue' where id=$1 returning *",[i.id])).rows[0];
   assert.ok(new Date(i.due_date)<new Date());const count=sends.length,before=reads;
   assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   const result=await automation.tick(scope);assert.equal(sends.length,count+1,JSON.stringify({result,errors:f.errors}));
   assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'sent');assert.equal(reads,before+4);
  });
  for(const status of ['DUE_VIEWED','DUE_NOT_SENT','DUE_SENT','OVERDUE_VIEWED','OVERDUE_NOT_SENT','OVERDUE_SENT','PARTIALLY_PAID'])
   await t.test(`QuickBooks optional ${status} qualifies only with consistent positive balance`,async()=>{
    resetRemote();qboStatus=status;let i=await invoice('quickbooks');const paid=status==='PARTIALLY_PAID'?25:0;remoteBalance=125-paid;
    i=(await db.query("update invoices set status='overdue',amount_paid=$2 where id=$1 returning *",[i.id,paid])).rows[0];
    if(paid)await db.query(`insert into payments(workspace_id,invoice_id,amount,external_provider,external_payment_id,metadata)
     values($1,$2,$3,'quickbooks',$4,$5)`,[workspaceId,i.id,paid,randomUUID(),{external_invoice_id:i.external_invoice_id}]);
    const count=sends.length,before=reads;assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
    const result=await automation.tick(scope);assert.equal(sends.length,count+1,JSON.stringify({result,errors:f.errors}));
    assert.equal(result.results.find(r=>r.invoiceId===i.id)?.status,'sent');assert.equal(reads,before+4);
   });
  for(const status of ['VOIDED','REVERSED','PAID','PAID_NOT_DEPOSITED','DEPOSITED','UNKNOWN','DUE_BOGUS','unpaid','',null])
   await t.test(`QuickBooks optional ${JSON.stringify(status)} refuses queue and final dispatch`,async()=>{
    resetRemote();qboStatus=status;const i=await invoice('quickbooks');assert.equal((await prepare(i)).code,'external_accounting_required');
    qboStatus=undefined;assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
    const count=sends.length,before=reads;
    f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_delivery'))qboStatus=status;});
    try{await automation.tick(scope);}finally{f.intercept(null);}
    assert.equal(sends.length,count);assert.equal(reads,before+2);
   });
  await t.test('QuickBooks voided zero amounts refuse queue and final dispatch',async()=>{
   resetRemote();const i=await invoice('quickbooks');remoteTotal=0;remoteBalance=0;
   assert.equal((await prepare(i)).code,'external_accounting_required');
   resetRemote();assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   const count=sends.length,before=reads;
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_delivery')){remoteTotal=0;remoteBalance=0;}});
   try{await automation.tick(scope);}finally{f.intercept(null);}
   assert.equal(sends.length,count);assert.equal(reads,before+2);
  });
  for(const scenario of ['paid','error','timeout','credentials','amount','status'])await t.test(scenario+' changes after engine payment check and fails final dispatch read',async()=>{
   resetRemote();const i=await invoice();assert.equal((await prepare(i)).ok,true);assert.equal((await confirm()).completed,true);
   const before=reads,count=sends.length;
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_delivery')){
    if(scenario==='paid'){remoteStatus='paid';remoteBalance=0;}
    if(scenario==='error')unreachable=true;
    if(scenario==='timeout')stalled=true;
    if(scenario==='credentials')missingCredentials=true;
    if(scenario==='amount')remoteTotal=126;
    if(scenario==='status')remoteStatus='void';
   }});
   try{await automation.tick(scope);}finally{f.intercept(null);}
   assert.equal(reads,before+(scenario==='credentials'?1:2),'engine and final dispatcher independently verify');assert.equal(sends.length,count);
   await db.exec('reset role');
   assert.equal((await db.query('select count(*)::int n from app.first_party_reminder_dispatches where invoice_id=$1',[i.id])).rows[0].n,0);
   await db.exec('set role service_role');
   const after=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   assert.equal(Number(after.total_amount),125);assert.equal(Number(after.amount_paid),0);assert.equal(after.status,'sent');
  });
  await t.test('evidence is scoped, expires, and does not bypass audit or role checks',async()=>{
   resetRemote();const i=await invoice(),evidence=await externalReminderRead({invoice:i,ownerId,workspaceId,accounting});
   const verify=async e=>(await supabase.rpc('cetld_core_check_local_reminder_payment_with_external_read',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_invoice_id:i.id,p_external_read:e})).data;
   assert.equal((await verify(evidence)).ok,true);
   assert.equal((await check(i)).ok,false,'no evidence survives the RPC');
   assert.equal((await verify({...evidence,startedAt:'2000-01-01T00:00:00Z'})).ok,false);
   assert.equal((await verify({...evidence,invoiceId:randomUUID()})).ok,false);
   await db.query('update invoices set amount_paid=1 where id=$1',[i.id]);remoteBalance=124;
   const changed=(await db.query('select * from invoices where id=$1',[i.id])).rows[0];
   assert.equal((await verify(evidence)).ok,false,'concurrent local update invalidates evidence');
   const fresh=await externalReminderRead({invoice:changed,ownerId,workspaceId,accounting});
   assert.equal((await verify(fresh)).reason,'payment_balance_mismatch');
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
   await assert.rejects(db.query('select cetld_core_check_local_reminder_payment_with_external_read($1,$2,$3,$4)',[ownerId,workspaceId,i.id,evidence]),/permission denied/);
   await assert.rejects(db.query("select record_invoice_payment($1,$2,1,'local','fixture',false)",[workspaceId,i.id]),/EXTERNAL_ACCOUNTING/);
  });
 }finally{await f.close();}
});

test('bounded read discards timeout and missing credentials',async()=>{
 const invoice={id:randomUUID(),external_provider:'zoho_books',external_invoice_id:'remote-id',metadata:{},currency:'USD',total_amount:125,amount_paid:0,status:'sent'};
 await assert.rejects(externalReminderRead({invoice,ownerId:randomUUID(),workspaceId:randomUUID(),accounting:{reminderInvoiceState:()=>new Promise(()=>{})},timeoutMs:10}),/timed out/);
 await assert.rejects(externalReminderRead({invoice,ownerId:randomUUID(),workspaceId:randomUUID(),env:{}}));
});
