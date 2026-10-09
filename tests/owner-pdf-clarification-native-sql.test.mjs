import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

const caption='Log this public sample invoice for testing. Keep customer messages and reminders off.';
const clarification='My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders.';
const migration='20261009031935_invoice_review_nonzero_inferred_currency_correction.sql';
const generalMigration='20261009040005_invoice_review_general_inferred_currency_correction.sql';
const readQuestions=['Can you check if the currency is AUD?','Tell me if the currency is AUD','I want to know whether the currency is AUD'];

function textPdf(lines){
 const escape=text=>text.replace(/[\\()]/g,'\\$&');
 const stream=`BT /F1 10 Tf 40 760 Td 14 TL ${lines.map(text=>`(${escape(text)}) Tj T*`).join('\n')} ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[];
 for(const [i,value]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;}
 const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 return Buffer.from(pdf);
}

async function fixture({oldSql=false,transform=null,currency='AUD',currencyEvidence='Melbourne, VIC 3000',beforeGeneral=false}={}){
 const f=await createOfflineSqlNetwork(oldSql?{excludeMigrations:[migration,generalMigration]}:beforeGeneral?{excludeMigrations:[generalMigration]}:{}),{db,supabase}=f;
 const ownerId=randomUUID(),phone='+15555550314';
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (public.create_workspace('PDF clarification fixture',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 const scope={workspaceId,ownerId,customerId,phone};
 // Synthetic selectable PDF reproduces the reported facts and printed stamp;
 // the original public PDF is not included in this repository.
 const location={INR:'Mumbai, India',USD:'New York, NY 10001',EUR:'Berlin, Germany',GBP:'London, United Kingdom',AED:'Dubai, UAE',SGD:'Singapore',AUD:'Melbourne, VIC 3000',CAD:'Toronto, Canada',CHF:'Zurich, Switzerland'}[currency];
 const bytes=textPdf(['INVOICE','INV-3337','Test Business',location,'Date 25 January 2016','Due 31 January 2016','Web Design $85.00','Subtotal $85.00','Tax $8.50','Total $93.50','PAID']);
 const facts={invoiceNumber:'INV-3337',customerName:'Test Business',invoiceDate:'2016-01-25',dueDate:'2016-01-31',
  subtotal:85,tax:8.5,total:93.5,outstandingAmount:93.5,currency,direction:'uncertain',clientEmail:'test@test.com',
  clientPhone:null,clientPhoneRaw:null,notes:null,currencySource:currencyEvidence,paymentStatus:'paid',paymentStatusEvidence:'Paid'};
 const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),
  lineItems:[{description:'Web Design',quantity:1,unitPrice:85,amount:85,confidence:.99}],lineItemsConfidence:.99};
 const calls=[],executions=[],outputs=[];let confirming=false;
 const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},
  toolsFactory:options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,async execute(name,args,context){executions.push({name,args});const result=await tools.execute(name,args,context);outputs.push(result);return transform?transform(result,args):result;}};
  },fetchImpl:async(url,init)=>{
   const body=JSON.parse(init.body),host=new URL(url).hostname;calls.push({host,body});
   if(host==='generativelanguage.googleapis.com'){
    assert.equal(body.generationConfig.responseMimeType,'application/json');
    assert.ok(body.contents.flatMap(item=>item.parts||[]).some(part=>part.text?.includes('INV-3337')));
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});
   }
   assert.equal(host,'api.cloudflare.com');assert.equal(body.model,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
   const tool=body.messages.findLast(item=>item.role==='tool');
   const readQuestion=body.messages.some(item=>item.role==='user'&&readQuestions.includes(item.content));
   if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'native-malformed-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(confirming?{operation:'confirm'}:
    readQuestion?{operation:'pending'}:{operation:'create',table:'invoices',values:{amount:93.5,currency:'USD',issue_date:'2016-01-25',due_date:'2016-01-31',subtotal:85,tax:8.5,total_amount:93.5,line_items:[],unsupported:'synthetic invalid field'}})}}]}}]});
   const result=JSON.parse(tool.content);
   if(readQuestion)return Response.json({choices:[{finish_reason:'stop',message:{content:`The retained invoice currency is ${result.invoice.currency}. It remains in review. Nothing was saved.`}}]});
   return Response.json({choices:[{finish_reason:'stop',message:{content:result.completed?'Saved invoice INV-2026-0001 for Test Business, USD 93.50.':result.message||'I could not log this invoice. Nothing was saved.'}}]});
  }});
 const persist=async(id,message,media=false)=>{
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",[id,phone,media?'document':'text',message,media?id:null]);
  // The actual cloud worker persists owner messages with NULL customer_id.
  await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,null,$2,'inbound','owner',$3,$4,'received',$5,$5)",[workspaceId,phone,message,media?'document':'text',id]);
  if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,'application/pdf',bytes,bytes.length]);
 };
 const turn=async(id,message,media=false)=>{confirming=message==='yes';await persist(id,message,media);return handler({...scope,messageId:id,message,...(media?{media:{bytes,mimeType:'application/pdf',fileName:'fixture.pdf'}}:{})});};
 const review=async()=>(await db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='pdf-source' order by id desc limit 1",[workspaceId])).rows[0];
 const ledger=async()=>(await db.query(`select jsonb_build_object('invoices',(select coalesce(jsonb_agg(to_jsonb(i)),'[]') from invoices i),'payments',(select count(*) from payments),'files',(select count(*) from invoice_files),'reversals',(select count(*) from payment_reversals),'owner_receipts',(select count(*) from whatsapp_owner_action_receipts),'direct_receipts',(select count(*) from whatsapp_direct_write_receipts),'customer_outbound',(select count(*) from whatsapp_messages where audience='customer' and direction='outbound')) value`)).rows[0].value;
 const first=await turn('pdf-source',caption,true),draft=await review();
 assert.equal(draft.action.stage,'incomplete',JSON.stringify({first,draft,errors:f.errors}));assert.deepEqual(draft.action.validationIssues,['PAYMENT_STATUS_CONFLICT']);
 assert.equal(draft.action.invoice.total,93.5);assert.equal(draft.action.invoice.outstanding,93.5);assert.equal(draft.action.invoice.currency,currency);assert.deepEqual(draft.action.missingFields,['direction']);
 return {...f,scope,bytes,turn,persist,handler,review,ledger,calls,executions,outputs};
}

test('event254 PDF wording takes real scoped review path before Cloudflare and saves only on a later confirmation',async()=>{
 const f=await fixture();try{
  const before=await f.ledger(),draft=await f.review(),callCount=f.calls.length,executionCount=f.executions.length;
  const reply=await f.turn('pdf-correction',clarification),proposal=await f.review();
  assert.equal(f.calls.length,callCount,JSON.stringify({reply,outputs:f.outputs}));
  assert.deepEqual(f.executions.slice(executionCount).map(x=>x.args),[{operation:'reviewAttachment',table:'invoices',values:{currency:'USD',invoice_direction:'receivable'}}]);
  assert.equal(proposal.id,draft.id);assert.equal(proposal.version,draft.version+1);assert.equal(proposal.action.stage,'proposal');
  assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.direction,'receivable');assert.equal(proposal.action.invoice.total,93.5);assert.equal(proposal.action.invoice.outstanding,93.5);
  assert.equal(proposal.action.invoice.subtotal,85);assert.equal(proposal.action.invoice.tax,8.5);assert.equal(proposal.action.invoice.alreadyPaid,false);
  assert.deepEqual(proposal.action.paymentEvidence,draft.action.paymentEvidence);assert.equal(proposal.action.sourceMessageId,'pdf-source');
  assert.deepEqual(proposal.action.paymentStatusResolution.extractedFacts.invoice,draft.action.invoice);assert.equal(proposal.action.paymentStatusResolution.ownerInstruction,clarification);
  assert.match(reply.answer,/INV-3337/);assert.match(reply.answer,/Test Business/);assert.match(reply.answer,/USD 93\.50/);assert.match(reply.answer,/reply yes/i);assert.match(reply.answer,/Nothing was saved/);
  assert.deepEqual(await f.ledger(),before);
  const replay=await f.handler({...f.scope,messageId:'pdf-correction',message:clarification});assert.equal(replay.replayed,true);assert.deepEqual(await f.review(),proposal);assert.equal(f.calls.length,callCount);
  const saved=await f.turn('pdf-confirm','yes');assert.match(saved.answer,/Saved invoice INV-2026-0001/);
  const ledger=await f.ledger();assert.equal(ledger.invoices.length,1);const invoice=ledger.invoices[0];
  assert.equal(Number(invoice.total_amount),93.5);assert.equal(Number(invoice.amount_paid),0);assert.equal(invoice.currency,'USD');assert.equal(invoice.status,'draft');
  assert.equal(invoice.metadata.printed_invoice_number,'INV-3337');assert.equal(invoice.metadata.followup_state,'draft');assert.equal(invoice.metadata.next_follow_up_at,null);
  assert.equal(ledger.payments,0);assert.equal(ledger.reversals,0);assert.equal(ledger.customer_outbound,0);assert.equal(ledger.files,1);
  const file=(await f.db.query('select * from invoice_files where invoice_id=$1',[invoice.id])).rows[0];assert.equal(file.mime_type,'application/pdf');
  const stored=await f.supabase.storage.from('invoice-files').download(file.storage_path);assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),f.bytes);
  const calls=f.calls.length;assert.equal((await f.handler({...f.scope,messageId:'pdf-confirm',message:'yes'})).replayed,true);assert.equal(f.calls.length,calls);assert.deepEqual(await f.ledger(),ledger);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('ordinary composed CHF correction uses the same review and preserves all printed arithmetic',async()=>{
 const f=await fixture();try{
  const before=await f.ledger(),calls=f.calls.length;
  const message='Our business issued the invoice; the paid watermark is wrong; nothing has been paid; the currency is CHF; the full CHF 93.50 is still due; please save the invoice as an unpaid draft; keep customer messages or reminders off.';
  const reply=await f.turn('ordinary-correction',message),review=await f.review();
  assert.equal(f.calls.length,calls);assert.equal(review.action.stage,'proposal',JSON.stringify({review,reply,outputs:f.outputs}));assert.equal(review.action.invoice.currency,'CHF');
  assert.equal(review.action.invoice.subtotal,85);assert.equal(review.action.invoice.tax,8.5);assert.equal(review.action.invoice.total,93.5);assert.match(reply.answer,/CHF 93\.50/);assert.deepEqual(await f.ledger(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const [currency,currencyEvidence] of [
 ['INR','Indian details'],['USD','US address or phone details'],['EUR','European details'],['GBP','UK details'],
 ['AED','UAE details'],['SGD','Singapore details'],['CAD','Canadian details'],['CHF','Swiss details'],
 ['GBP','inferred GBP based on address'],
])test(`native retained ${currency} inference (${currencyEvidence}) stages current owner currency facts before separate confirmation`,async()=>{
 const f=await fixture({currency,currencyEvidence});try{
  const draft=await f.review(),before=await f.ledger(),calls=f.calls.length,executions=f.executions.length;
  const corrected=currency==='USD'?'CHF':'USD',message=clarification.replaceAll('USD',corrected);
  const reply=await f.turn('general-currency-correction',message),proposal=await f.review();
  assert.equal(f.calls.length,calls,JSON.stringify({reply,outputs:f.outputs}));
  assert.deepEqual(f.executions.slice(executions).map(x=>x.args),[{operation:'reviewAttachment',table:'invoices',values:{currency:corrected,invoice_direction:'receivable'}}]);
  assert.equal(proposal.action.stage,'proposal');assert.equal(proposal.action.invoice.currency,corrected);assert.equal(proposal.action.invoice.direction,'receivable');
  assert.deepEqual(Object.fromEntries(Object.entries(proposal.action.invoice).filter(([key])=>!['currency','direction'].includes(key))),Object.fromEntries(Object.entries(draft.action.invoice).filter(([key])=>!['currency','direction'].includes(key))));
  assert.deepEqual(proposal.action.paymentStatusResolution.extractedFacts.invoice,draft.action.invoice);
  assert.equal(proposal.action.paymentStatusResolution.extractedFacts.currencyEvidence,currencyEvidence);assert.equal(proposal.action.sourceMessageId,'pdf-source');
  assert.match(reply.answer,new RegExp(corrected+' 93\\.50'));assert.match(reply.answer,/Nothing was saved/);assert.deepEqual(await f.ledger(),before);
  assert.equal((await f.handler({...f.scope,messageId:'general-currency-correction',message})).replayed,true);assert.deepEqual(await f.review(),proposal);
  if(currency==='CAD'){
   await f.turn('general-currency-confirm','yes');const ledger=await f.ledger();
   assert.equal(ledger.invoices.length,1);assert.equal(ledger.invoices[0].currency,'USD');assert.equal(ledger.invoices[0].status,'draft');
   assert.equal(Number(ledger.invoices[0].amount_paid),0);assert.equal(ledger.payments,0);assert.equal(ledger.customer_outbound,0);assert.equal(ledger.files,1);
   const file=(await f.db.query('select * from invoice_files where invoice_id=$1',[ledger.invoices[0].id])).rows[0];
   const stored=await f.supabase.storage.from('invoice-files').download(file.storage_path);assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),f.bytes);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const [currency,currencyEvidence] of [['GBP','printed currency code GBP'],['EUR','€ symbol'],['CAD','ambiguous $ symbol; assumed CAD'],['INR','currency not shown; assumed workspace default INR'],['GBP','printed GBP code and inferred USD based on address'],['CAD','unknown location']])
test(`native correction rejects printed or ambiguous ${currency} provenance (${currencyEvidence})`,async()=>{
 const f=await fixture({currency,currencyEvidence});try{
  const draft=await f.review(),before=await f.ledger(),calls=f.calls.length;
  const reply=await f.turn('invalid-currency-provenance',clarification);
  assert.equal(f.calls.length,calls);assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);
  assert.doesNotMatch(reply.answer,/Reply yes|saved invoice|Proposed/i);assert.match(reply.answer,/Nothing was saved/);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('superseded AUD-only SQL refuses another inferred currency without generic invoice creation',async()=>{
 const f=await fixture({currency:'CAD',currencyEvidence:'Canadian details',beforeGeneral:true});try{
  const draft=await f.review(),before=await f.ledger(),calls=f.calls.length;
  const reply=await f.turn('old-inferred-correction',clarification);
  assert.equal(f.calls.length,calls);assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);
  assert.match(reply.answer,/Nothing was saved/);assert.doesNotMatch(reply.answer,/Reply yes|saved invoice|Proposed/i);
 }finally{await f.close();}
});

test('old deployed SQL rejects the nonzero currency correction with grounded no-save reply and no fallback',async()=>{
 const f=await fixture({oldSql:true});try{
  const before=await f.ledger(),draft=await f.review(),calls=f.calls.length;
  const reply=await f.turn('old-sql-correction',clarification);
  assert.equal(f.calls.length,calls);assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);
  assert.match(reply.answer,/correction could not be recorded/i);assert.match(reply.answer,/Nothing was saved/);assert.doesNotMatch(reply.answer,/reply yes|saved invoice/i);
  assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/invoice review/);
 }finally{await f.close();}
});

test('contradictory, quoted and extra-directive corrections leave retained review intact without native creation',async()=>{
 const f=await fixture();try{
  const before=await f.ledger(),draft=await f.review(),calls=f.calls.length;
  for(const [index,message]of [clarification+' We received USD 10.',clarification+' Also send the customer a reminder.',`Someone said "${clarification}"`,clarification.replace('full USD 93.50','full USD 94.50')].entries()){
   const reply=await f.turn('invalid-correction-'+index,message);
   assert.equal(f.calls.length,calls,JSON.stringify({message,reply,outputs:f.outputs}));assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);
   assert.match(reply.answer,/Nothing was saved/);assert.doesNotMatch(reply.answer,/reply yes|saved invoice/i);
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('forged owner scope cannot consume the PDF review or reach a provider',async()=>{
 const f=await fixture();try{
  const before=await f.ledger(),draft=await f.review(),calls=f.calls.length;
  const reply=await f.handler({...f.scope,workspaceId:randomUUID(),messageId:'foreign-correction',message:clarification});
  assert.equal(reply,'');assert.equal(f.calls.length,calls);assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('lost SQL acknowledgement resumes as uncertain without reissuing the retained review transition',async()=>{
 const f=await fixture({transform:(result,args)=>{
  if(args.operation==='reviewAttachment')throw Object.assign(new Error('lost transition acknowledgement'),{code:'OWNER_LOOP_TIMEOUT'});
  return result;
 }});try{
  const before=await f.ledger(),calls=f.calls.length;await f.persist('interrupted-correction',clarification);
  const scope={...f.scope,messageId:'interrupted-correction',message:clarification,allowDeferred:true};
  const interrupted=await f.handler(scope);assert.equal(interrupted.deferred,true,JSON.stringify(interrupted));
  const proposal=await f.review();assert.equal(proposal.action.stage,'proposal');assert.equal(proposal.action.invoice.currency,'USD');
  assert.equal(interrupted.checkpoint.boundedReviewSelected,true);assert.equal(interrupted.checkpoint.uncertainWrite,'owner-retained-review');
  const resumed=await f.handler({...scope,checkpoint:interrupted.checkpoint});
  assert.match(resumed.answer,/interrupted|uncertain/i);assert.doesNotMatch(resumed.answer,/reply yes|saved invoice/i);
  assert.equal(f.calls.length,calls);assert.equal(f.executions.filter(x=>x.args.operation==='reviewAttachment').length,1);
  assert.deepEqual(await f.review(),proposal);assert.deepEqual(await f.ledger(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a currency question retains ordinary native read-only answering and never becomes a correction',async()=>{
 const f=await fixture();try{
  const before=await f.ledger(),draft=await f.review();
  for(const [index,message]of readQuestions.entries()){
   const calls=f.calls.length,executions=f.executions.length,reply=await f.turn('currency-question-'+index,message);
   assert.ok(f.calls.length>calls,'a read-only question must not be replaced with the correction refusal');
   assert.deepEqual(f.executions.slice(executions).map(x=>x.args),[{operation:'pending'}]);
   assert.match(reply.answer,/currency is AUD/);assert.doesNotMatch(reply.answer,/reply yes/i);assert.deepEqual(await f.review(),draft);assert.deepEqual(await f.ledger(),before);assert.deepEqual(f.errors,[]);
  }
 }finally{await f.close();}
});
