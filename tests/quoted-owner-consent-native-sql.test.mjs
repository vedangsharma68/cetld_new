import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerReplyStore} from '../automation/whatsapp/owner-reply-store.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {SupabaseInboundInbox,parseMetaMessages,createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {quotedConsentDateReply,QUOTED_TARGET_CLARIFICATION} from '../automation/whatsapp/owner-quoted-consent.mjs';
import {normalizeOwnerReceiptRef} from '../automation/whatsapp/owner-receipt-ref.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {getSendEligibility,resolveActiveBindings,revokeConsentForPhone} from '../automation/whatsapp/consent.mjs';

// Isolated SDK/PostgreSQL fixtures only. No live inbound, consent, or Graph call.
const quiet={info(){},warn(){},error(){}};
async function fixture(){
 const network=await createOfflineSqlNetwork(),{db,supabase}=network;
 const ownerId=randomUUID(),phone='+919871367051',env={NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-quoted-fixture',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_WABA_ID:'987654321',
  WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture-no-live-access',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (create_workspace('Quoted fixture',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
 const ownerCustomerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 const scope={workspaceId,ownerId,phone,customerId:ownerCustomerId};
 await db.query("update workspace_settings set business_name='Quoted fixture' where workspace_id=$1",[workspaceId]);
 const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Customer A') returning *",[workspaceId])).rows[0];
 const other=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Customer B','+12025550719') returning *",[workspaceId])).rows[0];
 const invoice=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
  values($1,$2,'QA-1001','2026-03-31',null,'INR',6471,'sent','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customer.id])).rows[0];
 const history=[{role:'user',content:'send a reminder for QA-1001'},{role:'assistant',content:'Customer A has no saved number.'}];
 const handler=createOwnerMessageHandler({supabase,env,logger:quiet,historyReader:async()=>history,
  providerFactory:()=>({}),agentFactory:async()=>{throw Error('bounded quote/phone path must not call a model');}});
 const inbox=new SupabaseInboundInbox(supabase,{env});
 const event=async(message,{id=randomUUID(),context=null,timestamp=new Date().toISOString(),sender=phone}={})=>{
  await db.query(`insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,reply_context_id,provider_timestamp,status)
    values($1,'123456789',$2,'text',$3,$4,$5,'processing') on conflict(provider_message_id) do nothing`,[id,sender,message,context,timestamp]);return id;
 };
 const turn=async(message,opts={})=>{const messageId=await event(message,opts);return {messageId,...await handler({...scope,messageId,message,replyContextId:opts.context||null})};};
 const resolve=async(messageId,message,changes={})=>(await supabase.rpc('whatsapp_owner_resolve_quote',{
  p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_message_id:messageId,p_user_message:message,...changes})).data;
 const consent=async(messageId,message,target=customer.id,changes={})=>(await supabase.rpc('whatsapp_owner_record_consent',{
  p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_customer_id:target,p_contact_phone:'+12025550719',p_message_id:messageId,p_user_message:message,...changes})).data;
 const saved=await turn('+12025550719');assert.match(saved.answer,/Saved.*Customer A/);
 const receipt=(await db.query('select * from whatsapp_messages where workspace_id=$1 and idempotency_key=$2',[workspaceId,`reply:${saved.messageId}`])).rows[0];
 assert.equal(receipt.owner_receipt_ref.customerId,customer.id);assert.equal(receipt.owner_receipt_ref.invoiceId,invoice.id);
 assert.equal(receipt.customer_id,null);assert.equal(receipt.invoice_id,null,'quoted target metadata must not change the actual owner recipient');
 // Exercise the real owner-recipient scope check and receipt finish. Every
 // transport request is intercepted here; there is no live Graph connection.
 const graphCalls=[];
 const outbound=createWhatsAppOutbound({supabase,env,logger:quiet,
  authorizeInboundReply:async input=>{
   const result=await supabase.rpc('whatsapp_claim_owner_reply',{p_provider_message_id:input.messageId,p_sender_phone:input.phone,p_workspace_id:input.workspaceId});
   assert.equal(result.error,null);return {allowed:result.data===true};
  },
  fetchImpl:async(url,init)=>{
   assert.equal(String(url),'https://graph.facebook.com/v24.0/123456789/messages');assert.equal(init.method,'POST');
   graphCalls.push(JSON.parse(init.body));return Response.json({messages:[{id:'wamid.saved-A'}]});
  }});
 const delivered=await outbound.sendServiceReply({workspaceId,to:phone,body:saved.answer,buttons:saved.buttons,
  audience:'owner',kind:'normal',businessName:'Quoted fixture',messageId:saved.messageId,lastInboundAt:new Date().toISOString()});
 assert.equal(delivered.status,'accepted',JSON.stringify(delivered));assert.equal(graphCalls.length,1);
 const accepted=(await db.query('select * from whatsapp_messages where id=$1',[receipt.id])).rows[0];
 assert.equal(accepted.provider_message_id,'wamid.saved-A');assert.equal(accepted.owner_receipt_ref.customerId,customer.id);
 assert.equal(accepted.customer_id,null);assert.equal(accepted.invoice_id,null);
 history.push({role:'user',content:'Is that phone saved elsewhere?'},{role:'assistant',content:'That phone is also saved for Customer B.'});
 return {...network,scope,env,handler,inbox,customer,other,invoice,receipt,event,turn,resolve,consent,history};
}

test('quoted agreement resolves A despite intervening B; collisions preserve B, original words and unknown due',async()=>{
 const f=await fixture(),{db,supabase,scope,customer,other,invoice}=f;
 try{
  // Simulate the real shared-phone arrangement: the active grant belongs to B.
  await db.query('update whatsapp_consents set customer_id=$1 where workspace_id=$2 and phone=$3',[other.id,scope.workspaceId,'+12025550719']);
  const before=(await db.query('select to_jsonb(c) v from whatsapp_consents c where workspace_id=$1 order by id',[scope.workspaceId])).rows;
  const invoiceBefore=(await db.query('select to_jsonb(i) v from invoices i where id=$1',[invoice.id])).rows;
  const message='they approve, send them a reminder (the invoice is due tommrow)';
  const result=await f.turn(message,{context:'wamid.saved-A'});
  assert.match(result.answer,/consent for Customer B; it does not cover Customer A/);
  assert.match(result.answer,/Repeating the confirmation will not resolve/);assert.match(result.answer,/No consent or phone was changed/);
  assert.match(result.answer,/saved due date is not shown/);assert.ok(result.answer.includes('set invoice '+invoice.invoice_number+' due date to '));
  assert.match(result.answer,/approve its exact wording; no reminder was sent/);
  const target=await f.resolve(result.messageId,message);assert.equal(target.customerId,customer.id);assert.equal(target.invoiceId,invoice.id);assert.equal(target.relativeDue,true);
  assert.deepEqual((await db.query('select to_jsonb(c) v from whatsapp_consents c where workspace_id=$1 order by id',[scope.workspaceId])).rows,before);
  assert.deepEqual((await db.query('select to_jsonb(i) v from invoices i where id=$1',[invoice.id])).rows,invoiceBefore);
  assert.equal((await getSendEligibility({supabase,workspaceId:scope.workspaceId,phone:'+12025550719'})).customer.id,other.id,'B eligibility is never consent for A');
  assert.equal((await db.query('select message_text from whatsapp_inbound_events where provider_message_id=$1',[result.messageId])).rows[0].message_text,message);
  assert.equal((await db.query("select count(*)::int n from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null",[scope.workspaceId])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id=$1',[result.messageId])).rows[0].n,0);
  const again=await f.turn(message,{context:'wamid.saved-A',id:result.messageId});assert.equal(again.replayed,true);assert.equal(again.answer,result.answer);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('affirmative clause records scoped evidence once, does not approve a reminder or change null due',async()=>{
 const f=await fixture(),{db,scope,customer,invoice}=f;
 try{
  const message='they approve, send them a reminder (the invoice is due tomorrow)';
  const result=await f.turn(message,{context:'wamid.saved-A'});assert.match(result.answer,/Recorded reminder consent for Customer A/);
  const receipt=(await db.query('select * from whatsapp_direct_write_receipts where provider_message_id=$1',[result.messageId])).rows[0];
  assert.equal(receipt.request.customerId,customer.id);assert.equal(receipt.request.message,message);
  assert.equal((await f.consent(result.messageId,message)).replayed,true);
  const [a,b]=await Promise.all([f.consent(result.messageId,message),f.consent(result.messageId,message)]);
  assert.equal(a.replayed,true);assert.equal(b.replayed,true);
  assert.equal((await db.query('select count(*)::int n from whatsapp_direct_write_receipts where provider_message_id=$1',[result.messageId])).rows[0].n,1);
  const current=(await db.query('select * from invoices where id=$1',[invoice.id])).rows[0];
  assert.equal(current.due_date,null);assert.equal(current.next_follow_up_at,null);assert.equal(current.metadata.approved_reminder_text??null,null);
  assert.equal((await db.query('select count(*)::int n from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null',[scope.workspaceId])).rows[0].n,0);
  for(const text of [
   'approve','yes','they approve',
   'do they approve, send them a reminder (the invoice is due tomorrow)',
   'they do not approve, send them a reminder (the invoice is due tomorrow)',
   'they approve? send them a reminder (the invoice is due tomorrow)',
   'if they approve, send them a reminder (the invoice is due tomorrow)',
   'they approved yesterday, send them a reminder (the invoice is due tomorrow)',
   'they said they approve, send them a reminder (the invoice is due tomorrow)',
   '“they approve”, send them a reminder (the invoice is due tomorrow)',
   "'they agreed to reminders', send them a reminder (the invoice is due tomorrow)",
   'they approve, send them a reminder if the invoice is due tomorrow',
   'Customer B agreed to reminders, send them a reminder (the invoice is due tomorrow)',
   'Customer A agreed to reminders last week',
   'Customer A agreed to reminders unless they change their mind',
   'Customer A agreed to reminders in 2025',
   'I heard Customer A agreed to reminders',
   '‘Customer A agreed to reminders',
   '`Customer A agreed to reminders',
   'Customer B agreed to reminders on +12025550719',
  ]){
   const id=await f.event(text,{context:'wamid.saved-A'}),before=(await db.query('select to_jsonb(c) v from whatsapp_consents c where customer_id=$1',[customer.id])).rows;
   const rejected=await f.consent(id,text);assert.equal(rejected.ok,false,text+JSON.stringify(rejected));
   assert.deepEqual((await db.query('select to_jsonb(c) v from whatsapp_consents c where customer_id=$1',[customer.id])).rows,before,text);
  }
  const forged=await f.event(message,{context:'wamid.saved-A'});
  assert.equal((await f.consent(forged,message,customer.id,{p_user_message:message+' forged'})).code,'DENIED');
  assert.equal((await f.consent(forged,message,f.other.id)).ok,false);
  assert.equal((await f.consent(forged,message,customer.id,{p_owner_id:randomUUID()})).code,'DENIED');
  for(const word of ['yes','approve']){
   const result=await f.turn(word,{context:'wamid.saved-A'});
   assert.match(result.answer,/isn't consent or reminder approval/);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('quote scope, age, current versions and bot provenance reject unbound or foreign receipts',async()=>{
 const f=await fixture(),{db,scope}=f;
 try{
  const text='they approve, send them a reminder (the invoice is due tommrow)';
  for(const context of ['does-not-exist','wamid.user-message']){
   const id=await f.event(text,{context});assert.equal((await f.resolve(id,text)).ok,false);
   assert.equal((await f.turn(text,{id,context})).answer,QUOTED_TARGET_CLARIFICATION);
  }
  const id=await f.event(text,{context:'wamid.saved-A'});
  for(const changes of [{p_workspace_id:randomUUID()},{p_owner_id:randomUUID()},{p_phone:'+12025550702'},{p_user_message:text+' forged'}])
   assert.equal((await f.resolve(id,text,changes)).ok,false);
  const base=(await db.query('select * from whatsapp_messages where id=$1',[f.receipt.id])).rows[0];
  for(const patch of [
   {owner_receipt_ref:null},{direction:'inbound',owner_receipt_ref:null},{audience:'customer',owner_receipt_ref:null},
   {phone:'+12025550702'}, {status:'pending'}, {kind:'ack',owner_receipt_ref:null},
   {owner_receipt_ref:{...base.owner_receipt_ref,ownerId:randomUUID()}},
   {owner_receipt_ref:{...base.owner_receipt_ref,sourceMessageId:'fabricated-source'}},
   {created_at:new Date(Date.now()-25*3600_000).toISOString()},
  ]){
   const keys=Object.keys(patch);await db.query('update whatsapp_messages set '+keys.map((k,j)=>k+'=$'+(j+1)).join(',')+' where id=$'+(keys.length+1),[...Object.values(patch).map(v=>v&&typeof v==='object'?JSON.stringify(v):v),base.id]);
   assert.equal((await f.resolve(id,text)).ok,false,JSON.stringify(patch));
   await db.query('update whatsapp_messages set owner_receipt_ref=$1,direction=$2,audience=$3,phone=$4,status=$5,kind=$6,created_at=$7 where id=$8',[
    JSON.stringify(base.owner_receipt_ref),base.direction,base.audience,base.phone,base.status,base.kind,base.created_at,base.id]);
  }
  await db.exec('begin');
  await db.query('update invoices set customer_id=$1 where id=$2',[f.other.id,f.invoice.id]);
  assert.equal((await f.resolve(id,text)).code,'STALE_QUOTE_BINDING');
  await db.query('update invoices set customer_id=$1 where id=$2',[f.customer.id,f.invoice.id]);
  assert.equal((await f.resolve(id,text)).ok,false,'even rebound-back receipt is stale');
  await db.exec('rollback');
  assert.equal((await f.resolve(id,text)).ok,true);
  await db.exec('begin');
  await db.query('update customers set phone=$1 where id=$2',['+12025550718',f.customer.id]);
  assert.equal((await f.resolve(id,text)).code,'STALE_QUOTE_BINDING');
  await db.query('update customers set phone=$1 where id=$2',['+12025550719',f.customer.id]);
  assert.equal((await f.resolve(id,text)).code,'STALE_QUOTE_BINDING','changing the phone back cannot revive the old receipt');
  assert.equal((await f.consent(id,text)).ok,false);
  await db.exec('rollback');
  const privileges=(await db.query("select has_function_privilege('anon','public.whatsapp_owner_resolve_quote(uuid,uuid,text,text,text)','execute') a,has_function_privilege('authenticated','public.whatsapp_owner_resolve_quote(uuid,uuid,text,text,text)','execute') u,has_function_privilege('service_role','public.whatsapp_owner_resolve_quote(uuid,uuid,text,text,text)','execute') s")).rows[0];
  assert.deepEqual(privileges,{a:false,u:false,s:true});
  // A supported local lifecycle deletion invalidates even an otherwise current
  // receipt. Do not disable lifecycle triggers to create this test state.
  assert.equal((await f.resolve(id,text)).ok,true);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${scope.ownerId}'`);
  const proposal=(await db.query("select invoice_lifecycle_action(p_action=>'prepare',p_workspace_id=>$1,p_invoice_id=>$2,p_idempotency_key=>$3) v",[scope.workspaceId,f.invoice.id,randomUUID()])).rows[0].v;
  assert.equal(proposal.ok,true,JSON.stringify(proposal));
  const deleted=(await db.query("select invoice_lifecycle_action(p_action=>'confirm',p_workspace_id=>$1,p_proposal_id=>$2,p_user_message=>$3,p_confirmation_message_id=>$4) v",[scope.workspaceId,proposal.proposalId,proposal.requiresExactConfirmation?'DELETE '+proposal.invoiceNumber:'yes',randomUUID()])).rows[0].v;
  assert.equal(deleted.ok,true,JSON.stringify(deleted));
  await db.exec("set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await f.resolve(id,text)).code,'STALE_QUOTE_BINDING');
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('signed text ingress retains reply context unchanged through durable duplicates and retries',async()=>{
 const f=await fixture();
 try{
  const text='they approve, send them a reminder (the invoice is due tomorrow)',id='wamid.signed-quote';
  const payload=context=>({object:'whatsapp_business_account',entry:[{id:f.env.WHATSAPP_WABA_ID,changes:[{field:'messages',value:{metadata:{phone_number_id:f.env.WHATSAPP_PHONE_NUMBER_ID},
   messages:[{id,from:f.scope.phone.slice(1),type:'text',text:{body:text},timestamp:String(Math.floor(Date.now()/1000)),context:{id:context}}]}}]}]});
  const tasks=[],runtime={enqueue:messages=>f.inbox.enqueue(messages),processPending:async()=>({claimed:0,completed:0})};
  const webhook=createWhatsAppWebhookHandler({env:f.env,runtime,logger:quiet,waitUntil:task=>tasks.push(task)});
  const deliver=async(context,valid=true)=>{
   const raw=Buffer.from(JSON.stringify(payload(context))),req=Readable.from([raw]);req.method='POST';req.headers={'x-hub-signature-256':'sha256='+createHmac('sha256',valid?f.env.WHATSAPP_APP_SECRET:'wrong-fixture').update(raw).digest('hex')};
   const response={setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
   await webhook(req,response);return response;
  };
  assert.equal((await deliver('forged',false)).statusCode,403);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0].n,0);
  assert.equal((await deliver('wamid.saved-A')).statusCode,200);
  assert.equal((await deliver('different-quote')).statusCode,200);await Promise.all(tasks);
  const stored=(await f.db.query('select * from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];
  assert.equal(stored.reply_context_id,'wamid.saved-A');assert.equal(stored.message_text,text);
  const claimed=(await f.inbox.claim(100)).find(e=>e.provider_message_id===id);assert.equal(claimed.reply_context_id,'wamid.saved-A');
  await f.inbox.defer(claimed,'fixture-retry');await f.db.query('update whatsapp_inbound_events set next_attempt_at=now() where id=$1',[claimed.id]);
  const retry=(await f.inbox.claim(100)).find(e=>e.provider_message_id===id);assert.equal(retry.reply_context_id,'wamid.saved-A');
  let forwarded;
  const inbound=createInboundRuntime({supabase:f.supabase,inbox:{...f.inbox,claim:async()=>[retry],beginOwnerJob:async()=>{},checkpoint:async()=>{},complete:async()=>{}},env:f.env,
   logger:quiet,onOwnerMessage:async input=>{forwarded=input;return {answer:'Fixture reply'};},outbound:{sendTypingIndicator:async()=>{},sendServiceReply:async()=>({status:'accepted'})}});
  await inbound.processPending();assert.equal(forwarded.replyContextId,'wamid.saved-A');assert.equal(forwarded.messageTimestamp,retry.provider_timestamp);
  for(const context of [{id:'x'.repeat(257)},{id:42},{id:''}]){
   const p=payload('unused');p.entry[0].changes[0].value.messages[0].context=context;
   assert.equal(parseMetaMessages(p,f.env.WHATSAPP_PHONE_NUMBER_ID,f.env.WHATSAPP_WABA_ID)[0].reply_context_id,undefined);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('phone-wide suppression/revocation still blocks both shared customers and cannot be revived by a quote',async()=>{
 const f=await fixture();
 try{
  await f.db.query('update whatsapp_consents set customer_id=$1 where workspace_id=$2 and phone=$3',[f.other.id,f.scope.workspaceId,'+12025550719']);
  await revokeConsentForPhone({supabase:f.supabase,workspaceId:f.scope.workspaceId,phone:'+12025550719',via:'stop'});
  const text='they approve, send them a reminder (the invoice is due tomorrow)',id=await f.event(text,{context:'wamid.saved-A'});
  assert.equal((await f.consent(id,text)).ok,false);
  assert.equal((await getSendEligibility({supabase:f.supabase,workspaceId:f.scope.workspaceId,phone:'+12025550719'})).allowed,false);
  assert.deepEqual(await resolveActiveBindings({supabase:f.supabase,phone:'+12025550719'}),[]);
  await f.db.query("insert into whatsapp_global_suppressions(phone) values('+12025550719') on conflict do nothing");
  assert.equal((await f.consent(await f.event(text,{context:'wamid.saved-A'}),text)).code,'globally_suppressed');
 }finally{await f.close();}
});

test('relative due dates use original owner-local calendar including DST/month rollover; missing timestamp stays unknown',()=>{
 for(const [timestamp,timezone,expected] of [
  ['2026-10-24T20:00:00Z','Asia/Kolkata','2026-10-26'],
  ['2026-10-31T23:30:00Z','America/New_York','2026-11-01'],
  ['2026-12-31T23:30:00Z','Asia/Kolkata','2027-01-02'],
 ])assert.match(quotedConsentDateReply({relativeDue:true,invoiceId:'fixture',invoiceNumber:'QA-1001',dueDate:null,messageTimestamp:timestamp},timezone),new RegExp(expected));
 assert.match(quotedConsentDateReply({relativeDue:true,invoiceId:'fixture',messageTimestamp:null},'Asia/Kolkata'),/exact due date/);
 assert.equal(normalizeOwnerReceiptRef({kind:'customer_phone_saved',customerId:'forged'}),null);
});
