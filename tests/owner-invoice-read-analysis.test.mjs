import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerInvoiceReadAnalysis,ownerHypotheticalOverpayment,deriveInvoiceReadAnalysis,invoiceReadAnalysisReply,invoiceReadAnalysisArgs} from '../automation/whatsapp/owner-invoice-read-analysis.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const question='If Offline Ledger Company pays USD 1000 against QA-2048, how much would be overpaid? Just explain; do not record a payment or change anything.';
const row={invoice_number:'INV-2048-1',currency:'USD',total_amount:'1234.56',amount_paid:'400',metadata:{source_invoice_number:'QA-2048'}};
test('plain unpaid list requests are read-only and derive net balances without equating unpaid with a status',()=>{
  for(const message of ['show me my unpaid invoices','Please list outstanding invoices.','show unpaid invoices'])
    assert.equal(ownerInvoiceReadAnalysis(message)?.kind,'unpaidInvoices');
  for(const message of ['show me my unpaid invoices and record a payment','mark my invoices unpaid','show unpaid invoices for Example'])
    assert.equal(ownerInvoiceReadAnalysis(message),null);
  const parsed=ownerInvoiceReadAnalysis('show me my unpaid invoices');
  const derived=deriveInvoiceReadAnalysis(parsed,[{...row,status:'draft'},
    {...row,invoice_number:'REVERSED-1',status:'sent',amount_paid:'0'},
    {...row,invoice_number:'FULL-1',status:'sent',amount_paid:'1234.56'},
    {...row,invoice_number:'OVER-1',status:'sent',amount_paid:'1300'},
    {...row,invoice_number:'BILL-1',status:'draft',metadata:{invoice_direction:'payable'}}]);
  assert.deepEqual(derived.invoices.map(row=>[row.invoiceNumber,row.outstanding]),[['INV-2048-1','834.56'],['REVERSED-1','1234.56'],['BILL-1','834.56']]);
  const reply=invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',invoiceReadAnalysis:derived});
  assert.match(reply,/including drafts/);assert.match(reply,/BILL-1.*payable/);assert.doesNotMatch(reply,/FULL-1|OVER-1|no payments|never paid/i);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,status:'draft'}],{truncated:true}),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,status:'void'}]),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,status:'sent',amount_paid:null}]),null);
  const empty=deriveInvoiceReadAnalysis(parsed,[]);
  assert.match(invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',invoiceReadAnalysis:empty}),/No unpaid invoices/);
  const many=deriveInvoiceReadAnalysis(parsed,Array.from({length:30},(_,i)=>({...row,invoice_number:`INV-LONG-${i}`,customer_name:'Long synthetic customer name'.repeat(4),status:'draft'})));
  const shortReply=invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',invoiceReadAnalysis:many});
  assert(shortReply.length<=1024);assert.match(shortReply,/Showing \d+ of 30/);
});
test('explicit all-customer unpaid listing accepts only bounded global, draft, and no-change clauses',()=>{
  assert.deepEqual(ownerInvoiceReadAnalysis('now show me my unpaid invoices'),{kind:'unpaidInvoices',includeDrafts:true});
  assert.equal(ownerInvoiceReadAnalysis('show me my unpaid invoices now'),null);
  const message='Show me all unpaid invoices across all customers, including drafts. Do not change anything.';
  const parsed=ownerInvoiceReadAnalysis(message);
  assert.deepEqual(parsed,{kind:'unpaidInvoices',includeDrafts:true});
  assert.deepEqual(invoiceReadAnalysisArgs(parsed).filters,[{column:'status',operator:'in',value:['draft','sent','overdue']}]);
  for(const text of [message+' Send reminders.','Show all unpaid invoices for Example Customer, including drafts. Do not change anything.',
    'Show all unpaid invoices across all customers, including drafts, and mark them reviewed.'])
    assert.equal(ownerInvoiceReadAnalysis(text),null,text);
});
test('conditional analysis is separate from financial instructions and ambiguous scenarios',()=>{
  assert.equal(ownerInvoiceReadAnalysis(question)?.kind,'conditionalPayment');
  for(const text of [question+' Record the payment now.',question.replace('1000','1000.001'),question.replace('USD 1000','USD 0'),
    'Record USD 1000 payment for Offline Ledger Company invoice QA-2048.',
    question.replace('USD 1000','USD 1000 or USD 1200')])assert.equal(ownerInvoiceReadAnalysis(text),null,text);
});
test('abstract hypothetical overpayment is strict, same-currency integer-cent arithmetic',()=>{
  const question='If a customer pays USD 120 on an invoice for USD 100, how much is overpaid? Just explain, do not record a payment.';
  assert.deepEqual(ownerHypotheticalOverpayment(question),{currency:'USD',paymentCents:12000,invoiceTotalCents:10000,overpaymentCents:2000});
  assert.equal(ownerHypotheticalOverpayment(question.replace('USD 120','INR 120')),null);
  for(const text of [question.replace('USD 100','USD 100 or USD 90'),question.replace('USD 120','USD 0'),
    question+' Record it.',question.replace('USD 120','USD 120.001')])assert.equal(ownerHypotheticalOverpayment(text),null,text);
});
test('scenario calculation uses integer cents and refuses currency mismatch, incomplete and ambiguous reads',()=>{
  const parsed=ownerInvoiceReadAnalysis(question),derived=deriveInvoiceReadAnalysis(parsed,[row]);
  assert.equal(derived.resultingOverpayment,'165.44');assert.equal(derived.resultingOutstanding,'0.00');
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,currency:'INR'}]),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[row,row]),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[row],{truncated:true}),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,amount_paid:null}]),null);
  assert.equal(deriveInvoiceReadAnalysis(parsed,[{...row,metadata:{...row.metadata,invoice_direction:'payable'}}]),null);
  assert.equal(invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',truncated:true,invoiceReadAnalysis:derived}),null);
});
test('currency groups keep receivable balances apart and omit known payable invoices',()=>{
  const parsed=ownerInvoiceReadAnalysis('Show unpaid balances for Example One and Example Two, grouped by currency. Include draft invoices.');
  const result=deriveInvoiceReadAnalysis(parsed,[{...row,customer_name:'Example One'},
    {...row,customer_name:'Example Two',currency:'INR',total_amount:'1000',amount_paid:'100'},
    {...row,customer_name:'Example One',total_amount:'9999',metadata:{invoice_direction:'payable'}}]);
  assert.deepEqual(result.groups,[{currency:'INR',outstanding:'900.00'},{currency:'USD',outstanding:'834.56'}]);
});
test('planner failure diagnostics expose only an allowlisted code/status and phase',async()=>{
  const tool=createWorkspaceDataTool({supabase:{from(){throw Error('no SQL expected');}},scope:{workspaceId:'synthetic'},authorize:async()=>true,
    planRequest:async()=>{throw Object.assign(new Error('private output must remain hidden'),{code:'INVALID_OUTPUT',status:502});}});
  const result=await tool.execute({request:'Show invoice balances'});
  assert.equal(result.code,'UNAVAILABLE');assert.deepEqual(result.planningFailure,{phase:'planning',deadlineExpired:false,code:'INVALID_OUTPUT',status:502});
  assert.doesNotMatch(JSON.stringify(result),/private output/);
});
test('an interrupted conditional read resumes its scoped lookup without a payment proposal or model call',async()=>{
  let pause=true,checkpoint,readCalls=0;
  const controller=new AbortController();
  const derived=deriveInvoiceReadAnalysis(ownerInvoiceReadAnalysis(question),[row]);
  const tools={supportsInvoiceReadAnalysis:true,definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
    getWriteAttempted:()=>false,
    async execute(name,args){
      assert.equal(name,'workspaceData');assert.equal(args.operation,'read');assert.equal(args.table,'invoices');readCalls++;
      if(pause){controller.abort();await Promise.resolve();}
      return {ok:true,readOnly:true,operation:'read',table:'invoices',truncated:false,rows:[{invoice_number:row.invoice_number}],invoiceReadAnalysis:derived};
    }};
  const provider={async generate(){throw Error('read analysis must not request a model');}};
  const first=await runOwnerAgent({provider,tools,message:question,allowDeferred:true,budgetMs:1000,signal:controller.signal,onCheckpoint:async value=>{checkpoint=structuredClone(value);}});
  assert.equal(first.deferred,true);assert.equal(checkpoint.boundedInvoiceReadSelected,true);
  assert.equal(checkpoint.pendingToolCalls[0].name,'workspaceData');assert.equal(checkpoint.pendingToolCalls[0].args.operation,'read');
  assert.equal(checkpoint.uncertainWrite,null);
  pause=false;
  const resumed=await runOwnerAgent({provider,tools,message:question,allowDeferred:true,checkpoint,budgetMs:1000});
  assert.match(resumed.answer,/overpayment would be USD 165\.44/);assert.match(resumed.answer,/No changes were made/);assert.equal(readCalls,2);
});
