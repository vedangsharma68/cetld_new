import test from 'node:test';
import assert from 'node:assert/strict';
import {saveAssistantInvoice, retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';
import {createAIHandler} from '../ai/routes.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const invoiceId='22222222-2222-4222-8222-222222222222';
const base={invoiceNumber:'INV-1048',clientName:'Arbor & Finch',invoiceDate:'2026-09-01',dueDate:'2026-10-01',subtotal:100,tax:18,total:118,outstanding:118,currency:'INR',clientEmail:null,clientPhone:null,notes:null};

function memoryStore(){
  let row=null,createdInput=null;
  const store={workspaceId,userId:'33333333-3333-4333-8333-333333333333',
    async findAssistantInvoice(){return row},
    async findCustomer(){return null},
    async createCustomer(){return{id:'44444444-4444-4444-8444-444444444444'}},
    async createAssistantInvoice(input){createdInput=input;const invoice=input.invoice;row={id:invoiceId,workspace_id:workspaceId,customer_id:input.customerId,invoice_number:invoice.invoiceNumber,issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:invoice.currency,total_amount:String(invoice.total),amount_paid:String(invoice.alreadyPaid?invoice.total:0),status:invoice.alreadyPaid?'paid':'draft',notes:invoice.notes,metadata:{assistant_idempotency_key:invoice.idempotencyKey,followup_state:invoice.alreadyPaid?'cancelled':'draft',next_follow_up_at:null,bookkeeping_sync_status:'pending'}};return row},
    async updateAssistantInvoiceMetadata(id,metadata){assert.equal(id,invoiceId);row={...row,metadata};return row},
    async getAssistantInvoice(){return row},
    async query(){return[{id:'44444444-4444-4444-8444-444444444444',workspace_id:workspaceId,name:'Arbor & Finch'}]},
    get createdInput(){return createdInput},get row(){return row}
  };
  return store;
}

test('missing due date asks the required question and performs no write',async()=>{
  let writes=0;
  const result=await saveAssistantInvoice({store:{findAssistantInvoice(){writes++}},invoice:{...base,dueDate:null},confirmed:true,idempotencyKey:'invoice_missing_due_1'});
  assert.deepEqual(result,{needsInput:true,question:'What is the due date for this invoice?'});
  assert.equal(writes,0);
});

test('confirmed paid invoice is settled before sync and cannot start reminders',async()=>{
  const store=memoryStore();let synced;
  const result=await saveAssistantInvoice({store,invoice:{...base,alreadyPaid:true},confirmed:true,idempotencyKey:'invoice_paid_1048',accounting:{async syncInvoice(input){synced=input;return{provider:'quickbooks',externalId:'qb-1048'}}}});
  assert.equal(result.saved,true);assert.equal(result.invoice.status,'paid');assert.equal(result.invoice.amountPaid,118);
  assert.equal(store.createdInput.invoice.outstanding,0);
  assert.equal(store.row.metadata.followup_state,'cancelled');assert.equal(store.row.metadata.next_follow_up_at,null);
  assert.equal(synced.invoice.alreadyPaid,true);assert.equal(result.sync.status,'synced');
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

