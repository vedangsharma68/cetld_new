import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

function textPdf(lines) {
 const escape=text=>text.replace(/[\\()]/g,'\\$&');
 const stream=`BT /F1 10 Tf 40 760 Td 14 TL ${lines.map(text=>`(${escape(text)}) Tj T*`).join('\n')} ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];
 for(const [i,value] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;}
 const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 return Buffer.from(pdf);
}

for(const kind of ['paid-conflict-pdf','paid-image','paid-evidence-conflict-image','unsupported-unpaid-image','paid-zero-pdf','partial-pdf','paid-fallback-pdf','shipping-pdf'])test(`native attachment keeps ${kind} in review without invoice or payment writes`,async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550126';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Evidence fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const shipping=kind==='shipping-pdf',image=kind.endsWith('image'),evidenceConflict=kind==='paid-evidence-conflict-image',unsupported=kind==='unsupported-unpaid-image',partial=kind==='partial-pdf',zero=kind==='paid-zero-pdf',fallback=kind==='paid-fallback-pdf',total=shipping?123:118;
  const bytes=image?Buffer.from([255,216,255,0,0,0]):textPdf(['INVOICE','Invoice Number: EVIDENCE-118','Invoice Date: 2026-10-01','Due Date: 2026-10-31','FROM: Evidence fixture','BILL TO: Fixture customer',...(fallback?[]:['QTY DESCRIPTION UNIT PRICE AMOUNT','1 Service 100.00 100.00']),'Subtotal 100.00','Tax 18.00',...(shipping?['Shipping 5.00']:[partial?'PARTIALLY PAID':'PAID']),...(zero||partial?['Invoice Total 118.00',`Amount Due ${zero?'0':'50'}.00`]:[`Total Due ${total}.00`]),'Currency: USD']);
  const messageId='evidence-source',mimeType=image?'image/jpeg':'application/pdf',caption='Log this sample invoice. Do not send any customer reminders.';
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$1)",[messageId,phone,image?'image':'document',caption]);
  await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[messageId,mimeType,bytes,bytes.length]);
  const facts={invoiceNumber:'EVIDENCE-118',customerName:'Fixture customer',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:100,tax:18,total:118,outstandingAmount:118,currency:'USD',direction:'receivable',clientEmail:null,clientPhone:null,clientPhoneRaw:null,notes:null,paymentStatus:fallback?null:evidenceConflict||unsupported?'unpaid':'paid',paymentStatusEvidence:fallback||unsupported?null:'PAID watermark; Total Due USD 118'};
  const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItems:[{description:'Service',quantity:1,unitPrice:100,amount:100,confidence:.99}],lineItemsConfidence:.99};
  let requests=0,extractions=0,followup=false;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
   requests++;const body=JSON.parse(init.body);
   if(new URL(url).hostname==='generativelanguage.googleapis.com'){extractions++;return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});}
   assert.equal(new URL(url).hostname,'api.cloudflare.com');
   const result=body.messages.findLast(item=>item.role==='tool');
   if(!result)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'generic-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(followup?{operation:'confirm'}:{operation:'create',table:'invoices',values:{customer_name:'Invented',total_amount:1,currency:'USD'}})}}]}}]});
   return Response.json({choices:[{finish_reason:'stop',message:{content:followup?JSON.parse(result.content).message:'The invoice could not be logged due to temporary unavailability.'}}]});
  }});
  const input={workspaceId,ownerId,customerId,phone,messageId,message:caption,media:{bytes,mimeType,fileName:image?'fixture.jpg':'fixture.pdf'}};
  const reply=await handler(input);
  const review=(await db.query("select action from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'=$2",[workspaceId,messageId])).rows[0]?.action;
  assert.equal(review?.stage,'incomplete',JSON.stringify({review,reply}));
  assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));assert.match(reply.answer,/Nothing was saved/);assert.doesNotMatch(reply.answer,/unavailable|processing failed/i);
  if(shipping){assert.match(reply.answer,/breakdown/);assert.match(review.invoice.notes,/Shipping 5/);assert.equal(review.invoice.total,123);assert.equal(review.invoice.subtotal,100);assert.equal(review.invoice.lineItems.length,1);assert.ok(review.validationIssues.includes('INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX'));}
  else{assert.match(reply.answer,/payment|paid/i);assert.match(reply.answer,/outstanding|balance/i);assert.equal(review.paymentEvidence.status,partial?'partial':evidenceConflict?'conflicting':unsupported?'unpaid':'paid');if(!unsupported)assert.match(review.paymentEvidence.text,/PAID/);assert.ok(review.validationIssues.includes(zero||partial?'PAYMENT_RECORD_REQUIRES_REVIEW':unsupported?'UNCERTAIN_PAYMENT_STATUS':'PAYMENT_STATUS_CONFLICT'));assert.equal(review.invoice.alreadyPaid,false);assert.equal(review.invoice.total,118);assert.equal(review.invoice.outstanding,zero?0:partial?50:118);}
  const count=requests,replay=await handler(input);assert.equal(replay.replayed,true);assert.equal(replay.answer,reply.answer);assert.equal(requests,count);assert.equal(extractions,image||fallback?1:0);
  followup=true;await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values('evidence-confirm','fixture',$1,'text','yes','processing')",[phone]);
  const confirmation=await handler({workspaceId,ownerId,customerId,phone,messageId:'evidence-confirm',message:'yes'});assert.doesNotMatch(confirmation.answer,/saved invoice|payment recorded/i);
  for(const table of ['invoices','invoice_files','payments','payment_reversals','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])assert.equal((await db.query(`select count(*)::int n from ${table} where workspace_id=$1`,[workspaceId])).rows[0].n,0,table);
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
