import test from 'node:test';
import assert from 'node:assert/strict';
import {providerFetch} from '../automation/accounting/http.mjs';
import {AccountingProviderError,providerDiagnostics} from '../automation/accounting/errors.mjs';
import {syncInvoiceRow,syncRetryDelay} from '../automation/invoice-sync.mjs';

const url='https://www.zohoapis.in/books/v3/invoices?organization_id=test-org';
const message='The export was rejected: “test invoice” must be corrected.';
const authorization='Zoho-oauthtoken isolated-test-access-token';
async function rejection(body,requestUrl=url,options={method:'POST',headers:{Authorization:authorization}}) {
  try {await providerFetch(async()=>Response.json(body,{status:400}),'zoho_books',requestUrl,options);assert.fail('expected provider error');}
  catch(error){assert.ok(error instanceof AccountingProviderError);return error;}
}

test('Zoho API HTTP 400 preserves the exact response code/message and operation without query strings',async()=>{
  const error=await rejection({code:1001,message,access_token:'do-not-copy',extra:{private:'do-not-copy'}});
  assert.equal(error.code,'ACCOUNTING_PROVIDER_ERROR');assert.equal(error.status,400);
  assert.deepEqual(providerDiagnostics(error),{providerCode:'1001',providerMessage:message,providerOperation:'POST /books/v3/invoices'});
  assert.doesNotMatch(error.message,/test invoice/);assert.equal(error.details,undefined);
  assert.doesNotMatch(JSON.stringify(error),/do-not-copy|test-org|isolated-test-access-token/);
});

test('provider response code zero is preserved rather than replaced with the HTTP fallback',async()=>{
  const error=await rejection({code:0,message:'Explicit zero'});assert.equal(error.providerCode,'0');
});

test('credential echoes are redacted and provider messages have a storage bound',async()=>{
  const secretMessage='Rejected isolated-test-access-token; refresh_token="private-refresh"; client_secret: private-client; Bearer private-bearer';
  const error=await rejection({code:1001,message:secretMessage});
  assert.doesNotMatch(error.providerMessage,/isolated-test-access-token|private-refresh|private-client|private-bearer/);
  assert.match(error.providerMessage,/Rejected/);assert.match(error.providerMessage,/redacted/);
  const long=await rejection({code:1001,message:'x'.repeat(3000)});assert.equal(long.providerMessage.length,2000);
  const unicode=await rejection({code:1001,message:'x'.repeat(1999)+'😀tail'});
  assert.equal(unicode.providerMessage,'x'.repeat(1999)+'😀');assert.equal(unicode.providerMessage.isWellFormed(),true);
  const malformed=await rejection({code:1001,message:'invalid \ud800'});assert.equal(malformed.providerMessage,'invalid \ufffd');
});

test('OAuth and malformed error bodies never become provider messages',async()=>{
  const oauth=await rejection({error:'invalid_grant',message:'access_token=private-token',error_description:'private detail'},'https://accounts.zoho.in/oauth/v2/token');
  assert.deepEqual(providerDiagnostics(oauth),{providerCode:'invalid_grant',providerMessage:null,providerOperation:null});
  await assert.rejects(providerFetch(async()=>new Response('<html>private detail</html>',{status:400}),'zoho_books',url,{method:'POST'}),error=>error.providerCode==='http_400'&&!JSON.stringify(error).includes('private detail'));
  const object=await rejection({code:1001,message:{token:'private'}});assert.equal(providerDiagnostics(object).providerMessage,null);
});

test('export metadata persists the specific Zoho response and clears it on the next successful attempt',async()=>{
  let now=Date.now(),version=0;
  let row={id:'22222222-2222-4222-8222-222222222222',workspace_id:'11111111-1111-4111-8111-111111111111',customer_id:'customer',invoice_number:'INV-TEST',total_amount:118,currency:'INR',status:'draft',metadata:{invoice_direction:'receivable',bookkeeping_sync_status:'pending'},updated_at:'v0'};
  const store={workspaceId:row.workspace_id,userId:'owner',getAssistantInvoice:async()=>row,
    async updateAssistantInvoiceMetadata(id,metadata,fields={}){assert.equal(id,row.id);row={...row,...fields,metadata,updated_at:`v${++version}`};return row}};
  const invoice={direction:'receivable',clientName:'Client',invoiceNumber:row.invoice_number,total:118,currency:'INR'};
  const accounting={async syncInvoice(){throw await rejection({code:1001,message})}};
  const failed=await syncInvoiceRow({store,row,invoice,accounting,clock:()=>new Date(now)});
  assert.equal(failed.sync.status,'failed');assert.equal(row.last_sync_error,'ACCOUNTING_PROVIDER_ERROR');
  assert.equal(row.metadata.bookkeeping_sync_http_status,400);
  assert.equal(row.metadata.bookkeeping_sync_provider_code,'1001');
  assert.equal(row.metadata.bookkeeping_sync_provider_message,message);
  assert.equal(row.metadata.bookkeeping_sync_provider_operation,'POST /books/v3/invoices');
  now+=syncRetryDelay(1)+1;
  const saved=await syncInvoiceRow({store,row,invoice,accounting:{async syncInvoice(){return{provider:'zoho_books',externalId:'remote'}}},clock:()=>new Date(now)});
  assert.equal(saved.sync.status,'synced');
  for(const key of ['bookkeeping_sync_http_status','bookkeeping_sync_provider_code','bookkeeping_sync_provider_message','bookkeeping_sync_provider_operation'])assert.equal(row.metadata[key],null);
});

test('generic internal failures do not copy arbitrary error messages or details into provider metadata',()=>{
  assert.deepEqual(providerDiagnostics(Object.assign(Error('private internal error'),{details:{token:'private'},providerCode:'injected',providerMessage:'private'})),{providerCode:null,providerMessage:null,providerOperation:null});
});
