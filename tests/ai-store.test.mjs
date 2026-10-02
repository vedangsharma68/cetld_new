import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAIWorkspace} from '../ai/store.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const userId='33333333-3333-4333-8333-333333333333';
const customerId='44444444-4444-4444-8444-444444444444';
const lineItems=[{description:'Labour',quantity:1,unitPrice:25,amount:25,confidence:0.99}];
const invoice={invoiceNumber:'INV-1048',invoiceDate:'2026-09-01',dueDate:'2026-10-01',currency:'INR',total:118,subtotal:100,tax:18,outstanding:0,notes:'Paid',clientEmail:null,clientPhone:null,lineItems,alreadyPaid:true,idempotencyKey:'assistant_paid_invoice_1048'};

test('paid Assistant invoices use the atomic workspace RPC and never direct payment-table writes',async()=>{
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const parsed=new URL(url);calls.push({url:parsed,options});
    if(parsed.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:userId}),{status:200});
    if(parsed.pathname==='/rest/v1/workspace_members')return new Response(JSON.stringify([{workspace_id:workspaceId,user_id:userId,role:'owner'}]),{status:200});
    if(parsed.pathname==='/rest/v1/rpc/create_paid_assistant_invoice')return new Response(JSON.stringify({id:'22222222-2222-4222-8222-222222222222',workspace_id:workspaceId,invoice_number:invoice.invoiceNumber,status:'paid'}),{status:200});
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };
  const store=await authorizeAIWorkspace({headers:{authorization:'Bearer token-value-long-enough'}},workspaceId,{env:{SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'publishable',NODE_ENV:'test'},fetchImpl});
  const saved=await store.createPaidAssistantInvoice({customerId,invoice});
  assert.equal(saved.status,'paid');
  const rpc=calls.find(call=>call.url.pathname==='/rest/v1/rpc/create_paid_assistant_invoice');
  assert.ok(rpc);
  const payload=JSON.parse(rpc.options.body);
  assert.equal(payload.p_workspace_id,workspaceId);
  assert.equal(payload.p_customer_id,customerId);
  assert.equal(payload.p_idempotency_key,invoice.idempotencyKey);
  assert.equal(payload.p_total_amount,invoice.total);
  assert.deepEqual(payload.p_metadata.line_items,lineItems);
  assert.equal(calls.some(call=>call.url.pathname==='/rest/v1/payments'),false);
  await assert.rejects(store.createAssistantInvoice({customerId,invoice}),/PAID_INVOICES_REQUIRE_ATOMIC_SETTLEMENT/);
});

test('ordinary Assistant invoice creation relies on database settlement defaults',async()=>{
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const parsed=new URL(url);calls.push({url:parsed,options});
    if(parsed.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:userId}),{status:200});
    if(parsed.pathname==='/rest/v1/workspace_members')return new Response(JSON.stringify([{workspace_id:workspaceId,user_id:userId,role:'owner'}]),{status:200});
    if(parsed.pathname==='/rest/v1/invoices')return new Response(JSON.stringify([{id:'22222222-2222-4222-8222-222222222222',workspace_id:workspaceId,invoice_number:invoice.invoiceNumber,status:'draft',amount_paid:'0.00'}]),{status:201});
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };
  const store=await authorizeAIWorkspace({headers:{authorization:'Bearer token-value-long-enough'}},workspaceId,{env:{SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'publishable',NODE_ENV:'test'},fetchImpl});
  await store.createAssistantInvoice({customerId,invoice:{...invoice,alreadyPaid:false}});
  const request=calls.find(call=>call.url.pathname==='/rest/v1/invoices');
  const payload=JSON.parse(request.options.body);
  assert.equal(Object.hasOwn(payload,'amount_paid'),false);
  assert.equal(Object.hasOwn(payload,'status'),false);
  assert.deepEqual(payload.metadata.line_items,lineItems);
});

test('Assistant paid update settles a draft with the workspace-scoped payment RPC',async()=>{
  const invoiceId='22222222-2222-4222-8222-222222222222';
  const key='assistant_payment_0123456789abcdef0123456789abcdef';
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const parsed=new URL(url);calls.push({url:parsed,options});
    if(parsed.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:userId}),{status:200});
    if(parsed.pathname==='/rest/v1/workspace_members')return new Response(JSON.stringify([{workspace_id:workspaceId,user_id:userId,role:'owner'}]),{status:200});
    if(parsed.pathname==='/rest/v1/rpc/record_invoice_payment')return new Response(JSON.stringify({id:'55555555-5555-4555-8555-555555555555',workspace_id:workspaceId,invoice_id:invoiceId,amount:'118.00'}),{status:200});
    if(parsed.pathname==='/rest/v1/invoices')return new Response(JSON.stringify([{id:invoiceId,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-1048',total_amount:'118.00',amount_paid:'118.00',status:'paid',metadata:{followup_state:'cancelled'}}]),{status:200});
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };
  const store=await authorizeAIWorkspace({headers:{authorization:'Bearer token-value-long-enough'}},workspaceId,{env:{SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'publishable',NODE_ENV:'test'},fetchImpl});
  const saved=await store.settleAssistantInvoice(invoiceId,key);
  assert.equal(saved.status,'paid');assert.equal(saved.amount_paid,'118.00');
  const rpc=calls.find(call=>call.url.pathname==='/rest/v1/rpc/record_invoice_payment');
  assert.deepEqual(JSON.parse(rpc.options.body),{p_workspace_id:workspaceId,p_invoice_id:invoiceId,p_amount:null,p_idempotency_key:key,p_reference:'Marked paid by Cetld Assistant',p_settle_remaining:true});
  assert.equal(calls.some(call=>call.options.method==='PATCH'),false);
});

test('deleted invoices are excluded from Assistant reads and their files never reach storage',async()=>{
  const invoiceId='22222222-2222-4222-8222-222222222222';
  const fileId='66666666-6666-4666-8666-666666666666';
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const parsed=new URL(url);calls.push({url:parsed,options});
    if(parsed.pathname==='/auth/v1/user')return new Response(JSON.stringify({id:userId}),{status:200});
    if(parsed.pathname==='/rest/v1/workspace_members')return new Response(JSON.stringify([{workspace_id:workspaceId,user_id:userId,role:'owner'}]),{status:200});
    if(parsed.pathname==='/rest/v1/invoices') {
      assert.equal(parsed.searchParams.get('deleted_at'),'is.null');
      return new Response(JSON.stringify([]),{status:200});
    }
    if(parsed.pathname==='/rest/v1/invoice_files')return new Response(JSON.stringify([{id:fileId,workspace_id:workspaceId,invoice_id:invoiceId,storage_path:`${workspaceId}/${invoiceId}/proof.pdf`,file_name:'proof.pdf',mime_type:'application/pdf',size_bytes:120}]),{status:200});
    if(parsed.pathname.startsWith('/storage/'))throw new Error('Deleted invoice files must not be downloaded');
    throw new Error(`Unexpected request ${parsed.pathname}`);
  };
  const store=await authorizeAIWorkspace({headers:{authorization:'Bearer token-value-long-enough'}},workspaceId,{env:{SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'publishable',NODE_ENV:'test'},fetchImpl});
  assert.deepEqual(await store.query('invoices',{select:'id,invoice_number'}),[]);
  await assert.rejects(store.downloadInvoiceFile(fileId),error=>error.code==='FILE_NOT_FOUND');
  assert.equal(calls.filter(call=>call.url.pathname==='/rest/v1/invoices').length,2);
  assert.equal(calls.some(call=>call.url.pathname.startsWith('/storage/')),false);
});
