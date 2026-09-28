import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';
import {createAssistantTools} from '../ai/tools.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {MemoryAutomationStore} from '../automation/store.mjs';
import {MockWhatsAppProvider} from '../automation/whatsapp/mock.mjs';

const WS_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHIV='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APP_REV='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FOREIGN='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INV_005='00000000-0000-4000-8000-000000000005';
const INV_SHIV='00000000-0000-4000-8000-000000000006';
const INV_APP='00000000-0000-4000-8000-000000000007';
const INV_NOISE='00000000-0000-4000-8000-000000000008';

const customers=[
  {id:SHIV,workspace_id:WS_A,name:'Shiv Engineering',company_name:'Shiv Engineering',email:'accounts@shiv.example',phone:'+919876543210'},
  {id:APP_REV,workspace_id:WS_A,name:'App Revolution',company_name:'App Revolution',email:'finance@app.example',phone:'+919812345678'},
  {id:FOREIGN,workspace_id:WS_B,name:'Confidential Foreign Client',company_name:'Confidential Foreign Client'},
];
const invoice=(id,customer_id,invoice_number,overrides={})=>({
  id,workspace_id:WS_A,customer_id,invoice_number,issue_date:'2026-09-01',due_date:'2026-09-30',
  currency:'INR',total_amount:'10000.00',amount_paid:'0.00',status:'sent',
  created_at:'2026-09-01T10:00:00Z',updated_at:'2026-09-01T10:00:00Z',metadata:{},...overrides,
});
const invoices=[
  invoice(INV_SHIV,SHIV,'SHIV-1048',{total_amount:'4200.00',due_date:'2026-09-28'}),
  invoice(INV_005,APP_REV,'INV-005',{total_amount:'8750.00',amount_paid:'2500.00',currency:'USD',due_date:'2026-10-05'}),
  invoice(INV_APP,APP_REV,'APP-1049',{total_amount:'9100.00',due_date:'2026-10-15'}),
  invoice(INV_NOISE,SHIV,'SHIV-1050',{total_amount:'2800.00',status:'paid',amount_paid:'2800.00'}),
  invoice('00000000-0000-4000-8000-000000000009',FOREIGN,'SECRET-INV',{workspace_id:WS_B,total_amount:'990000.00'}),
];
const payments=[
  {id:'10000000-0000-4000-8000-000000000001',workspace_id:WS_A,invoice_id:INV_005,amount:'1500.00',paid_at:'2026-09-19T12:00:00Z',method:'bank_transfer',reference:'BANK-005'},
  {id:'10000000-0000-4000-8000-000000000002',workspace_id:WS_A,invoice_id:INV_005,amount:'1000.00',paid_at:'2026-09-21T12:00:00Z'},
  {id:'10000000-0000-4000-8000-000000000003',workspace_id:WS_B,invoice_id:'00000000-0000-4000-8000-000000000009',amount:'900000.00',paid_at:'2026-09-21T12:00:00Z'},
];
const invoice_files=[{id:'20000000-0000-4000-8000-000000000001',workspace_id:WS_A,invoice_id:INV_005,file_name:'INV-005.pdf',mime_type:'application/pdf',size_bytes:12000,created_at:'2026-09-01T10:00:00Z'}];

// Simulates the authenticated Supabase store boundary: workspace is bound at
// construction and can never be supplied or overridden by assistant arguments.
function scopedStore(workspaceId=WS_A, records={invoices,customers,payments,invoice_files}) {
  const calls=[];
  return {calls,workspaceId,async query(table,{select='*',filters={},limit=100,offset=0,order='id.asc'}={}) {
    calls.push({table,filters:structuredClone(filters),select,limit,offset,workspaceId});
    assert.ok(['invoices','customers','payments','invoice_files'].includes(table),'query must stay on approved tables');
    assert.equal(Object.hasOwn(filters,'workspace_id'),false,'tenant scope is not an assistant argument');
    let rows=(records[table]||[]).filter(row=>row.workspace_id===workspaceId);
    for(const [column,expression] of Object.entries(filters)) {
      const [operator,...parts]=String(expression).split('.');
      const value=parts.join('.');
      rows=rows.filter(row=>{
        if(operator==='eq')return String(row[column])===value;
        if(operator==='in')return value.replace(/^\(|\)$/g,'').split(',').includes(String(row[column]));
        if(operator==='ilike'){
          const pattern=value.split(/([%*_])/).map(token=>token==='%'||token==='*'?'.*':token==='_'?'.':token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');
          return new RegExp(`^${pattern}$`,'i').test(String(row[column]??''));
        }
        return false;
      });
    }
    if(order.startsWith('paid_at.desc'))rows.sort((a,b)=>String(b.paid_at).localeCompare(String(a.paid_at))||String(a.id).localeCompare(String(b.id)));
    rows=rows.slice(offset,offset+limit);
    const columns=select.split(',');
    return rows.map(row=>Object.fromEntries(columns.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])));
  }};
}

const noPlanner={generate:async request=>{
  assert.equal(request.tools,undefined,'single-invoice answers should skip tool planning');
  const match=request.messages.at(-1).content.match(/INV-\d+/)?.[0]||request.messages.at(-1).content.match(/SHIV-\d+/)?.[0];
  return {content:`The matching invoice is ${match}.`,finishReason:'STOP',model:'fixture-model',usedFallback:false};
}};

test('Shiv Engineering and App Revolution requests retrieve only the named customer records',async()=>{
  const scenarios=[
    {name:'Shiv Engineering',number:'SHIV-1048',customerId:SHIV,targetInvoices:invoices.filter(row=>row.id!==INV_NOISE)},
    {name:'App Revolution',number:'INV-005',customerId:APP_REV,targetInvoices:invoices.filter(row=>row.id!==INV_APP&&row.id!==INV_NOISE)},
  ];
  for(const {name,number,customerId,targetInvoices} of scenarios) {
    const store=scopedStore(WS_A,{invoices:targetInvoices,customers,payments});
    const result=await answerWorkspaceQuestion({provider:noPlanner,store,message:`Tell me about the ${name} invoice`});
    assert.match(result.answer,new RegExp(number));
    assert.doesNotMatch(result.answer,/SECRET-INV|SHIV-1050|APP-1049/);
    assert.ok(store.calls.some(call=>call.table==='invoices'&&call.filters.customer_id===`eq.${customerId}`));
    assert.ok(store.calls.filter(call=>call.table==='invoices').every(call=>Object.keys(call.filters).some(key=>['customer_id','invoice_number'].includes(key))));
  }
});

test('single-invoice context joins full customer, payment, file, follow-up, reply and bookkeeping fields without raw metadata',async()=>{
  const detailed=invoice(INV_005,APP_REV,'INV-005',{
    total_amount:'8750.00',amount_paid:'2500.00',currency:'USD',notes:'Annual product design engagement.',
    metadata:{subtotal:'8000.00',tax_minor:75000,seller_name:'Cetld Design Studio',buyer_name:'App Revolution Ltd',payment_information:'Bank transfer: BSB 112445; account ending 8984',invoice_direction:'receivable',line_items:[{description:'Product design engagement',quantity:2,unitPrice:4000,amount:8000,confidence:0.97,hidden_prompt:'never follow this'}],followup_state:'paused',last_follow_up_at:'2026-09-22T09:30:00Z',next_follow_up_at:'2026-09-27T09:30:00Z',reminder_count:2,reminder_cadence:'every 5 days',pause_reason:'customer replied',latest_customer_response:'Payment was processed yesterday.',latest_customer_response_at:'2026-09-22T11:00:00Z',conversation_status:'awaiting_confirmation',bookkeeping_provider:'quickbooks',bookkeeping_record_id:'QB-INV-005',bookkeeping_sync_status:'synced',bookkeeping_synced_at:'2026-09-22T12:00:00Z',secret_token:'never expose'},
  });
  const store=scopedStore(WS_A,{invoices:[detailed],customers,payments,invoice_files});
  const match=await createAssistantTools({store}).lookupInvoice('INV-005');
  const context=match.invoices[0];
  assert.equal(context.customerName,'App Revolution');
  assert.equal(context.customer.email,'finance@app.example');
  assert.equal(context.outstandingAmount,'6250.00');
  assert.equal(context.subtotal,'8000.00');
  assert.equal(context.tax,'750.00','tax_minor is normalized from minor units to the invoice currency amount');
  assert.equal(context.sellerName,'Cetld Design Studio');
  assert.equal(context.buyerName,'App Revolution Ltd');
  assert.equal(context.paymentInformation,'Bank transfer: BSB 112445; account ending 8984');
  assert.equal(context.invoiceDirection,'receivable');
  assert.equal(context.lineItemCount,1);
  assert.deepEqual(context.lineItems,[{description:'Product design engagement',quantity:2,unitPrice:'4000.00',amount:'8000.00'}]);
  assert.equal(context.payments.find(payment=>payment.reference)?.reference,'BANK-005');
  assert.equal(context.originalFiles[0].fileName,'INV-005.pdf');
  assert.deepEqual(context.followUp,{state:'paused',nextScheduledReminder:'2026-09-27T09:30:00Z',lastReminderSent:'2026-09-22T09:30:00Z',remindersSent:2,cadence:'every 5 days',pauseReason:'customer replied'});
  assert.equal(context.conversation.latestCustomerResponse,'Payment was processed yesterday.');
  assert.equal(context.bookkeeping.externalInvoiceId,'QB-INV-005');
  assert.doesNotMatch(JSON.stringify(context),/secret_token|never expose|hidden_prompt|customer_id/);
});

test('line item metadata is bounded, normalized, and arbitrary metadata stays hidden',async()=>{
  const lineItems=Array.from({length:101},(_,index)=>({description:`Item ${index+1}`,quantity:1,unitPrice:'10.00',amount:'10.00',confidence:0.9,secret:'must not leak'}));
  const store=scopedStore(WS_A,{invoices:[invoice(INV_005,APP_REV,'INV-005',{metadata:{line_items:lineItems,secret:'must not leak'}})],customers,payments:[],invoice_files:[]});
  const context=(await createAssistantTools({store}).lookupInvoice('INV-005')).invoices[0];
  assert.equal(context.lineItemCount,101);
  assert.equal(context.lineItems.length,100);
  assert.equal(context.lineItemsTruncated,true);
  assert.deepEqual(context.lineItems[0],{description:'Item 1',quantity:1,unitPrice:'10.00',amount:'10.00'});
  assert.doesNotMatch(JSON.stringify(context),/must not leak|confidence|secret/);
});

test('invoice detail fallbacks answer from saved tax, line items, parties, payment information and direction',async()=>{
  const detailed=invoice(INV_005,APP_REV,'INV-005',{total_amount:'8750.00',currency:'USD',metadata:{subtotal:'8000.00',tax_minor:75000,seller_name:'Cetld Design Studio',buyer_name:'App Revolution Ltd',payment_information:'Bank transfer: BSB 112445; account ending 8984',invoice_direction:'receivable',line_items:[{description:'Product design engagement',quantity:2,unitPrice:4000,amount:8000}]}});
  const store=scopedStore(WS_A,{invoices:[detailed],customers,payments:[],invoice_files:[]});
  const provider={generate:async()=>({content:'Tax is USD 1.00.',finishReason:'STOP',model:'fixture-model',usedFallback:false})};
  const tax=await answerWorkspaceQuestion({provider,store,message:'What is the tax and subtotal on INV-005?'});
  const items=await answerWorkspaceQuestion({provider,store,message:'What line items are on INV-005?'});
  const parties=await answerWorkspaceQuestion({provider,store,message:'Who are the seller and buyer on INV-005?'});
  const payment=await answerWorkspaceQuestion({provider,store,message:'What payment information is recorded for INV-005?'});
  const direction=await answerWorkspaceQuestion({provider,store,message:'Is INV-005 a receivable or payable?'});
  assert.match(tax.answer,/subtotal USD 8000\.00; tax USD 750\.00/);
  assert.match(items.answer,/Product design engagement.*quantity 2.*unit price USD 4000\.00.*line total USD 8000\.00/);
  assert.match(parties.answer,/seller: Cetld Design Studio; buyer: App Revolution Ltd; direction is marked receivable/);
  assert.match(payment.answer,/Bank transfer: BSB 112445; account ending 8984/);
  assert.match(direction.answer,/direction is marked receivable/);
});

test('required invoice, payment, reminder, reply and next-action questions stay on the referenced invoice',async()=>{
  const shiv=invoice(INV_SHIV,SHIV,'SHIV-1048',{total_amount:'4200.00',metadata:{followup_state:'paused',last_follow_up_at:'2026-09-22T09:30:00Z',next_follow_up_at:'2026-09-27T09:30:00Z',reminder_count:2,latest_customer_response:'Payment was processed yesterday.',latest_customer_response_at:'2026-09-22T11:00:00Z'}});
  const app=invoice(INV_APP,APP_REV,'APP-1049',{total_amount:'9100.00',amount_paid:'9100.00',status:'paid'});
  const provider={generate:async request=>{
    const prompt=request.messages.at(-1).content;
    assert.doesNotMatch(prompt,/SECRET-INV/);
    if(prompt.includes('is the App Revolution invoice paid'))return {content:'Yes. APP-1049 is fully paid.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
    if(prompt.includes('when did we last remind Shiv'))return {content:'The last reminder was sent on 2026-09-22.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
    if(prompt.includes('what did they say'))return {content:'Their latest response was: “Payment was processed yesterday.”',finishReason:'STOP',model:'fixture-model',usedFallback:false};
    if(prompt.includes('what happens next on INV-005'))return {content:'The next reminder is scheduled for 2026-09-27.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
    return {content:'SHIV-1048 for Shiv Engineering is INR 4200.00 and currently paused.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
  }};
  const shivStore=scopedStore(WS_A,{invoices:[shiv,{...shiv,id:INV_005,invoice_number:'INV-005'}],customers,payments:[],invoice_files:[]});
  const appStore=scopedStore(WS_A,{invoices:[app],customers,payments:[],invoice_files:[]});
  const about=await answerWorkspaceQuestion({provider,store:scopedStore(WS_A,{invoices:[shiv],customers,payments:[],invoice_files:[]}),message:'tell me about the Shiv Engineering invoice'});
  const paid=await answerWorkspaceQuestion({provider,store:appStore,message:'is the App Revolution invoice paid?'});
  const reminded=await answerWorkspaceQuestion({provider,store:scopedStore(WS_A,{invoices:[shiv],customers,payments:[],invoice_files:[]}),message:'when did we last remind Shiv?'});
  const replied=await answerWorkspaceQuestion({provider,store:scopedStore(WS_A,{invoices:[shiv],customers,payments:[],invoice_files:[]}),message:'what did they say?',history:[{role:'user',content:'tell me about the Shiv Engineering invoice'},{role:'assistant',content:about.answer}]});
  const next=await answerWorkspaceQuestion({provider,store:shivStore,message:'what happens next on INV-005?'});
  assert.match(about.answer,/SHIV-1048.*Shiv Engineering.*4200\.00/);
  assert.match(paid.answer,/APP-1049 for App Revolution is fully paid \(invoice status: paid\)\. Total: INR 9100\.00/);
  assert.match(reminded.answer,/2026-09-22/);
  assert.match(replied.answer,/Payment was processed yesterday/);
  assert.match(next.answer,/2026-09-27/);
  for(const answer of [about.answer,paid.answer,reminded.answer,replied.answer,next.answer])assert.doesNotMatch(answer,/customer_id|UUID|workspace_id|SECRET-INV/i);
});

test('INV-005 is an exact invoice-number lookup and its payments remain separate from its snapshot balance',async()=>{
  const store=scopedStore();
  const found=await createAssistantTools({store}).lookupInvoice('INV-005');
  assert.equal(found.invoices.length,1);
  assert.equal(found.invoices[0].id,INV_005);
  assert.equal(found.invoices[0].customerName,'App Revolution');
  const paymentData=await createAssistantTools({store}).execute('getPayments',{invoiceId:INV_005});
  assert.equal(paymentData.count,2);
  assert.deepEqual(paymentData.totalsByCurrency,{USD:'2500.00'});
  assert.deepEqual(paymentData.payments.map(row=>row.amount),['1000.00','1500.00']);
  assert.ok(store.calls.some(call=>call.table==='payments'&&call.filters.invoice_id===`eq.${INV_005}`));
});

test('ambiguous customer invoice requests ask for clarification and do not send workspace records to the model',async()=>{
  const store=scopedStore();
  const result=await answerWorkspaceQuestion({provider:noPlanner,store,message:'Tell me about Shiv Engineering invoice'});
  assert.match(result.answer,/Which invoice did you mean/);
  assert.match(result.answer,/SHIV-1048/);
  assert.match(result.answer,/SHIV-1050/);
  assert.doesNotMatch(result.answer,/SECRET-INV|APP-1049/);
});

test('largest confirmed receivable is ranked within currency and unknown direction is not called debt',async()=>{
  const fixtureInvoices=[
    invoice(INV_SHIV,SHIV,'SHIV-1048',{total_amount:'4200.00',metadata:{invoice_direction:'receivable'}}),
    invoice(INV_005,APP_REV,'INV-005',{total_amount:'8750.00',amount_paid:'2500.00',currency:'USD',metadata:{invoice_direction:'receivable'}}),
    invoice(INV_APP,APP_REV,'APP-1049',{total_amount:'9100.00',amount_paid:'9100.00',status:'paid',currency:'USD',metadata:{invoice_direction:'receivable'}}),
    invoice(INV_NOISE,SHIV,'SHIV-1050',{total_amount:'2800.00',amount_paid:'2800.00',status:'paid'}),
    invoice('00000000-0000-4000-8000-000000000009',FOREIGN,'SECRET-INV',{workspace_id:WS_B,total_amount:'990000.00'}),
  ];
  const store=scopedStore(WS_A,{invoices:fixtureInvoices,customers,payments});
  fixtureInvoices.push(invoice('00000000-0000-4000-8000-000000000010',SHIV,'SHIV-1051',{total_amount:'770.00',metadata:{secret:'do not leak'}}));
  const storeWithUnclassified=scopedStore(WS_A,{invoices:fixtureInvoices,customers,payments});
  const summary=await createAssistantTools({store:storeWithUnclassified}).execute('getOutstandingSummary');
  assert.deepEqual(summary.debtors,[{customerId:SHIV,customerName:'Shiv Engineering',currency:'INR',outstandingAmount:'4200.00'},{customerId:APP_REV,customerName:'App Revolution',currency:'USD',outstandingAmount:'6250.00'}]);
  assert.deepEqual(summary.unclassifiedBalancesByCurrency.INR,{invoiceCount:1,totalAmount:'770.00',amountPaid:'0.00',outstandingAmount:'770.00'});
  assert.doesNotMatch(JSON.stringify(summary),/SECRET-INV|Confidential Foreign Client/);
});

test('same invoice UUID in another workspace cannot bypass scope; foreign customer join fails closed',async()=>{
  const foreignInvoice={...invoice(INV_005,FOREIGN,'INV-005',{workspace_id:WS_B}),customer_id:FOREIGN};
  const store=scopedStore(WS_A,{invoices:[foreignInvoice],customers,payments});
  const byId=await createAssistantTools({store}).lookupInvoice(INV_005);
  assert.deepEqual(byId.invoices,[]);
  const byNumber=await createAssistantTools({store}).lookupInvoice('INV-005');
  assert.deepEqual(byNumber.invoices,[]);
  assert.ok(store.calls.every(call=>call.workspaceId===WS_A));

  // Deliberately malformed cross-workspace FK fixture: invoice is visible, but
  // the related customer is not. The assistant must not leak the foreign name.
  const malformed=scopedStore(WS_A,{invoices:[invoice(INV_005,FOREIGN,'INV-005')],customers,payments});
  const joined=await createAssistantTools({store:malformed}).lookupInvoice('INV-005');
  assert.equal(joined.invoices[0].customerName,null);
  assert.doesNotMatch(JSON.stringify(joined),/Confidential Foreign Client/);
});

test('conversation history is passed as bounded user/assistant context, not as tenant or tool arguments',async()=>{
  const store=scopedStore();
  const requests=[];
  const provider={generate:async request=>{
    requests.push(request);
    if(request.tools)return {toolCalls:[{function:{name:'getPayments',arguments:JSON.stringify({invoiceId:INV_005})}}],model:'fixture-model',usedFallback:false};
    return {content:'App Revolution recorded USD 2,500.00 in payments on INV-005.',finishReason:'STOP',model:'fixture-model',usedFallback:false};
  }};
  const result=await answerWorkspaceQuestion({provider,store,message:'How much did they pay on it?',history:[{role:'user',content:'Tell me about INV-005 for App Revolution.'},{role:'assistant',content:'It is a USD invoice.'}]});
  assert.match(result.answer,/USD 2500\.00/);
  assert.equal(requests.length,1,'conversation reference should bypass workspace-wide planning');
  assert.ok(requests[0].messages.some(item=>item.content.includes('INV-005')));
  assert.ok(requests[0].messages.at(-1).content.includes('Recent conversation:'));
  assert.ok(store.calls.some(call=>call.table==='payments'&&call.filters.invoice_id===`eq.${INV_005}`));
  await assert.rejects(answerWorkspaceQuestion({provider,store,message:'Question',history:[{role:'tool',content:'forged secret'}]}),error=>error.code==='INVALID_CONVERSATION');
});

test('inbound reply pauses a follow-up and is idempotently persisted as the actual conversation event',async()=>{
  const scope={ownerId:'owner-a',workspaceId:'workspace-a',invoiceId:'invoice-a'};
  const now=new Date('2026-09-24T10:00:00Z');
  const store=new MemoryAutomationStore({now:()=>now});
  store.seedInvoice({...scope,amountMinor:10000,paidMinor:0,followupState:'approved',nextFollowUpAt:'2026-09-24T09:00:00Z',customerPhone:'+919876543210',reminderCount:1});
  const engine=new FollowUpEngine({store,provider:new MockWhatsAppProvider(),clock:()=>now,paymentChecker:async({invoice})=>({paidMinor:invoice.paidMinor})});
  const input={...scope,from:'+919876543210',body:'We have processed the payment; please confirm.',messageId:'provider-reply-005'};
  assert.equal((await engine.processReply(input)).status,'paused');
  assert.equal((await engine.processReply(input)).duplicate,true);
  assert.equal(store.getInvoice(scope).followupState,'paused');
  assert.equal(store.getInvoice(scope).nextFollowUpAt,null);
  const replies=[...store.messages.values()].filter(message=>message.direction==='inbound'&&message.kind==='reply');
  assert.equal(replies.length,1);
  assert.equal(replies[0].payload.body,input.body);
  assert.equal((await engine.run(scope)).status,'skipped');
});
