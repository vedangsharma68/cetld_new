import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

const captions=[
  ['Log this sample invoice for testing. Do not send any customer reminders.','image/jpeg'],
  ['Log this sample invoice for testing. Do not send any customer reminders.','application/pdf'],
  ['Please save this invoice. No customer reminders.','image/jpeg'],
  ['Record the attached invoice, but do not send reminders.','application/pdf'],
  ['Add this bill; never send customer reminders.','image/jpeg'],
  ['Please save it. Do not send reminders.','image/jpeg'],
  ['Could you please save this invoice? No reminders.','image/jpeg'],
  ['Please could you log this invoice? No reminders.','image/jpeg'],
  ['Do not save this invoice. Just tell me its total.','image/jpeg',true],
];

for(const [caption,mimeType,declined=false] of captions)test(`default native attachment routing: ${mimeType} / ${caption}`,async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550123';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Cedar Studio',$1)).id",[randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
    assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const messageId='caption-source',bytes=mimeType==='application/pdf'
      ?await readFile(new URL('./fixtures/receivable_missing_due.pdf',import.meta.url)):Buffer.from([255,216,255,0,0,0]);
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'123456',$2,$3,$4,'processing',$1)",[messageId,phone,mimeType==='application/pdf'?'document':'image',caption]);
    await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[messageId,mimeType,bytes,bytes.length]);
    // Retain a terminal review and stale conversational context as in a real
    // owner conversation; neither may replace the current document's source.
    await db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,source,action,expires_at) values($1,$2,$3,'whatsapp',$4,now()-interval '1 minute')",[workspaceId,customerId,phone,{type:'invoice_review_draft',stage:'canceled',sourceMessageId:'old-source'}]);
    await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,$3,'outbound','owner','Deleted duplicate invoice INV-OLD.','normal','delivered','old-reply')",[workspaceId,customerId,phone]);
    const facts={invoiceNumber:'PRINTED-118',customerName:'Fixture customer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:100,tax:18,total:118,outstandingAmount:118,currency:'USD',clientPhone:null,clientPhoneRaw:null,clientEmail:null,notes:null,direction:'receivable',currencySource:null,addressHint:null,paymentTerms:null};
    if(mimeType==='application/pdf')Object.assign(facts,{invoiceNumber:'INV-R-1048',customerName:'Northlake Foods',invoiceDate:'2026-09-01',dueDate:null,currency:'INR'});
    const wire={...Object.fromEntries(Object.entries(facts).flatMap(([k,v])=>[[k,v],[k+'Confidence',v===null?0:.99]])),lineItems:[{description:'Service',quantity:1,unitPrice:100,amount:100,confidence:.99}],lineItemsConfidence:.99};
    const requests=[],results=[],logs=[];let firstContract=null;
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
      logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},fetchImpl:async(url,init)=>{
        const parsed=new URL(url),body=JSON.parse(init.body);requests.push(parsed.hostname);
        if(parsed.hostname==='generativelanguage.googleapis.com'){
          assert.ok(body.contents[0].parts.some(part=>mimeType==='application/pdf'?part.text?.includes('INV-R-1048'):part.inlineData?.mimeType===mimeType));
          return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});
        }
        assert.equal(parsed.hostname,'api.cloudflare.com');
        const tool=body.messages.findLast(item=>item.role==='tool');
        if(!firstContract)firstContract={choice:body.tool_choice,tools:body.tools};
        const result=tool?JSON.parse(tool.content):null;if(result)results.push(result);
        // Reproduce the generic invoice-create arguments, rather than script
        // the desired saveAttachment call. The server must bind the operation.
        const message=!result||result.code==='INVALID'&&requests.length<=6
          ?{content:'',tool_calls:[{id:`generic-${requests.length}`,type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,...(declined?{currency:'USD'}:{status:'unpaid'}),custom_fields:{},...(requests.length>3?{notes:'invented'}:{})}})}}]}
          :{content:result.completed?`Saved invoice ${result.review.invoice.invoiceNumber} for ${result.review.invoice.clientName}, ${result.review.invoice.currency} 118.`:'The sample invoice was not logged.'};
        return Response.json({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]});
      }});
    const input={workspaceId,ownerId,customerId,phone,messageId,message:caption,media:{bytes,mimeType,fileName:mimeType==='application/pdf'?'fixture.pdf':'fixture.jpg'}};
    const reply=await handler(input);
    assert.equal(reply.plannerFailure,undefined,JSON.stringify({reply,logs}));
    if(declined){
      assert.doesNotMatch(reply.answer,/Saved invoice/);assert.equal(firstContract.choice,'auto');
      assert.equal(results[0]?.validationCode,'ATTACHMENT_REVIEW_REQUIRED');assert.equal(results[0]?.writeAttempted,false);
      assert.equal(requests.filter(host=>host==='generativelanguage.googleapis.com').length,0);
      for(const table of ['invoices','invoice_files','payments','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])
        assert.equal((await db.query(`select count(*)::int n from ${table} where workspace_id=$1`,[workspaceId])).rows[0].n,0,table);
      assert.equal((await db.query("select count(*)::int n from whatsapp_pending_actions where workspace_id=$1 and action->>'stage'!='canceled'",[workspaceId])).rows[0].n,0);
      assert.equal((await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer'",[workspaceId])).rows[0].n,0);
      assert.deepEqual(f.errors,[]);return;
    }
    assert.match(reply.answer,/Saved invoice INV-2026-0001/);
    assert.equal(firstContract.choice,'required');assert.deepEqual(firstContract.tools.map(t=>t.function.name),['workspaceData']);
    assert.deepEqual(firstContract.tools[0].function.parameters.properties.operation.enum,['saveAttachment']);
    assert.equal(results[0]?.completed,true,JSON.stringify(results));
    assert.equal(logs.filter(row=>row.label==='WhatsApp owner tool call'&&row.data.validationCode==='INVALID_FIELDS').length,0);
    const invoice=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows;
    assert.equal(invoice.length,1);assert.equal(Number(invoice[0].total_amount),118);assert.equal(Number(invoice[0].amount_paid),0);
    assert.notEqual(invoice[0].invoice_number,'INVENTED');assert.equal(invoice[0].metadata.printed_invoice_number,mimeType==='application/pdf'?'INV-R-1048':'PRINTED-118');
    assert.equal((await db.query('select count(*)::int n from invoice_files where workspace_id=$1',[workspaceId])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'=$2 and action->>'stage'='saved'",[workspaceId,messageId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from payments where workspace_id=$1',[workspaceId])).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer'",[workspaceId])).rows[0].n,0);
    assert.equal(requests.filter(host=>host==='generativelanguage.googleapis.com').length,1);
    const count=requests.length,replay=await handler(input);assert.equal(replay.replayed,true);assert.equal(replay.answer,reply.answer);assert.equal(requests.length,count);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
