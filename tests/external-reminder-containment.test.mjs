import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {externalReminderRead,reminderPaymentRpc,hasExternalReminderLedger} from '../automation/external-reminder-verification.mjs';
import {createAccountingIntegration} from '../automation/accounting/integration.mjs';
import {createLocalReminderPaymentChecker} from '../automation/local-reminder-payment.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {createFirstPartyReminderProvider} from '../automation/whatsapp/cloud-reminders.mjs';

const ownerId=randomUUID(),workspaceId=randomUUID(),invoiceId=randomUUID(),customerId=randomUUID(),claimId=randomUUID();
const invoice=extra=>({id:invoiceId,workspace_id:workspaceId,status:'sent',currency:'USD',total_amount:125,amount_paid:0,
 external_provider:'zoho_books',external_invoice_id:'same-id',metadata:{invoice_direction:'receivable'},...extra});

test('legacy, new imports/exports and malformed/forged bindings refuse before provider, token, pre-RPC or RPC work',async()=>{
 let effects=0;
 const forbidden=()=>{effects++;throw Error('Forbidden effect');};
 const accounting={reminderInvoiceState:forbidden,accessToken:forbidden,connectionStatus:forbidden};
 const supabase={rpc:forbidden};
 const examples=[invoice(),invoice({metadata:{origin:'import'}}),invoice({metadata:{origin:'export'}}),
  ...[null,'',{},[],false,{immutable:true,verified:true,originalAccountId:'current-org'}].map(binding=>invoice({metadata:{provider_account_binding:binding,provenance:'verified',provider_account_id:'current-org'}})),
  invoice({metadata:{diagnostic:{existence:'present',currentAccountId:'current-org',exactId:'same-id',provenance:'provenance_unverified'}}}),
  ...['external_provider','external_invoice_id','accounting_provider','bookkeeping_record_id'].flatMap(marker=>['\t',[],{},false,0].map(value=>{
   const i=invoice({external_provider:null,external_invoice_id:null,metadata:{}});
   if(marker.startsWith('external_'))i[marker]=value;else i.metadata[marker]=value;return i;
  }))];
 for(const i of examples){
  const before=structuredClone(i);assert.equal(hasExternalReminderLedger(i),true);
  await assert.rejects(externalReminderRead({invoice:i,ownerId,workspaceId,accounting,fetchImpl:forbidden}),/provenance is unsupported/);
  for(const name of ['whatsapp_owner_reminder','cetld_core_check_local_reminder_payment','cetld_core_authorize_first_party_reminder']){
   const result=await reminderPaymentRpc({supabase,name,args:{},invoice:i,beforeRpc:forbidden,accounting,fetchImpl:forbidden});
   assert.equal(result.data.ok,false);assert.equal(result.data.authorized,false);assert.equal(result.data.reason,'external_accounting_required');
  }
  assert.deepEqual(i,before);
 }
 assert.equal(effects,0);
});

test('current org switches, matching facts and expired tokens cannot manufacture reminder provenance',async()=>{
 for(const current of ['original-org','other-org']){
  let effects=0,org=current;
  const forbidden=()=>{effects++;throw Error('Credential work forbidden');};
  const provider={refreshToken:forbidden,fetchInvoiceBalance:()=>{
   effects++;org='changed-during-read';return {externalId:'same-id',status:'sent',currency:'USD',totalMinor:12500,balanceMinor:12500,paidMinor:0};
  }};
  const accounting=createAccountingIntegration({store:{getConnection:forbidden},cipher:{decrypt:forbidden},providers:{zoho_books:provider,quickbooks:provider}});
  await assert.rejects(accounting.reminderInvoiceState({userId:ownerId,workspaceId,provider:'zoho_books',invoiceId:'same-id',
   providerAccountId:current,verified:true,tokenExpiresAt:0}),{code:'ACCOUNTING_REMINDER_PROVENANCE_UNSUPPORTED'});
  assert.equal(effects,0);assert.equal(org,current,'the provider read, including a possible account race, never starts');
 }
});

test('local-only wrapper and payment checker preserve original RPC and preflight behavior',async()=>{
 const calls=[],local=invoice({external_provider:null,external_invoice_id:null});
 const supabase={rpc:async(name,args)=>{calls.push([name,args]);return {data:{ok:true,paidMinor:0},error:null};}};
 assert.equal(await externalReminderRead({invoice:local}),null);
 const args={p_invoice_id:invoiceId};let checked=false;
 await reminderPaymentRpc({supabase,name:'local_gate',args,invoice:local,beforeRpc:async()=>{checked=true;}});
 assert.equal(checked,true);assert.deepEqual(calls.shift(),['local_gate',args]);
 const checker=createLocalReminderPaymentChecker({supabase,ownerId,workspaceId});
 assert.deepEqual(await checker({ownerId,workspaceId,invoiceId,invoice:local}),{paidMinor:0});
 assert.equal(calls[0][0],'cetld_core_check_local_reminder_payment');
 await assert.rejects(checker({ownerId:randomUUID(),workspaceId,invoiceId,invoice:local}),/scope/);
});

test('saved linked payment check refuses without provider/RPC work',async()=>{
 let rpc=0,reads=0;
 const query={select(){return this;},eq(){return this;},async maybeSingle(){reads++;return {data:invoice()};}};
 const checker=createLocalReminderPaymentChecker({supabase:{from:()=>query,rpc:()=>{rpc++;throw Error('No RPC');}},ownerId,workspaceId,
  accounting:{reminderInvoiceState(){throw Error('No provider');}}});
 await assert.rejects(checker({ownerId,workspaceId,invoiceId,invoice:invoice()}),/unavailable/);
 assert.equal(reads,1);assert.equal(rpc,0);
});

test('approved and cloud sender preflights block linked rows before review/approval RPC or dispatch',async()=>{
 const phone='+919871367051',env={WHATSAPP_REMINDERS_ENABLED:'true',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_PHONE_NUMBER_ID:'1234567890',
  WHATSAPP_GRAPH_API_VERSION:'v24.0',WHATSAPP_ACCESS_TOKEN:'fixture-only'};
 let effects=0;
 const forbidden=()=>{effects++;throw Error('No RPC/send/model/settings/refresh');};
 const store={getInvoice:async()=>invoice(),getWorkspacePreferences:forbidden};
 const supabase={rpc:forbidden,from:forbidden};
 const input={workspaceId,invoiceId,customerId,to:phone,body:'fixture',idempotencyKey:`reminder:${workspaceId}:${claimId}`};
 const approved=createApprovedReminderProvider({env,supabase,store,ownerId,workspaceId,fetchImpl:forbidden});
 await assert.rejects(approved.prepareReminder(input),/provenance is unsupported/);
 assert.deepEqual(await approved.sendReminder(input),{status:'blocked',reason:'external_accounting_required'});
 const cloud=createFirstPartyReminderProvider({env,supabase,store,ownerId,workspaceId,fetchImpl:forbidden,
  templateSnapshot:{status:'APPROVED',category:'UTILITY',useCase:'first_party_invoice_reminder',name:'fixture_reminder',language:'en',
   body:'{{1}} {{2}} {{3}} {{4}} {{5}} {{6}}',revision:'fixture',wabaId:env.WHATSAPP_WABA_ID,phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID}});
 assert.deepEqual(await cloud.sendReminder(input),{status:'blocked',reason:'external_accounting_required'});
 assert.deepEqual(await cloud.sendReminder({...input,workspaceId:randomUUID()}),{status:'blocked',reason:'scope'});
 assert.equal(effects,0);
});

test('owner dashboard preview/approval refuse before reminder RPC, proposal or conversation append',async()=>{
 const {previewReminderReview,approveReminderReview}=await import('../ai/reminder-review.mjs');
 const {createAccountingActionToken}=await import('../ai/accounting-actions.mjs');
 const {reminderFingerprint}=await import('../automation/whatsapp/reminder-fingerprint.mjs');
 let effects=0;const forbidden=()=>{effects++;throw Error('No RPC/proposal/append');};
 const store={role:'owner',workspaceId,userId:ownerId,query:async()=>[invoice()],ownerAssistantRPC:forbidden,
  getOwnerAssistantSettings:forbidden,ownerConversation:{pending:forbidden,read:forbidden,propose:forbidden,decide:forbidden,append:forbidden}};
 const env={AI_ACCOUNTING_CONFIRMATION_SECRET:'x'.repeat(32)};
 await assert.rejects(previewReminderReview({store,env,body:{invoiceId,text:'Fixture',tone:'professional',sendNow:true}}),{code:'external_accounting_required'});
 const reviewPayload={payload:{invoiceId},summary:'Fixture'};
 const approvalToken=createAccountingActionToken({action:'owner_reminder',payload:{proposalId:randomUUID(),reviewHash:reminderFingerprint(reviewPayload)},
  userId:ownerId,workspaceId,secret:env.AI_ACCOUNTING_CONFIRMATION_SECRET});
 await assert.rejects(approveReminderReview({store,env,body:{confirmed:true,approvalToken,reviewPayload}}),{code:'external_accounting_required'});
 assert.equal(effects,0);
});

test('saved proposal preflight blocks linked confirmation without decide/append RPC; cancellation stays available',async()=>{
 const {createOwnerConversation}=await import('../ai/owner-conversation.mjs');
 let rpc=0,read=0;
 const proposal={id:randomUUID(),state:'pending',action:{type:'owner_reminder',payload:{invoiceId}}};
 const conversation=createOwnerConversation({workspaceId,ownerId,readProposal:async()=>proposal,
  readReminderInvoice:async id=>{read++;assert.equal(id,invoiceId);return invoice();},
  rpc:async()=>{rpc++;return {data:{ok:true}};}});
 await assert.rejects(conversation.propose(proposal.action),{code:'external_accounting_required'});
 await assert.rejects(conversation.decide(proposal.id,true),{code:'external_accounting_required'});
 assert.equal(read,2);assert.equal(rpc,0);
 assert.deepEqual(await conversation.decide(proposal.id,false),{ok:true});assert.equal(rpc,1);
 const unresolved=createOwnerConversation({workspaceId,ownerId,rpc:()=>{throw Error('Missing resolvers must not reach an RPC');}});
 await assert.rejects(unresolved.propose(proposal.action),{code:'external_accounting_required'});
 await assert.rejects(unresolved.decide(proposal.id,true),{code:'OWNER_CONVERSATION_UNAVAILABLE'});
});
