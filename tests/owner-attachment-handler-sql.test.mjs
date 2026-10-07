import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {extractInvoice} from '../ai/extraction.mjs';

const phone='+919871367051';
async function fixture({clientPhone=null,loseInsertAcknowledgement=false,loseReplyReceipt=false,caption='log this invoice',history=[],nativeWire=false,extractionWire=null}={}){
  const f=await createOfflineSqlNetwork(),ownerId=randomUUID();
  await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await f.db.query('select (public.create_workspace($1,$2)).id',['Fixture studio',randomUUID()])).rows[0].id;
  const verification=(await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const binding=(await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
  let extractions=0,insertInterrupted=false;const results=[];
  const extracted=Object.fromEntries(Object.entries({invoiceNumber:'INV-2026-0720',customerName:'Fixture customer',invoiceDate:'2026-07-20',dueDate:null,
    subtotal:6190,tax:0,total:6190,outstandingAmount:6190,currency:'USD',direction:'receivable',clientEmail:null,clientPhone,clientPhoneRaw:null,
    notes:'Net 30',paymentTerms:'Net 30',lineItems:[{description:'Fixture service',quantity:1,unitPrice:6190,amount:6190}]})
    .map(([key,value])=>[key,{value,confidence:.99}]));
  const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
    ...(history.length?{historyReader:async()=>history}:{}),
    ...(loseReplyReceipt?{replyStore:null}:{}),
    invoiceStoreFactory:verified=>{
      const store=createWhatsAppInvoiceStore({supabase:f.supabase,...verified,audience:'owner'});
      return {...store,async createAssistantInvoice(input){
        const saved=await store.createAssistantInvoice(input);
        if(loseInsertAcknowledgement&&!insertInterrupted){insertInterrupted=true;throw Error('isolated lost write acknowledgement');}
        return saved;
      }};
    },
    authorize:input=>{assert.ok(input?.workspaceId&&input?.ownerId&&input?.customerId&&input?.phone);
      return authorizeOwnerPhone({supabase:f.supabase,...input});},
    toolsFactory:options=>createOwnerWorkspaceTools({...options,
      attachmentIngestFactory:input=>createWhatsAppBoundMessageHandler({...input,extract:async request=>{
        extractions++;
        return extractionWire?extractInvoice({...request,imageExtractor:async()=>null,
          provider:{async generateStructured(call){return {data:call.validate(structuredClone(extractionWire)),model:'gemini-3.5-flash-lite'};}}}):structuredClone(extracted);
      }})}),
    providerFactory:()=>nativeWire?new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,
      cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger:{info(){},warn(){},error(){}},
      fetchImpl:async(_url,input)=>{
        const wire=JSON.parse(input.body),result=wire.messages.findLast(item=>item.role==='tool');
        let message;
        if(!result){
          assert.equal(wire.tool_choice,'required');assert.deepEqual(wire.tools.map(tool=>tool.function.name),['workspaceData']);
          // The production provider tried to log an earlier deletion. Even a
          // well-formed native call must be bound to the current attachment.
          message={content:'',tool_calls:[{id:'stale-context-log',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'business_records',values:{record_type:'log',name:'Deleted duplicate invoice INV-OLD'}})}}]};
        }else{
          const value=JSON.parse(result.content);results.push(value);
          message={content:value.completed?`Saved invoice ${value.review.invoice.invoiceNumber} for Fixture customer, USD 6190.`:'The invoice could not be logged due to temporary unavailability.'};
        }
        return new Response(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
      }}):({async generate({messages,tools,toolChoice}){
      const result=messages.findLast(item=>item.role==='tool');
      if(!result){
        assert.equal(toolChoice,'required');assert.deepEqual(tools.map(tool=>tool.function.name),['workspaceData']);
        return {model:'fixture',toolCalls:[{id:'fixture-save',type:'function',function:{name:'workspaceData',
          arguments:JSON.stringify({operation:'create',table:'invoices',values:{total_amount:1}})}}]};
      }
      const value=JSON.parse(result.content);results.push(value);
      return {model:'fixture',content:value.completed?`Saved invoice ${value.review.invoice.invoiceNumber} for Fixture customer, USD 6190.`:'I could not log the invoice because the processing failed.'};
    }})});
  async function turn(id,mimeType='image/jpeg'){
    const bytes=extractionWire?Buffer.from([255,216,255,0,0,0]):Buffer.from('isolated invoice source '+mimeType);
    await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,$3,$4,'processing') on conflict(provider_message_id) do nothing",[id,phone,mimeType==='application/pdf'?'document':'image',caption]);
    return {reply:await handler({...scope,message:caption,messageId:id,media:{bytes,mimeType,fileName:mimeType==='application/pdf'?'fixture.pdf':'fixture.jpg'}}),bytes};
  }
  return {...f,scope,handler,turn,results,get extractions(){return extractions;}};
}

for(const caption of ['log this','please save it','record the attached'])test(`current attachment caption '${caption}' cannot log an earlier deletion through native Cloudflare calls and real SQL`,async()=>{
  const f=await fixture({caption,nativeWire:true,history:[{role:'user',content:'delete it'},{role:'assistant',content:'Deleted duplicate invoice INV-OLD.'}]});
  try{
    const {reply}=await f.turn('attachment-current-caption');
    assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));
    assert.match(reply.answer,/Saved invoice INV-2026-0001/);
    assert.equal(f.extractions,1);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from business_records')).rows[0].n,0);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('actual extraction wire and default owner toolset retain contradictory amounts and replace a false outage reply with the review reason',async()=>{
  const facts={invoiceNumber:'0852',customerName:'Fixture customer',invoiceDate:'2026-10-01',dueDate:'2026-10-01',subtotal:100,tax:10,total:115,
    outstandingAmount:115,currency:null,direction:'receivable',clientEmail:null,clientPhone:null,clientPhoneRaw:null,notes:'Shipping 5',currencySource:null,addressHint:null,paymentTerms:'Due on receipt'};
  const extractionWire={...Object.fromEntries(Object.entries(facts).flatMap(([name,value])=>[[name,value],[name+'Confidence',value===null?0:.99]])),
    lineItems:[{description:'Printed service',quantity:1,unitPrice:100,amount:100,confidence:.99}],lineItemsConfidence:.99};
  const f=await fixture({nativeWire:true,extractionWire});try{
    const {reply}=await f.turn('inconsistent-attachment');
    assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));
    assert.match(reply.answer,/subtotal plus tax does not match the total/);
    assert.match(reply.answer,/Nothing was saved/);
    assert.doesNotMatch(reply.answer,/unavailable|processing failed/i);
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase}),review=await pending.loadInvoiceReview(f.scope);
    assert.equal(review.action.stage,'incomplete');assert.equal(review.action.sourceMessageId,'inconsistent-attachment');
    assert.equal(review.action.invoice.subtotal,100);assert.equal(review.action.invoice.tax,10);assert.equal(review.action.invoice.total,115);
    assert.ok(review.action.validationIssues.includes('INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX'));
    const tools=createOwnerWorkspaceTools({supabase:f.supabase,scope:f.scope,pending,pendingAtStart:review,pendingInitialState:review,
      ownerStore:{async query(){throw Error('An inconsistent review must not read unrelated records');}},
      invoiceStoreFactory:()=>{throw Error('An inconsistent review must not construct a write store');},
      authorize:async()=>true,message:'The total is 115; save it',messageId:'inconsistent-follow-up',logger:{error(){}}});
    const continued=await tools.execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values:{total_amount:115}});
    assert.equal(continued.ok,false);assert.equal(continued.code,'INVALID');assert.match(continued.message,/amount breakdown/);
    assert.equal((await tools.execute('workspaceData',{operation:'saveAttachment'})).ok,false);
    for(const table of ['invoices','invoice_files','business_records','payments'])assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0);
    assert.equal(f.extractions,1);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

for(const mimeType of ['image/jpeg','application/pdf'])test(`real owner handler and SQL log ${mimeType}, persist source and replay once with missing-phone follow-up`,async()=>{
  const f=await fixture();try{
    const first=await f.turn('fixture-attachment',mimeType);
    assert.match(first.reply.answer,/Saved invoice INV-2026-0001/,JSON.stringify({reply:first.reply,errors:f.errors,results:f.results}));
    assert.equal(f.results[0].completed,true);assert.equal(f.results[0].invoiceFileAttached,true);
    const rows=(await f.db.query('select * from invoices where workspace_id=$1',[f.scope.workspaceId])).rows;
    assert.equal(rows.length,1);assert.equal(Number(rows[0].total_amount),6190);assert.equal(rows[0].currency,'USD');
    assert.equal(rows[0].metadata.printed_invoice_number,'INV-2026-0720');
    assert.equal(rows[0].issue_date.toISOString().slice(0,10),'2026-07-20');assert.equal(rows[0].due_date.toISOString().slice(0,10),'2026-08-19');
    assert.equal(rows[0].metadata.line_items[0].amount,6190);assert.equal(rows[0].metadata.bookkeeping_sync_status,'not_configured');
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
    assert.equal((await pending.loadPendingAction(f.scope)).action.type,'invoice_debtor_phone');
    assert.equal(await pending.loadInvoiceReview(f.scope),null);
    const receipt=await pending.loadSavedInvoiceReview({...f.scope,sourceMessageId:'fixture-attachment'});
    assert.equal(receipt.action.invoice.id,rows[0].id);
    assert.equal(await pending.loadSavedInvoiceReview({...f.scope,sourceMessageId:'different-source'}),null);
    assert.equal(await pending.loadSavedInvoiceReview({...f.scope,workspaceId:randomUUID(),sourceMessageId:'fixture-attachment'}),null);
    const files=(await f.db.query('select * from invoice_files where invoice_id=$1',[rows[0].id])).rows;
    assert.equal(files.length,1);assert.equal(files[0].mime_type,mimeType);
    const downloaded=await f.supabase.storage.from('invoice-files').download(files[0].storage_path);
    assert.deepEqual(Buffer.from(await downloaded.data.arrayBuffer()),first.bytes);
    const replay=await f.turn('fixture-attachment',mimeType);
    assert.equal(replay.reply.replayed,true);assert.equal(f.extractions,1);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('owner attachment cannot create or read invoices for a forged conversation scope',async()=>{
  const f=await fixture();try{
    const reply=await f.handler({...f.scope,workspaceId:randomUUID(),message:'log this invoice',messageId:'forged',media:{bytes:Buffer.from('isolated'),mimeType:'image/jpeg'}});
    assert.equal(reply,'');assert.equal(f.extractions,0);assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,0);
  }finally{await f.close();}
});

test('committed invoice with lost insert acknowledgement is read back and completes once',async()=>{
  const f=await fixture({loseInsertAcknowledgement:true});try{
    const {reply}=await f.turn('interrupted-insert');
    assert.match(reply.answer,/Saved invoice/);assert.equal(f.results[0].completed,true);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
    assert.equal(f.extractions,1);
  }finally{await f.close();}
});

test('lost reply receipt reconciles consumed saved review without extracting or creating again',async()=>{
  const f=await fixture({loseReplyReceipt:true});try{
    assert.match((await f.turn('interrupted-reply')).reply.answer,/Saved invoice/);
    assert.match((await f.turn('interrupted-reply')).reply.answer,/Saved invoice/);
    assert.equal(f.extractions,1);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
  }finally{await f.close();}
});

test('consumed historical saved review recovers its legacy scoped key without a second invoice',async()=>{
  const f=await fixture({loseReplyReceipt:true});try{
    assert.match((await f.turn('legacy-saved-source')).reply.answer,/Saved invoice/);
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
    const receipt=await pending.loadSavedInvoiceReview({...f.scope,sourceMessageId:'legacy-saved-source'});
    const key=`wa_invoice_${createHash('sha256').update(`${f.scope.workspaceId}:${f.scope.phone}:${receipt.id}`).digest('hex').slice(0,32)}`;
    await f.db.query("update invoices set metadata=jsonb_set(metadata,'{assistant_idempotency_key}',to_jsonb($2::text)) where id=$1",[receipt.action.invoice.id,key]);
    assert.match((await f.turn('legacy-saved-source')).reply.answer,/Saved invoice/);
    assert.equal(f.extractions,1);assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
  }finally{await f.close();}
});

test('expired failed review cannot resume but a fresh attachment can replace it and save',async()=>{
  const f=await fixture();try{
    await f.db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,source,action,expires_at) values($1,$2,$3,'whatsapp',$4,now()-interval '1 minute')",
      [f.scope.workspaceId,f.scope.customerId,phone,{type:'invoice_review_draft',stage:'failed',sourceMessageId:'expired-source',invoice:{invoiceNumber:'STALE'}}]);
    const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
    assert.equal(await pending.loadInvoiceReview(f.scope),null);
    assert.match((await f.turn('fresh-retry')).reply.answer,/Saved invoice/);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal(f.extractions,1);
  }finally{await f.close();}
});

test('fresh upload of the same printed customer invoice refuses a duplicate through the real owner toolset',async()=>{
  const f=await fixture();try{
    assert.match((await f.turn('original-source')).reply.answer,/Saved invoice/);
    await f.turn('same-invoice-new-provider-id');
    const refusal=f.results.at(-1);
    assert.equal(refusal.ok,false);assert.equal(refusal.code,'DUPLICATE_INVOICE');
    assert.match(refusal.message,/already logged/);
    assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);
    assert.equal(f.extractions,2);
  }finally{await f.close();}
});
