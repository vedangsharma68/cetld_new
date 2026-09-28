import test from 'node:test';
import assert from 'node:assert/strict';
import {saveAssistantInvoice, updateAssistantInvoice, retryAssistantInvoiceSync, validateAssistantInvoice} from '../ai/invoice-ops.mjs';
import {createAIHandler} from '../ai/routes.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const invoiceId='22222222-2222-4222-8222-222222222222';
const base={direction:'receivable',invoiceNumber:'INV-1048',clientName:'Arbor & Finch',invoiceDate:'2026-09-01',dueDate:'2026-10-01',subtotal:100,tax:18,total:118,outstanding:118,currency:'INR',clientEmail:null,clientPhone:null,notes:null};

function memoryStore(){
  let row=null,createdInput=null,paidInput=null;
  const store={workspaceId,userId:'33333333-3333-4333-8333-333333333333',
    async findAssistantInvoice(){return row},
    async findCustomer(){return null},
    async createCustomer(){return{id:'44444444-4444-4444-8444-444444444444'}},
    async createAssistantInvoice(input){createdInput=input;const invoice=input.invoice;row={id:invoiceId,workspace_id:workspaceId,customer_id:input.customerId,invoice_number:invoice.invoiceNumber,issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:invoice.currency,total_amount:String(invoice.total),amount_paid:String(invoice.alreadyPaid?invoice.total:0),status:invoice.alreadyPaid?'paid':'draft',notes:invoice.notes,metadata:{assistant_idempotency_key:invoice.idempotencyKey,followup_state:invoice.alreadyPaid?'cancelled':'draft',next_follow_up_at:null,bookkeeping_sync_status:'pending'}};return row},
    async createPaidAssistantInvoice(input){paidInput=input;const invoice=input.invoice;row={id:invoiceId,workspace_id:workspaceId,customer_id:input.customerId,invoice_number:invoice.invoiceNumber,issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:invoice.currency,total_amount:String(invoice.total),amount_paid:String(invoice.total),status:'paid',notes:invoice.notes,metadata:{assistant_idempotency_key:invoice.idempotencyKey,followup_state:'cancelled',next_follow_up_at:null,bookkeeping_sync_status:'pending'}};return row},
    async updateAssistantInvoiceMetadata(id,metadata,synchronization={}){assert.equal(id,invoiceId);row={...row,metadata,...synchronization};return row},
    async getAssistantInvoice(){return row},
    async query(){return[{id:'44444444-4444-4444-8444-444444444444',workspace_id:workspaceId,name:'Arbor & Finch'}]},
    get createdInput(){return createdInput},get paidInput(){return paidInput},get row(){return row}
  };
  return store;
}

test('missing due date asks the required question and performs no write',async()=>{
  let writes=0;
  const result=await saveAssistantInvoice({store:{findAssistantInvoice(){writes++}},invoice:{...base,dueDate:null},confirmed:true,idempotencyKey:'invoice_missing_due_1'});
  assert.deepEqual(result,{needsInput:true,question:'What is the due date for this invoice?'});
  assert.equal(writes,0);
});

test('payable and uncertain invoices are rejected before any persistence',async()=>{
  for(const direction of ['payable','uncertain',null]){
    let calls=0;
    const store=new Proxy({}, {get(){calls++;return async()=>null}});
    await assert.rejects(saveAssistantInvoice({store,invoice:{...base,direction},confirmed:true,idempotencyKey:'invoice_direction_1048'}));
    assert.equal(calls,0,`store was touched for ${direction}`);
  }
});

test('zero total and inconsistent subtotal, tax, or outstanding cannot be saved',async()=>{
  for(const patch of [
    {subtotal:0,tax:0,total:0,outstanding:0},
    {subtotal:100,tax:17.98,total:118,outstanding:118},
    {subtotal:100,tax:18,total:118,outstanding:119},
  ]){
    let calls=0;
    const store=new Proxy({}, {get(){calls++;return async()=>null}});
    await assert.rejects(saveAssistantInvoice({store,invoice:{...base,...patch},confirmed:true,idempotencyKey:'invoice_amount_guard_1048'}));
    assert.equal(calls,0,`store was touched for ${JSON.stringify(patch)}`);
  }
});

test('one-cent printed rounding adjustment may be saved after review',async()=>{
  const store=memoryStore();
  const saved=await saveAssistantInvoice({store,invoice:{...base,tax:17.99},confirmed:true,idempotencyKey:'invoice_rounding_1048'});
  assert.equal(saved.saved,true);
  assert.equal(store.createdInput.invoice.tax,17.99);
  assert.equal(store.createdInput.invoice.total,118);
});

test('validated Assistant invoices keep bounded itemization and reject malformed item values',()=>{
  const lineItems=[{description:' Labour ',quantity:3,unitPrice:130,amount:390,confidence:0.99}];
  assert.deepEqual(validateAssistantInvoice({...base,lineItems}).lineItems,[{description:'Labour',quantity:3,unitPrice:130,amount:390,confidence:0.99}]);
  for(const invalid of [
    [{description:'Oil',quantity:-1,unitPrice:10,amount:10}],
    [{description:'Oil',quantity:1,unitPrice:10.001,amount:10}],
    [{description:'Oil',quantity:1,unitPrice:10,amount:10,extra:'ignored'}],
    Array.from({length:101},()=>({description:'Item',quantity:1,unitPrice:1,amount:1})),
  ]) assert.throws(()=>validateAssistantInvoice({...base,lineItems:invalid}),error=>error.code==='INVALID_INVOICE_LINE_ITEMS');
});

test('partial outstanding requires a payment record before an invoice can be saved',async()=>{
  let calls=0;
  const store=new Proxy({}, {get(){calls++;return async()=>null}});
  await assert.rejects(saveAssistantInvoice({store,invoice:{...base,outstanding:68},confirmed:true,idempotencyKey:'invoice_partial_1048'}),error=>error.code==='PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD');
  assert.equal(calls,0);
});

test('confirmed paid invoice is settled before sync and cannot start reminders',async()=>{
  const store=memoryStore();let synced;
  const result=await saveAssistantInvoice({store,invoice:{...base,outstanding:0,alreadyPaid:true},confirmed:true,idempotencyKey:'invoice_paid_1048',accounting:{async syncInvoice(input){synced=input;return{provider:'quickbooks',externalId:'qb-1048'}}}});
  assert.equal(result.saved,true);assert.equal(result.invoice.status,'paid');assert.equal(result.invoice.amountPaid,118);
  assert.equal(store.paidInput.invoice.outstanding,0);assert.equal(store.createdInput,null);
  assert.equal(store.row.metadata.followup_state,'cancelled');assert.equal(store.row.metadata.next_follow_up_at,null);
  assert.equal(synced.invoice.alreadyPaid,true);assert.equal(result.sync.status,'synced');assert.equal(store.row.external_provider,'quickbooks');assert.equal(store.row.external_invoice_id,'qb-1048');assert.equal(store.row.sync_status,'synced');
});

test('bookkeeping failure keeps the cetld invoice and exposes a retryable state',async()=>{
  const store=memoryStore();
  const saved=await saveAssistantInvoice({store,invoice:base,confirmed:true,idempotencyKey:'invoice_sync_fail',accounting:{async syncInvoice(){throw Object.assign(new Error('provider down'),{code:'ACCOUNTING_SYNC_FAILED'})}}});
  assert.equal(saved.saved,true);assert.equal(saved.invoice.id,invoiceId);assert.deepEqual(saved.sync,{status:'failed',provider:null,retryable:true});
  const retried=await retryAssistantInvoiceSync({store,invoiceId,accounting:{async syncInvoice(){return{provider:'zoho_books',externalId:'zoho-1048'}}}});
  assert.equal(retried.sync.status,'synced');assert.equal(retried.sync.externalId,'zoho-1048');
});

test('AI save route returns 422 for a missing due date',async()=>{
  const handler=createAIHandler({authorize:async()=>({}),accountingFactory:async()=>null});
  const req={method:'POST',query:{action:'save-invoice'},body:{workspaceId,confirmed:true,idempotencyKey:'invoice_route_due_1',invoice:{...base,dueDate:null}},headers:{}};
  const res={code:0,data:null,setHeader(){},status(code){this.code=code;return this},json(data){this.data=data;return this}};
  await handler(req,res);
  assert.equal(res.code,422);assert.equal(res.data.error,'MISSING_DUE_DATE');assert.equal(res.data.question,'What is the due date for this invoice?');
});

test('Assistant invoice API rejects currencies and amounts the two-decimal ledger cannot store',()=>{
  for(const currency of ['JPY','KWD','BHD','ZZZ'])assert.throws(()=>validateAssistantInvoice({...base,currency}),error=>error.code==='UNSUPPORTED_CURRENCY');
  for(const total of ['118.257',118.257])assert.throws(()=>validateAssistantInvoice({...base,total}),error=>error.code==='AMOUNT_PRECISION_UNSUPPORTED');
  assert.equal(validateAssistantInvoice({...base,currency:'INR',subtotal:'100.25',total:'118.25',outstanding:'118.25'}).total,118.25);
});

test('chat invoice updates validate arguments and require confirmation before writing',async()=>{
  let writes=0;
  const store={async updateAssistantInvoice(id,patch){writes++;return{id,invoice_number:'INV-1048',due_date:patch.due_date||base.dueDate,currency:patch.currency||base.currency,total_amount:String(patch.total_amount||base.total),amount_paid:'0',status:patch.status||'draft',metadata:{}}}};
  await assert.rejects(updateAssistantInvoice({store,invoiceId,changes:{dueDate:'2026-10-20'},confirmed:false}),error=>error.code==='CONFIRMATION_REQUIRED');
  assert.equal(writes,0);
  await assert.rejects(updateAssistantInvoice({store,invoiceId,changes:{total:-1},confirmed:true}),error=>error.code==='INVALID_INVOICE_AMOUNT');
  assert.equal(writes,0);
  const result=await updateAssistantInvoice({store,invoiceId,changes:{dueDate:'2026-10-20',currency:'USD'},confirmed:true});
  assert.equal(result.updated,true);assert.equal(writes,1);assert.equal(result.invoice.dueDate,'2026-10-20');
});

test('chat invoice update settles a draft through the atomic payment store',async()=>{
  let directWrites=0;
  const key='assistant_payment_0123456789abcdef0123456789abcdef';
  const store={
    async updateAssistantInvoice(){directWrites++;},
    async settleAssistantInvoice(id,idempotencyKey){
      assert.equal(id,invoiceId);assert.equal(idempotencyKey,key);
      return{id,invoice_number:'INV-1048',due_date:base.dueDate,currency:'INR',total_amount:'118.00',amount_paid:'118.00',status:'paid',metadata:{followup_state:'cancelled'}};
    }
  };
  const result=await updateAssistantInvoice({store,invoiceId,changes:{status:'paid'},confirmed:true,idempotencyKey:key});
  assert.equal(result.updated,true);assert.equal(result.invoice.status,'paid');assert.equal(result.invoice.amountPaid,118);assert.equal(directWrites,0);
});
