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

test('paid-invoice questions read verified settlement records without a model plan', async () => {
  const provider={generate:async()=>{throw new Error('Paid invoice lookup must not call the model');}};
  for (const message of ['which invoices are paid??','What invoice was paid?','List paid invoices','How many invoices are paid?']) {
    const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message,clock:fixedClock});
    assert.match(result.answer,/1 fully paid invoice: 1001 — Ann Revolution \(CHF 1650\.00\)/);
    assert.doesNotMatch(result.answer,/INV-005|1223113|GST-3425-26|couldn.t safely check/i);
    assert.deepEqual(result.evidence.records.map(row=>row.label),['1001']);
    assert.equal(result.evidence.complete,true);
  }
});

test('paid-invoice lookup validates the paid amount, does not equate partial payments with full settlement', async () => {
  const records={invoices:invoices.map(row => row.invoice_number === '1001' ? {...row,amount_paid:'500.00'} : row),customers,payments:[],invoice_files:[]};
  const result=await answerWorkspaceQuestion({provider:{generate:async()=>{throw Error('No model call expected');}},store:workspaceStore(records),message:'Are there any paid invoices?',clock:fixedClock});
  assert.equal(result.answer,'There are no fully paid invoices in this workspace right now.');
  assert.equal(result.evidence.complete,true);
  assert.deepEqual(result.evidence.records,[]);
});

test('paid-invoice lookup includes fully settled legacy rows with stale status and marks a shortened list', async () => {
  const legacy=invoices[3];
  const paidRows=Array.from({length:11},(_,index)=>({...legacy,id:`20000000-0000-4000-8000-${String(index).padStart(12,'0')}`,invoice_number:`PAID-${index}`,status:'sent'}));
  const result=await answerWorkspaceQuestion({provider:{generate:async()=>{throw Error('No model call expected');}},store:workspaceStore({invoices:paidRows,customers,payments:[],invoice_files:[]}),message:'Show me paid invoices',clock:fixedClock});
  assert.match(result.answer,/11 fully paid invoices/);
  assert.match(result.answer,/Showing the first 10\./);
  assert.doesNotMatch(result.answer,/PAID-10/);
  assert.equal(result.evidence.complete,false);
  assert.equal(result.evidence.truncated,true);
  assert.equal(result.evidence.records.length,10);
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
  assert.match(result.answer,/^Unpaid balances total AUD 6054\.00 and INR 1725\.00 right now\./i);
  assert.match(result.answer,/Some invoices need a quick review before these numbers are final\.$/i);
  assert.equal(result.answer.split('review').length - 1, 1);
  assert.doesNotMatch(result.answer,/customers? owe|debtor/i);
});

test('Assistant bypasses an incorrect empty-overdue model answer and returns grounded balances',async()=>{
  const provider=providerWithOverdueToolAndFalseEmptyAnswer();
  const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message:'Which invoices are overdue?',clock:fixedClock});

  assert.equal(provider.requests.length,0);
  assert.match(result.answer,/3 overdue invoices \(as of 28 Sept? 2026 UTC\):/i);
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
  assert.match(result.answer,/Some invoices need a quick review before follow-up\./i,'review flags should be one short plain-language line');
  assert.match(result.answer,/direction unclassified/i,'legacy rows without invoice direction cannot be called confirmed receivables');
  assert.doesNotMatch(result.answer,/Ann Revolution|1001|CHF 1650/);
  assert.deepEqual(result.evidence.records.map(row=>row.label),['INV-005','1223113','GST-3425-26']);
});

test('overdue summaries distinguish payable and uncertain direction with shared follow-up caveats',async()=>{
  const classifiedInvoices=[
    {...invoice('10000000-0000-4000-8000-000000000011',CUSTOMER_GREEN,'PAY-101','2026-09-15','INR','125.00','0.00','sent'),metadata:{invoice_direction:'payable'}},
    {...invoice('10000000-0000-4000-8000-000000000012',CUSTOMER_MINERAL,'UNC-202','2026-09-16','USD','240.00','0.00','sent'),metadata:{invoice_direction:'uncertain'}},
  ];
  const store=workspaceStore({invoices:classifiedInvoices,customers,payments:[],invoice_files:[]});
  const result=await answerWorkspaceQuestion({provider:providerWithOverdueToolAndFalseEmptyAnswer(),store,message:'Which invoices are overdue?',clock:fixedClock});

  assert.match(result.answer,/PAY-101.*INR 125\.00.*direction: payable/i);
  assert.match(result.answer,/UNC-202.*USD 240\.00.*direction uncertain/i);
  assert.match(result.answer,/Some invoices need a quick review before follow-up\./i);
  assert.equal((result.answer.match(/quick review/g)||[]).length,1);
  assert.doesNotMatch(result.answer,/confirm classification before treating|confirm unclassified/i);
});

test('dashboard overdue prompts bypass an AI planner that could add an unsupported date filter',async()=>{
  const provider={async generate(){throw Error('The dashboard prompt must not call the AI planner');}};
  for(const message of ['What needs my attention today?','Which invoices are most overdue?']){
    const result=await answerWorkspaceQuestion({provider,store:workspaceStore(),message,clock:fixedClock});
    assert.match(result.answer,/3 overdue invoices \(as of 28 Sept? 2026 UTC\):/i);
    assert.match(result.answer,/INV-005.*AUD 1564\.00/i);
    assert.match(result.answer,/1223113.*INR 1725\.00/i);
    assert.match(result.answer,/GST-3425-26.*AUD 4490\.00/i);
    assert.equal(result.model,null);
  }
});

test('largest-debtor answers rank confirmed receivables per currency and exclude unconfirmed drafts',async()=>{
  const rankedInvoices=[
    {...invoice('10000000-0000-4000-8000-000000000011',CUSTOMER_GREEN,'AUD-100','2026-09-01','AUD','100.00','0.00','sent'),metadata:{invoice_direction:'receivable'}},
    {...invoice('10000000-0000-4000-8000-000000000012',CUSTOMER_MINERAL,'AUD-250','2026-09-01','AUD','250.00','0.00','sent'),metadata:{invoice_direction:'receivable'}},
    {...invoice('10000000-0000-4000-8000-000000000013',CUSTOMER_SHIV,'INR-500','2026-09-01','INR','500.00','0.00','sent'),metadata:{invoice_direction:'receivable'}},
    invoice('10000000-0000-4000-8000-000000000014',CUSTOMER_GREEN,'AUD-DRAFT','2026-09-01','AUD','9000.00','0.00','draft'),
  ];
  const rankedCustomers=customers.map(row=>({...row,company_name:row.name}));
  const store=workspaceStore({invoices:rankedInvoices,customers:rankedCustomers,payments:[],invoice_files:[]});
  let providerCalls=0;
  const result=await answerWorkspaceQuestion({
    provider:{generate:async()=>{providerCalls++;throw Error('largest-debtor questions must not wait on a model');}},
    store,
    message:'Who owes me the most?',
    clock:fixedClock,
  });

  assert.equal(providerCalls,0);
  assert.match(result.answer,/MineralTree.*AUD 250\.00/i);
  assert.match(result.answer,/Shiv Engineering.*INR 500\.00/i);
  assert.match(result.answer,/by currency/i);
  assert.match(result.answer,/cannot (?:be )?compared|can't compare/i);
  assert.match(result.answer,/draft.*excluded|exclude.*draft/i);
  assert.doesNotMatch(result.answer,/Green1 Materials LLC.*AUD 9000\.00/i);
  assert.equal(result.model,null);

  const usResult=await answerWorkspaceQuestion({provider:{generate:async()=>{providerCalls++;throw Error('largest-debtor questions must not wait on a model');}},store,message:'Who owes us the most?',clock:fixedClock});
  assert.match(usResult.answer,/MineralTree.*AUD 250\.00/i);
  assert.equal(providerCalls,0);
});

test('who-do-I-owe phrasing does not enter the largest customer debtor shortcut',async()=>{
  let providerCalled=false;
  await assert.rejects(answerWorkspaceQuestion({
    provider:{generate:async()=>{providerCalled=true;throw Error('payer questions must stay on their own planner path');}},
    store:workspaceStore(),
    message:'Who do I owe the most?',
    clock:fixedClock,
  }),/payer questions must stay on their own planner path/);
  assert.equal(providerCalled,true);
});

test('explicit Zoho largest-debtor questions use connected Zoho data rather than the local ledger',async()=>{
  const requests=[];
  let zohoReads=0;
  const result=await answerWorkspaceQuestion({
    provider:{generate:async request=>{
      requests.push(request);
      if(request.tools)return {toolCalls:[{function:{name:'getZohoBooksData',arguments:'{"resource":"invoices"}'}}],model:'test-model',usedFallback:false};
      return {content:'No matching Zoho Books records are in the selected results.',finishReason:'STOP',model:'test-model',usedFallback:false};
    }},
    store:workspaceStore(),
    accounting:{readZohoData:async()=>{zohoReads++;return {records:[]};}},
    message:'Who owes me the most in Zoho Books?',
    clock:fixedClock,
  });
  assert.equal(zohoReads,1);
  assert.ok(requests[0].tools.some(item=>item.function.name==='getZohoBooksData'));
  assert.match(result.answer,/Zoho Books/);
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
  assert.match(result.answer,/Showing 5 of 101/i);
  assert.match(result.answer,/results truncated.*check the ledger/i);
  assert.deepEqual({complete:result.evidence.complete,truncated:result.evidence.truncated},{complete:false,truncated:true});
  assert.equal(result.evidence.records.length,100);
});
