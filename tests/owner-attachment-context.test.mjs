import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
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
  let persisted=null,omitAudit=false;
  const store={
    async findAssistantInvoice(){return persisted;},async findCustomer(){return {id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'};},
    async createAssistantInvoice({invoice,reviewNumberAudit}){saved++;if(omitAudit)reviewNumberAudit=null;persisted={id:'ffffffff-ffff-4fff-8fff-fffffffffff2',workspace_id:scope.workspaceId,
      invoice_number:invoice.invoiceNumber==='AUTO'?'INV-2026-0042':invoice.invoiceNumber,issue_date:invoice.invoiceDate,due_date:invoice.dueDate,currency:invoice.currency,total_amount:invoice.total,
      amount_paid:0,status:'draft',metadata:{...(reviewNumberAudit?{printed_invoice_number:reviewNumberAudit.originalExtractedNumber,invoice_number_override_audit:clone(reviewNumberAudit)}:{}),assistant_idempotency_key:invoice.idempotencyKey,line_items:clone(invoice.lineItems),subtotal:invoice.subtotal,tax:invoice.tax}};return persisted;},
    async updateAssistantInvoiceMetadata(_id,metadata){persisted.metadata={...persisted.metadata,...metadata};return persisted;},
    async keepInvoiceFile(input){files++;assert.deepEqual(input.bytes,sourceBytes);},
  };
  db.supabase.rpc=async(name,args)=>{
    if(name!=='whatsapp_override_invoice_review_number')return {error:{message:'isolated unavailable'}};
    assert.equal(args.p_workspace_id,scope.workspaceId);assert.equal(args.p_owner_id,scope.ownerId);assert.equal(args.p_phone,scope.phone);
    if(current?.version!==args.p_version)return {data:{ok:false,code:'STALE'}};
    const audit={originalExtractedNumber:current.action.invoice.invoiceNumber,requestedNumber:args.p_number,
      intent:args.p_intent,ownerMessageId:args.p_provider_message_id,ownerInstruction:args.p_authorization_quote,sourceMessageId:sourceId};
    current={...current,version:++version,action:{...current.action,invoice:{...current.action.invoice,invoiceNumber:args.p_number},invoiceNumberOverrideAudit:audit}};
    return {data:{ok:true,review:clone(current)}};
  };
  let sourceAvailable=true;
  const tools=(message,messageId,media=null)=>createOwnerWorkspaceTools({supabase:db.supabase,scope,clock,ownerStore:{query:async()=>[]},
    pending,pendingAtStart:current?clone(current):null,pendingInitialState:current?clone(current):{generation:0,id:null,action:null},
    invoiceStoreFactory:()=>store,authorize:async()=>true,message,messageId,media,logger:{error(){}},providerFactory:()=>({}),
    sourceMediaReader:async input=>{assert.equal(input.providerMessageId,sourceId);assert.equal(input.workspaceId,scope.workspaceId);assert.equal(input.phone,scope.phone);
      return sourceAvailable?{bytes:sourceBytes,mimeType:'application/pdf',fileName:'fixture.pdf'}:null;},
    extractAttachment:async()=>{extractions++;return clone(extracted);}});
  return {tools,sourceId,sourceBytes,pending,db,get current(){return current;},get saved(){return saved;},get files(){return files;},get extractions(){return extractions;},get persisted(){return persisted;},
    omitAudit(){omitAudit=true;},restoreAudit(){persisted.metadata.printed_invoice_number=current.action.invoiceNumberOverrideAudit.originalExtractedNumber;persisted.metadata.invoice_number_override_audit=clone(current.action.invoiceNumberOverrideAudit);},
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

test('a clear attachment save is forced through the consolidated workspaceData save operation',async()=>{
  let rounds=0,saveResult=null,calledArgs=null;
  const tools={definitions:[{type:'function',function:{name:'workspaceData',description:'Read or change workspace data.',parameters:{type:'object',properties:{operation:{type:'string'}},additionalProperties:false}}}],
    async execute(name,args){calledArgs={name,args};saveResult={ok:true,completed:true,operation:'saveAttachment',invoice:{invoiceNumber:'INV-17',clientName:'Rob & Joe Traders',total:662.75,currency:'USD'}};return saveResult;},
    getWriteAttempted:()=>true};
  const result=await runOwnerAgent({tools,message:'Log this invoice',clock,
    attachmentDescriptor:{available:true,mimeType:'image/jpeg'},
    provider:{async generate({messages,tools:offered,toolChoice}){
      rounds++;
      if(rounds===1){
        assert.equal(toolChoice,'required');
        assert.deepEqual(offered.map(item=>item.function.name),['workspaceData']);
        assert.deepEqual(offered[0].function.parameters.required,['operation']);
        assert.deepEqual(offered[0].function.parameters.properties.operation.enum,['saveAttachment']);
        // Simulate a planner that tries the unsupported invoice.create shape.
        return call({operation:'create',table:'invoices',values:{line_items:[],invoice_direction:'receivable',payment_terms:'Net 30'}});
      }
      saveResult=JSON.parse(messages.findLast(item=>item.role==='tool').content);
      return {model:'fixture',content:saveResult.completed?'Saved INV-17 for Rob & Joe Traders, USD 662.75.':'The invoice review is saved for follow-up.'};
    }}});
  assert.deepEqual(calledArgs,{name:'workspaceData',args:{operation:'saveAttachment'}});
  assert.ok(saveResult?.ok,JSON.stringify(saveResult));
  assert.equal(saveResult.completed,true);
  assert.equal(rounds,2);
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

test('owner numbering intent preserves extraction audit and assigns a unique number only after later approval',async()=>{
  const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
  const original=clone(f.current.action.invoice);
  const changed=await f.tools('Use my usual numbering for this invoice','fixture-renumber').execute('workspaceData',{
    operation:'reviewAttachment',table:'invoices',values:{invoice_number:'AUTO',invoice_number_intent:'use_workspace_numbering'}});
  assert.equal(changed.ok,true);assert.equal(changed.requiresLaterConfirmation,true);assert.equal(changed.originalExtractedNumber,'INV-17');assert.equal(f.saved,0);
  assert.deepEqual({...f.current.action.invoice,invoiceNumber:original.invoiceNumber},original);
  assert.equal((await f.tools('Use my usual numbering for this invoice','fixture-renumber').execute('workspaceData',{operation:'saveAttachment'})).ok,false);
  const saved=await f.tools('The reviewed number and facts are fine; save it','fixture-approve-number').execute('workspaceData',{operation:'saveAttachment'});
  assert.equal(saved.completed,true);assert.equal(saved.invoiceNumber,'INV-2026-0042');assert.equal(f.saved,1);
  assert.equal(f.persisted.metadata.printed_invoice_number,'INV-17');
  assert.equal(f.persisted.metadata.invoice_number_override_audit.originalExtractedNumber,'INV-17');
  assert.equal(f.persisted.metadata.invoice_number_override_audit.ownerInstruction,'Use my usual numbering for this invoice');
});

test('number override requires intent, bounded owner value and changes no other known fields',async()=>{
  for(const values of [{invoice_number:'AUTO'},{invoice_number:'AUTO',invoice_number_intent:'replace_extracted_number'},
    {invoice_number:'INVENTED',invoice_number_intent:'replace_extracted_number'},
    {invoice_number:'AUTO',invoice_number_intent:'use_workspace_numbering',total_amount:99},
    {invoice_number:'bad\nnumber',invoice_number_intent:'replace_extracted_number'}]){
    const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
    const result=await f.tools('Use my usual numbering','fixture-bad-number').execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values});
    assert.equal(result.ok,false);assert.equal(f.current.action.invoice.invoiceNumber,'INV-17');assert.equal(f.saved,0);
  }
});

test('real owner invoice adapter inserts number audit atomically and rejects foreign customer or untrusted customer audit',async()=>{
  const db=createOwnerChatDatabase();
  const store=createWhatsAppInvoiceStore({supabase:db.supabase,...scope,audience:'owner',authorize:async()=>true});
  const audit={originalExtractedNumber:'INV-17',requestedNumber:'AUTO',ownerMessageId:'owner-number-request',ownerInstruction:'Use usual numbering'};
  const invoice={invoiceNumber:'AUTO',invoiceDate:'2026-10-01',dueDate:'2026-10-31',currency:'USD',total:662.75,
    subtotal:600,tax:62.75,clientName:'John Smith',idempotencyKey:'isolated-real-store',direction:'receivable',lineItems:[]};
  await store.createAssistantInvoice({customerId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',invoice,reviewNumberAudit:audit});
  const saved=db.tables.invoices.find(row=>row.metadata?.assistant_idempotency_key==='isolated-real-store');
  assert.deepEqual(saved.metadata.invoice_number_override_audit,audit);assert.equal(saved.metadata.printed_invoice_number,'INV-17');
  assert.equal(saved.workspace_id,scope.workspaceId);
  await assert.rejects(store.createAssistantInvoice({customerId:'e0000000-0000-4000-8000-000000000001',invoice,reviewNumberAudit:audit}),/customer scope/);
  const customerStore=createWhatsAppInvoiceStore({supabase:db.supabase,...scope});
  await assert.rejects(customerStore.createAssistantInvoice({customerId:scope.customerId,invoice,reviewNumberAudit:audit}),/invalid trusted invoice number audit/);
});

test('unverified saved audit does not claim success; reconciliation resumes the same invoice once',async()=>{
  const f=fixture();await f.tools('Read invoice',f.sourceId,{bytes:f.sourceBytes,mimeType:'application/pdf'}).execute('workspaceData',{operation:'analyzeAttachment'});
  await f.tools('Use usual numbering','fixture-number-reconcile').execute('workspaceData',{
    operation:'reviewAttachment',table:'invoices',values:{invoice_number:'AUTO',invoice_number_intent:'use_workspace_numbering'}});
  f.omitAudit();
  const uncertain=await f.tools('Save it','fixture-number-save').execute('workspaceData',{operation:'saveAttachment'});
  assert.equal(uncertain.ok,false);assert.equal(uncertain.code,'DATABASE_UNAVAILABLE');assert.equal(uncertain.completed,undefined);
  assert.equal(f.saved,1);assert.equal(f.current.action.stage,'saving');assert.equal(f.files,0);
  f.restoreAudit();
  const resumed=await f.tools('Check and finish the save','fixture-number-resume').execute('workspaceData',{operation:'saveAttachment'});
  assert.equal(resumed.completed,true);assert.equal(resumed.replayed,true);assert.equal(resumed.invoiceNumber,'INV-2026-0042');
  assert.equal(f.saved,1);assert.equal(f.files,1);assert.equal(f.current.action.stage,'saved');
});
