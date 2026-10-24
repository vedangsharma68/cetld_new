import test from 'node:test';
import assert from 'node:assert/strict';
import {createAIHandler} from '../ai/routes.mjs';
import {createAccountingActionToken} from '../ai/accounting-actions.mjs';
import {TokenCipher,connectionAad} from '../automation/accounting/index.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const invoiceId='22222222-2222-4222-8222-222222222222';
const ownerId='33333333-3333-4333-8333-333333333333';
const memberId='44444444-4444-4444-8444-444444444444';
const customerId='55555555-5555-4555-8555-555555555555';
const idempotencyKey='manual_retry_key_1';
const invoice={direction:'receivable',invoiceNumber:'INV-1',clientName:'Client',total:118,currency:'INR',invoiceDate:'2026-10-01',dueDate:'2026-10-20'};
const response=()=>({setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}});

// Exercise the real workspace authorization, caller invoice store, server
// accounting runtime, encrypted connection, provider adapter and lease writes.
function fixture({attempts=0}={}) {
  const key=Buffer.alloc(32,7);
  const env={SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'test-publishable',SUPABASE_SERVICE_ROLE_KEY:'test-service-role',ACCOUNTING_TOKEN_ENCRYPTION_KEY:key.toString('base64')};
  const authorization='Bearer test-caller-member';
  const token={accessToken:'test-access',refreshToken:'test-refresh',expiresAt:Date.now()+3600_000,apiDomain:'https://www.zohoapis.com'};
  const encrypted=new TokenCipher(key).encrypt(token,connectionAad('zoho_books',workspaceId));
  const state={connectionFailure:false,connected:true,authorized:true,providerStatus:200,providerCalls:0,callerConnectionReads:0,connectionReads:0,patches:[],
    connection:{owner_id:ownerId,workspace_id:workspaceId,provider:'zoho_books',provider_account_id:'test-org',api_domain:token.apiDomain,status:'connected',token_ciphertext:encrypted.ciphertext,token_iv:encrypted.iv,token_tag:encrypted.tag,token_expires_at:new Date(token.expiresAt).toISOString()},
    row:{id:invoiceId,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-1',issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:'INR',total_amount:'118.00',amount_paid:'0.00',status:'draft',updated_at:'v0',metadata:{invoice_direction:'receivable',assistant_idempotency_key:idempotencyKey,bookkeeping_sync_status:'failed',bookkeeping_sync_attempts:attempts,followup_state:'draft'}}};
  const fetchImpl=async(input,options={})=>{
    const url=new URL(input),headers=new Headers(options.headers);
    if(url.origin!==env.SUPABASE_URL) {
      state.providerCalls++;
      assert.equal(state.row.metadata.bookkeeping_sync_attempts,attempts+1,'attempt must be durable before any invoice provider request');
      assert.equal(headers.get('authorization'),`Zoho-oauthtoken ${token.accessToken}`);
      assert.equal(url.searchParams.get('organization_id'),'test-org');
      if(state.providerStatus!==200)return Response.json({code:1001,message:'Synthetic provider rejection'},{status:state.providerStatus});
      if(options.method==='POST')return Response.json({invoice:{invoice_id:'remote-invoice'}});
      return Response.json(url.pathname.endsWith('/contacts')?{contacts:[{contact_id:'remote-contact',contact_name:'Client'}]}:{invoices:[]});
    }
    if(url.pathname==='/rest/v1/cetld_accounting_connections') {
      state.connectionReads++;
      if(headers.get('authorization')!==`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) {
        state.callerConnectionReads++;
        return Response.json({code:'42501',message:'permission denied for table cetld_accounting_connections'},{status:403});
      }
      assert.equal(headers.get('apikey'),env.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(url.searchParams.get('workspace_id'),`eq.${workspaceId}`);
      assert.equal(url.searchParams.get('provider'),'eq.zoho_books');
      if(state.connectionFailure)return Response.json({code:'42501',message:'Synthetic connection lookup failure'},{status:403});
      if(!state.connected)return Response.json([]);
      if(url.searchParams.has('owner_id'))assert.equal(url.searchParams.get('owner_id'),`eq.${ownerId}`,'use the connection owner, not the calling member');
      return Response.json([state.connection]);
    }
    const service=headers.get('authorization')===`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
    if(service) {
      assert.equal(url.pathname,'/rest/v1/invoices','service data access is limited to saved-row export authorization and sync completion');
      if(url.searchParams.get('select')==='id,workspace_id,invoice_number,metadata,status,deleted_at') assert.equal(options.method,undefined,'export authorization only reads saved facts');
      else assert.equal(state.row.metadata.bookkeeping_sync_attempts,attempts+1);
    } else assert.equal(headers.get('authorization'),authorization,'invoice data must retain caller RLS');
    assert.equal(headers.get('apikey'),service?env.SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_PUBLISHABLE_KEY);
    if(url.pathname==='/auth/v1/user')return Response.json({id:memberId});
    assert.equal(url.searchParams.get('workspace_id'),`eq.${workspaceId}`);
    if(url.pathname==='/rest/v1/workspace_members')return Response.json(state.authorized?[{workspace_id:workspaceId,user_id:memberId,role:'member'}]:[]);
    if(url.pathname==='/rest/v1/customers')return Response.json([{id:customerId,workspace_id:workspaceId,name:'Client'}]);
    assert.equal(url.pathname,'/rest/v1/invoices');
    if(options.method==='PATCH') {
      assert.equal(url.searchParams.get('updated_at'),`eq.${state.row.updated_at}`);
      const patch=JSON.parse(options.body);state.patches.push(patch);
      assert.equal(service,Boolean(patch.external_invoice_id),'external linkage must be saved only by the accounting runtime');
      state.row={...state.row,...patch,updated_at:`v${state.patches.length}`};
    }
    return Response.json([state.row]);
  };
  const handler=createAIHandler({env,fetchImpl});
  return {state,env,async request(action='retry-invoice-sync',body={invoiceId,idempotencyKey}) {
    const res=response(),method=action==='invoice-sync-status'?'GET':'POST';
    await handler({method,query:{action,...(method==='GET'?{workspaceId}:{})},headers:{authorization},body:{workspaceId,...body}},res);
    return res;
  }};
}

test('manual retries and assistant save replays resolve the owner connection using only service-role credentials',async()=>{
  for(const action of ['retry-invoice-sync','save-invoice','confirm-accounting-action']) {
    const f=fixture();
    const body=action==='retry-invoice-sync'?{invoiceId,idempotencyKey}:action==='save-invoice'?{invoice,idempotencyKey,confirmed:true}:{confirmed:true,confirmationToken:createAccountingActionToken({action:'create_invoice',payload:{invoice,idempotencyKey},userId:memberId,workspaceId,secret:f.env.ACCOUNTING_TOKEN_ENCRYPTION_KEY})};
    const res=await f.request(action,body);
    assert.equal(res.code,200,JSON.stringify(res.body));assert.equal(res.body.sync.status,'synced');
    assert.ok(f.state.connectionReads>=2);assert.equal(f.state.callerConnectionReads,0);assert.ok(f.state.providerCalls>0);
    assert.equal(f.state.patches[0].metadata.bookkeeping_sync_attempts,0,'claim alone cannot spend an attempt');
    assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,1);
    assert.equal(f.state.row.metadata.followup_state,'draft');
    assert.doesNotMatch(JSON.stringify(res.body),/test-access|test-refresh|token_ciphertext|token_iv|token_tag|test-service-role/);
  }
});

test('drawer connection lookup uses service role and returns only a boolean after workspace authorization',async()=>{
  const f=fixture();const res=await f.request('invoice-sync-status');
  assert.equal(res.code,200);assert.deepEqual(res.body,{connected:true});
  assert.equal(f.state.connectionReads,1);assert.equal(f.state.callerConnectionReads,0);assert.equal(f.state.providerCalls,0);
  for(const action of ['invoice-sync-status','retry-invoice-sync']) {
    const denied=fixture();denied.state.authorized=false;
    assert.equal((await denied.request(action)).code,403);
    assert.equal(denied.state.connectionReads,0);assert.equal(denied.state.providerCalls,0);assert.equal(denied.state.patches.length,0);
  }
});

test('manual retry refuses test fixtures before connection lookup, provider work or metadata writes',async()=>{
  for(const marker of [{test_invoice:true},{source_invoice_number:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'}]) {
    const f=fixture({attempts:5});
    f.state.row.metadata={...f.state.row.metadata,...marker};
    const res=await f.request();
    assert.equal(res.code,409);assert.equal(res.body.error,'INVOICE_NOT_EXPORTABLE');
    assert.equal(f.state.connectionReads,0);assert.equal(f.state.providerCalls,0);assert.equal(f.state.patches.length,0);
    assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,5);
  }
});

test('repeated connection lookup failures preserve the retry budget and recovery spends exactly one attempt',async()=>{
  const f=fixture({attempts:4});f.state.connectionFailure=true;
  for(let n=0;n<6;n++) {
    const res=await f.request();assert.equal(res.code,200);assert.equal(res.body.sync.status,'failed');
    assert.equal(f.state.row.metadata.bookkeeping_sync_error,'ACCOUNTING_STORE_ERROR');
    assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,4);assert.equal(f.state.row.metadata.bookkeeping_sync_exhausted,false);
    assert.equal(f.state.providerCalls,0);assert.equal(f.state.callerConnectionReads,0);
    f.state.row.metadata.bookkeeping_sync_next_at=null;
  }
  f.state.connectionFailure=false;
  assert.equal((await f.request()).body.sync.status,'synced');assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,5);
});

test('missing connections and invalid encrypted credentials do not spend an invoice attempt',async()=>{
  for(const kind of ['disconnected','invalid-token']) {
    const f=fixture({attempts:4});
    if(kind==='disconnected')f.state.connected=false;else f.state.connection.token_tag='invalid';
    const res=await f.request();assert.equal(res.code,200);
    assert.equal(res.body.sync.status,kind==='disconnected'?'not_configured':'failed');
    assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,4);assert.equal(f.state.row.metadata.bookkeeping_sync_exhausted,false);
    assert.equal(f.state.providerCalls,0);
  }
});

test('an actual provider rejection consumes the fifth attempt and retains bounded retries',async()=>{
  const f=fixture({attempts:4});f.state.providerStatus=400;
  const res=await f.request();assert.equal(res.code,200);assert.equal(res.body.sync.status,'failed');assert.equal(res.body.sync.retryable,false);
  assert.equal(f.state.providerCalls,1);assert.equal(f.state.row.metadata.bookkeeping_sync_attempts,5);assert.equal(f.state.row.metadata.bookkeeping_sync_exhausted,true);
});
