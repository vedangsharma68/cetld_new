import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';

const phone='+919871367051';
async function fixture({clientPhone=null,loseInsertAcknowledgement=false,loseReplyReceipt=false}={}){
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
      attachmentIngestFactory:input=>createWhatsAppBoundMessageHandler({...input,extract:async()=>{extractions++;return structuredClone(extracted);}})}),
    providerFactory:()=>({async generate({messages,tools,toolChoice}){
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
    const bytes=Buffer.from('isolated invoice source '+mimeType);
    await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,$3,'log this invoice','processing') on conflict(provider_message_id) do nothing",[id,phone,mimeType==='application/pdf'?'document':'image']);
    return {reply:await handler({...scope,message:'log this invoice',messageId:id,media:{bytes,mimeType,fileName:mimeType==='application/pdf'?'fixture.pdf':'fixture.jpg'}}),bytes};
  }
  return {...f,scope,handler,turn,results,get extractions(){return extractions;}};
}

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
