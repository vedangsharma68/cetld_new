import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAIWorkspace} from '../ai/store.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const userId='33333333-3333-4333-8333-333333333333';
const customerId='44444444-4444-4444-8444-444444444444';
const invoice={invoiceNumber:'INV-1048',invoiceDate:'2026-09-01',dueDate:'2026-10-01',currency:'INR',total:118,subtotal:100,tax:18,outstanding:0,notes:'Paid',clientEmail:null,clientPhone:null,alreadyPaid:true,idempotencyKey:'assistant_paid_invoice_1048'};

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
});
