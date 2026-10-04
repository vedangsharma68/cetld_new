import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW} from './fixtures/owner-chat-battery.mjs';

const clone=value=>structuredClone(value),clock=()=>DEFAULT_NOW;
function fixture(){
  const db=createOwnerChatDatabase();let current=null,version=0,saved=0,files=0,extractions=0;
  const sourceId='owner-photo-fixture',sourceBytes=Buffer.from('isolated source bytes');
  const extracted=Object.fromEntries(Object.entries({invoiceNumber:'INV-17',customerName:'Rob & Joe Traders',invoiceDate:'2026-10-01',dueDate:'2026-10-31',
    subtotal:600,tax:62.75,total:662.75,outstandingAmount:662.75,currency:'USD',direction:'receivable',clientEmail:null,clientPhone:null,clientPhoneRaw:null,notes:'Net 30',
    lineItems:[{description:'Fixture service',quantity:1,unitPrice:600,amount:600,confidence:0.95}]})
    .map(([key,value])=>[key,{value,confidence:0.95}]));
  const pending={
    async beginInvoiceReview(){current={id:81,version:++version,generation:version,created_at:clock().toISOString(),action:{type:'invoice_review_draft',stage:'extracting'}};return clone(current);},
    async loadInvoiceReview(){return current?clone(current):null;},
    async loadPendingAction(){return current?clone(current):null;},
    async loadPendingActionState(){return current?clone(current):{generation:0,id:null,action:null};},
    async transitionInvoiceReview({id,version:expected,fromStage,action}){
      if(current?.id!==id||current.version!==expected||current.action.stage!==fromStage)return null;
      current={...current,version:++version,action:clone(action)};return clone(current);
    },
  };
  let persisted=null;
  const store={
    async findAssistantInvoice(){return persisted;},async findCustomer(){return {id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'};},
    async createAssistantInvoice({invoice}){saved++;persisted={id:'ffffffff-ffff-4fff-8fff-fffffffffff2',workspace_id:scope.workspaceId,
      invoice_number:invoice.invoiceNumber,issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:invoice.currency,total_amount:invoice.total,
      amount_paid:0,status:'draft',metadata:{assistant_idempotency_key:invoice.idempotencyKey,line_items:clone(invoice.lineItems),subtotal:invoice.subtotal,tax:invoice.tax}};return persisted;},
    async updateAssistantInvoiceMetadata(_id,metadata){persisted.metadata={...persisted.metadata,...metadata};return persisted;},
    async keepInvoiceFile(input){files++;assert.deepEqual(input.bytes,sourceBytes);},
  };
  let sourceAvailable=true;
  const tools=(message,messageId,media=null)=>createOwnerWorkspaceTools({supabase:db.supabase,scope,clock,ownerStore:{query:async()=>[]},
    pending,pendingAtStart:current?clone(current):null,pendingInitialState:current?clone(current):{generation:0,id:null,action:null},
    invoiceStoreFactory:()=>store,authorize:async()=>true,message,messageId,media,logger:{error(){}},providerFactory:()=>({}),
    sourceMediaReader:async input=>{assert.equal(input.providerMessageId,sourceId);assert.equal(input.workspaceId,scope.workspaceId);assert.equal(input.phone,scope.phone);
      return sourceAvailable?{bytes:sourceBytes,mimeType:'application/pdf',fileName:'fixture.pdf'}:null;},
    extractAttachment:async()=>{extractions++;return clone(extracted);}});
  return {tools,sourceId,sourceBytes,pending,db,get current(){return current;},get saved(){return saved;},get files(){return files;},get extractions(){return extractions;},get persisted(){return persisted;},
    unavailable(){sourceAvailable=false;},replace(){current={...current,version:++version,action:{...current.action,sourceMessageId:'new-owner-photo'}};}};
}
const call=args=>({toolCalls:[{id:'fixture-call',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}],model:'fixture'});

test('attachment analysis survives whole conversation followups and saves once with original fields and source',async()=>{
  const f=fixture();
  async function turn(message,id,operation=null,media=null){
    const tools=f.tools(message,id,media);let rounds=0;
    return runOwnerAgent({tools,message,clock,attachmentDescriptor:{available:Boolean(media),mimeType:'application/pdf'},provider:{async generate({messages}){
      rounds++;
      if(id!==f.sourceId){
        const runtime=JSON.parse(messages.filter(item=>item.role==='system')[1].content);
        assert.equal(runtime.pendingAttachmentReview.invoice.clientName,'Rob & Joe Traders');
        assert.equal(runtime.pendingAttachmentReview.invoice.total,662.75);
        assert.equal(runtime.pendingAttachmentReview.invoice.currency,'USD');
      }
      if(operation&&rounds===1)return call({operation});
      const result=messages.findLast(item=>item.role==='tool');
      if(operation==='analyzeAttachment'){
        assert.equal(JSON.parse(result.content).reviewRetained,true);
        return {model:'fixture',content:'The attachment shows INV-17 for Rob & Joe Traders, USD 662.75.'};
      }
      if(operation==='saveAttachment'){
        assert.equal(JSON.parse(result.content).completed,true);
        return {model:'fixture',content:'Saved INV-17 for Rob & Joe Traders, USD 662.75.'};
      }
      return {model:'fixture',content:'The retained invoice is INV-17 for Rob & Joe Traders, USD 662.75.'};
    }}});
  }
  await turn('Read this attached invoice',f.sourceId,'analyzeAttachment',{bytes:f.sourceBytes,mimeType:'application/pdf'});
  assert.equal(f.current.action.stage,'proposal');assert.equal(f.saved,0);
  await turn('like?','fixture-question');assert.equal(f.saved,0);
  await turn('yea, they are fine; log this invoice','fixture-save','saveAttachment');
  assert.equal(f.saved,1);assert.equal(f.files,1);assert.equal(f.extractions,1);assert.equal(f.current.action.stage,'saved');
  assert.deepEqual(f.persisted.metadata.line_items,[{description:'Fixture service',quantity:1,unitPrice:600,amount:600,confidence:0.95}]);
  assert.equal(f.persisted.metadata.tax,62.75);assert.equal(f.persisted.amount_paid,0);
});

test('repeating known review fields is a verified no-op, while changing extracted fields remains guarded',async()=>{
  const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
  const tools=f.tools('These are fine','fixture-known');
  const result=await tools.execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values:{invoice_number:'INV-17',customer_name:'Rob & Joe Traders',
    subtotal:600,tax:62.75,notes:'Net 30',line_items:f.current.action.invoice.lineItems}});
  assert.equal(result.ok,true);assert.equal(result.unchanged,true);assert.equal(f.saved,0);
  const unsupported=await tools.execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values:{invoice_number:'AUTO'}});
  assert.equal(unsupported.ok,false);assert.equal(f.current.action.invoice.invoiceNumber,'INV-17');
});

test('missing source, replaced review and same attachment-turn save cannot authorize old or stale media',async()=>{
  for(const failure of ['missing','replaced','same-turn']){
    const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
    const tools=f.tools('Log it',failure==='same-turn'?f.sourceId:'fixture-save');
    if(failure==='missing')f.unavailable();if(failure==='replaced')f.replace();
    const result=await tools.execute('workspaceData',{operation:'saveAttachment'});
    assert.equal(result.ok,false);assert.equal(f.saved,0);assert.equal(f.files,0);
  }
});

test('acknowledging known facts does not spend the write slot before saving the retained review',async()=>{
  const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
  const tools=f.tools('The known fields are fine, save it','fixture-noop-save');
  assert.equal((await tools.execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values:{invoice_number:'INV-17',total_amount:662.75}})).unchanged,true);
  assert.equal((await tools.execute('workspaceData',{operation:'saveAttachment'})).completed,true);
  assert.equal(f.saved,1);
});
