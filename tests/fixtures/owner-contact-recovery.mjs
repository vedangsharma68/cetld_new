import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './offline-sql-network.mjs';
import {applyNoFooterMigration} from './no-footer-reminders.mjs';
import {createWhatsAppInvoiceStore} from '../../automation/whatsapp/invoice-store.mjs';
import {createWhatsAppPendingActionStore} from '../../automation/whatsapp/pending-actions.mjs';
import {ownerWriteConfirmation} from '../../automation/whatsapp/owner-write-confirmation.mjs';
import {createOwnerMessageHandler} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppBoundMessageHandler} from '../../automation/whatsapp/assistant-handler.mjs';

export async function verifyOwnerContactRecovery(){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f;
 try{
  for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])
   await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await applyNoFooterMigration(db,{approve:true});
  const ownerId=randomUUID(),phone='+12025550107';
  await db.query("insert into auth.users(id,email) values($1,'owner@example.test')",[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (create_workspace('Contact test',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const debtor=(await db.query("insert into customers(workspace_id,name) values($1,'John Smith') returning id",[workspaceId])).rows[0].id;
  const invoiceId=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
   values($1,$2,'US-001',current_date-2,current_date-1,'USD',125,'sent','{"invoice_direction":"receivable"}') returning id`,[workspaceId,debtor])).rows[0].id;
  await db.query("update invoices set invoice_number='US-001' where id=$1",[invoiceId]);
  await db.query(`update workspace_settings set owner_bot_preferences='{"confirmationMode":"direct"}',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1`,
   [workspaceId,{contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],maxReminders:3}]);
  const history=[],scope={workspaceId,ownerId,customerId,phone};let seq=0,modelCalls=0;
  const printed=Object.fromEntries(Object.entries({invoiceNumber:'PRINT-001',customerName:'Printed Buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',
    subtotal:100,tax:0,total:100,outstandingAmount:100,currency:'USD',direction:'receivable',clientEmail:null,clientPhone:'+14155550244',clientPhoneRaw:null,
    notes:null,paymentTerms:null,lineItems:[{description:'Printed service',quantity:1,unitPrice:100,amount:100}]})
    .map(([key,value])=>[key,{value,confidence:.99}]));
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},providerFactory:()=>({}),
   toolsFactory:options=>createOwnerWorkspaceTools({...options,attachmentIngestFactory:input=>createWhatsAppBoundMessageHandler({...input,extract:async()=>structuredClone(printed)})}),
   historyReader:async()=>history,agentFactory:async({message,tools,businessProfile})=>{
    modelCalls++;
    assert.equal(businessProfile.currency,'INR');
    if(message==='please nudge John about US-001'){
      const result=await tools.execute('workspaceData',{operation:'sendReminderNow',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'US-001'}]});
      assert.equal(result.code,'missing_contact');
      return {answer:"I couldn't send a reminder to John Smith."};
    }
    if(message==='yes'){
      const result=await tools.execute('workspaceData',{operation:'confirm'});
      return {answer:ownerWriteConfirmation(result)};
    }
    if(message==='log this invoice'){
      const result=await tools.execute('workspaceData',{operation:'saveAttachment'});
      assert.equal(result.outcome,'review_ready',JSON.stringify({result,errors:f.errors}));
      return {answer:`Invoice ${result.review.invoice.invoiceNumber} for Printed Buyer: USD 100. Reply yes to save.`};
    }
    if(message==='it is 9818685252'||message==='John Smith number is 12345'){
      const result=await tools.execute('workspaceData',{operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'John Smith'}],values:{phone:message==='it is 9818685252'?'9818685252':'12345'}});
      if(message==='it is 9818685252')assert.equal(result.completed,true,JSON.stringify({result,errors:f.errors}));
      else assert.equal(result.code,'INVALID_PHONE',JSON.stringify(result));
      return {answer:message==='John Smith number is 12345'?'The number could not be saved.':'Saved the phone.'};
    }
    throw Error('unexpected model request: '+message);
   }});
  const turn=async(message,{contactCard,media}={})=>{
   const messageId='contact-'+(++seq);
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,$3,$4,'processing')",[messageId,phone,contactCard?'contacts':media?'image':'text',message]);
   const result=await handler({...scope,message,messageId,...(contactCard?{contactCard}:{}),...(media?{media}:{})});
   history.push({role:'user',content:message},{role:'assistant',content:result.answer});
   return result;
  };
  const contact=async()=>(await db.query('select phone from customers where id=$1',[debtor])).rows[0].phone;
  const consent=async()=>(await db.query('select * from whatsapp_consents where workspace_id=$1 and customer_id=$2',[workspaceId,debtor])).rows;
  // Explicit generic model tool calls use the same validator and atomic consent saver.
  await turn('it is 9818685252');
  assert.equal(await contact(),'+919818685252');assert.equal((await consent())[0].source,'verbal');
  const invalid=await turn('John Smith number is 12345');assert.match(invalid.answer,/Send it with the country code, like \+919818685252\./);assert.equal(await contact(),'+919818685252');
  history.push({role:'user',content:'Compare US-001 and US-002'},{role:'assistant',content:'Those are two invoices.'});
  assert.match((await turn('+919876543210')).answer,/Which customer or invoice/);assert.equal(await contact(),'+919818685252');
  await db.query('update customers set phone=null where id=$1',[debtor]);
  const failed=await turn('send a reminder for US-001');assert.match(failed.answer,/John Smith's number isn't a usable WhatsApp number/);assert.match(failed.answer,/\+919818685252/);
  const invalidCorrection=await turn('12345');assert.match(invalidCorrection.answer,/Send it with the country code/);assert.equal(await contact(),null);
  const callsBefore=modelCalls;
  const corrected=await turn('+91 98186-85252');assert.match(corrected.answer,/Saved \+919818685252 for John Smith/);assert.match(corrected.answer,/Reminder preview for US-001/);assert.equal(modelCalls,callsBefore);
  assert.equal(await contact(),'+919818685252');
  assert.equal((await db.query('select followup_state from invoices where id=$1',[invoiceId])).rows[0].followup_state,'draft');
  await turn('cancel');
  await db.query('update customers set phone=null where id=$1',[debtor]);
  const modelFailed=await turn('please nudge John about US-001');assert.match(modelFailed.answer,/usable WhatsApp number/);
  const modelCorrected=await turn('+919818685252');assert.match(modelCorrected.answer,/Saved/);assert.match(modelCorrected.answer,/Reminder preview/);
  await turn('cancel');
  assert.match((await turn('what is my business name')).answer,/Contact test/);
  assert.match((await turn('what is my email')).answer,/owner@example.test/);
  const both=await turn('what is my business name / email');assert.match(both.answer,/Contact test/);assert.match(both.answer,/owner@example.test/);
  // Simulate an existing workspace with a missing legacy profile field.
  await db.exec('alter table workspace_settings disable trigger user');
  await db.query('update workspace_settings set business_name=null where workspace_id=$1',[workspaceId]);
  await db.exec('alter table workspace_settings enable trigger user');
  assert.match((await turn('what is my business name')).answer,/isn't saved/);
  const offer=await turn('my business name is John Studio');assert.match(offer.answer,/Would you like me to save John Studio/);
  assert.equal((await db.query('select business_name from workspace_settings where workspace_id=$1',[workspaceId])).rows[0].business_name,null);
  const gate=await turn('send a reminder for US-001');assert.match(gate.answer,/Save your business name first/);
  const saved=await turn('my business name is John Studio');assert.match(saved.answer,/Saved your business name as John Studio/);
  assert.equal((await db.query('select business_name from workspace_settings where workspace_id=$1',[workspaceId])).rows[0].business_name,'John Studio');
  assert.match((await turn('send a reminder for US-001')).answer,/Reminder preview/);await turn('cancel');
  // STOP wins even when the owner supplies the same phone again.
  await db.query("update whatsapp_consents set revoked_at=now(),revoked_via='stop' where workspace_id=$1 and customer_id=$2",[workspaceId,debtor]);
  await db.query("insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,'+919818685252','stop')",[workspaceId]);
  await turn('it is 9818685252');assert.ok((await consent())[0].revoked_at);
  assert.match((await turn('send a reminder for US-001')).answer,/stopped WhatsApp reminders/);
  // A batch failure rolls back both the contact and its assumed consent.
  const batchMessage='Update John phone and another customer',batchId='contact-batch-rollback';
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[batchId,phone,batchMessage]);
  const updatedAt=(await db.query('select updated_at from customers where id=$1',[debtor])).rows[0].updated_at;
  const rollback=await supabase.rpc('whatsapp_apply_owner_batch',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_provider_message_id:batchId,p_authorization_quote:batchMessage,
    p_operations:[{operation:'customer.update',targetId:debtor,expectedUpdatedAt:new Date(updatedAt).toISOString(),payload:{phone:'+919876543210'}},
      {operation:'customer.update',targetId:randomUUID(),expectedUpdatedAt:new Date().toISOString(),payload:{name:'Missing'}}]});
  assert.equal(rollback.data?.rolledBack,true,JSON.stringify(rollback));assert.equal(await contact(),'+919818685252');
  assert.equal((await db.query("select count(*)::int n from whatsapp_consents where workspace_id=$1 and phone='+919876543210'",[workspaceId])).rows[0].n,0);
  // A generic edit to another field cannot turn an imported phone into consent.
  const untouched=await db.query("insert into customers(workspace_id,name,phone) values($1,'Imported contact','+12025550119') returning id,updated_at",[workspaceId]);
  const editId='contact-unrelated-edit',editMessage='Change Imported contact company name to Imported Studio';
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[editId,phone,editMessage]);
  const edited=await supabase.rpc('whatsapp_apply_direct_owner_write',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_provider_message_id:editId,p_interaction_id:null,p_idempotency_key:'contact_unrelated_edit_1',p_operation:'customer.update',p_target_id:untouched.rows[0].id,p_expected_updated_at:new Date(untouched.rows[0].updated_at).toISOString(),p_authorization_kind:'instruction',p_authorization_quote:editMessage,p_button_decision:null,p_pending_id:null,p_pending_version:null,p_payload:{company_name:'Imported Studio'}});
  assert.equal(edited.data?.ok,true,JSON.stringify(edited));
  assert.equal((await db.query("select count(*)::int n from whatsapp_consents where workspace_id=$1 and phone='+12025550119'",[workspaceId])).rows[0].n,0);
  // Successful batches distinguish a supplied phone from an unrelated child edit.
  const otherImported=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Other imported','+12025550122') returning id,updated_at",[workspaceId])).rows[0];
  const batchSaveId='contact-batch-save',batchSaveMessage='Save Imported contact number +12025550119 and Other imported company Other Studio';
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[batchSaveId,phone,batchSaveMessage]);
  const importedNow=(await db.query('select updated_at from customers where id=$1',[untouched.rows[0].id])).rows[0].updated_at;
  const batchSaved=await supabase.rpc('whatsapp_apply_owner_batch',{p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_provider_message_id:batchSaveId,p_authorization_quote:batchSaveMessage,
    p_operations:[{operation:'customer.update',targetId:untouched.rows[0].id,expectedUpdatedAt:new Date(importedNow).toISOString(),payload:{phone:'+12025550119'}},
      {operation:'customer.update',targetId:otherImported.id,expectedUpdatedAt:new Date(otherImported.updated_at).toISOString(),payload:{company_name:'Other Studio'}}]});
  assert.equal(batchSaved.data?.completed,true,JSON.stringify(batchSaved));
  assert.equal((await db.query("select source from whatsapp_consents where workspace_id=$1 and phone='+12025550119'",[workspaceId])).rows[0].source,'verbal');
  assert.equal((await db.query("select count(*)::int n from whatsapp_consents where workspace_id=$1 and phone='+12025550122'",[workspaceId])).rows[0].n,0);
  // The existing invoice-review country-code continuation uses the same saver.
  const countryMessage='+91',countryId='contact-country-code';
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[countryId,phone,countryMessage]);
  const pending=createWhatsAppPendingActionStore({supabase}),state=await pending.loadPendingActionState(scope);
  await pending.storePendingAction({...scope,expectedState:state,source:'whatsapp',action:{type:'invoice_debtor_phone',stage:'awaiting_phone',invoiceId,clientName:'John Smith',clientPhoneRaw:'9876543210'}});
  const store=createWhatsAppInvoiceStore({supabase,workspaceId,customerId,audience:'owner',ownerId,ownerPhone:phone,messageId:countryId,message:countryMessage,authorize:async()=>true});
  await store.saveDebtorPhone({invoiceId,phone:'+919876543210',assumedConsentAt:new Date().toISOString()});
  assert.equal(await contact(),'+919876543210');
  assert.equal((await db.query("select source from whatsapp_consents where workspace_id=$1 and phone='+919876543210'",[workspaceId])).rows[0].source,'verbal');
  const metadata=(await db.query('select metadata from invoices where id=$1',[invoiceId])).rows[0].metadata;
  assert.equal(metadata.debtor_phone,'+919876543210');assert.equal(metadata.client_phone,'+919876543210');
  // Durable cards prove their phone field independently of digits in the name.
  const cardTurn=(card,persisted=card)=>turn(JSON.stringify(persisted),{contactCard:card});
  const cardCalls=modelCalls;
  assert.equal((await cardTurn({name:'John Smith 2',phone:'12345'})).answer,'The phone number is not in a supported format. Send it with the country code, like +919818685252.');
  assert.equal(await contact(),'+919876543210');assert.equal((await pending.loadPendingAction(scope)).action.stage,'awaiting_phone');
  const actualCard={name:'John Smith 2',phone:'9876501234'};
  const forged=await cardTurn({...actualCard,phone:'+9129876501234'},actualCard);
  assert.doesNotMatch(forged.answer,/Saved/);assert.equal(await contact(),'+919876543210');
  assert.equal((await pending.loadPendingAction(scope)).action.stage,'awaiting_phone');
  const cardSaved=await cardTurn(actualCard);assert.match(cardSaved.answer,/Saved \+919876501234 for John Smith/);
  assert.equal(await contact(),'+919876501234');assert.equal(await pending.loadPendingAction(scope),null);
  const cardConsent=(await db.query("select source,consent_text_version from whatsapp_consents where workspace_id=$1 and customer_id=$2 and phone='+919876501234'",[workspaceId,debtor])).rows;
  assert.equal(cardConsent.length,1);assert.equal(cardConsent[0].source,'verbal');assert.equal(cardConsent[0].consent_text_version,'owner_supplied_assumed_v1');
  const unsolicited=await cardTurn({name:'Another contact 3',phone:'+14155550245'});
  assert.equal(unsolicited.answer,'Which customer or invoice is this number for?');assert.equal(await contact(),'+919876501234');
  const nextState=await pending.loadPendingActionState(scope);
  await pending.storePendingAction({...scope,expectedState:nextState,source:'whatsapp',action:{type:'invoice_debtor_phone',stage:'awaiting_phone',invoiceId,clientName:'John Smith'}});
  const stoppedConsent=(await consent()).find(row=>row.phone==='+919818685252');
  const suppressions=(await db.query("select * from whatsapp_suppressions where workspace_id=$1 and phone='+919818685252'",[workspaceId])).rows;
  const stoppedCard={name:'John Smith 2',phone:'+919818685252'},stoppedReply=await cardTurn(stoppedCard);
  // The existing phone-change guard also blocks switching back to a stopped
  // number. Its rejection must preserve both STOP and the contact question.
  assert.equal(stoppedReply.plannerFailure?.code,'23514');assert.doesNotMatch(stoppedReply.answer,/Saved/);
  assert.equal(await contact(),'+919876501234');
  assert.deepEqual((await consent()).find(row=>row.phone==='+919818685252'),stoppedConsent);
  assert.deepEqual((await db.query("select * from whatsapp_suppressions where workspace_id=$1 and phone='+919818685252'",[workspaceId])).rows,suppressions);
  const blockedPending=await pending.loadPendingAction(scope);
  assert.equal(blockedPending.action.type,'invoice_debtor_phone');assert.equal(blockedPending.action.stage,'awaiting_phone');
  await pending.consumePendingAction({...blockedPending,...scope});
  assert.equal(modelCalls,cardCalls,'contact cards must not reach the planner');
  // The printed E.164 contact must save before its review is marked complete.
  const printedReply=await turn('log this invoice',{media:{bytes:Buffer.from('isolated printed invoice source'),mimeType:'image/jpeg',fileName:'printed-phone.jpg'}});
  assert.equal(printedReply.plannerFailure,undefined,JSON.stringify({printedReply,errors:f.errors}));
  assert.match(printedReply.answer,/Reply yes/i);
  assert.equal((await db.query("select count(*)::int n from invoices where workspace_id=$1 and metadata->>'client_name'='Printed Buyer'",[workspaceId])).rows[0].n,0);
  const confirmedPrinted=await turn('yes');
  assert.match(confirmedPrinted.answer,/Saved invoice/);assert.doesNotMatch(confirmedPrinted.answer,/couldn.t|could not|country code|WhatsApp number/i);
  const printedCustomer=(await db.query("select id,phone from customers where workspace_id=$1 and name='Printed Buyer'",[workspaceId])).rows;
  assert.equal(printedCustomer.length,1);assert.equal(printedCustomer[0].phone,'+14155550244');
  const printedInvoice=(await db.query("select metadata from invoices where workspace_id=$1 and customer_id=$2",[workspaceId,printedCustomer[0].id])).rows;
  assert.equal(printedInvoice.length,1);assert.equal(printedInvoice[0].metadata.client_phone,'+14155550244');assert.equal(printedInvoice[0].metadata.debtor_phone,'+14155550244');
  const printedConsent=(await db.query("select source from whatsapp_consents where workspace_id=$1 and customer_id=$2 and phone='+14155550244'",[workspaceId,printedCustomer[0].id])).rows;
  assert.equal(printedConsent.length,1);assert.equal(printedConsent[0].source,'verbal');
  assert.notEqual((await pending.loadPendingAction(scope))?.action?.type,'invoice_debtor_phone');
  assert.equal(f.requests.some(r=>r.url.includes('graph.facebook.com')),false);
  return {normalized:true,retriedPreview:true,invalidRejected:true,businessProfile:true,businessNameSaved:true,stopPreserved:true,contactCard:true,printedPhone:true};
 }finally{await db.close();}
}
