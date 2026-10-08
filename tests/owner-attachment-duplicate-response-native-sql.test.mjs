import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';

async function fixture({badDuplicateReply=false,storeWrap=store=>store}={}){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550128';
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (public.create_workspace('Duplicate fixture',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 const scope={workspaceId,ownerId,customerId,phone};
 const facts={invoiceNumber:'SB-10442',customerName:'Northwind Systems LLC',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:879,tax:72.52,total:951.52,outstandingAmount:951.52,currency:'USD',direction:'payable',clientPhone:null,clientPhoneRaw:null,clientEmail:null,notes:'Net 30',currencySource:'photo',addressHint:null,paymentTerms:null,paymentStatus:null,paymentStatusEvidence:null};
 const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItems:[{description:'Service',quantity:1,unitPrice:879,amount:879,confidence:.99}],lineItemsConfidence:.99};
 const bytes=Buffer.from([255,216,255,0,0,0]),results=[];let current='',providerCalls=0,extractions=0;
 const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
  invoiceStoreFactory:verified=>storeWrap(createWhatsAppInvoiceStore({supabase,...verified,audience:'owner'})),logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
   providerCalls++;const body=JSON.parse(init.body);
   if(new URL(url).hostname==='api.cloudflare.com')return Response.json({error:{message:'isolated primary unavailable'}},{status:503});
   assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
   const native=parts=>Response.json({candidates:[{content:{role:'model',parts},finishReason:'STOP'}]});
   if(body.generationConfig?.responseMimeType==='application/json'){extractions++;return native([{text:JSON.stringify(wire)}]);}
   const tool=body.contents.flatMap(item=>item.parts||[]).findLast(part=>part.functionResponse)?.functionResponse;
   if(!tool)return native([{functionCall:{name:'workspaceData',args:current==='yes'?{operation:'confirm'}:current.includes('my business issued')?{operation:'reviewAttachment',table:'invoices',values:{invoice_direction:'receivable'}}:{operation:'create',table:'invoices',values:{customer_name:'Invented',total_amount:1,currency:'USD'}}},thoughtSignature:'fixture-native-signature'}]);
   const result=tool.response;results.push(result);
   const answer=result.code==='DUPLICATE_INVOICE'?(badDuplicateReply?'Saved invoice INV-2026-9999.':result.message)
    :result.completed?`Saved invoice ${result.invoiceNumber||result.review?.invoice?.invoiceNumber} for Northwind Systems LLC, USD 951.52.`
    :result.requiresLaterConfirmation?'Invoice SB-10442 for Northwind Systems LLC, USD 951.52. Reply yes to save it, or cancel.'
    :result.ok===false?'The invoice save could not be verified yet. Please check its status before retrying.'
    :'Please confirm that your business issued this invoice. Nothing was saved.';
   return native([{text:answer}]);
  }});
 const turn=async(id,message,media=false)=>{
  current=message;
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",[id,phone,media?'image':'text',message,media?id:null]);
  await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,customerId,phone,message,id]);
  if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,'image/jpeg',bytes,bytes.length]);
  return handler({...scope,messageId:id,message,...(media?{media:{bytes,mimeType:'image/jpeg',fileName:'fixture.jpg'}}:{})});
 };
 const upload=async(prefix)=>{
  await turn(prefix+'-source','Log this new sample invoice as an unpaid USD receivable issued by my business to Northwind Systems LLC. This is a test; do not send any customer reminders.',true);
  const clarify=await turn(prefix+'-issuer','Yes, my business issued invoice SB-10442 to Northwind Systems LLC. It is a receivable. Save this test invoice with customer reminders off.');
  assert.match(clarify.answer,/reply yes/i,JSON.stringify({clarify,results,errors:f.errors}));
  return turn(prefix+'-confirm','yes');
 };
 return {...f,scope,handler,turn,upload,results,get providerCalls(){return providerCalls;},get extractions(){return extractions;}};
}

for(const badDuplicateReply of [false,true])test(`native default owner duplicate ${badDuplicateReply?'repairs a false success':'reports the verified rejection'} without saving or changing the original`,async()=>{
 const f=await fixture({badDuplicateReply});try{
  assert.match((await f.upload('original')).answer,/Saved invoice INV-2026-0001/);
  const before=(await f.db.query('select to_jsonb(i) value from invoices i where workspace_id=$1',[f.scope.workspaceId])).rows[0].value;
  assert.equal(before.metadata.printed_invoice_number,'SB-10442');assert.notEqual(before.invoice_number,'SB-10442');
  const duplicate=await f.upload('duplicate');
  assert.equal(duplicate.plannerFailure,undefined,JSON.stringify(duplicate));assert.match(duplicate.answer,/already logged/);assert.match(duplicate.answer,/INV-2026-0001/);assert.match(duplicate.answer,/SB-10442/);assert.match(duplicate.answer,/No new invoice was saved/);assert.doesNotMatch(duplicate.answer,/Saved invoice|INV-2026-9999|reply yes|may have saved/i);
  if(badDuplicateReply)assert.ok(duplicate.agentDiagnostics.safetyRejects.includes('attachment_duplicate_status'),'false success drafts must be rejected before the grounded fallback');
  const result=f.results.findLast(value=>value.code==='DUPLICATE_INVOICE');assert.equal(result.ok,false);assert.equal(result.completed,undefined);assert.equal(result.invoiceCreated,false);assert.equal(result.outcome,'duplicate_rejected');assert.equal(result.existingInvoice.invoiceNumber,before.invoice_number);
  const after=(await f.db.query('select to_jsonb(i) value from invoices i where workspace_id=$1',[f.scope.workspaceId])).rows;assert.equal(after.length,1);assert.deepEqual(after[0].value,before);
  const failed=(await f.db.query("select action from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='duplicate-source'",[f.scope.workspaceId])).rows[0].action;assert.equal(failed.stage,'failed');assert.equal(failed.failureCode,'DUPLICATE_INVOICE');
  assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);assert.equal((await f.db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.equal(f.extractions,2);
  const calls=f.providerCalls,replay=await f.handler({...f.scope,messageId:'duplicate-confirm',message:'yes'});assert.equal(replay.replayed,true);assert.equal(replay.answer,duplicate.answer);assert.equal(f.providerCalls,calls);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('known duplicate with unavailable identity readback reports the rejection without inventing an original number',async()=>{
 const f=await fixture({storeWrap:store=>({...store,async findDuplicateSourceInvoice(){throw Error('isolated identity read unavailable');}})});try{
  await f.upload('original');const before=(await f.db.query('select to_jsonb(i) value from invoices i')).rows;
  const reply=await f.upload('duplicate');assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));assert.match(reply.answer,/rejected as a duplicate/);assert.match(reply.answer,/No new invoice was saved/);assert.match(reply.answer,/details could not be verified/);assert.doesNotMatch(reply.answer,/INV-2026-|Saved invoice|reply yes/);
  assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i')).rows,before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('ambiguous historical source identities remain untouched and do not pick an original invoice arbitrarily',async()=>{
 const f=await fixture();try{
  await f.upload('original');const original=(await f.db.query('select * from invoices')).rows[0];
  const otherCustomer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Different customer') returning id",[f.scope.workspaceId])).rows[0].id;
  await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,metadata) values($1,$2,'OTHER-CUSTOMER','2026-10-01','2026-10-31','USD',20,$3)",[f.scope.workspaceId,otherCustomer,{printed_invoice_number:'SB-10442'}]);
  const store=createWhatsAppInvoiceStore({supabase:f.supabase,...f.scope,audience:'owner',authorize:async()=>true});
  assert.deepEqual(await store.findDuplicateSourceInvoice({invoiceNumber:'SB-10442',clientName:'Northwind Systems LLC'}),{invoiceNumber:original.invoice_number,clientName:'Northwind Systems LLC',sourceInvoiceNumber:'SB-10442'},'same-source invoices for another customer cannot confuse the original identity');
  const queries=f.requests.filter(request=>request.method==='GET'&&new URL(request.url).pathname==='/rest/v1/invoices'&&new URL(request.url).searchParams.get('select')==='id,workspace_id,customer_id,invoice_number,metadata');
  assert.equal(queries.length,3);for(const request of queries){const params=new URL(request.url).searchParams;assert.equal(params.get('workspace_id'),'eq.'+f.scope.workspaceId);assert.equal(params.get('customer_id'),'eq.'+original.customer_id);assert.equal(params.get('limit'),'2');}
  const denied=createWhatsAppInvoiceStore({supabase:f.supabase,...f.scope,audience:'owner',authorize:async()=>false});await assert.rejects(denied.findDuplicateSourceInvoice({invoiceNumber:'SB-10442',clientName:'Northwind Systems LLC'}),/owner binding changed/);
  const second=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,metadata) values($1,$2,'OTHER-HISTORICAL','2026-10-01','2026-10-31','USD',10,'{}') returning id",[f.scope.workspaceId,original.customer_id])).rows[0];
  // Historical duplicates can predate the insert guard; simulate that retained
  // state with a metadata edit, without weakening or changing any SQL routine.
  await f.db.query("update invoices set metadata=jsonb_set(metadata,'{printed_invoice_number}','\"SB-10442\"') where id=$1",[second.id]);
  const before=(await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows;
  const reply=await f.upload('duplicate');assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));assert.match(reply.answer,/rejected as a duplicate/);assert.doesNotMatch(reply.answer,/INV-2026-|already logged as|Saved invoice/);
  const outcome=f.results.findLast(value=>value.code==='DUPLICATE_INVOICE');assert.equal(outcome.existingInvoice,undefined);assert.equal(outcome.invoiceCreated,false);
  assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i order by id')).rows,before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('an unknown write result keeps reconciliation safety and cannot become a duplicate rejection',async()=>{
 const f=await fixture({storeWrap:store=>({...store,async createAssistantInvoice(){throw Error('isolated unknown write result');}})});try{
  const reply=await f.upload('uncertain');assert.match(reply.answer,/verif|check|uncertain|may have/i);assert.doesNotMatch(reply.answer,/already logged|rejected as a duplicate|No new invoice was saved|Saved invoice/i);
  assert.equal(f.results.some(value=>value.code==='DUPLICATE_INVOICE'),false);assert.ok(f.results.some(value=>value.code==='DATABASE_UNAVAILABLE'));
  const review=(await f.db.query('select action from whatsapp_pending_actions')).rows[0].action;assert.equal(review.stage,'saving');assert.notEqual(review.failureCode,'DUPLICATE_INVOICE');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('lost insert acknowledgement reconciles the current save receipt rather than reporting an old-source duplicate',async()=>{
 let lost=false;
 const f=await fixture({storeWrap:store=>({...store,async createAssistantInvoice(input){const saved=await store.createAssistantInvoice(input);if(!lost){lost=true;throw Error('isolated lost insert acknowledgement');}return saved;}})});try{
  const reply=await f.upload('raced');assert.match(reply.answer,/Saved invoice INV-2026-0001/);assert.equal(reply.plannerFailure,undefined);assert.equal(f.results.some(value=>value.code==='DUPLICATE_INVOICE'),false);
  assert.equal((await f.db.query('select count(*)::int n from invoices')).rows[0].n,1);assert.equal((await f.db.query('select count(*)::int n from invoice_files')).rows[0].n,1);assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
