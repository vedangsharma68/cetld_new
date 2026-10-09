import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
const message='Record a USD 500 partial payment for the dummy invoice SB-10442 for Northwind Systems LLC. Keep customer messages and reminders off.';
const read={operation:'read',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'SB-10442'}]};
const definition={type:'function',function:{name:'workspaceData',parameters:{type:'object'}}};
const evidence={ok:true,readOnly:true,operation:'read',table:'invoices',lookupInvoiceNumber:'SB-10442',rows:[{invoice_number:'INV-2026-6769',currency:'USD',total_amount:951.52,amount_paid:0}],truncated:false};
const proposal={ok:true,proposal:true,expiresAt:new Date(Date.now()+600_000).toISOString(),details:{type:'owner_invoice_payment',requestedInvoiceNumber:'SB-10442',requestedCustomerName:'Northwind Systems LLC',changes:{amount:500,currency:'USD'},paymentAmount:500,currency:'USD',outstandingAmount:451.52}};
const requirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true};
const provider=()=>({async generate(){return {toolCalls:[{id:'read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(read)}}]};}});
function toolsFor(execute){let attempted=false;return {supportsBoundedPaymentProposal:true,definitions:[definition],async execute(name,args){if(args.operation!=='read')attempted=true;return execute(name,args);},getWriteAttempted:()=>attempted,getReplyRequirement:()=>requirement};}
test('checkpointed acknowledged proposal renders without a model call or duplicate proposal',async()=>{
 let checkpoint,creates=0,modelCalls=0;
 const tools=toolsFor(async(name,args)=>{if(args.operation==='read')return evidence;creates++;assert.deepEqual(args,{operation:'create',table:'payments',filters:read.filters,values:{amount:500,currency:'USD'}});return proposal;});
 const first=await runOwnerAgent({message,tools,provider:provider(),allowDeferred:true,onCheckpoint:async value=>{checkpoint=structuredClone(value);}});
 assert.match(first.answer,/USD 500\.00/);assert.equal(creates,1);assert.equal(first.agentDiagnostics.rounds,2);assert.equal(checkpoint.boundedPaymentSelected,true);assert.equal(checkpoint.phase,'final');
 const resumed=await runOwnerAgent({message,tools:toolsFor(async()=>{throw new Error('No tool may rerun');}),checkpoint,allowDeferred:true,provider:{async generate(){modelCalls++;throw new Error('No model required');}}});
 assert.equal(resumed.answer,first.answer);assert.equal(resumed.boundedPaymentReply,true);assert.equal(creates,1);assert.equal(modelCalls,0);
});
test('interrupted proposal remains uncertain and resume never creates it again',async()=>{
 let checkpoint,creates=0;
 const first=await runOwnerAgent({message,tools:toolsFor(async(name,args)=>{if(args.operation==='read')return evidence;creates++;return new Promise(()=>{});}),provider:provider(),budgetMs:100,allowDeferred:true,onCheckpoint:async value=>{checkpoint=structuredClone(value);}});
 assert.equal(first.deferred,true);assert.equal(creates,1);assert.equal(checkpoint.uncertainWrite,'owner-payment-proposal');assert.equal(checkpoint.boundedPaymentSelected,true);
 const resumed=await runOwnerAgent({message,tools:toolsFor(async()=>{throw new Error('Uncertain operation must not rerun');}),checkpoint,allowDeferred:true,provider:{async generate(){return {content:'The previous operation was interrupted. Check its result before trying another payment.'};}}});
 assert.equal(resumed.boundedPaymentReply,undefined);assert.doesNotMatch(resumed.answer,/Proposed a/);assert.equal(creates,1);
});
test('an attempted operation or a current ambiguous instruction never enables a canonical proposal',async()=>{
 for(const input of [message,'He said "'+message+'"',message.replace('USD 500','USD 500 or EUR 500')]){
  let creates=0,calls=0;
  const tools=toolsFor(async(name,args)=>{if(args.operation!=='read')creates++;return {...evidence,writeAttempted:input===message};});
  const result=await runOwnerAgent({message:input,tools,provider:{async generate(request){calls++;return request.tools?await provider().generate():{content:'No changes were made.'};}}});
  assert.equal(creates,0,input);assert.equal(result.boundedPaymentReply,undefined);assert.ok(calls<=4);
 }
});
test('a failed customer match is rendered without denying an invoice that the scoped read found',async()=>{
 let calls=0,creates=0;
 const result=await runOwnerAgent({message,tools:{...toolsFor(async(name,args)=>{
  if(args.operation==='read'){
   assert.deepEqual(args.filters,[...read.filters,{column:'customer_name',operator:'eq',value:'Northwind Systems LLC'}]);
   return evidence;
  }
  creates++;return {ok:false,code:'NOT_FOUND',operation:'create',table:'payments'};
 }),getReplyRequirement:()=>null,getWriteAttempted:()=>creates>0},provider:{async generate(){calls++;return provider().generate();}}});
 assert.equal(calls,0);assert.equal(creates,1);assert.equal(result.boundedPaymentReply,true);
 assert.equal(result.answer,'The invoice and customer could not be matched for this payment. This payment was not recorded.');
});
