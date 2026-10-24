import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryInvoiceSync,invoiceSyncMessage} from '../invoice/bookkeeping-client.mjs';
import {createTestInvoiceClient,createTestInvoiceUI} from '../invoice/test-mode-ui.mjs';

const WORKSPACE='10000000-0000-4000-8000-000000000001';
const OWNER='20000000-0000-4000-8000-000000000001';
const INVOICE='30000000-0000-4000-8000-000000000001';
const REQUEST='40000000-0000-4000-8000-000000000001';
const success={ok:true,invoiceId:INVOICE,invoiceNumber:`CETLD-TEST-${REQUEST}-NO-PAYMENT-REQUIRED`};

test('test invoice client sends only creation identity with the owner session',async()=>{
  const calls=[];
  const request=createTestInvoiceClient({accessToken:async()=> 'owner-session',fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json(success);
  }});
  assert.deepEqual(await request({workspaceId:WORKSPACE,idempotencyKey:REQUEST,customerId:OWNER,phone:'+12025550123',amount:100}),success);
  assert.equal(calls[0].url,'/api/invoice-lifecycle');
  assert.equal(calls[0].options.headers.Authorization,'Bearer owner-session');
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body),{action:'createTestInvoice',workspaceId:WORKSPACE,idempotencyKey:REQUEST});
});

test('test creation fails closed without a session or a confirmed test result',async()=>{
  let requests=0;
  await assert.rejects(createTestInvoiceClient({accessToken:async()=>null,fetchImpl:async()=>{requests++;}})({workspaceId:WORKSPACE,idempotencyKey:REQUEST}),/Sign in/);
  assert.equal(requests,0);
  for(const result of [{ok:true,invoiceId:INVOICE,invoiceNumber:'INV-1'},{ok:true,invoiceNumber:success.invoiceNumber},{}]) {
    const request=createTestInvoiceClient({accessToken:async()=> 'owner-session',fetchImpl:async()=>Response.json(result)});
    await assert.rejects(request({workspaceId:WORKSPACE,idempotencyKey:REQUEST}));
  }
});

function fixture({demo=false,owner=true,request=async()=>success}={}) {
  const state={demo,user:{id:OWNER},workspace:{id:WORKSPACE,owner_id:owner?OWNER:INVOICE},invoices:[]};
  const calls=[],control={disabled:false};
  const ui=createTestInvoiceUI({state,request:async payload=>{calls.push(['request',{...payload}]);return request(payload);},
    requestId:()=>REQUEST,openDialog:(title,html)=>calls.push(['dialog',title,html]),dialog:()=>({close:()=>calls.push(['close'])}),
    loadData:async()=>{calls.push(['load']);state.invoices=[{id:INVOICE}];return true;},detail:id=>calls.push(['detail',id]),
    button:(action,label)=>`<button type="button" data-action="${action}">${label}</button>`,toast:message=>calls.push(['toast',message]),
    showError:(_dialog,error)=>calls.push(['error',error.message]),
  });
  return {ui,state,calls,control};
}

test('test invoice UI is owner only and preserves ordinary preview and approval',async()=>{
  for(const options of [{demo:true},{owner:false}]) {
    const f=fixture(options);
    assert.equal(f.ui.entry(),'');assert.equal(f.ui.review(),false);assert.equal(await f.ui.create(f.control),false);
    assert.deepEqual(f.calls,[]);
  }
  const f=fixture();
  assert.match(f.ui.entry(),/Create test invoice/);
  assert.equal(f.ui.review(),true);
  const html=f.calls[0][2];
  for(const text of ['Pappa','+919818685252','INR 1','NO PAYMENT REQUIRED','usual reminder preview','consent'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/<input|<select|<textarea/);
  assert.equal(f.calls.filter(([kind])=>kind==='request').length,0,'review does not create or send');
  assert.equal(await f.ui.create(f.control),true);
  assert.deepEqual(f.calls.filter(([kind])=>kind==='request'),[['request',{workspaceId:WORKSPACE,idempotencyKey:REQUEST}]]);
  assert.deepEqual(f.calls.filter(([kind])=>['close','load','detail'].includes(kind)),[['close'],['load'],['detail',INVOICE]]);
  assert.equal(f.control.disabled,false);
});

test('a failed create retries the same request UUID and a changed owner scope cannot submit',async()=>{
  let attempts=0;
  const f=fixture({request:async()=>{if(++attempts===1)throw Error('Temporary failure');return success;}});
  f.ui.review();
  assert.equal(await f.ui.create(f.control),false);
  assert.equal(await f.ui.create(f.control),true);
  assert.deepEqual(f.calls.filter(([kind])=>kind==='request').map(([,payload])=>payload.idempotencyKey),[REQUEST,REQUEST]);
  const changed=fixture();changed.ui.review();changed.state.workspace.owner_id=INVOICE;
  assert.equal(await changed.ui.create(changed.control),false);
  assert.equal(changed.calls.filter(([kind])=>kind==='request').length,0);
});
test('test invoice bookkeeping remains visibly excluded after an ordinary correction marks sync pending',()=>{
  const metadata={test_invoice:true,bookkeeping_sync_status:'pending'};
  assert.equal(canRetryInvoiceSync({metadata},true),false);
  assert.equal(invoiceSyncMessage({status:'pending'},metadata),'Test invoice. Permanently excluded from accounting exports.');
});
