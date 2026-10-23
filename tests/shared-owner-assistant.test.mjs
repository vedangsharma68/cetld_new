import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {applyNoFooterMigration} from './fixtures/no-footer-reminders.mjs';
import {createAccountingActionToken} from '../ai/accounting-actions.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createAssistantClient} from '../assistant-client.js';
import {selectInvoiceReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {buildDefaultInvoiceReminderDraft} from '../automation/whatsapp/reminder-parameters.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createOwnerConversation} from '../ai/owner-conversation.mjs';

const migration='20261023061702_shared_owner_assistant.sql';
const logger={info(){},warn(){},error(){}};
const response=()=>({setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}});

test('shared owner context and dashboard commands use real authenticated stores and PostgreSQL safety gates',async t=>{
 const graph=[];
 const f=await createOfflineSqlNetwork({excludeMigrations:[migration],externalFetch:async(url,options)=>{assert.equal(url.origin,'https://graph.facebook.com');graph.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.shared.delivery'}]});}});const {db}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  for(const file of ['20261020105604_invoice_reminder_full_customer_name.sql','20261022221930_default_payment_reminder_draft.sql',migration])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const ownerId=randomUUID(),otherOwner=randomUUID(),phone='+12025550107',recipient='+919871367051';
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,otherOwner]);
  const asUser=async id=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${id}'`);
  const service=async()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  await asUser(ownerId);const workspaceId=(await db.query("select (create_workspace('Shared business',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await service();assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const ownerCustomer=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const customer=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith',$2) returning id",[workspaceId,recipient])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','test',array['invoice_updates'])",[workspaceId,customer,recipient]);
  const invoiceId=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
   values($1,$2,'TEST','2026-10-01','2026-10-22','USD',100,'sent','{"invoice_direction":"receivable","subtotal":100,"tax":0,"line_items":[]}') returning id`,[workspaceId,customer])).rows[0].id;
  await db.query("update invoices set invoice_number='INV-001' where id=$1",[invoiceId]);
  await db.query("update workspace_settings set default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,{contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3,cadenceDays:3}]);
  const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'public-fixture-key',AI_ACCOUNTING_CONFIRMATION_SECRET:'a'.repeat(32)};
  let actor=ownerId,planned=0,invalidHistory=false;
  const fetchImpl=async(raw,init)=>{const url=new URL(raw);if(invalidHistory&&url.pathname.endsWith('/rpc/owner_assistant_history'))return Response.json(null);if(url.pathname==='/auth/v1/user')return Response.json({id:actor});if(url.searchParams.has('select'))url.searchParams.set('select',url.searchParams.get('select').replaceAll('::text',''));return f.fetchImpl(url,init);};
  const provider={async generate(){planned++;throw Error('No model needed for bounded commands');}};
  const handler=createAIHandler({env,fetchImpl,providerFactory:()=>provider,logger});
  async function api(action,body={},method='POST'){
   await asUser(actor);const res=response();await handler({method,headers:{authorization:'Bearer fixture-user-token'},query:{action,workspaceId},body:{workspaceId,...body}},res);return res;
  }
  const ask=message=>api('assistant',{message,history:[{role:'user',content:'FORGED browser history'}]});
  const confirm=(pending,confirmed=true)=>api(confirmed?'confirm-accounting-action':'cancel-assistant-action',{confirmed,confirmationToken:pending.confirmationToken});
  const invoice=async()=>{await service();return (await db.query('select * from invoices where id=$1',[invoiceId])).rows[0];};
  const shared=()=>createOwnerConversation({rpc:(name,args)=>f.supabase.rpc(name,args),workspaceId,ownerId,channel:'whatsapp'});
  const wa=async(message,agentFactory=async()=>({answer:'WhatsApp context received.'}))=>{
   await service();const messageId=randomUUID();await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
   return createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},providerFactory:()=>provider,agentFactory,logger,replyStore:null})({workspaceId,ownerId,customerId:ownerCustomer,phone,messageId,message});
  };
  await t.test('web → WhatsApp → web uses the same persisted thread, ignoring forged browser history',async()=>{
   assert.equal((await ask('hello')).code,200);
   const reply=await wa('Continue from the web',async({history})=>{assert.ok(history.some(x=>x.content==='hello'));assert.ok(history.every(x=>!x.content.includes('FORGED')));return {answer:'We discussed invoice INV-001 on WhatsApp.'};});
   assert.match(reply.answer,/INV-001/);
   const loaded=await api('assistant-history',{},'GET');assert.equal(loaded.code,200);assert.ok(loaded.data.turns.some(x=>x.content===reply.answer));
   await service();await db.query("insert into whatsapp_conversation_turns(workspace_id,customer_id,phone,role,content,audience) values($1,$2,$3,'user','PRIVATE CUSTOMER MESSAGE','customer')",[workspaceId,customer,recipient]);
   const history=await shared().read();assert.ok(history.every(x=>!x.content.includes('PRIVATE CUSTOMER')));
   await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,$3,'inbound','customer','PRIVATE ON THE OWNER PHONE','text','received','customer-same-phone')",[workspaceId,customer,phone]);
   assert.ok((await shared().read()).every(x=>!x.content.includes('PRIVATE ON THE OWNER PHONE')));
   await asUser(ownerId);const otherBusiness=(await db.query("select (create_workspace('Other business',$1)).id",[randomUUID()])).rows[0].id;
   const otherThread=createOwnerConversation({rpc:(name,args)=>f.supabase.rpc(name,args),workspaceId:otherBusiness,ownerId});
   assert.deepEqual(await otherThread.read(),[]);await otherThread.append({key:'other-business-user',role:'user',content:'OTHER BUSINESS PRIVATE'});
   assert.ok((await shared().read()).every(x=>!x.content.includes('OTHER BUSINESS PRIVATE')));

  });
  await t.test('reload preserves the signed invoice proposal and confirmation is idempotent',async()=>{
   const r=await ask('change invoice INV-001 due date to 2026-11-01');assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(r.data.pendingAction.type,'owner_correction');
   assert.equal(new Date((await invoice()).due_date).toISOString().slice(0,10),'2026-10-22');
   const loaded=await api('assistant-history',{},'GET');assert.equal(loaded.data.pending.proposalId,r.data.pendingAction.proposalId);
   const client=createAssistantClient({getAccessToken:async()=> 'token',fetchImpl:async()=>Response.json(loaded.data)});
   assert.ok((await client.load({workspaceId})).some(x=>x.pendingAction?.confirmationToken));
   const done=await confirm(loaded.data.pending);assert.equal(done.code,200,JSON.stringify(done.data));assert.equal(done.data.updated,true);
   assert.equal((await confirm(loaded.data.pending)).data.replayed,true);
   assert.equal(new Date((await invoice()).due_date).toISOString().slice(0,10),'2026-11-01');
  });
  await t.test('customer corrections show the business name without exposing internal identifiers',async()=>{
   const r=await ask('change invoice INV-001 customer to John Smith');assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(r.data.pendingAction.type,'owner_correction');assert.match(r.data.answer,/Customer: John Smith/);assert.doesNotMatch(r.data.answer,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);assert.equal((await confirm(r.data.pendingAction,false)).code,200);
  });
  await t.test('payments need a distinct confirmation, preserve exact amount and can be confirmed on WhatsApp',async()=>{
   await service();await db.query("update invoices set metadata=metadata||'{\"printed_invoice_number\":\"PRINT-001\"}'::jsonb where id=$1",[invoiceId]);
   const r=await ask('record USD 25 payment for invoice PRINT-001');assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(r.data.pendingAction.type,'owner_payment');
   assert.equal(Number((await invoice()).amount_paid),0);
   const reply=await wa('yes');assert.match(reply.answer,/Recorded USD 25/);
   assert.equal(Number((await invoice()).amount_paid),25);
   assert.equal((await confirm(r.data.pendingAction)).data.replayed,true);
   const tampered=await confirm({...r.data.pendingAction,confirmationToken:r.data.pendingAction.confirmationToken+'x'});assert.equal(tampered.code,400);
  });
  await t.test('partial payments compare exact decimal cents at a floating-point boundary',async()=>{
   await service();const edge=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'EDGE','2026-10-01','2026-12-01','USD',27.58,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[workspaceId,customer])).rows[0].id;
   await db.query("update invoices set invoice_number='MONEY-EDGE' where id=$1",[edge]);
   const first=await ask('record USD 15.03 payment for invoice MONEY-EDGE');assert.equal((await confirm(first.data.pendingAction)).code,200);
   const rest=await ask('record USD 12.55 payment for invoice MONEY-EDGE');assert.equal(rest.data.pendingAction.type,'owner_payment');assert.equal((await confirm(rest.data.pendingAction)).code,200);
   await service();const row=(await db.query('select amount_paid,status from invoices where id=$1',[edge])).rows[0];assert.equal(Number(row.amount_paid),27.58);assert.equal(row.status,'paid');
  });
  await t.test('schedule reads and updates require confirmation and cancel survives reload',async()=>{
   assert.match((await ask('show follow-up schedule')).data.answer,/Days between reminders: 3/);
   const r=await ask('set follow-up cadence to every 7 days');assert.equal(r.data.pendingAction.type,'owner_schedule');
   const other=await ask('create an invoice for Bluebird for USD 40 due 2026-12-01');assert.equal(other.data.pendingAction,null);assert.match(other.data.answer,/Finish or cancel/);assert.equal((await api('assistant-history',{},'GET')).data.pending.proposalId,r.data.pendingAction.proposalId);
   assert.equal((await confirm(r.data.pendingAction,false)).code,200);
   assert.equal((await api('assistant-history',{},'GET')).data.pending,null);
   const again=await ask('set follow-up cadence to every 7 days');assert.equal((await confirm(again.data.pendingAction)).code,200);
   assert.match((await ask('show follow-up schedule')).data.answer,/Days between reminders: 7/);
  });
  await t.test('web and native WhatsApp proposals cannot create two outstanding owner approvals',async()=>{
   const r=await ask('set follow-up cadence to every 8 days');assert.equal(r.data.pendingAction.type,'owner_schedule');
   const reply=await wa('change invoice INV-001 notes to Revised',async({tools})=>{
    const blocked=await tools.execute('workspaceData',{operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-001'}],values:{notes:'Revised'}});
    assert.equal(blocked.code,'PENDING');return {answer:blocked.message};
   });assert.match(reply.answer,/saved Assistant proposal/);
   await service();
   const insertNative=(customerId,recipientPhone)=>db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,action,source) values($1,$2,$3,'{\"type\":\"invoice_review_draft\",\"stage\":\"proposal\"}','whatsapp') returning id",[workspaceId,customerId,recipientPhone]);
   await assert.rejects(()=>insertNative(ownerCustomer,phone),/pending owner approval/);
   const separate=(await insertNative(customer,recipient)).rows[0].id;
   assert.equal((await api('assistant-history',{},'GET')).data.pending.proposalId,r.data.pendingAction.proposalId);
   assert.equal((await confirm(r.data.pendingAction,false)).code,200);
   await service();const native=(await insertNative(ownerCustomer,phone)).rows[0].id;
   const blocked=await ask('set follow-up cadence to every 8 days');assert.equal(blocked.data.pendingAction,null);assert.match(blocked.data.answer,/Finish or cancel/);
   await service();await db.query('delete from whatsapp_pending_actions where id in ($1,$2)',[native,separate]);
  });
  await t.test('reminder preview, approve and send-now share consent and fresh eligibility gates',async()=>{
   const r=await ask('show reminder preview for INV-001');assert.equal(r.code,200,JSON.stringify(r.data));assert.equal(r.data.pendingAction.type,'owner_reminder');assert.match(r.data.answer,/Delivery form/);
   assert.notEqual((await invoice()).followup_state,'approved');
   assert.equal((await confirm(r.data.pendingAction)).code,200);
   const approved=await invoice();assert.equal(approved.followup_state,'approved');assert.equal(approved.metadata.approved_reminder_delivery.type,'template');
   const send=await ask('send reminder for INV-001 now');assert.equal(send.data.pendingAction.type,'owner_reminder');
   await service();await db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,'stop')",[workspaceId,recipient]);
   const blocked=await confirm(send.data.pendingAction);assert.equal(blocked.code,409);assert.equal(blocked.data.error,'suppressed');
   await confirm(send.data.pendingAction,false);
   const stopped=await ask('send reminder for INV-001 now');assert.equal(stopped.data.pendingAction,null);assert.match(stopped.data.answer,/stopped/);
   await service();await db.query('delete from whatsapp_suppressions where workspace_id=$1 and phone=$2',[workspaceId,recipient]);
   const fresh=await ask('send reminder for INV-001 now');assert.equal((await confirm(fresh.data.pendingAction)).code,200);
   assert.equal((await invoice()).metadata.approved_reminder_delivery.body,fresh.data.answer.split('\n\n')[1]);
   assert.equal((await db.query("select count(*)::int n from whatsapp_messages where direction='outbound' and audience='customer'")).rows[0].n,0);
  });
  await t.test('the final SQL reservation independently rejects an unapproved outgoing form',async()=>{
   await service();const scope={workspaceId,ownerId,invoiceId};
   const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:'fixture',fetchImpl:f.fetchImpl});
   const approved=(await invoice()).metadata.approved_reminder_delivery;
   await db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Please pay soon\n\nShared business'),next_follow_up_at=now()-interval '1 minute' where id=$1",[invoiceId]);
   const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
   const settings=await store.getWorkspacePreferences(scope),row=await store.getInvoice(scope);
   const authorization=await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at});assert.equal(authorization.authorized,true);
   const consent=(await db.query('select * from whatsapp_consents where workspace_id=$1 and customer_id=$2',[workspaceId,customer])).rows[0];
   const client=(await db.query('select * from customers where id=$1',[customer])).rows[0];
   const entry=selectInvoiceReminderTemplate(settings.follow_up_preferences,client.reminder_tone??null);
   const snapshot={invoiceId,customerId:customer,phone:recipient,body:approved.body,delivery:approved,invoiceVersion:row.automation_version,invoiceUpdatedAt:row.updated_at,preferencesUpdatedAt:settings.updated_at,consentId:consent.id,consentCreatedAt:new Date(consent.created_at).toISOString(),template:{name:entry.name,language:entry.language,revision:entry.revision,body:entry.body,wabaId:'1734116767674237',phoneNumberId:'1234567890',parameters:approved.parameters},defaultDraft:buildDefaultInvoiceReminderDraft({invoice:row,settings,customer:client})};
   const gate=await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{p_owner_id:ownerId,p_workspace_id:workspaceId,p_claim_id:claim.id,p_snapshot:snapshot,p_snapshot_hash:reminderFingerprint(snapshot)});
   assert.equal(gate.error,null,JSON.stringify(f.errors));assert.equal(gate.data.authorized,false);assert.equal(gate.data.reason,'needs_re_review');assert.equal(graph.length,0);
   assert.equal((await invoice()).metadata.reminder_review_reason,'delivery_form_review');
   await store.markDeliveryFailed({...scope,claimId:claim.id,token:authorization.token,unknown:false,error:'needs_re_review'});
  });
  await t.test('free-form approvals never silently become templates, including expired/unknown windows and retries',async()=>{
   await service();
   const scope={workspaceId,ownerId,invoiceId};
   const sendEnv={NODE_ENV:'test',SUPABASE_URL:env.SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:'fixture-key',WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:recipient,WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
   const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:'fixture-key',fetchImpl:f.fetchImpl});
   const runtime=createAutomationRuntime({env:sendEnv,store,supabase:f.supabase,fetchImpl:f.fetchImpl});
   for(const window of ['expired','unknown']){
    await db.query("delete from whatsapp_messages where workspace_id=$1 and audience='customer' and phone=$2",[workspaceId,recipient]);
    if(window==='expired')await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key,created_at) values($1,$2,$3,'inbound','customer','Hello','text','received','expired-window-fixture',now()-interval '48 hours')",[workspaceId,customer,recipient]);
    await db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Please pay soon\n\nShared business','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)),next_follow_up_at=now()-interval '1 minute' where id=$1",[invoiceId,workspaceId]);
    const result=await runtime.tick(scope);assert.equal(result.results[0].status,'needs_re_review',window+JSON.stringify({result,errors:f.errors}));
    assert.equal(graph.length,0);assert.equal((await invoice()).followup_state,'paused');
    await runtime.tick(scope);assert.equal(graph.length,0,'a retry cannot authorize a different form');
   }
   const fresh=await ask('send reminder for INV-001 now');assert.equal((await confirm(fresh.data.pendingAction)).code,200);
   const approved=(await invoice()).metadata.approved_reminder_delivery;
   const sent=await runtime.tick(scope);assert.equal(sent.results[0].status,'sent',JSON.stringify({sent,errors:f.errors}));assert.equal(graph.length,1);
   assert.equal(graph[0].type,approved.type);assert.equal(graph[0].template.name,approved.name);assert.deepEqual(graph[0].template.components[0].parameters.map(p=>p.text),approved.parameters);
   await runtime.tick(scope);assert.equal(graph.length,1);
  });
  await t.test('stale invoice proposals and cross-account reads fail closed; RLS denies another owner',async()=>{
   const r=await ask('change invoice INV-001 due date to 2026-12-01');await service();await db.query("update invoices set notes='concurrent edit' where id=$1",[invoiceId]);
   assert.equal((await confirm(r.data.pendingAction)).data.error,'STALE');await confirm(r.data.pendingAction,false);
   actor=otherOwner;assert.equal((await api('assistant-history',{},'GET')).code,403);
   await asUser(otherOwner);await db.exec('set role authenticated');assert.equal((await db.query('select * from owner_assistant_turns where workspace_id=$1',[workspaceId])).rows.length,0);
   await assert.rejects(db.query('select owner_assistant_history($1,$2)',[workspaceId,ownerId]),/owner required/);actor=ownerId;
  });
  await t.test('a signed legacy paid-status token cannot let an admin bypass owner-only payment recording',async()=>{
   await service();await db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspaceId,otherOwner]);actor=otherOwner;
   const confirmationToken=createAccountingActionToken({action:'update_invoice',payload:{invoiceId,changes:{status:'paid'},idempotencyKey:'admin_payment_attempt_123'},userId:otherOwner,workspaceId,secret:env.AI_ACCOUNTING_CONFIRMATION_SECRET});
   const denied=await api('confirm-accounting-action',{confirmed:true,confirmationToken});assert.equal(denied.code,403);assert.equal(denied.data.error,'OWNER_REQUIRED');
   assert.equal(Number((await invoice()).amount_paid),25);actor=ownerId;
  });
  await t.test('existing create proposals survive reload, reject a canceled token and accept a later chat yes',async()=>{
   const proposal=await ask('create an invoice for Bluebird for USD 40 due 2026-12-01');assert.equal(proposal.code,200,JSON.stringify(proposal.data));assert.equal(proposal.data.pendingAction.type,'create_invoice');
   const loaded=await api('assistant-history',{},'GET');assert.ok(loaded.data.turns.some(t=>t.pending_action?.confirmationToken===proposal.data.pendingAction.confirmationToken));
   assert.equal((await confirm(proposal.data.pendingAction,false)).code,200);assert.equal((await confirm(proposal.data.pendingAction)).code,409);
   const fresh=await ask('create an invoice for Bluebird for USD 40 due 2026-12-01');assert.equal(fresh.data.pendingAction.type,'create_invoice');
   const done=await ask('yes');assert.equal(done.code,200,JSON.stringify(done.data));assert.match(done.data.answer,/Saved invoice/);
   await service();assert.equal((await db.query("select count(*)::int n from invoices where workspace_id=$1 and metadata->>'assistant_idempotency_key'=$2",[workspaceId,fresh.data.pendingAction.payload.idempotencyKey])).rows[0].n,1);
   assert.equal((await confirm(fresh.data.pendingAction)).data.replayed,true);
  });
  await t.test('reviewed photo/PDF invoice saves persist a shared receipt for the next WhatsApp turn',async()=>{
   const invoice={direction:'receivable',invoiceNumber:'PHOTO-REVIEWED',clientName:'Photo Customer',invoiceDate:'2026-10-01',dueDate:'2026-12-01',total:50,subtotal:50,tax:0,outstanding:50,currency:'USD',lineItems:[],alreadyPaid:false};
   const saved=await api('save-invoice',{confirmed:true,idempotencyKey:'photo_reviewed_shared_123',invoice,conversationSource:'assistant'});assert.equal(saved.code,200,JSON.stringify(saved.data));
   assert.equal(saved.data.saved,true);
   const reply=await wa('Continue after the photo review',async({history})=>{assert.ok(history.some(t=>t.content.includes(saved.data.invoice.invoiceNumber)&&t.content.includes('reviewed')));return {answer:'The reviewed photo invoice is in context.'};});assert.match(reply.answer,/in context/);
  });
  await t.test('expired proposals and a missing migration fail closed before model work or changes',async()=>{
   const proposal=await ask('set follow-up cadence to every 8 days');assert.equal(proposal.data.pendingAction.type,'owner_schedule');
   await service();await db.query("update owner_assistant_proposals set expires_at=now()-interval '1 minute' where id=$1",[proposal.data.pendingAction.proposalId]);
   assert.equal((await confirm(proposal.data.pendingAction)).data.error,'EXPIRED');
   const before=Number((await invoice()).total_amount);
   f.intercept(async url=>{if(url.pathname.endsWith('/rpc/owner_assistant_history'))throw Error('Migration not installed');});
   const unavailable=await ask('change invoice INV-001 total to USD 5');f.intercept(null);assert.equal(unavailable.code,503);assert.equal(Number((await invoice()).total_amount),before);
   invalidHistory=true;assert.equal((await ask('What is overdue?')).code,503);invalidHistory=false;
  });
  await t.test('last twenty turns are shared across channel changes without retaining customer messages',async()=>{
   await service();for(let i=0;i<24;i++)await shared().append({key:'cap:'+i,role:i%2?'assistant':'user',content:'cap '+i});
   const r=await api('assistant-history',{},'GET');assert.equal(r.data.turns.length,20);assert.equal(r.data.turns[0].content,'cap 4');assert.equal(r.data.turns.at(-1).content,'cap 23');
  });
  assert.equal(planned,0);
 }finally{await f.close();}
});
