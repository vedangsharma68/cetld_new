import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';
import {createAccountingActionToken, verifyAccountingActionToken} from '../ai/accounting-actions.mjs';
import {createAIHandler} from '../ai/routes.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-secret-with-at-least-thirty-two-characters';
const EMPTY_STORE = {query:async()=>[]};

test('Assistant create request returns a validated proposal without writing', async () => {
  let created = 0;
  const provider = {generate:async()=>({toolCalls:[{function:{name:'proposeCreateInvoice',arguments:JSON.stringify({invoiceNumber:'INV-1048',clientName:'Shiv Engineering',invoiceDate:'2026-10-01',dueDate:'2026-10-15',total:84600,currency:'INR'})}}],model:'test',usedFallback:false})};
  const accounting = {readZohoData:async()=>({provider:'zoho_books',records:[]}),async syncInvoice(){created++;}};
  const result = await answerWorkspaceQuestion({provider,store:EMPTY_STORE,message:'Create an invoice for Shiv Engineering for INR 84,600 due 15 October 2026, invoice number INV-1048.',accounting,clock:()=>new Date('2026-09-24T00:00:00.000Z')});
  assert.match(result.answer,/Create INV-1048/);
  assert.equal(result.pendingAction.type,'create_invoice');
  assert.equal(result.pendingAction.payload.invoice.total,84600);
  assert.equal(created,0);
});

test('Assistant refuses a Zoho invoice proposal using an unsupported precision currency',async()=>{
  const provider={generate:async()=>({toolCalls:[{function:{name:'proposeCreateInvoice',arguments:JSON.stringify({invoiceNumber:'INV-JPY',clientName:'Shiv Engineering',invoiceDate:'2026-10-01',dueDate:'2026-10-15',total:84600,currency:'JPY'})}}],model:'test',usedFallback:false})};
  const accounting={readZohoData:async()=>({provider:'zoho_books',records:[]}),async syncInvoice(){throw new Error('must not write') }};
  const result=await answerWorkspaceQuestion({provider,store:EMPTY_STORE,message:'Create a JPY invoice.',accounting,clock:()=>new Date('2026-09-24T00:00:00.000Z')});
  assert.equal(result.pendingAction,null);
  assert.match(result.answer,/CETLD supports only two-decimal currencies/i);
});

test('Assistant invoice edit resolves one Zoho invoice and returns a proposal without writing', async () => {
  let updated = 0;
  const provider = {generate:async()=>({toolCalls:[{function:{name:'proposeUpdateInvoice',arguments:JSON.stringify({target:'INV-005',changes:{dueDate:'2026-10-30'}})}}],model:'test',usedFallback:false})};
  const accounting = {async getInvoice(target){assert.equal(target,'INV-005');return{externalId:'zoho-inv-5',number:'INV-005',customerName:'Shiv Engineering',amountMinor:8460000,currency:'INR'};},async updateInvoice(){updated++;}};
  const result = await answerWorkspaceQuestion({provider,store:EMPTY_STORE,message:"Change INV-005's due date to 30 October 2026.",accounting,clock:()=>new Date('2026-09-24T00:00:00.000Z')});
  assert.match(result.answer,/due date to 30 October 2026/);
  assert.equal(result.pendingAction.type,'update_invoice');
  assert.equal(result.pendingAction.payload.invoiceId,'zoho-inv-5');
  assert.deepEqual(result.pendingAction.payload.changes,{dueDate:'2026-10-30'});
  assert.equal(updated,0);
});

test('confirmation tokens bind the action to user/workspace and expire', () => {
  const payload = {invoiceId:'zoho-5',changes:{dueDate:'2026-10-30'}};
  const token = createAccountingActionToken({action:'update_invoice',payload,userId:USER,workspaceId:WORKSPACE,secret:SECRET,now:100000});
  assert.deepEqual(verifyAccountingActionToken(token,{userId:USER,workspaceId:WORKSPACE,secret:SECRET,now:100001}),{action:'update_invoice',payload});
  assert.throws(()=>verifyAccountingActionToken(token,{userId:USER,workspaceId:'33333333-3333-4333-8333-333333333333',secret:SECRET,now:100001}),error=>error.code==='ACCOUNTING_ACTION_SCOPE_MISMATCH');
  assert.throws(()=>verifyAccountingActionToken(token,{userId:USER,workspaceId:WORKSPACE,secret:SECRET,now:100000+11*60*1000}),error=>error.code==='ACCOUNTING_ACTION_EXPIRED');
});

test('confirmation endpoint executes only the signed, explicitly confirmed update', async () => {
  const calls = [];
  const integration = {
    async connectionStatus(input) { assert.equal(input.workspaceId,WORKSPACE);return {status:'connected'}; },
    async readZohoData() { return {provider:'zoho_books',records:[]}; },
    async updateInvoice(input) { calls.push(['update',input]);return {provider:'zoho_books',externalId:input.invoiceId}; },
  };
  const store = {userId:USER,workspaceId:WORKSPACE};
  const handler = createAIHandler({env:{ACCOUNTING_TOKEN_ENCRYPTION_KEY:SECRET},authorize:async()=>store,accountingFactory:async()=>integration});
  const payload = {invoiceId:'zoho-invoice-005',changes:{dueDate:'2026-10-30'}};
  const confirmationToken = createAccountingActionToken({action:'update_invoice',payload,userId:USER,workspaceId:WORKSPACE,secret:SECRET});
  const req = {method:'POST',query:{action:'confirm-accounting-action'},body:{workspaceId:WORKSPACE,confirmed:true,confirmationToken},headers:{}};
  const res = {code:0,data:null,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await handler(req,res);
  assert.equal(res.code,200);
  assert.equal(res.data.updated,true);
  assert.equal(calls[0][0],'update');
  assert.equal(calls[0][1].invoiceId,'zoho-invoice-005');
  assert.deepEqual(calls[0][1].invoice,{dueDate:'2026-10-30'});
  assert.equal(res.data.sync,'pending');

  const rejected = {...res,code:0,data:null};
  await handler({...req,body:{...req.body,confirmed:false}},rejected);
  assert.equal(rejected.code,409);
  assert.equal(calls.length,1);
});

test('confirmed create reports the real Zoho sync result', async () => {
  const invoice={invoiceNumber:'INV-1048',clientName:'Shiv Engineering',invoiceDate:'2026-10-01',dueDate:'2026-10-15',total:84600,currency:'INR'};
  const store={userId:USER,workspaceId:WORKSPACE,findAssistantInvoice:async()=>null,findCustomer:async()=>({id:'customer-1'}),createAssistantInvoice:async()=>({id:'invoice-1',invoice_number:'INV-1048',customer_name:'Shiv Engineering',issue_date:'2026-10-01',due_date:'2026-10-15',currency:'INR',total_amount:84600,amount_paid:0,status:'draft',metadata:{}}),updateAssistantInvoiceMetadata:async(_id,metadata)=>({id:'invoice-1',invoice_number:'INV-1048',customer_name:'Shiv Engineering',issue_date:'2026-10-01',due_date:'2026-10-15',currency:'INR',total_amount:84600,amount_paid:0,status:'draft',metadata})};
  const integration={async connectionStatus(){return{status:'connected'};},async syncInvoice(){throw Object.assign(new Error('temporary'),{code:'ACCOUNTING_SYNC_FAILED'});}};
  const handler=createAIHandler({env:{ACCOUNTING_TOKEN_ENCRYPTION_KEY:SECRET},authorize:async()=>store,accountingFactory:async()=>integration});
  const confirmationToken=createAccountingActionToken({action:'create_invoice',payload:{invoice,idempotencyKey:'assistant_create_1048'},userId:USER,workspaceId:WORKSPACE,secret:SECRET});
  const req={method:'POST',query:{action:'confirm-accounting-action'},body:{workspaceId:WORKSPACE,confirmed:true,confirmationToken},headers:{}};
  const res={code:0,data:null,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await handler(req,res);
  assert.equal(res.code,200);assert.equal(res.data.saved,true);assert.equal(res.data.sync.status,'failed');assert.equal(res.data.sync.externalId,undefined);
});
