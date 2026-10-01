import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppBoundMessageHandler, parseInvoiceCorrection} from '../automation/whatsapp/assistant-handler.mjs';

const scope={workspaceId:'workspace-a',customerId:'customer-a',phone:'+919871367051'};
function supabase(){return {from(table){return {select(){return this},eq(){return this},async maybeSingle(){if(table==='workspace_ai_settings')return {data:{primary_model:'space-bunny-free',fallback_model:null}};throw Error(table)}}}}}
function handlerWith(store,{current=null}={}){
  return createWhatsAppBoundMessageHandler({supabase:supabase(),providerFactory:()=>({}),channelFactory:()=>({ask(){throw Error('planner must not write')}}),
    pendingActionStoreFactory:()=>({loadInvoiceReview:async()=>current}),invoiceStoreFactory:()=>store,clock:()=>new Date('2026-10-01T12:00:00Z')});
}
const invoice={id:'invoice-1',invoiceNumber:'INV-2026-0001',printedInvoiceNumber:'INV-2026-0720',clientName:'Global Dynamics Inc.',total:100,currency:'USD',status:'draft'};

test('closed correction grammar accepts supported fields and rejects free-form writes',()=>{
  assert.deepEqual(parseInvoiceCorrection('change its amount to 6969USD'),{changes:{total:6969,currency:'USD'}});
  assert.deepEqual(parseInvoiceCorrection('make the due date 30 Sept',()=>new Date('2026-10-01')),{changes:{dueDate:'2026-09-30'}});
  assert.equal(parseInvoiceCorrection('run update invoices set total=1'),null);
});

test('correction immediately applies and echoes old -> new; redelivery is idempotent',async()=>{
  let calls=0;
  const store={findInvoices:async()=>[invoice],async applyCorrection(input){calls++;assert.equal(input.idempotencyKey,'wa_correction_wamid-1');return {invoice:{...invoice,total:6969},changes:{total:{old:100,new:6969},currency:{old:'USD',new:'USD'}},duplicate:calls>1}}};
  const handler=handlerWith(store,{current:{action:{stage:'saved',invoice}}});
  assert.equal(await handler({...scope,message:'change its amount to 6969USD',messageId:'wamid-1'}),'Amount: 100 -> 6969\nCurrency: USD -> USD');
  assert.equal(await handler({...scope,message:'change its amount to 6969USD',messageId:'wamid-1'}),'Amount: 100 -> 6969\nCurrency: USD -> USD');
  assert.equal(calls,2);
});

test('settled and overpaid invoice corrections are refused with the store reason',async()=>{
  for(const [reason,pattern] of [['settled',/already paid or settled/],['payments_exceed_total',/below payments/]]){
    const handler=handlerWith({findInvoices:async()=>[invoice],applyCorrection:async()=>({reason})},{current:{action:{stage:'saved',invoice}}});
    assert.match(await handler({...scope,message:'change its amount to 50USD',messageId:`m-${reason}`}),pattern);
  }
});

test('ambiguous correction asks one short targeting question',async()=>{
  const handler=handlerWith({findInvoices:async()=>[invoice,{...invoice,id:'invoice-2'}]});
  assert.equal(await handler({...scope,message:'currency should be INR',messageId:'m-ambiguous'}),'Which invoice number should I use?');
});

test('send invoice file returns the stored media descriptor',async()=>{
  const media={bytes:Buffer.from('pdf'),mime_type:'application/pdf',file_name:'INV-2026-0720.pdf'};
  const handler=handlerWith({findInvoices:async()=>[invoice],latestInvoiceFile:async id=>{assert.equal(id,invoice.id);return media}},{current:{action:{stage:'saved',invoice}}});
  assert.deepEqual(await handler({...scope,message:'send me the invoice file',messageId:'m-file'}),{answer:'Here is invoice INV-2026-0720.',media});
});
