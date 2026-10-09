import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';

test('failed extraction is closed safely and a fresh JPEG retries through the real owner handler',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550174';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Disposable attachment fixture',$1)).id",[randomUUID()])).rows[0].id;
    const challenge=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,challenge.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const scope={workspaceId,ownerId,customerId,phone};
    const facts={invoiceNumber:'SAFE-RETRY-118',customerName:'Fixture buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',
      subtotal:100,tax:18,total:118,outstandingAmount:118,currency:'USD',direction:'receivable',clientEmail:null,clientPhone:null,
      clientPhoneRaw:null,notes:null,paymentTerms:'Net 30',currencySource:null,addressHint:null,paymentStatus:null,paymentStatusEvidence:null,
      lineItems:[{description:'Fixture service',quantity:1,unitPrice:100,amount:100,confidence:.99}]};
    const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItemsConfidence:.99};
    let extractionCalls=0;const toolResults=[];
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:options=>options.requestPurpose==='extraction'?{async generateStructured(call){
        extractionCalls++;
        if(extractionCalls===1)throw new Error('isolated structured extraction unavailable');
        return {data:call.validate(structuredClone(wire)),model:'fixture-structured-transport'};
      }}:{async generate({messages}){
        const prior=messages.findLast(message=>message.role==='tool');
        if(!prior)return {model:'fixture-chat',toolCalls:[{id:'attachment-save',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({
          operation:'create',table:'invoices',values:{total_amount:1}})}}]};
        const result=JSON.parse(prior.content);toolResults.push(result);
        return {model:'fixture-chat',content:result.completed?`Saved invoice ${result.review.invoice.invoiceNumber} for Fixture buyer, USD 118.`
          :result.ok===false?`The invoice was not saved: ${result.message||result.code}. Nothing was saved.`:'Invoice review is required. Nothing was saved.'};
      }}});
    const turn=async(id)=>{
      const bytes=Buffer.from([255,216,255,217,0,1,2]);
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,'image','Log this sample invoice. No customer reminders.','processing',$1)",[id,phone]);
      await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner','Log this sample invoice. No customer reminders.','text','received',$4,$4)",[workspaceId,customerId,phone,id]);
      await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,\'image/jpeg\',$2,$3)',[id,bytes,bytes.length]);
      return {reply:await handler({...scope,messageId:id,message:'Log this sample invoice. No customer reminders.',media:{bytes,mimeType:'image/jpeg',fileName:'fixture.jpg'}}),bytes};
    };

    const failed=await turn('failed-source');
    assert.match(failed.reply.answer,/extraction service is unavailable|resend the attachment/i,JSON.stringify(failed.reply));
    assert.equal(extractionCalls,1);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from invoice_files')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    const pending=createWhatsAppPendingActionStore({supabase}),failedAction=await pending.loadInvoiceReview(scope);
    assert.equal(failedAction.action.stage,'canceled');
    assert.equal(failedAction.action.failureCode,'EXTRACTION_UNAVAILABLE');

    const retried=await turn('fresh-retry-source');
    assert.match(retried.reply.answer,/Saved invoice INV-2026-0001/,JSON.stringify({reply:retried.reply,extractionCalls,errors:f.errors,toolResults}));
    assert.equal(extractionCalls,2);
    const invoices=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows;
    assert.equal(invoices.length,1);assert.equal(Number(invoices[0].total_amount),118);assert.equal(invoices[0].currency,'USD');
    assert.equal(invoices[0].metadata.printed_invoice_number,'SAFE-RETRY-118');
    const files=(await db.query('select * from invoice_files where workspace_id=$1',[workspaceId])).rows;
    assert.equal(files.length,1);assert.equal(files[0].mime_type,'image/jpeg');
    const downloaded=await supabase.storage.from('invoice-files').download(files[0].storage_path);
    assert.deepEqual(Buffer.from(await downloaded.data.arrayBuffer()),retried.bytes);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
