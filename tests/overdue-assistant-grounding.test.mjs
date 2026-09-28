import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';
import {createAssistantTools} from '../ai/tools.mjs';

const WORKSPACE_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_GREEN='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUSTOMER_MINERAL='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CUSTOMER_SHIV='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CUSTOMER_PAID='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const invoice=(id,customerId,invoiceNumber,dueDate,currency,totalAmount,amountPaid,status='draft')=>({
  id,workspace_id:WORKSPACE_ID,customer_id:customerId,invoice_number:invoiceNumber,
  issue_date:dueDate,due_date:dueDate,currency,total_amount:totalAmount,amount_paid:amountPaid,status,
  created_at:`${dueDate}T09:00:00Z`,updated_at:`${dueDate}T09:00:00Z`,metadata:{},
});

const invoices=[
  invoice('10000000-0000-4000-8000-000000000001',CUSTOMER_GREEN,'INV-005','2021-06-27','AUD','1564.00','0.00'),
  invoice('10000000-0000-4000-8000-000000000002',CUSTOMER_MINERAL,'1223113','2024-01-15','INR','1725.00','0.00'),
  invoice('10000000-0000-4000-8000-000000000003',CUSTOMER_SHIV,'GST-3425-26','2026-09-26','AUD','4490.00','0.00'),
  invoice('10000000-0000-4000-8000-000000000004',CUSTOMER_PAID,'1001','2026-10-02','CHF','1650.00','1650.00','paid'),
];
const customers=[
  {id:CUSTOMER_GREEN,workspace_id:WORKSPACE_ID,name:'Green1 Materials LLC'},
  {id:CUSTOMER_MINERAL,workspace_id:WORKSPACE_ID,name:'MineralTree'},
  {id:CUSTOMER_SHIV,workspace_id:WORKSPACE_ID,name:'Shiv Engineering'},
  {id:CUSTOMER_PAID,workspace_id:WORKSPACE_ID,name:'Ann Revolution'},
];
const fixedClock=()=>new Date('2026-09-28T12:00:00.000Z');

function workspaceStore(records={invoices,customers,payments:[],invoice_files:[]}){

  return {async query(table,{filters={}}={}){
    return (records[table]||[]).filter(row=>Object.entries(filters).every(([column,expression])=>{
      const [operator,...parts]=String(expression).split('.');
      const value=parts.join('.');
      if(operator==='eq')return String(row[column])===value;
      if(operator==='in')return value.replace(/^\(|\)$/g,'').split(',').includes(String(row[column]));
      return false;
    }));
  }};
}

function providerWithOverdueToolAndFalseEmptyAnswer(){
  const requests=[];
  return {requests,async generate(request){
    requests.push(request);
    if(request.tools)return {toolCalls:[{function:{name:'getOverdueInvoices',arguments:'{}'}}],model:'test-model',usedFallback:false};
    return {content:"There aren't any overdue invoices in this workspace right now.",finishReason:'STOP',model:'test-model',usedFallback:false};
  }};
}

test('overdue results include unpaid past-due drafts from the ledger and exclude a future paid invoice',async()=>{
  const overdue=await createAssistantTools({store:workspaceStore(),clock:fixedClock}).execute('getOverdueInvoices',{});

  assert.equal(overdue.asOfUtcDate,'2026-09-28');
  assert.equal(overdue.count,3);
  assert.deepEqual(overdue.invoices.map(row=>[row.invoiceNumber,row.dueDate,row.currency,row.outstandingAmount,row.invoiceStatus]),[
    ['INV-005','2021-06-27','AUD','1564.00','draft'],
    ['1223113','2024-01-15','INR','1725.00','draft'],
    ['GST-3425-26','2026-09-26','AUD','4490.00','draft'],
  ]);
  assert.deepEqual(overdue.balancesByCurrency.AUD,{invoiceCount:2,totalAmount:'6054.00',amountPaid:'0.00',outstandingAmount:'6054.00'});
  assert.deepEqual(overdue.balancesByCurrency.INR,{invoiceCount:1,totalAmount:'1725.00',amountPaid:'0.00',outstandingAmount:'1725.00'});
  assert.equal(overdue.balancesByCurrency.CHF,undefined);
});

function providerWithFalseEmptyOutstandingAnswer(){
  const requests=[];
  return {requests,async generate(request){
    requests.push(request);
    if(request.tools)return {toolCalls:[{function:{name:'getOutstandingSummary',arguments:'{}'}}],model:'test-model',usedFallback:false};
    return {content:"There aren't any outstanding balances in this workspace right now.",finishReason:'STOP',model:'test-model',usedFallback:false};
  }};
}

test('Assistant replaces an incorrect empty-outstanding answer without calling unknown-direction invoices customer debt',async()=>{
  const provider=providerWithFalseEmptyOutstandingAnswer();
  const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message:'How much is outstanding?',clock:fixedClock});
  assert.match(result.answer,/unpaid ledger balances/i);
  assert.match(result.answer,/draft.*not sent/i);
  assert.match(result.answer,/direction.*unclassified|unclassified.*direction/i);
  assert.doesNotMatch(result.answer,/customers? owe|debtor/i);
});

test('Assistant replaces an incorrect empty-overdue answer with all three grounded past-due balances',async()=>{
  const provider=providerWithOverdueToolAndFalseEmptyAnswer();
  const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message:'Which invoices are overdue?',clock:fixedClock});

  assert.equal(provider.requests.length,2);
  assert.match(result.answer,/3 overdue invoices need attention/i);
  for(const [number,currency,amount,dueDate] of [
    ['INV-005','AUD','1564.00','2021-06-27'],
    ['1223113','INR','1725.00','2024-01-15'],
    ['GST-3425-26','AUD','4490.00','2026-09-26'],
  ]){
    assert.match(result.answer,new RegExp(`${number}.*${currency} ${amount}.*${dueDate}`));
  }
  for(const [number,customer] of [
    ['INV-005','Green1 Materials LLC'],
    ['1223113','MineralTree'],
    ['GST-3425-26','Shiv Engineering'],
  ]) assert.match(result.answer,new RegExp(`${number} for ${customer}`));
  assert.match(result.answer,/draft; not sent/i,'draft invoices must be clearly identified as unsent');
  assert.match(result.answer,/review and issue before follow-up/i,'draft invoices need owner review before any follow-up');
  assert.match(result.answer,/direction.*unclassified/i,'legacy rows without invoice direction cannot be called confirmed receivables');
  assert.doesNotMatch(result.answer,/Ann Revolution|1001|CHF 1650/);
  assert.deepEqual(result.evidence.records.map(row=>row.label),['INV-005','1223113','GST-3425-26']);
});

test('dashboard overdue prompts bypass an AI planner that could add an unsupported date filter',async()=>{
  const provider={async generate(){throw Error('The dashboard prompt must not call the AI planner');}};
  for(const message of ['What needs my attention today?','Which invoices are most overdue?']){
    const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message,clock:fixedClock});
    assert.match(result.answer,/3 overdue invoices need attention/i);
    assert.match(result.answer,/INV-005.*AUD 1564\.00/i);
    assert.match(result.answer,/1223113.*INR 1725\.00/i);
    assert.match(result.answer,/GST-3425-26.*AUD 4490\.00/i);
    assert.equal(result.model,null);
  }
});

test('truncated overdue results disclose partial details and evidence completeness',async()=>{
  const manyInvoices=Array.from({length:101},(_,index)=>invoice(
    `10000000-0000-4000-8000-${String(index+100).padStart(12,'0')}`,
    CUSTOMER_GREEN,
    `DUE-${String(index+1).padStart(3,'0')}`,
    '2026-09-20','AUD','10.00','0.00','sent',
  ));
  const store=workspaceStore({invoices:manyInvoices,customers:[customers[0]],payments:[],invoice_files:[]});
  const overdue=await createAssistantTools({store,clock:fixedClock}).execute('getOverdueInvoices',{});
  assert.equal(overdue.count,101);
  assert.equal(overdue.invoices.length,100);
  assert.deepEqual({complete:overdue.complete,truncated:overdue.truncated},{complete:false,truncated:true});

  const provider=providerWithOverdueToolAndFalseEmptyAnswer();
  const result=await answerWorkspaceQuestion({provider,store,message:'Which invoices are overdue?',clock:fixedClock});
  assert.match(result.answer,/showing the first 5 of 101/i);
  assert.match(result.answer,/result is truncated.*check the ledger/i);
  assert.deepEqual({complete:result.evidence.complete,truncated:result.evidence.truncated},{complete:false,truncated:true});
  assert.equal(result.evidence.records.length,100);
});
