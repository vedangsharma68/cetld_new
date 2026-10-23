import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {applyNoFooterMigration} from './fixtures/no-footer-reminders.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {REMINDER_TEMPLATES} from '../automation/whatsapp/reminder-templates.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';
import {approveReviewedReminder} from './fixtures/reviewed-reminder.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
const migration='20261023083356_per_message_reminder_review.sql',phone='+919871367051';
const response=()=>({setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}});

test('per-message review binds the real API, PostgreSQL approval, dispatch and retry forms',async t=>{
 const graph=[];let reject=false;
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261023061702_shared_owner_assistant.sql'],externalFetch:async(url,options)=>{
  assert.equal(url.origin,'https://graph.facebook.com');graph.push(JSON.parse(options.body));return reject?new Response('',{status:400}):Response.json({messages:[{id:'wamid.review.'+graph.length}]});
 }});const {db}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql','20261023061702_shared_owner_assistant.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const ownerId=randomUUID(),other=randomUUID();await db.query('insert into auth.users(id) values($1),($2)',[ownerId,other]);
  const asUser=async(id=ownerId)=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${id}'`);
  const service=async()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  await asUser();const workspaceId=(await db.query("select (create_workspace('Review business',$1)).id",[randomUUID()])).rows[0].id;
  await service();
  await db.query("update workspace_settings set business_name='Review business',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,{tone:'professional',contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:5,firstReminderDays:0,cadenceDays:3}]);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith',$2) returning id",[workspaceId,phone])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','test',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'public-fixture-key',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',AI_ACCOUNTING_CONFIRMATION_SECRET:'a'.repeat(32),
   WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  let actor=ownerId;
  const fetchImpl=async(raw,init)=>new URL(raw).pathname==='/auth/v1/user'?Response.json({id:actor}):f.fetchImpl(raw,init);
  const handler=createAIHandler({env,fetchImpl,logger:{error(){},warn(){},info(){}}});
  const api=async(action,body={},method='POST')=>{await asUser(actor);const res=response();await handler({method,headers:{authorization:'Bearer fixture-owner-token'},query:{action,workspaceId},body:{workspaceId,...body}},res);return res};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:'fixture-key',fetchImpl:f.fetchImpl});
  const runtime=createAutomationRuntime({env,store,supabase:f.supabase,fetchImpl:f.fetchImpl});
  const invoice=async()=>{await service();return (await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,current_date-3,current_date-1,'USD',125,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[workspaceId,customerId,'TEST-'+randomUUID().slice(0,6)])).rows[0].id};
  const inbound=async(expired=false)=>{await service();await db.query("delete from whatsapp_messages where workspace_id=$1 and direction='inbound'",[workspaceId]);await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key,created_at) values($1,$2,$3,'inbound','customer','Hello','text','received',$4,clock_timestamp()-$5::interval)",[workspaceId,customerId,phone,randomUUID(),expired?'25 hours':'1 hour'])};
  const preview=(invoiceId,extra={})=>api('preview-reminder',{invoiceId,text:'The exact edited words, including punctuation!',tone:'firm',sendNow:true,approveFallback:false,...extra});
  const approve=p=>api('approve-reminder',{approvalToken:p.approvalToken,reviewPayload:p.reviewPayload,confirmed:true});
  const tick=async invoiceId=>{await service();const result=await runtime.tick({ownerId,workspaceId});return {...result,results:result.results.filter(row=>row.invoiceId===invoiceId)}};
  await t.test('migration preserves reviewed legacy queues and pending proposals; unbound legacy approvals become visible re-review',async()=>{
   const valid=await invoice(),legacy=await invoice();
   const receipt=await approveReviewedReminder(db,{workspaceId,invoiceId:valid});
   await db.query("update invoices set metadata=metadata||jsonb_build_object('approved_reminder_delivery_reviewed_at',clock_timestamp()) where id=$1",[valid]);
   const before=(await db.query('select * from invoices where id=$1',[valid])).rows[0];
   await db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Legacy owner words\n\nReview business','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)),next_follow_up_at=clock_timestamp()-interval '1 minute' where id=$1",[legacy,workspaceId]);
   await asUser();const proposal={id:randomUUID(),type:'owner_schedule',payload:{patch:{cadenceDays:7},updatedAt:(await store.getWorkspacePreferences({workspaceId})).updated_at},summary:'Existing pending approval'};
   assert.equal((await f.supabase.rpc('owner_assistant_propose',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_proposal:proposal})).data.id,proposal.id);
   await service();await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
   const after=(await db.query('select * from invoices where id=$1',[valid])).rows[0];
   assert.deepEqual(after.metadata.approved_reminder_delivery,receipt);assert.equal(after.followup_state,'approved');assert.equal(after.automation_version,before.automation_version);assert.equal(+new Date(after.next_follow_up_at),+new Date(before.next_follow_up_at));
   // Reserve without HTTP and record the receipt after the migration, while
   // count_before is still current: this exercises receipt cadence recovery.
   const legacyScope={ownerId,workspaceId,invoiceId:valid};
   const [claim]=await store.claimDueFollowups({...legacyScope,now:new Date().toISOString(),limit:1});
   assert.equal((await store.authorizeDelivery({...legacyScope,claimId:claim.id,preferencesVersion:(await store.getWorkspacePreferences(legacyScope)).updated_at})).authorized,true);
   let captured;
   f.intercept(async(url,options)=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder')){captured=JSON.parse(options.body);throw Error('No fixture HTTP dispatch')}});
   const provider=createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl});
   await provider.sendReminder({...legacyScope,customerId,to:phone,body:receipt.body,idempotencyKey:`reminder:${workspaceId}:${claim.id}`});f.intercept(null);
   assert.ok(captured);const reserved=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',captured);assert.equal(reserved.data.authorized,true,JSON.stringify({reserved,errors:f.errors}));
   const recorded=await f.supabase.rpc('cetld_core_record_first_party_receipt',{p_callback_token:reserved.data.callback_token,p_waba_id:env.WHATSAPP_WABA_ID,p_phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID,p_phone:phone,p_message_id:'wamid.legacy.cadence',p_status:'accepted'});
   assert.equal(recorded.data.ok,true,JSON.stringify(recorded));
   const advanced=(await db.query('select * from invoices where id=$1',[valid])).rows[0];
   assert.equal(advanced.reminder_count,before.reminder_count+1);assert.equal(advanced.followup_state,'approved');
   assert.ok(+new Date(advanced.next_follow_up_at)>=Date.now()+3*86400000-10000,'legacy receipt advances by configured three-day cadence');
   assert.deepEqual(advanced.metadata.approved_reminder_delivery,receipt);assert.equal(receipt.version,undefined);assert.equal(receipt.mode,undefined);
   const held=(await db.query('select * from invoices where id=$1',[legacy])).rows[0];assert.equal(held.followup_state,'paused');assert.equal(held.metadata.reminder_review_reason,'delivery_form_review');assert.match(held.metadata.approved_reminder_text,/Legacy owner words/);
   const pending=(await db.query('select * from owner_assistant_proposals where id=$1',[proposal.id])).rows[0];assert.equal(pending.state,'pending');assert.deepEqual(pending.action,proposal);
   const blocked=await preview(await invoice());assert.equal(blocked.code,409);assert.equal(blocked.data.error,'PENDING');
   await asUser();assert.equal((await f.supabase.rpc('owner_assistant_decide',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_id:proposal.id,p_confirmed:false})).data.ok,true);
  });
  await t.test('2a: scheduled reminders use the selected tone template even inside the service window',async()=>{
   await inbound();const id=await invoice(),p=await preview(id,{sendNow:false,tone:'firm'});assert.equal(p.code,200,JSON.stringify({data:p.data,errors:f.errors}));assert.equal(p.data.delivery.form,'template');assert.equal(p.data.delivery.templateName,'cetld_invoice_details_firm_v1');
   const a=await approve(p.data);assert.equal(a.code,200,JSON.stringify({data:a.data,errors:f.errors}));await service();await db.query("update invoices set next_follow_up_at=clock_timestamp()-interval '1 minute' where id=$1",[id]);
   const result=await tick(id);assert.equal(result.results[0].status,'sent',JSON.stringify({result,errors:f.errors}));assert.equal(graph.at(-1).type,'template');assert.equal(graph.at(-1).template.name,p.data.delivery.templateName);
  });
  await t.test('2b: immediate free-form sends the exact reviewed words, never regenerated tone text',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal(p.code,200,JSON.stringify(p.data));assert.equal(p.data.delivery.form,'service');assert.equal((await approve(p.data)).code,200);
   const result=await tick(id);assert.equal(result.results[0].status,'sent',JSON.stringify({result,errors:f.errors}));assert.equal(graph.at(-1).type,'text');assert.equal(graph.at(-1).text.body,p.data.delivery.text);
   const row=(await db.query('select * from invoices where id=$1',[id])).rows[0];assert.equal(row.next_follow_up_at,null,'one-off service approval must not become a recurring schedule');
  });
  await t.test('2c: expiry holds the approval visibly for review without a send',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);await inbound(true);const count=graph.length;
   const result=await tick(id);assert.equal(result.results[0].status,'needs_re_review',JSON.stringify({result,errors:f.errors}));assert.equal(graph.length,count);
   const row=(await db.query('select * from invoices where id=$1',[id])).rows[0];assert.equal(row.followup_state,'paused');assert.equal(row.metadata.reminder_review_reason,'undeliverable_window_expired');
   assert.equal((await db.query('select dispatch_outcome from app.reminder_approvals where invoice_id=$1',[id])).rows[0].dispatch_outcome,'undeliverable_window_expired');
  });
  await t.test('a pre-approved fallback sends only that named template after expiry and records template_fallback',async()=>{
   await inbound();const id=await invoice(),p=await preview(id,{approveFallback:true,tone:'gentle'});assert.equal(p.code,200,JSON.stringify(p.data));assert.ok(p.data.delivery.fallback);assert.equal((await approve(p.data)).code,200);await inbound(true);
   const result=await tick(id);assert.equal(result.results[0].status,'sent',JSON.stringify({result,errors:f.errors}));assert.equal(graph.at(-1).template.name,p.data.delivery.fallback.templateName);
   const d=(await db.query('select snapshot from app.first_party_reminder_dispatches where invoice_id=$1',[id])).rows[0];assert.equal(d.snapshot.deliveryForm,'template_fallback');assert.equal(d.snapshot.body,p.data.delivery.fallback.text);
  });
  await t.test('the final SQL reservation chooses only a pre-approved fallback when the window closes after preparation',async()=>{
   for(const fallback of [false,true]){
    await inbound();const id=await invoice(),p=await preview(id,{approveFallback:fallback});assert.equal((await approve(p.data)).code,200);const before=graph.length;
    f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await db.query("update whatsapp_messages set created_at=clock_timestamp()-interval '25 hours' where workspace_id=$1 and direction='inbound'",[workspaceId]);});
    const result=await tick(id);f.intercept(null);
    assert.equal(result.results[0].status,fallback?'sent':'needs_re_review',JSON.stringify({result,errors:f.errors}));assert.equal(graph.length,before+(fallback?1:0));
    if(fallback){assert.equal(graph.at(-1).type,'template');assert.equal(graph.at(-1).template.name,p.data.delivery.fallback.templateName);const row=(await db.query('select snapshot from app.first_party_reminder_dispatches where invoice_id=$1',[id])).rows[0];assert.equal(row.snapshot.body,p.data.delivery.fallback.text);assert.equal(row.snapshot.deliveryForm,'template_fallback');}
   }
  });
  await t.test('a window closing while the final reservation response returns is held before HTTP and records expiry',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);await service();
   const scope={ownerId,workspaceId,invoiceId:id},[claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   const authorization=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:(await store.getWorkspacePreferences(scope)).updated_at});assert.equal(authorization.authorized,true);
   const before=graph.length;
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await db.query("update whatsapp_messages set created_at=clock_timestamp()-interval '24 hours'+interval '0.1 seconds' where workspace_id=$1 and direction='inbound'",[workspaceId]);});
   const delayed={from:(...args)=>f.supabase.from(...args),async rpc(name,args){const result=await f.supabase.rpc(name,args);if(name==='cetld_core_authorize_first_party_reminder'&&result.data?.authorized)await new Promise(resolve=>setTimeout(resolve,300));return result;}};
   const result=await createApprovedReminderProvider({env,supabase:delayed,store,ownerId,workspaceId,fetchImpl:f.fetchImpl}).sendReminder({...scope,customerId,to:phone,body:p.data.delivery.text,idempotencyKey:`reminder:${workspaceId}:${claim.id}`});f.intercept(null);
   assert.equal(result.status,'blocked');assert.equal(graph.length,before);assert.equal((await db.query('select metadata from invoices where id=$1',[id])).rows[0].metadata.reminder_review_reason,'undeliverable_window_expired');
  });
  await t.test('retry after expiry re-evaluates the same free-form approval and never substitutes a template',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);
   await service();const scope={ownerId,workspaceId,invoiceId:id};const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   const settings=await store.getWorkspacePreferences(scope);const authorization=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at});assert.equal(authorization.authorized,true);
   const provider=createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl});const count=graph.length;
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))throw Error('Known pre-reservation network failure')});
   const first=await provider.sendReminder({...scope,customerId,to:phone,body:p.data.delivery.text,idempotencyKey:`reminder:${workspaceId}:${claim.id}`});
   f.intercept(null);assert.equal(first.status,'blocked');assert.equal(graph.length,count);
   await store.markDeliveryFailed({...scope,claimId:claim.id,token:authorization.token,unknown:false,error:'known_pre_dispatch_failure'});
   await inbound(true);const retried=await tick(id);assert.equal(retried.results[0].status,'needs_re_review',JSON.stringify({retried,errors:f.errors}));assert.equal(graph.length,count);
   assert.equal((await db.query('select attempts from cetld_core_automation_delivery_claims where id=$1',[claim.id])).rows[0].attempts,2);
   assert.equal((await db.query('select dispatch_outcome from app.reminder_approvals where invoice_id=$1',[id])).rows[0].dispatch_outcome,'undeliverable_window_expired');
  });
  await t.test('2d: signature tampering and final-gate form/word mutations fail closed',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);
   const edited=structuredClone(p.data);edited.reviewPayload.payload.preview='Unapproved replacement';assert.equal((await approve(edited)).data.error,'REMINDER_REVIEW_CHANGED');
   assert.equal((await approve({...p.data,approvalToken:p.data.approvalToken+'x'})).code,400);
   assert.equal((await approve(p.data)).code,200);await service();
   const scope={ownerId,workspaceId,invoiceId:id},[claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   const authorization=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:(await store.getWorkspacePreferences(scope)).updated_at});assert.equal(authorization.authorized,true);
   let captured;const count=graph.length;
   f.intercept(async(url,options)=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder')){captured=JSON.parse(options.body);throw Error('Capture before reservation')}});
   const provider=createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl});
   await provider.sendReminder({...scope,customerId,to:phone,body:p.data.delivery.text,idempotencyKey:`reminder:${workspaceId}:${claim.id}`});f.intercept(null);assert.ok(captured);
   const snapshot=structuredClone(captured.p_snapshot);snapshot.body='Unapproved outgoing text';snapshot.delivery.body=snapshot.body;
   const checked=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{...captured,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot)});
   assert.equal(checked.error,null,JSON.stringify(f.errors));assert.equal(checked.data.authorized,false);assert.equal(graph.length,count);
   await store.markDeliveryFailed({...scope,claimId:claim.id,token:authorization.token,unknown:false,error:'rejected_words'});
   const otherId=await invoice(),otherPreview=await preview(otherId,{approveFallback:false});assert.equal((await approve(otherPreview.data)).code,200);
   await service();const original=(await db.query('select metadata from invoices where id=$1',[otherId])).rows[0].metadata.approved_reminder_delivery;
   await db.query("update invoices set metadata=metadata||jsonb_build_object('approved_reminder_delivery',$2::jsonb) where id=$1",[otherId,{...original,fallback:{type:'template',name:'Unapproved template',body:'Unapproved words'}}]);
   const result=await tick(otherId);assert.equal(result.results[0].status,'needs_re_review');assert.equal(graph.length,count);
  });
  await t.test('2d: final SQL independently rejects an unapproved template form, even with approved catalog words',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);await service();
   const scope={ownerId,workspaceId,invoiceId:id},[claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   const authorization=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:(await store.getWorkspacePreferences(scope)).updated_at});assert.equal(authorization.authorized,true);
   let captured;const count=graph.length;
   f.intercept(async(url,options)=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder')){captured=JSON.parse(options.body);throw Error('Capture before reservation')}});
   await createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl}).sendReminder({...scope,customerId,to:phone,body:p.data.delivery.text,idempotencyKey:`reminder:${workspaceId}:${claim.id}`});f.intercept(null);
   const t=p.data.reviewPayload.payload.template,snapshot=structuredClone(captured.p_snapshot);
   snapshot.delivery={type:'template',name:t.name,language:t.language,revision:t.revision,parameters:t.parameters,body:t.templatePreview,buttonVariant:false};snapshot.body=t.templatePreview;snapshot.deliveryForm='template_fallback';
   const checked=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{...captured,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot)});
   assert.equal(checked.error,null,JSON.stringify(f.errors));assert.equal(checked.data.authorized,false);assert.equal(graph.length,count);
   await store.markDeliveryFailed({...scope,claimId:claim.id,token:authorization.token,unknown:false,error:'unapproved_form'});
  });
  await t.test('legacy words, form, template identity and parameters must match protected confirmation evidence',async()=>{
   const id=await invoice(),legacy=await approveReviewedReminder(db,{workspaceId,invoiceId:id});
   const proof=(await db.query("select * from owner_assistant_proposals where action#>>'{payload,invoiceId}'=$1",[id])).rows[0];
   const provider=createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl}),input={ownerId,workspaceId,invoiceId:id,to:phone};
   assert.equal((await provider.prepareReminder(input)).body,legacy.body);
   const mutations=[p=>{p.preview+=' Changed';},p=>{p.approvalText+=' Changed';},p=>{p.template.name+='other';},p=>{p.template.language='hi';},p=>{p.template.revision='other';},p=>{p.template.parameters[0]='Other customer';},p=>{p.template.reviewedDelivery={version:2,type:'freeform',body:p.preview};}];
   for(const mutate of mutations){
    const action=structuredClone(proof.action);mutate(action.payload);
    await db.query('update owner_assistant_proposals set action=$2 where id=$1',[proof.id,action]);
    await assert.rejects(provider.prepareReminder(input),error=>error.code==='DELIVERY_REVIEW_REQUIRED');
    assert.equal((await db.query('select app.legacy_reminder_approval_matches($1,i) allowed from invoices i where id=$2',[ownerId,id])).rows[0].allowed,false);
   }
   // Historical WhatsApp confirmations have a receipt pointer, not inline words.
   await db.query('delete from owner_assistant_proposals where id=$1',[proof.id]);
   const pending=(await db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,source,action,consumed_at) values($1,$2,$3,'whatsapp',$4,clock_timestamp()) returning *",[workspaceId,customerId,phone,{type:'owner_reminder_approval',...proof.action.payload}])).rows[0];
   const messageId='legacy-confirm-'+randomUUID();
   await db.query("insert into whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result) values($1,$2,$3,$4,$1,$5,$6)",[messageId,workspaceId,ownerId,phone,{operation:'reminder.confirm',pendingId:pending.id,pendingVersion:pending.version},{ok:true,completed:true,action:'reminder.approved'}]);
   assert.equal((await provider.prepareReminder(input)).body,legacy.body);
   assert.equal((await db.query('select app.legacy_reminder_approval_matches($1,i) allowed from invoices i where id=$2',[ownerId,id])).rows[0].allowed,true);
   await db.query('delete from whatsapp_pending_actions where id=$1',[pending.id]);
   await assert.rejects(provider.prepareReminder(input),error=>error.code==='DELIVERY_REVIEW_REQUIRED');
   assert.equal((await db.query('select app.legacy_reminder_approval_matches($1,i) allowed from invoices i where id=$2',[ownerId,id])).rows[0].allowed,false);
   await db.query("update invoices set followup_state='paused',next_follow_up_at=null where id=$1",[id]);
  });
  await t.test('a member cannot downgrade immutable v2 approval to a versionless legacy artifact, even with an older genuine legacy receipt',async()=>{
   await service();await db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'member') on conflict do nothing",[workspaceId,other]);
   for(const withOldReceipt of [false,true]){
    await inbound();const id=await invoice();
    const legacy=await approveReviewedReminder(db,{workspaceId,invoiceId:id});
    if(!withOldReceipt)await db.query("delete from owner_assistant_proposals where action#>>'{payload,invoiceId}'=$1",[id]);
    const legacyText=(await db.query('select metadata from invoices where id=$1',[id])).rows[0].metadata.approved_reminder_text;
    const p=await preview(id);assert.equal((await approve(p.data)).code,200);await asUser(other);await db.exec('set role authenticated');
    await db.query("update invoices set metadata=metadata||jsonb_build_object('approved_reminder_delivery',$2::jsonb,'approved_reminder_text',$3::text) where id=$1",[id,legacy,legacyText]);
    await service();const count=graph.length,scope={ownerId,workspaceId,invoiceId:id};
    const provider=createApprovedReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,fetchImpl:f.fetchImpl});
    await assert.rejects(provider.prepareReminder({...scope,to:phone}),error=>error.code==='DELIVERY_REVIEW_REQUIRED');
    assert.equal((await provider.sendReminder({...scope,customerId,to:phone,body:legacy.body,idempotencyKey:`reminder:${workspaceId}:${randomUUID()}`})).reason,'needs_re_review');
    const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});assert.ok(claim);
    const settings=await store.getWorkspacePreferences(scope),currentInvoice=await store.getInvoice(scope);
    assert.equal((await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at})).authorized,true);
    const consent=(await db.query('select * from whatsapp_consents where workspace_id=$1 and customer_id=$2 and revoked_at is null',[workspaceId,customerId])).rows[0];
    const entry=REMINDER_TEMPLATES.find(t=>t.name===legacy.name);
    const snapshot={invoiceId:id,customerId,phone,body:legacy.body,invoiceVersion:currentInvoice.automation_version,invoiceUpdatedAt:currentInvoice.updated_at,preferencesUpdatedAt:settings.updated_at,delivery:legacy,
     consentId:consent.id,consentCreatedAt:consent.created_at.toISOString(),template:{name:entry.name,language:entry.language,body:entry.body,revision:entry.revision,wabaId:env.WHATSAPP_WABA_ID,phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,parameters:legacy.parameters}};
    const denied=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claim.id,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot)});
    assert.equal(denied.error,null,JSON.stringify(f.errors));assert.equal(denied.data.authorized,false);assert.equal(denied.data.reason,'needs_re_review');
    assert.equal(graph.length,count);assert.equal((await db.query('select count(*)::int n from app.first_party_reminder_dispatches where invoice_id=$1',[id])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from app.reminder_approvals where invoice_id=$1',[id])).rows[0].n,1);
   }
  });
  await t.test('a service approval cannot be moved onto a scheduled send; replay does not create another approval',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);assert.equal((await approve(p.data)).data.replayed,true);
   await service();assert.equal((await db.query('select count(*)::int n from app.reminder_approvals where invoice_id=$1',[id])).rows[0].n,1);
   const before=graph.length;await db.query("update invoices set next_follow_up_at=clock_timestamp()-interval '1 minute' where id=$1",[id]);
   const result=await tick(id);assert.equal(result.results[0].status,'needs_re_review',JSON.stringify({result,errors:f.errors}));assert.equal(graph.length,before);assert.equal((await db.query('select metadata from invoices where id=$1',[id])).rows[0].metadata.reminder_review_reason,'scheduled_template_only');
  });
  await t.test('concurrent or repeated expired preparation preserves the original hold reason and receipt',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);assert.equal((await approve(p.data)).code,200);await inbound(true);const before=graph.length;
   const args={p_workspace_id:workspaceId,p_owner_id:ownerId,p_invoice_id:id};
   const results=await Promise.all([f.supabase.rpc('owner_assistant_reminder_dispatch_preview',args),f.supabase.rpc('owner_assistant_reminder_dispatch_preview',args)]);
   for(const result of results){assert.equal(result.error,null,JSON.stringify(f.errors));assert.equal(result.data.ok,false);assert.equal(result.data.reason,'undeliverable_window_expired');}
   const row=(await db.query('select * from invoices where id=$1',[id])).rows[0];assert.equal(row.metadata.reminder_review_reason,'undeliverable_window_expired');assert.equal(row.metadata.approved_reminder_delivery.body,p.data.delivery.text);assert.equal(graph.length,before);
  });
  await t.test('the full 4,000-character Unicode message limit is reviewed and sent without truncation',async()=>{
   await inbound();const id=await invoice(),text='漢'.repeat(4000),p=await preview(id,{text});assert.equal(p.code,200,JSON.stringify(p.data));assert.equal((await approve(p.data)).code,200);
   const result=await tick(id);assert.equal(result.results[0].status,'sent',JSON.stringify({result,errors:f.errors}));assert.equal(graph.at(-1).text.body,text);
  });
  await t.test('new private approval/audit tables and dispatch RPC remain inaccessible to browser roles',async()=>{
   await service();for(const role of ['anon','authenticated','service_role'])for(const table of ['app.reminder_approvals','app.reminder_delivery_evaluations'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,table,'SELECT,INSERT,UPDATE,DELETE'])).rows[0].allowed,false);
   assert.equal((await db.query("select has_function_privilege('authenticated','public.owner_assistant_reminder_dispatch_preview(uuid,uuid,uuid)','EXECUTE') allowed")).rows[0].allowed,false);
   assert.equal((await db.query("select has_function_privilege('anon','public.owner_assistant_reminder_window(uuid,uuid,uuid)','EXECUTE') allowed")).rows[0].allowed,false);
   await asUser(other);await assert.rejects(db.query('select owner_assistant_reminder_status($1,$2)',[workspaceId,ownerId]),/owner required/);
   const deniedId=await invoice();await asUser();await assert.rejects(db.query('select owner_assistant_reminder_dispatch_preview($1,$2,$3)',[workspaceId,ownerId,deniedId]),/service required/);await service();
  });
  await t.test('consent loss after preview, owner isolation, and stale invoice changes preserve the gates',async()=>{
   await inbound();const id=await invoice(),p=await preview(id);await service();await db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,'stop')",[workspaceId,phone]);
   const count=graph.length;const failed=await approve(p.data);assert.equal(failed.code,409);assert.equal(failed.data.error,'suppressed');assert.equal(graph.length,count);
   await asUser();const pending=(await f.supabase.rpc('owner_assistant_pending',{p_workspace_id:workspaceId,p_owner_id:ownerId})).data;assert.ok(pending,'failure must not silently discard the pending proposal');
   assert.equal((await f.supabase.rpc('owner_assistant_decide',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_id:pending.id,p_confirmed:false})).data.ok,true);
   await service();await db.query('delete from whatsapp_suppressions where workspace_id=$1',[workspaceId]);
   const fresh=await preview(id);await service();await db.query("update invoices set notes='Concurrent owner edit' where id=$1",[id]);assert.equal((await approve(fresh.data)).data.error,'STALE');
   await asUser();const stale=(await f.supabase.rpc('owner_assistant_pending',{p_workspace_id:workspaceId,p_owner_id:ownerId})).data;await f.supabase.rpc('owner_assistant_decide',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_id:stale.id,p_confirmed:false});
   actor=other;assert.equal((await preview(id)).code,403);actor=ownerId;
   await service();const customer=(await db.query('select reminder_tone from customers where id=$1',[customerId])).rows[0];assert.equal(customer.reminder_tone,null,'per-message tone must not change the customer default');assert.equal((await store.getWorkspacePreferences({workspaceId})).follow_up_preferences.tone,'professional');
  });

 }finally{await f.close()}
});

for(const [routine,old,replacement,expected] of [
 ['public.cetld_core_record_first_party_receipt(text,text,text,text,text,text)',"      if i.automation_version=(d.snapshot->>'invoiceVersion')::bigint", "      if (i.automation_version)=(d.snapshot->>'invoiceVersion')::bigint",/Reminder receipt cadence patch point changed/],
 ['public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)','length(p_snapshot::text)>8000','length(p_snapshot::text)>7999',/Reminder snapshot size patch point changed/],
])test('held migration aborts atomically on a real installed-function mismatch: '+routine,async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261023061702_shared_owner_assistant.sql']});
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await f.db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(f.db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql','20261023061702_shared_owner_assistant.sql'])await f.db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const definition=(await f.db.query('select pg_get_functiondef($1::regprocedure) definition',[routine])).rows[0].definition;
  assert.ok(definition.includes(old));await f.db.exec(definition.replace(old,replacement));
  await assert.rejects(f.db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8')),expected);
  await f.db.exec('rollback');
  assert.equal((await f.db.query("select to_regclass('app.reminder_approvals') present")).rows[0].present,null);
 }finally{await f.close()}
});
