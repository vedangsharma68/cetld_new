import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerInvoiceReadAnalysis,deriveInvoiceReadAnalysis,invoiceReadAnalysisReply} from '../automation/whatsapp/owner-invoice-read-analysis.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const question='If Offline Ledger Company pays USD 1000 against QA-2048, how much would be overpaid? Just explain; do not record a payment or change anything.';
const row={invoice_number:'INV-2048-1',currency:'USD',total_amount:'1234.56',amount_paid:'400',metadata:{source_invoice_number:'QA-2048'}};
test('conditional analysis is separate from financial instructions and ambiguous scenarios',()=>{
  assert.equal(ownerInvoiceReadAnalysis(question)?.kind,'conditionalPayment');
  for(const text of [question+' Record the payment now.',question.replace('1000','1000.001'),question.replace('USD 1000','USD 0'),
    'Record USD 1000 payment for Offline Ledger Company invoice QA-2048.',
    question.replace('USD 1000','USD 1000 or USD 1200')])assert.equal(ownerInvoiceReadAnalysis(text),null,text);
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
