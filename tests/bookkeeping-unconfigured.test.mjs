import test from 'node:test';import assert from 'node:assert/strict';
import {syncInvoiceRow} from '../automation/invoice-sync.mjs';
import {bookkeepingSyncLabel,isUnconfiguredBookkeeping,showBookkeepingSyncError,invoiceSyncMessage} from '../invoice/bookkeeping-client.mjs';
import {readFile} from 'node:fs/promises';import vm from 'node:vm';

function fixture(metadata={}){
 let row={id:'invoice',workspace_id:'workspace',status:'draft',customer_id:'customer',currency:'INR',total_amount:1250,metadata:{invoice_direction:'receivable',...metadata}};
 const store={workspaceId:'workspace',userId:'owner',getAssistantInvoice:async()=>row,claimInvoiceSync:async(_,m,fields={})=>row={...row,...fields,metadata:m},finishInvoiceSync:async(_,m,fields={})=>row={...row,...fields,metadata:{...row.metadata,...m}}};
 return {store,get row(){return row;}};
}
const invoice={direction:'receivable',clientName:'Client',currency:'INR',total:1250};
test('never-connected bookkeeping stores no alert or retry timer, even after a legacy noisy attempt',async()=>{
 for(const configured of [false,true]){
  const f=fixture({bookkeeping_sync_error:'ACCOUNTING_NOT_CONNECTED',bookkeeping_sync_next_at:null});
  const accounting=configured?{prepareInvoiceSync:async()=>{throw Object.assign(Error('not connected'),{code:'ACCOUNTING_NOT_CONNECTED'});},syncInvoice:()=>assert.fail('no provider call')}:null;
  const result=await syncInvoiceRow({store:f.store,row:f.row,invoice,accounting});
  assert.equal(result.sync.status,'not_configured');assert.equal(result.sync.retryable,false);
  assert.equal(f.row.metadata.bookkeeping_sync_next_at,null);assert.equal(f.row.metadata.bookkeeping_sync_error,null);assert.equal(f.row.last_sync_error,null);
  assert.equal(f.row.metadata.bookkeeping_sync_attempts||0,0);assert.equal(bookkeepingSyncLabel(f.row),'Not connected');assert.equal(showBookkeepingSyncError(f.row),false);
 }
});
test('connected provider failures retain diagnostics and automatic retries',async()=>{
 const f=fixture(),accounting={prepareInvoiceSync:async()=>async()=>{throw Object.assign(Error('upstream unavailable'),{code:'ACCOUNTING_PROVIDER_ERROR',status:503});},syncInvoice(){}};
 const result=await syncInvoiceRow({store:f.store,row:f.row,invoice,accounting});
 assert.equal(result.sync.status,'failed');assert.equal(result.sync.retryable,true);assert.equal(f.row.metadata.bookkeeping_sync_attempts,1);
 assert.ok(Date.parse(f.row.metadata.bookkeeping_sync_next_at)>Date.now());assert.equal(showBookkeepingSyncError(f.row),true);
});
test('legacy missing-connection alerts are calm, while real errors are never hidden',()=>{
 const row={bookkeeping_sync_status:'not_configured',bookkeeping_sync_error:'ACCOUNTING_NOT_CONNECTED'};
 assert.equal(isUnconfiguredBookkeeping(row),true);assert.equal(showBookkeepingSyncError(row),false);
 assert.equal(showBookkeepingSyncError({...row,bookkeeping_sync_error:'UPSTREAM_FAILED'}),true);
 assert.equal(showBookkeepingSyncError({...row,bookkeeping_sync_attempts:2}),true);
 assert.match(invoiceSyncMessage({status:'not_configured'}),/not connected/);
});
test('actual invoice drawer replaces the enum and suppresses only never-connected alert/retry noise',async()=>{
 const app=await readFile(new URL('../app.js',import.meta.url),'utf8'),source=app.slice(app.indexOf('function detail(id){'),app.indexOf('function invoiceDeleteStatus('));
 for(const connectedFailure of [false,true]){
  let html;const row={id:'invoice',number:'INV-1',client:'Client',currency:'INR',invoice_direction:'receivable',bookkeeping_sync_status:connectedFailure?'failed':'not_configured',bookkeeping_sync_error:connectedFailure?'UPSTREAM_FAILED':'ACCOUNTING_NOT_CONNECTED',bookkeeping_sync_next_at:new Date(Date.now()+100000).toISOString()};
  const context={state:{invoices:[row]},bookkeepingSyncLabel,isUnconfiguredBookkeeping,showBookkeepingSyncError,remaining:()=>1250,terminalInvoice:()=>false,activeException:()=>null,receivableBalanceLabel:()=>'',followupStage:()=>['Draft',''],
   openDialog:(_,body)=>html=body,escape:String,status:()=> 'Open',money:()=>'',tag:String,day:()=>'',deliveryState:()=>'',invoiceBusinessDetails:()=>'',customFieldsView:()=>'',icon:()=>'',canRetryInvoiceSync:()=>false,ownerTemplateTestUI:{canReview:()=>false},isExternallyManagedInvoice:()=>false,button:()=>''};
  vm.runInNewContext(source+"detail('invoice')",context);
  assert.doesNotMatch(html,/not_configured/);
  if(connectedFailure){assert.match(html,/Sync error: UPSTREAM_FAILED/);assert.match(html,/Next retry after/);}
  else{assert.match(html,/Not connected/);assert.doesNotMatch(html,/role="alert"|Sync error|Next retry after/);}
 }
});
