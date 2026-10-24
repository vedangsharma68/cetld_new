import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {applyNoFooterMigration} from './fixtures/no-footer-reminders.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';

const phone='+919818685252';
const freshReads='20261024094013_fresh_external_reminder_reads.sql';
const overdueGate='20261024124500_unlinked_overdue_reminder_eligibility.sql';

// Actual owner API, approval SQL, scheduler and first-party provider. Every HTTP
// request remains inside the offline SQL fixture or the captured Graph stub.
async function setup(){
 const graph=[];
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261023061702_shared_owner_assistant.sql',freshReads,overdueGate],externalFetch:async(url,options)=>{
  assert.equal(url.origin,'https://graph.facebook.com');
  graph.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.test-invoice.'+graph.length}]});
 }}),{db}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])
   await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql','20261023061702_shared_owner_assistant.sql','20261023083356_per_message_reminder_review.sql','20261023164251_exact_reminder_approval_artifact.sql',freshReads,overdueGate])
   await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const ownerId=randomUUID(),otherOwner=randomUUID();
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,otherOwner]);
  const asUser=(id=ownerId)=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${id}'`);
  const service=()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  await asUser();const workspaceId=(await db.query("select (create_workspace('Test business',$1)).id",[randomUUID()])).rows[0].id;
  await service();
  await db.query("update workspace_settings set business_name='Test business',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,{tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:5,firstReminderDays:0,cadenceDays:3}]);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Pappa',$2) returning id",[workspaceId,phone])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture-only',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'public-fixture-key',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',AI_ACCOUNTING_CONFIRMATION_SECRET:'a'.repeat(32),
   WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  let actor=ownerId;
  const handler=createAIHandler({env,logger:{info(){},error(){},warn(){}},fetchImpl:async(raw,init)=>new URL(raw).pathname==='/auth/v1/user'?Response.json({id:actor}):f.fetchImpl(raw,init)});
  const api=async(action,body={})=>{
   await asUser(actor);const res={setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
   await handler({method:'POST',headers:{authorization:'Bearer fixture-owner-token'},query:{action,workspaceId},body:{workspaceId,...body}},res);return res;
  };
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:'fixture-key',fetchImpl:f.fetchImpl});
  const accounting={reminderInvoiceState(){throw Error('Unlinked test invoice must not read a provider');},syncInvoice(){throw Error('Reminder must not export');}};
  const runtime=createAutomationRuntime({env,store,accounting,supabase:f.supabase,fetchImpl:f.fetchImpl});
  const preview=id=>api('preview-reminder',{invoiceId:id,text:'TEST — NO PAYMENT REQUIRED\n\nReview this supported test invoice. No payment is required.',tone:'professional',sendNow:true,approveFallback:false});
  const approve=p=>api('approve-reminder',{approvalToken:p.approvalToken,reviewPayload:p.reviewPayload,confirmed:true});
  return {...f,graph,api,env,ownerId,otherOwner,workspaceId,customerId,store,service,asUser,preview,approve,
   actor(id){actor=id;},
   async seed(){
    f.intercept(null);actor=ownerId;env.WHATSAPP_TEST_ALLOWLIST=phone;
    await service();await db.query("update invoices set followup_state='paused',next_follow_up_at=null where workspace_id=$1",[workspaceId]);
    await db.query('delete from whatsapp_suppressions where workspace_id=$1',[workspaceId]);
    await db.query('delete from whatsapp_global_suppressions where phone=$1',[phone]);
    await db.query("update whatsapp_consents set revoked_at=null,revoked_via=null,source='verbal',categories=array['invoice_updates'] where workspace_id=$1",[workspaceId]);
    await db.query("delete from whatsapp_messages where workspace_id=$1 and direction='inbound'",[workspaceId]);
    await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key,created_at) values($1,$2,$3,'inbound','customer','Hello','text','received',$4,clock_timestamp()-interval '1 hour')",[workspaceId,customerId,phone,randomUUID()]);
    await asUser();
    const pending=(await f.supabase.rpc('owner_assistant_pending',{p_workspace_id:workspaceId,p_owner_id:ownerId})).data;
    if(pending)await f.supabase.rpc('owner_assistant_decide',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_id:pending.id,p_confirmed:false});
    // PostgreSQL composite RPC responses are represented as JSON by real
    // PostgREST; request the same representation from this native fixture.
    const result=await db.query('select to_jsonb(public.create_test_invoice($1,$2)) invoice',[workspaceId,randomUUID()]);
    return result.rows[0].invoice.id;
   },
   async approved(id){const p=await preview(id);assert.equal(p.code,200,JSON.stringify({data:p.data,errors:f.errors}));assert.equal((await approve(p.data)).code,200);return p.data;},
   async tick(){await service();return runtime.tick({ownerId,workspaceId});},
  };
 }catch(error){await f.close();throw error;}
}

test('supported test invoices require honest one-off words and preserve production reminder gates',async t=>{
 const f=await setup(),{db}=f;
 try{
  await t.test('template review fails closed for scheduled, closed-window and fallback delivery',async()=>{
   const id=await f.seed(),before=f.graph.length;
   for(const options of [{sendNow:false},{sendNow:true,approveFallback:true}]){
    const result=await f.api('preview-reminder',{invoiceId:id,text:'TEST — NO PAYMENT REQUIRED',tone:'professional',sendNow:true,approveFallback:false,...options});
    assert.equal(result.code,409);assert.equal(result.data.error,'test_invoice_template_blocked');
   }
   await f.service();await db.query("update whatsapp_messages set created_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and direction='inbound'",[f.workspaceId]);
   assert.equal((await f.preview(id)).data.error,'test_invoice_template_blocked');
   assert.equal(f.graph.length,before);
   assert.equal((await db.query('select followup_state from invoices where id=$1',[id])).rows[0].followup_state,'draft');
  });
  await t.test('TEST buried only in the invoice number cannot approve a one-off',async()=>{
   const id=await f.seed();const row=(await db.query('select * from invoices where id=$1',[id])).rows[0];
   const result=await f.api('preview-reminder',{invoiceId:id,text:`Invoice ${row.invoice_number} has a balance.`,tone:'professional',sendNow:true,approveFallback:false});
   assert.equal(result.code,409);assert.equal(result.data.error,'test_invoice_marker_required');
  });
  await t.test('previously queued template is blocked at prepare and direct dispatch',async()=>{
   const id=await f.seed();await f.approved(id);await f.service();
   // Simulate an old template approval stored before this guard existed.
   const original=await f.store.getInvoice({ownerId:f.ownerId,workspaceId:f.workspaceId,invoiceId:id});
   const store=Object.create(f.store);store.getInvoice=async()=>({...original,metadata:{...original.metadata,approved_reminder_delivery:{type:'template'}}});
   const provider=createApprovedReminderProvider({env:f.env,supabase:f.supabase,store,ownerId:f.ownerId,workspaceId:f.workspaceId,fetchImpl:f.fetchImpl});
   const input={workspaceId:f.workspaceId,invoiceId:id,customerId:f.customerId,to:phone,body:'old words',idempotencyKey:`reminder:${f.workspaceId}:${randomUUID()}`};
   await assert.rejects(provider.prepareReminder(input),{code:'test_invoice_template_blocked'});
   assert.deepEqual(await provider.sendReminder(input),{status:'blocked',reason:'test_invoice_template_blocked'});
   assert.equal(f.graph.length,0);
  });
  await t.test('verified inbound window, exact approval and dispatch send explicit TEST words to Pappa',async()=>{
   const id=await f.seed(),before=f.graph.length;
   const created=(await db.query('select * from invoices where id=$1',[id])).rows[0];
   assert.equal(created.metadata.test_invoice,true);assert.equal(created.followup_state,'draft');assert.equal(created.next_follow_up_at,null);
   assert.equal(created.status,'sent');assert.equal(created.currency,'INR');assert.equal(Number(created.total_amount),1);
   assert.equal(created.customer_id,f.customerId);assert.equal(created.metadata.source_invoice_number,created.invoice_number);
   assert.match(created.invoice_number,/^CETLD-TEST-.*NO.PAYMENT.REQUIRED$/);
   const preview=await f.preview(id);assert.equal(preview.code,200,JSON.stringify(preview.data));
   assert.equal(f.graph.length,before);assert.equal(preview.data.delivery.form,'service');
   assert.match(preview.data.delivery.text,/^TEST — NO PAYMENT REQUIRED\n/);
   assert.equal((await f.api('approve-reminder',{approvalToken:preview.data.approvalToken,reviewPayload:preview.data.reviewPayload,confirmed:false})).data.error,'CONFIRMATION_REQUIRED');
   const changed=structuredClone(preview.data.reviewPayload);changed.payload.preview+=' Different words';
   assert.equal((await f.api('approve-reminder',{approvalToken:preview.data.approvalToken,reviewPayload:changed,confirmed:true})).data.error,'REMINDER_REVIEW_CHANGED');
   assert.equal((await f.approve(preview.data)).code,200);
   const result=await f.tick(id);assert.equal(result.results.find(row=>row.invoiceId===id)?.status,'sent',JSON.stringify({result,errors:f.errors}));
   assert.equal(f.graph.length,before+1);const sent=f.graph.at(-1);
   assert.equal(sent.to,phone.slice(1));assert.equal(sent.type,'text');
   assert.equal(sent.text.body,preview.data.delivery.text);
   const saved=(await db.query('select * from invoices where id=$1',[id])).rows[0];
   assert.equal(saved.metadata.test_invoice,true);assert.equal(saved.external_invoice_id,null);assert.equal(saved.external_provider,null);
   assert.equal(saved.metadata.bookkeeping_record_id,undefined);assert.equal(Number(saved.amount_paid),0);
   assert.equal((await db.query('select count(*)::int n from payments where invoice_id=$1',[id])).rows[0].n,0);
   assert.equal((await db.query("select count(*)::int n from cetld_core_automation_events where idempotency_key='scheduled-owner-test:20261017:v1'")).rows[0].n,0);
  });
  for(const [label,mutation,reason] of [
   ['revoked consent',"update whatsapp_consents set revoked_at=clock_timestamp(),revoked_via='manual' where workspace_id=$1",'missing_consent'],
   ['consent category',"update whatsapp_consents set categories=array['customer_service'] where workspace_id=$1",'missing_consent'],
   ['workspace suppression',"insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,'+919818685252','stop')",'suppressed'],
   ['global suppression',"insert into whatsapp_global_suppressions(phone) select '+919818685252' where $1::uuid is not null",'globally_suppressed'],
  ])await t.test(label+' prevents a flagged invoice from previewing or sending',async()=>{
   const id=await f.seed(),before=f.graph.length;await f.service();await db.query(mutation,[f.workspaceId]);
   const preview=await f.preview(id);assert.equal(preview.code,409);assert.equal(preview.data.error,reason);
   await f.service();const provider=createApprovedReminderProvider({env:f.env,supabase:f.supabase,store:f.store,ownerId:f.ownerId,workspaceId:f.workspaceId,fetchImpl:f.fetchImpl});
   assert.equal((await provider.sendReminder({workspaceId:f.workspaceId,invoiceId:id,customerId:f.customerId,to:phone,body:'test',idempotencyKey:`reminder:${f.workspaceId}:${randomUUID()}`})).status,'blocked');
   assert.equal(f.graph.length,before);
  });
  await t.test('consent loss after real approval still blocks scheduler dispatch',async()=>{
   const id=await f.seed();await f.approved(id);await f.service();await db.query("update whatsapp_consents set revoked_at=clock_timestamp(),revoked_via='manual' where workspace_id=$1",[f.workspaceId]);
   const before=f.graph.length;await f.tick(id);assert.equal(f.graph.length,before);
  });
  await t.test('configured recipient allowlist is still required after owner approval',async()=>{
   const id=await f.seed();await f.approved(id);f.env.WHATSAPP_TEST_ALLOWLIST='+919871367051';
   const before=f.graph.length;await f.tick(id);assert.equal(f.graph.length,before);
  });
  await t.test('one-off remains a text send when the demand template is unavailable',async()=>{
   const id=await f.seed();await f.approved(id);await f.service();await db.exec('begin');
   try{
    await db.query("update app.first_party_reminder_templates set approved=false where name='cetld_invoice_details_professional_v1'");
    const before=f.graph.length;await f.tick(id);assert.equal(f.graph.length,before+1);
    assert.equal(f.graph.at(-1).type,'text');assert.match(f.graph.at(-1).text.body,/^TEST — NO PAYMENT REQUIRED/);
   }finally{await db.exec('rollback');}
  });
  await t.test('stale invoice snapshots and foreign owners cannot approve',async()=>{
   const id=await f.seed(),preview=await f.preview(id);assert.equal(preview.code,200);
   await f.service();await db.query("update invoices set notes='A concurrent owner edit' where id=$1",[id]);
   assert.equal((await f.approve(preview.data)).data.error,'STALE');
   f.actor(f.otherOwner);assert.equal((await f.preview(id)).code,403);f.actor(f.ownerId);
  });
  await t.test('the final SQL gate rejects facts changed after provider preparation',async()=>{
   const id=await f.seed();await f.approved(id);const before=f.graph.length;let reached=false;
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder')){
    reached=true;await db.query("update invoices set notes='Changed immediately before the atomic gate' where id=$1",[id]);
   }});
   await f.tick(id);assert.equal(reached,true);assert.equal(f.graph.length,before);f.intercept(null);
  });
  await t.test('fresh local-payment verification remains required before dispatch',async()=>{
   const id=await f.seed();await f.approved(id);const before=f.graph.length;let checked=false;
   f.intercept(url=>{if(url.pathname.endsWith('/rpc/cetld_core_check_local_reminder_payment')){checked=true;throw Error('Offline payment verification failure');}});
   const result=await f.tick(id);assert.equal(checked,true);assert.equal(f.graph.length,before);
   assert.equal(result.results.find(row=>row.invoiceId===id)?.reason,'payment_check_failed');f.intercept(null);
  });
  for(const action of ['pause','paid'])await t.test('ordinary owner '+action+' prevents a flagged invoice from sending',async()=>{
   const id=await f.seed();await f.approved(id);const before=f.graph.length;
   if(action==='pause'){
    await f.service();await f.store.updateInvoice({ownerId:f.ownerId,workspaceId:f.workspaceId,invoiceId:id,followupState:'paused',nextFollowUpAt:null});
   }else{
    await f.asUser();await db.query('select public.record_invoice_payment($1,$2,1,$3,$4,false)',[f.workspaceId,id,randomUUID(),'Offline fixture payment']);
   }
   await f.tick(id);assert.equal(f.graph.length,before);
  });
  await t.test('unlinked overdue test invoices use the verified one-off delivery gates',async()=>{
   const id=await f.seed();await f.service();await db.query("update invoices set status='overdue' where id=$1",[id]);
   const before=f.graph.length,preview=await f.approved(id);assert.equal(f.graph.length,before);
   const result=await f.tick(id);assert.equal(result.results.find(row=>row.invoiceId===id)?.status,'sent',JSON.stringify({result,errors:f.errors}));
   assert.equal(f.graph.length,before+1);const sent=f.graph.at(-1);
   assert.equal(sent.to,phone.slice(1));assert.equal(sent.type,'text');
   assert.equal(sent.text.body,preview.delivery.text);
   const saved=(await db.query('select * from invoices where id=$1',[id])).rows[0];
   assert.equal(saved.metadata.test_invoice,true);assert.equal(saved.external_invoice_id,null);assert.equal(saved.external_provider,null);
  });
  for(const status of ['draft','void','cancelled'])await t.test('unlinked '+status+' status retains the existing reminder refusal',async()=>{
   const id=await f.seed();await f.approved(id);await f.service();await db.query('update invoices set status=$2 where id=$1',[id,status]);
   const before=f.graph.length;await f.tick(id);assert.equal(f.graph.length,before);
  });
  await t.test('an unresolved dispute remains a hold on a test invoice',async()=>{
   const id=await f.seed();await f.approved(id);await f.service();await db.query("update invoices set metadata=metadata||'{\"followup_exception\":{\"type\":\"dispute\",\"note\":\"Fixture hold\"}}' where id=$1",[id]);
   const before=f.graph.length;await f.tick(id);assert.equal(f.graph.length,before);
  });
 }finally{await f.close();}
});

test('test one-off dispatch holds on expired window and never substitutes a template',async()=>{
 const f=await setup();try{
  const id=await f.seed();await f.approved(id);await f.service();
  await f.db.query("update whatsapp_messages set created_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and direction='inbound'",[f.workspaceId]);
  await f.tick(id);assert.equal(f.graph.length,0);
 }finally{await f.close();}
});

test('test one-off dispatch independently refuses missing TEST marker in a stored approval',async()=>{
 const f=await setup();try{
  const id=await f.seed();await f.approved(id);await f.service();
  const original=await f.store.getInvoice({ownerId:f.ownerId,workspaceId:f.workspaceId,invoiceId:id});
  const store=Object.create(f.store);store.getInvoice=async()=>({...original,metadata:{...original.metadata,approved_reminder_delivery:{type:'freeform',body:`Invoice ${original.invoice_number}`}}});
  const provider=createApprovedReminderProvider({env:f.env,supabase:f.supabase,store,ownerId:f.ownerId,workspaceId:f.workspaceId,fetchImpl:f.fetchImpl});
  assert.deepEqual(await provider.sendReminder({workspaceId:f.workspaceId,invoiceId:id,customerId:f.customerId,to:phone,body:'old',idempotencyKey:`reminder:${f.workspaceId}:${randomUUID()}`}),{status:'blocked',reason:'test_invoice_marker_required'});
  assert.equal(f.graph.length,0);
 }finally{await f.close();}
});

test('test one-off rechecks the service deadline after the atomic reservation, before HTTP',async()=>{
 const f=await setup();try{
  const id=await f.seed(),preview=await f.approved(id);await f.service();
  const scope={ownerId:f.ownerId,workspaceId:f.workspaceId,invoiceId:id};
  const [claim]=await f.store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
  const authorization=await f.store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:(await f.store.getWorkspacePreferences(scope)).updated_at});
  assert.equal(authorization.authorized,true);
  let now=Date.now(),reserved=false;
  const delayed={from:(...args)=>f.supabase.from(...args),async rpc(name,args){
   const result=await f.supabase.rpc(name,args);
   if(name==='cetld_core_authorize_first_party_reminder'&&result.data?.authorized){reserved=true;now=Date.parse(result.data.windowDeadline)+1;}
   return result;
  }};
  const provider=createApprovedReminderProvider({env:f.env,supabase:delayed,store:f.store,ownerId:f.ownerId,workspaceId:f.workspaceId,fetchImpl:f.fetchImpl,clock:()=>new Date(now)});
  const result=await provider.sendReminder({...scope,customerId:f.customerId,to:phone,body:preview.delivery.text,idempotencyKey:`reminder:${f.workspaceId}:${claim.id}`});
  assert.equal(reserved,true);assert.deepEqual(result,{status:'blocked',reason:'needs_re_review'});assert.equal(f.graph.length,0);
 }finally{await f.close();}
});
