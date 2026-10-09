import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

test('native owner attachment retains currency/direction ambiguity and clarifies the same SQL review before a later save',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550125';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Clarification fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const facts={invoiceNumber:'PRINTED-118',customerName:'Fixture customer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:100,tax:18,total:118,outstandingAmount:118,currency:null,direction:'payable',clientPhone:null,clientPhoneRaw:null,clientEmail:null,notes:'Payment due within 30 days.',currencySource:null,addressHint:null,paymentTerms:null};
  const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItems:[{description:'Service',quantity:1,unitPrice:100,amount:100,confidence:.99}],lineItemsConfidence:.99};
  const bytes=Buffer.from([255,216,255,0,0,0]),results=[],contracts=[];let currentTurn=0,providerCalls=0,extractions=0;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
   providerCalls++;const body=JSON.parse(init.body);
   if(new URL(url).hostname==='generativelanguage.googleapis.com'){extractions++;return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});}
   assert.equal(new URL(url).hostname,'api.cloudflare.com');const tool=body.messages.findLast(item=>item.role==='tool');
   if(!tool){contracts.push(body.tools);return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'misrouted-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(currentTurn===3?{operation:'confirm'}:{operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD',status:'unpaid'}})}}]}}]});}
   const result=JSON.parse(tool.content);results.push(result);
   const record=result.review?.invoice||result;
   const answer=result.completed?`Saved invoice ${record.invoiceNumber} for Fixture customer, USD 118.`
    :result.requiresLaterConfirmation?'Invoice PRINTED-118 for Fixture customer, USD 118. Reply yes to save it, or cancel.'
    :'The sample invoice cannot be logged due to missing required fields such as currency and direction.';
   return Response.json({choices:[{finish_reason:'stop',message:{content:answer}}]});
  }});
  const turn=async(id,message,media)=>{
   currentTurn++;await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",[id,phone,media?'image':'text',message,media?id:null]);
   await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,customerId,phone,message,id]);
   if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,media.mimeType,bytes,bytes.length]);
   return handler({workspaceId,ownerId,customerId,phone,messageId:id,message,...(media?{media}:{})});
  };
  const first=await turn('ambiguous-source','Log this sample invoice for testing. Do not send any customer reminders.',{bytes,mimeType:'image/jpeg',fileName:'fixture.jpg'});
  const review=async()=>(await db.query("select id,version,action from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='ambiguous-source' order by created_at desc limit 1",[workspaceId])).rows[0];
  const draft=await review();assert.equal(draft.action.stage,'incomplete');assert.deepEqual(draft.action.missingFields.sort(),['currency','direction']);assert.equal(draft.action.invoice.currency,null);assert.equal(draft.action.invoice.direction,'payable');assert.equal(draft.action.invoice.total,118);
  assert.match(first.answer,/confirm.*currency/i);assert.match(first.answer,/issued/i);assert.match(first.answer,/Nothing was saved/);
  const callsBeforeClarification=providerCalls;
  const clarified=await turn('clarify-source','Use USD. This is a receivable from Fixture customer, and it is unpaid. Log it without sending any customer reminders.');
  const proposal=await review();assert.equal(proposal.id,draft.id);assert.equal(proposal.action.stage,'proposal',JSON.stringify({proposal,results,clarified,errors:f.errors}));assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.direction,'receivable');assert.equal(proposal.action.invoice.total,118);assert.equal(proposal.action.invoice.clientName,'Fixture customer');assert.equal(extractions,1);
  assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);assert.match(clarified.answer,/reply yes/i);
  assert.equal(providerCalls,callsBeforeClarification,'the retained review continues before native planning');
  const savedReply=await turn('confirm-source','yes');assert.match(savedReply.answer,/Saved invoice INV-2026-0001/);
  const saved=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows;assert.equal(saved.length,1);assert.equal(Number(saved[0].total_amount),118);assert.equal(Number(saved[0].amount_paid),0);assert.equal(saved[0].currency,'USD');assert.equal(saved[0].metadata.printed_invoice_number,'PRINTED-118');assert.equal(saved[0].metadata.invoice_direction,'receivable');
  assert.equal((await db.query('select count(*)::int n from invoice_files where workspace_id=$1',[workspaceId])).rows[0].n,1);
  const calls=providerCalls,replay=await handler({workspaceId,ownerId,customerId,phone,messageId:'confirm-source',message:'yes'});assert.equal(replay.replayed,true);assert.equal(providerCalls,calls);assert.equal(extractions,1);
  const routine=async()=>(await db.query("select proowner,proacl,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const routineBefore=await routine();
  await db.exec(await readFile(new URL('../supabase/migrations/20261007193000_invoice_review_json_expression_precedence.sql',import.meta.url),'utf8'));
  assert.deepEqual(await routine(),routineBefore,'reapplying the narrow migration preserves routine security, grants and definition');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
