import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerActionButtons} from '../automation/whatsapp/owner-action-buttons.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {parsePdfInvoiceText} from '../ai/pdf-invoice-parser.mjs';
import {validateInvoiceExtractionResponse} from '../ai/extraction.mjs';
import {reviewDraft} from '../automation/whatsapp/assistant-handler.mjs';
import {freightInvoiceText} from './fixtures/freight-invoice-text.mjs';

const logger={info(){},warn(){},error(){}};
const env={WHATSAPP_APP_SECRET:'isolated-intake-fixture-secret'};

test('owner intake repairs and exact proposal buttons run through real handler, SDK and PostgreSQL',async t=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f;
 try{
  await db.exec(await readFile(new URL('../supabase/migrations/20261018060000_customer_reminder_tone.sql',import.meta.url),'utf8'));
  const ownerId=randomUUID(),phone='+12025550177';
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Intake regression',$1)).id",[randomUUID()])).rows[0].id;
  const {code}=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) result',[phone,code])).rows[0].result.ok,true);
  const customerId=(await db.query('select customer_id from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const scope={workspaceId,ownerId,phone,customerId};
  let plannerCalls=0,sequence=0;
  const provider={async generate(){plannerCalls++;throw Error('Intake repair/decision must bypass record lookup and planner');}};
  const handle=createOwnerMessageHandler({supabase,env,logger,authorize:async()=>true,providerFactory:()=>provider});
  const extracted=validateInvoiceExtractionResponse(parsePdfInvoiceText(freightInvoiceText,{businessName:'INTERNATIONAL PARCEL SERVICES'}));
  const base=reviewDraft(extracted,'source-pdf');
  const invoice=base.invoice;
  async function draft(action){
   await db.query('update whatsapp_pending_actions set consumed_at=now() where workspace_id=$1 and phone=$2 and consumed_at is null',[workspaceId,phone]);
   const row=(await db.query(`insert into whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,version,generation,expires_at)
     values($1,$2,$3,$4,'whatsapp',1,1,now()+interval '15 minutes') returning *`,[workspaceId,customerId,phone,JSON.stringify(action)])).rows[0];
   return JSON.parse(JSON.stringify(row));
  }
  async function inbound(message,interactionId,process=true){
   const messageId='intake-regression-'+(++sequence);
   await db.query(`insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status)
    values($1,'fixture',$2,'text',$3,'processing')`,[messageId,phone,message]);
   await db.query(`insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key)
    values($1,$2,'inbound','owner',$3,'text','received',$4,$4)`,[workspaceId,phone,message,messageId]);
   if(!process)return messageId;
   return handle({...scope,message,messageId,...(interactionId?{interactionId}:{} )});
  }
  const pending=createWhatsAppPendingActionStore({supabase});
  await t.test('full and terse repair messages persist both fields and re-render Confirm/Cancel',async()=>{
   for(const message of ['Invoice number is CR-25260643. The invoice shows no due date.','CR-25260643, no due date']){
    const row=await draft({...base,invoice:{...invoice,invoiceNumber:null},missingFields:['invoiceNumber','dueDate']});
    const result=await inbound(message);
    assert.equal(result.plannerFailure,undefined,JSON.stringify(result));
    assert.match(result.answer,/CR-25260643/);assert.match(result.answer,/due not shown/);assert.match(result.answer,/Confirm or Cancel/);
    assert.deepEqual(result.buttons?.map(b=>b.title),['Confirm','Cancel']);
    assert.doesNotMatch(result.answer,/Reply yes|No matching|invalid|unsupported/);
    const current=(await db.query('select * from whatsapp_pending_actions where id=$1',[row.id])).rows[0];
    assert.equal(current.version,2);assert.equal(current.action.stage,'proposal');assert.equal(current.action.invoice.dueDate,null);
    assert.deepEqual(current.action.missingFields,[]);assert.equal(current.action.ownerProvidedFacts.dueDate.value,null);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);
   }
  });
  await t.test('new extraction proposal also uses buttons in direct mode',async()=>{
   const row=await draft({...base,stage:'proposal'});
   const tools=createOwnerWorkspaceTools({supabase,scope,message:'Log this invoice',messageId:'new-extraction',pending,pendingAtStart:row,
    media:{bytes:Buffer.from('isolated PDF fixture'),mimeType:'application/pdf',fileName:'fixture.pdf'},
    extractAttachment:async()=>structuredClone(extracted),providerFactory:()=>provider,
    pendingStoreAvailable:true,interactiveAvailable:true,env,clock:()=>new Date(),authorize:async()=>true,
    botPreferences:{confirmationMode:'direct'},ownerStore:{query:async()=>[]}});
   const result=await tools.execute('workspaceData',{operation:'saveAttachment'});
   assert.equal(result.outcome,'review_ready',JSON.stringify(result));
   assert.equal(result.review.stage,'proposal');assert.equal(result.review.invoice.dueDate,null);
   assert.equal(tools.getReplyRequirement().buttonsAvailable,true);
  });
  await t.test('foreign, superseded, resolved and expired buttons never affect the current review',async()=>{
   const old=await draft({...base,stage:'proposal'});
   const [stale]=createOwnerActionButtons({scope,action:old,env});
   const current=await draft({...base,stage:'proposal'});
   for(const foreignScope of [{...scope,workspaceId:randomUUID()},{...scope,phone:'+12025550178'}]){
    const [foreign]=createOwnerActionButtons({scope:foreignScope,action:current,env});
    assert.match((await inbound('Confirm',foreign.id)).answer,/expired or changed/);
   }
   assert.match((await inbound('Confirm',stale.id)).answer,/expired or changed/);
   const [beforeChange]=createOwnerActionButtons({scope,action:current,env});
   await db.query('update whatsapp_pending_actions set version=version+1 where id=$1',[current.id]);
   assert.match((await inbound('Confirm',beforeChange.id)).answer,/expired or changed/);
   assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);
   const resolved=await draft({...base,stage:'proposal'});
   const [confirm,cancel]=createOwnerActionButtons({scope,action:resolved,env});
   const canceled=await inbound('Cancel',cancel.id);
   assert.match(canceled.answer,/cancel/i);assert.doesNotMatch(canceled.answer,/could not|unavailable/i);
   assert.equal((await db.query('select action from whatsapp_pending_actions where id=$1',[resolved.id])).rows[0].action.stage,'canceled');
   assert.match((await inbound('Confirm',confirm.id)).answer,/expired or changed/);
   const expiring=await draft({...base,stage:'proposal'});
   const [expired]=createOwnerActionButtons({scope,action:expiring,env});
   await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 second' where id=$1",[expiring.id]);
   assert.match((await inbound('Confirm',expired.id)).answer,/expired or changed/);
  });
  await t.test('confirmation saves null due date, preserves money, and repeated click is rejected',async()=>{
   const row=await draft({...base,stage:'proposal'});
   const [confirm]=createOwnerActionButtons({scope,action:row,env});
   const result=await inbound('Confirm',confirm.id);
   assert.match(result.answer,/Saved invoice CR-25260643/);assert.match(result.answer,/Due date: not shown/);
   const saved=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows[0];
   assert.equal(saved.due_date,null);assert.equal(saved.status,'draft');assert.equal(saved.metadata.next_follow_up_at,null);
   assert.equal(Number(saved.total_amount),6471);assert.deepEqual(saved.metadata.line_items.map(r=>r.amount),[5033.6,450.45]);
   assert.equal(saved.metadata.subtotal,5484.05);assert.equal(saved.metadata.tax,987.13);
   assert.match((await inbound('Confirm',confirm.id)).answer,/expired or changed/);
   assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,1);
   const engine=new FollowUpEngine({store:{getInvoice:async()=>({...saved,status:'sent',followup_state:'active',next_follow_up_at:'2020-01-01'})},
    provider:{sendReminder:async()=>assert.fail('Unknown due date must never send')},paymentChecker:async()=>assert.fail('Must skip before payment checking')});
   assert.deepEqual(await engine.run({ownerId,workspaceId,invoiceId:saved.id}),{status:'skipped',reason:'ineligible_invoice'});
   await db.query("update invoices set status='sent' where id=$1",[saved.id]);
   await db.query("update customers set phone='+12025550179' where id=$1",[saved.customer_id]);
   await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,'+12025550179','inbound_message','fixture',array['invoice_updates'])",[workspaceId,saved.customer_id]);
   await db.query("update workspace_settings set business_name='Intake fixture' where workspace_id=$1",[workspaceId]);
   const tools=createOwnerWorkspaceTools({supabase,scope,message:'Send reminder',messageId:'unknown-due-reminder',ownerStore:{query:async()=>[]},env,authorize:async()=>true,clock:()=>new Date(),botPreferences:{confirmationMode:'buttons'}});
   const refusal=await tools.execute('workspaceData',{operation:'previewReminder',table:'invoices',filters:[{column:'id',operator:'eq',value:saved.id}]});
   assert.equal(refusal.ok,false);assert.match(refusal.message,/due date/);
  });
  await t.test('typed yes/no fallback and financial gates remain effective',async()=>{
   const row=await draft({...base,stage:'proposal',invoice:{...invoice,invoiceNumber:'TYPED-99'}});
   assert.match((await inbound('yes')).answer,/Saved invoice TYPED-99/);
   await draft({...base,stage:'proposal',invoice:{...invoice,invoiceNumber:'TYPED-100'}});
   assert.match((await inbound('no')).answer,/cancel/i);
   for(const validationIssues of [['UNCERTAIN_LINE_ITEMS'],['PAYMENT_STATUS_CONFLICT'],['INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX']]){
    await draft({...base,stage:'incomplete',missingFields:['invoiceNumber','dueDate'],validationIssues});
    const result=await inbound('Invoice number is BAD-99. No due date.');
    assert(!result.buttons?.length);
   }
   assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,2);
   assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  });
  await t.test('SQL refuses null facts without explicit in-scope evidence or outside dueDate',async()=>{
   const row=await draft({...base,missingFields:['dueDate']});
   const messageId=await inbound('This is not true that there is no due date.',null,false);
   const proposal={...base,stage:'proposal',missingFields:[],ownerProvidedFacts:{dueDate:{value:null,sourceMessageId:messageId}}};
   await assert.rejects(db.query('select * from whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',[row.id,row.version,workspaceId,customerId,phone,'incomplete',JSON.stringify(proposal)]),/outside owner scope/);
   const missingNumber=await draft({...base,missingFields:['invoiceNumber'],invoice:{...invoice,invoiceNumber:null}});
   const invalidNumber={...base,stage:'proposal',missingFields:[],invoice:{...invoice,invoiceNumber:null},ownerProvidedFacts:{invoiceNumber:{value:null,sourceMessageId:messageId}}};
   await assert.rejects(db.query('select * from whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',[missingNumber.id,missingNumber.version,workspaceId,customerId,phone,'incomplete',JSON.stringify(invalidNumber)]),/lacks owner evidence/);
  });
  assert.equal(plannerCalls,0);
 }finally{await f.close();}
});
