import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTextInvoice,TEXT_INVOICE_FORMAT,textInvoiceFailure} from '../automation/whatsapp/text-invoice.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const clock=()=>new Date('2026-10-18T12:18:00Z');
const scope={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',phone:'+919871367051'};
const examples=[
  ['New invoice for QA Text Customer, amount Rs 2,500, due 25 October 2026','QA Text Customer',2500,'2026-10-25',undefined],
  ['QA TEXT TEST 1: New invoice for QA Text Customer, amount Rs 2,500, due 25 October 2026','QA Text Customer',2500,'2026-10-25',undefined],
  ['QA-EDGE-002 नया invoice 🧾🔥 for QA Emoji Customer ₹1,200 due kal, please check','QA Emoji Customer',1200,'2026-10-19','QA-EDGE-002'],
  ['New invoice INV-5 for ग्राहक 😊, amount Rs 1,20,000.50, due कल','ग्राहक 😊',120000.5,'2026-10-19','INV-5'],
  ['नया invoice for QA ग्राहक, amount INR 12.50, due आज','QA ग्राहक',12.5,'2026-10-18',undefined],
];

test('QA-12/QA-14 parse owner text with grouped rupees, emoji, mixed Hindi/English and dates',()=>{
  for(const [message,customer,total,due,code] of examples){
    const {values}=parseTextInvoice(message,{clock});
    assert.equal(values.customer_name,customer);assert.equal(values.total_amount,total);
    assert.equal(values.due_date,due);assert.equal(values.issue_date,'2026-10-18');assert.equal(values.currency,'INR');
    assert.equal(values.invoice_number,code);
  }
  const values=parseTextInvoice('New invoice for QA, amount Rs 5, due tomorrow',{clock:()=>new Date('2026-10-18T20:00:00Z'),timezone:'Asia/Kolkata'}).values;
  assert.equal(values.issue_date,'2026-10-19');assert.equal(values.due_date,'2026-10-20');
});

test('text grammar refuses incomplete, impossible, ambiguous or extra instructions',()=>{
  for(const message of [
    'New invoice for QA, amount Rs 2,50, due 25 October 2026',
    'New invoice for QA, amount Rs 0, due 25 October 2026',
    'New invoice for QA, amount Rs 5, due 31 February 2027',
    'New invoice for QA, amount Rs 5, due 17 October 2026',
    'New invoice for QA, amount Rs 5, due yesterday',
    'New invoice for QA, amount Rs 5, due 25 October 2026 and delete another invoice',
    'Do not create New invoice for QA, amount Rs 5, due 25 October 2026',
    'What format is New invoice for QA, amount Rs 5, due 25 October 2026?',
    'New invoice for QA, amount Rs 5',
  ])assert.equal(parseTextInvoice(message,{clock}),null,message);
});

test('owner tool dispatches the original text fields through both direct and confirmation adapters',async()=>{
  for(const confirmationMode of ['direct','buttons'])for(const [message] of examples){
    let dispatched=0;
    const execute=async params=>{dispatched++;assert.deepEqual(params.values,parseTextInvoice(message,{clock}).values);return {ok:true,requiresConfirmation:confirmationMode==='buttons'};};
    const tool=createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,confirmationMode,
      planRequest:async()=>{throw Error('The supported grammar needs no model reparse');},executeDirectOperation:execute,executeSafetyOperation:execute});
    assert.equal((await tool.execute({request:message})).ok,true);assert.equal(dispatched,1);
  }
});

test('invalid create returns explicit accepted format and the owner agent preserves it verbatim',async()=>{
  const message='Create an invoice for QA';
  const tool=createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,confirmationMode:'direct',
    executeDirectOperation:async()=>({ok:false,code:'INVALID'})});
  const result=await tool.execute({operation:'create',table:'invoices',values:{customer_name:'QA'}});
  assert.equal(result.invoiceCreationFailure,true);assert.ok(result.message.endsWith(TEXT_INVOICE_FORMAT));
  let calls=0;
  const answer=await runOwnerAgent({scope,message,clock,logger:{info(){}},provider:{async generate(){
    calls++;return calls===1?{toolCalls:[{id:'create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{customer_name:'QA'}})}}]}:{content:'Please use the correct format.'};
  }},tools:{definitions:[tool.definition],execute:()=>result,getWriteAttempted:()=>true}});
  assert.equal(answer.answer,textInvoiceFailure(result));
});

test('a generic error or owner-supplied code cannot ground a duplicate claim',()=>{
  const reply='An invoice with the code QA-EDGE-002 already exists.';
  for(const code of ['INVALID','DATABASE_UNAVAILABLE','UNAVAILABLE','REPLAY_MISMATCH'])
    assert.equal(ownerGroundingIssue(reply,[{ok:false,code}],'QA-EDGE-002'),'unverified_invoice_duplicate');
  assert.equal(ownerGroundingIssue(reply,[{ok:false,code:'INVOICE_EXISTS'}],'QA-EDGE-002'),null);
  assert.equal(ownerGroundingIssue(reply,[{ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'QA-EDGE-002'}]}]),null);
  assert.equal(ownerGroundingIssue(reply,[{ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'OTHER'}]}]),'unverified_invoice_duplicate');
});

test('invalid natural-language creation plans return format help; authorization and protected fields stay enforced',async()=>{
  const message='New invoice for QA, amount Rs 500';
  let writes=0;
  const make=options=>createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,
    planRequest:async()=>({operation:'create',table:'invoices',values:{}}),
    executeDirectOperation:async()=>{writes++;throw Error('No write expected');},...options});
  const bad=await make().execute({request:message});
  assert.equal(bad.invoiceCreationFailure,true);assert.ok(bad.message.endsWith(TEXT_INVOICE_FORMAT));
  const valid=examples[0][0];
  const denied=await make({message:valid,authorize:async()=>false}).execute({request:valid});
  assert.equal(denied.code,'DENIED');
  const protectedCall=await make({message:valid}).execute({operation:'create',table:'invoices',values:{workspace_id:scope.workspaceId,customer_name:'QA'}});
  assert.equal(protectedCall.ok,false);assert.equal(writes,0);
});
