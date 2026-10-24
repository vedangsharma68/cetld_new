import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/invoice-lifecycle.js';
import {authorizeAIWorkspace} from '../ai/store.mjs';
import {updateAssistantInvoice, validateAssistantInvoice} from '../ai/invoice-ops.mjs';

const workspaceId='10000000-0000-4000-8000-000000000001';
const ownerId='20000000-0000-4000-8000-000000000001';
const invoiceId='30000000-0000-4000-8000-000000000001';
const requestId='40000000-0000-4000-8000-000000000001';
const authorization='Bearer fixture-owner-access-token';
const invoiceNumber=`CETLD-TEST-${requestId}-NO-PAYMENT-REQUIRED`;
const row={id:invoiceId,workspace_id:workspaceId,invoice_number:invoiceNumber,status:'sent',currency:'INR',total_amount:'1.00',metadata:{test_invoice:true,source_invoice_number:invoiceNumber,followup_state:'draft'}};
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});

function transport({role='owner',member=true,saved=row,rpcError,patchError}={}) {
  const calls=[];
  globalThis.fetch=async (input,init={})=>{
    const url=new URL(input);calls.push({url,init});
    if(url.pathname==='/auth/v1/user')return Response.json({id:ownerId});
    if(url.pathname==='/rest/v1/workspace_members')return Response.json(member?[{workspace_id:workspaceId,user_id:ownerId,role}]:[]);
    if(url.pathname==='/rest/v1/rpc/create_test_invoice')return rpcError?Response.json(rpcError,{status:400}):Response.json(saved);
    if(url.pathname==='/rest/v1/invoices'&&init.method==='PATCH')return Response.json(patchError||{code:'42501',message:'TEST_INVOICE_IMMUTABLE'},{status:403});
    throw Error(`Offline test refused ${url.pathname}`);
  };
  return calls;
}
async function invoke(extra={},headers={authorization}) {
  const res={status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',headers,body:{action:'createTestInvoice',workspaceId,idempotencyKey:requestId,...extra}},res);
  return res;
}

test('supported test creation preserves caller JWT and sends only workspace and fresh request UUID to server RPC',async()=>{
  const calls=transport();
  for(let retry=0;retry<2;retry++){
    const res=await invoke();assert.equal(res.statusCode,200);
    assert.deepEqual(res.body,{ok:true,invoiceId,invoiceNumber,status:'sent'});
  }
  const rpc=calls.filter(call=>call.url.pathname.endsWith('/create_test_invoice'));
  assert.equal(rpc.length,2);
  for(const {init} of rpc){
    assert.equal(init.headers.Authorization,authorization);
    assert.deepEqual(JSON.parse(init.body),{p_workspace_id:workspaceId,p_request_id:requestId});
  }
  assert.equal(calls.some(({init})=>init.method==='PATCH'),false);
});

test('creation rejects arbitrary recipients, invoice facts, old consumed scheduled key and untrusted marker before database work',async()=>{
  for(const extra of [{clientPhone:'+919999999999'},{invoiceId},{invoiceNumber:'REAL-1'},{metadata:{test_invoice:true}},{total:1},{idempotencyKey:'scheduled-owner-test:20261017:v1'}]){
    const calls=transport();assert.equal((await invoke(extra)).statusCode,400);assert.equal(calls.length,0);
  }
});

test('owner authentication and membership are required for creation including admin and member accounts',async()=>{
  for(const options of [{role:'admin'},{role:'member'},{member:false}]){
    const calls=transport(options);assert.equal((await invoke()).statusCode,403);
    assert.equal(calls.some(call=>call.url.pathname.endsWith('/create_test_invoice')),false);
  }
  const calls=transport();assert.equal((await invoke({},{})).statusCode,403);assert.equal(calls.length,0);
});

test('fixed recipient lookup errors are actionable and malformed server result fails closed',async()=>{
  for(const code of ['TEST_RECIPIENT_REQUIRED','TEST_RECIPIENT_AMBIGUOUS']){
    transport({rpcError:{code:'23514',message:code}});
    const res=await invoke();assert.equal(res.statusCode,409);assert.deepEqual(res.body,{ok:false,code});
  }
  for(const changes of [{metadata:{}},{invoice_number:'REAL-1'},{currency:'USD'},{total_amount:99},{external_invoice_id:'provider-id'}]){
    transport({saved:{...row,...changes}});assert.equal((await invoke()).statusCode,503);
  }
});

test('ordinary assistant edit schema never accepts retrofit or removal markers, while metadata persistence surfaces database refusal',async()=>{
  for(const changes of [{metadata:{test_invoice:false}},{test_invoice:true},{source_invoice_number:'CETLD-TEST-hidden'}]){
    await assert.rejects(updateAssistantInvoice({store:{},invoiceId,confirmed:true,changes}),error=>error.code==='INVALID_INVOICE_CHANGES');
  }
  const calls=transport();
  const store=await authorizeAIWorkspace({headers:{authorization}},workspaceId,{env:{SUPABASE_URL:'https://offline.test',SUPABASE_PUBLISHABLE_KEY:'fixture-public-key'}});
  await assert.rejects(store.updateAssistantInvoiceMetadata(invoiceId,{}),error=>error.code==='TEST_INVOICE_IMMUTABLE');
  assert.equal(calls.at(-1).init.method,'PATCH');
  assert.throws(()=>validateAssistantInvoice({direction:'receivable',invoiceNumber,clientName:'Pappa',invoiceDate:'2026-10-24',dueDate:'2026-10-24',currency:'INR',total:1}),error=>error.code==='TEST_INVOICE_CREATION_REQUIRED');
});
