import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppBoundMessageHandler} from '../../automation/whatsapp/assistant-handler.mjs';

// Deliberately omit env from the handler options. This verifies activation from
// the process environment supplied by the release gate, as in production.
const deny=()=>assert.fail('Offline turns must not construct or call a provider');
const scope={workspaceId:'w',customerId:'c',phone:'+919871367051',messageId:'activation'};
function options(pending={}) {
  const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null})};
  return {supabase:{from:()=>q,rpc:async()=>({data:false})},authorizeScope:async()=>true,
    providerFactory:deny,extract:deny,fetchImpl:deny,logger:{error(){}},
    pendingActionStoreFactory:()=>({loadInvoiceReview:async()=>null,loadPendingAction:async()=>null,...pending}),
    invoiceStoreFactory:()=>({findInvoices:async()=>[]})};
}
test('ambient offline route handles invoice edits without a chat provider',async()=>{
  assert.equal(process.env.EXTRACTION_ROUTE,'offline');
  const handler=createWhatsAppBoundMessageHandler(options());
  assert.equal(await handler({...scope,message:'chnge the bil details'}),
    'What would you like to change, and what should the new value be?');
});
test('ambient offline route extracts media locally and persists its review provenance',async()=>{
  assert.equal(process.env.EXTRACTION_ROUTE,'offline');
  let extractions=0,stored;
  const handler=createWhatsAppBoundMessageHandler({...options({
    beginInvoiceReview:async()=>({id:1,action:{stage:'extracting'}}),
    transitionInvoiceReview:async input=>{stored=input;return true;},
  }),extractOffline:async({provider})=>{
    assert.equal(provider,null);extractions++;
    return {lineItems:{value:[],confidence:0}};
  }});
  const reply=await handler({...scope,message:'log invoice',media:{bytes:Buffer.from([1]),mimeType:'image/png'}});
  assert.equal(extractions,1);
  assert.equal(stored.action.extractionRoute,'offline');
  assert.equal(stored.action.stage,'incomplete');
  assert.match(reply,/Local invoice review/);
  assert.match(reply,/Nothing was saved/);
});
