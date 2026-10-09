import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

const caption='Log this public sample invoice for testing. Keep customer messages and reminders off.';
const correction='My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders.';

async function fixture({throwAfterConfirm=false,mutateBeforeConfirm=null}={}){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550314';
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (public.create_workspace('Retained review confirmation fixture',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 await db.query("select setval(pg_get_serial_sequence('public.whatsapp_pending_actions','id'),31,true)");
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 const scope={workspaceId,ownerId,customerId,phone};
 // This is the actual 43,627-byte public sample PDF used for event253/257.
 const bytes=await readFile(new URL('./fixtures/public-sliced-sample-invoice.pdf',import.meta.url));
 const facts={invoiceNumber:'INV-3337',customerName:'Test Business',invoiceDate:'2016-01-25',dueDate:'2016-01-31',
  subtotal:85,tax:8.5,total:93.5,outstandingAmount:93.5,currency:'AUD',direction:'uncertain',clientEmail:'test@test.com',
  clientPhone:null,clientPhoneRaw:null,notes:null,currencySource:'Melbourne, VIC 3000',paymentStatus:'paid',paymentStatusEvidence:'PAID'};
 const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),
  lineItems:[{description:'Web Design',quantity:1,unitPrice:85,amount:85,confidence:.99}],lineItemsConfidence:.99};
 const providerCalls=[],executions=[];let currentMessage='';let confirmationFaultArmed=throwAfterConfirm;
 const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
  logger:{info(){},warn(){},error(){}},toolsFactory:options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,async execute(name,args,context){
    executions.push({name,args});
    if(args.operation==='confirm'&&mutateBeforeConfirm==='expire')await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 second' where id=(select id from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='pdf-source')",[workspaceId]);
    if(args.operation==='confirm'&&mutateBeforeConfirm==='stale')await db.query("update whatsapp_pending_actions set version=version+1 where id=(select id from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='pdf-source')",[workspaceId]);
    const result=await tools.execute(name,args,context);
    if(args.operation==='confirm'&&confirmationFaultArmed){confirmationFaultArmed=false;throw Object.assign(new Error('lost confirmation acknowledgement'),{code:'OWNER_LOOP_TIMEOUT'});}
    return result;
   }};
  },fetchImpl:async(url,init)=>{
   const body=JSON.parse(init.body),host=new URL(url).hostname;providerCalls.push({host,body,message:currentMessage});
   if(host==='generativelanguage.googleapis.com'){
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(wire)}]},finishReason:'STOP'}]});
   }
   assert.equal(host,'api.cloudflare.com');
   const tool=body.messages.findLast(item=>item.role==='tool');
   // Deliberately repeat the observed event257 failure: the provider asks for
   // generic invoice creation even when the owner is replying to a retained
   // proposal. The real owner tool policy must select the guarded confirm.
   if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'event257-generic-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD',status:'unpaid'}})}}]}}]});
   const result=JSON.parse(tool.content);
   const completed=result.completed===true;
   return Response.json({choices:[{finish_reason:'stop',message:{content:completed?'Saved invoice INV-2026-0001 for Test Business, USD 93.50.':
    result.requiresLaterConfirmation?'Invoice INV-3337 for Test Business, USD 93.50. Reply yes to save it. Nothing was saved.':
    result.message||'Nothing was saved.'}}]});
  }});
 const persist=async(id,message,media=false)=>{
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",
   [id,phone,media?'document':'text',message,media?id:null]);
  // Production ingestion persists owner conversation rows with a NULL debtor id.
  await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,null,$2,'inbound','owner',$3,$4,'received',$5,$5)",
   [workspaceId,phone,message,media?'document':'text',id]);
  if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,'application/pdf',bytes,bytes.length]);
 };
 const turn=async(id,message,media=false,extra={})=>{currentMessage=message;await persist(id,message,media);return handler({...scope,messageId:id,message,...(media?{media:{bytes,mimeType:'application/pdf',fileName:'public-sample.pdf'}}:{}),...extra});};
 const review=async()=>(await db.query("select id,version,action,expires_at,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='pdf-source' order by id desc limit 1",[workspaceId])).rows[0];
 const ledger=async()=>(await db.query(`select jsonb_build_object(
  'invoices',(select coalesce(jsonb_agg(to_jsonb(i)),'[]') from invoices i where workspace_id=$1),
  'payments',(select count(*) from payments where workspace_id=$1),
  'files',(select count(*) from invoice_files where workspace_id=$1),
  'savedReviews',(select count(*) from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='invoice_review_draft' and action->>'stage'='saved'),
  'directReceipts',(select count(*) from whatsapp_direct_write_receipts where workspace_id=$1),
  'customerOutbound',(select count(*) from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound')) value`,[workspaceId])).rows[0].value;
 try{
  const first=await turn('pdf-source',caption,true),draft=await review();
  assert.equal(bytes.length,43627);assert.equal(draft.action.stage,'incomplete',JSON.stringify({first,draft,errors:f.errors}));
  assert.equal(draft.id,32,'retain the reported pending review ID');
  assert.equal(draft.action.invoice.total,93.5);assert.equal(draft.action.invoice.subtotal,85);assert.equal(draft.action.invoice.tax,8.5);
  assert.equal(draft.action.invoice.outstanding,93.5);assert.equal(draft.action.invoice.clientPhone,null);assert.deepEqual(draft.action.missingFields,['direction']);
  const corrected=await turn('pdf-correction',correction),proposal=await review();
  assert.equal(proposal.id,draft.id);assert.equal(proposal.action.stage,'proposal',JSON.stringify({proposal,corrected,errors:f.errors}));
  assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.direction,'receivable');
  assert.equal(proposal.action.invoice.total,93.5);assert.equal(proposal.action.invoice.subtotal,85);assert.equal(proposal.action.invoice.tax,8.5);
  assert.equal(proposal.action.invoice.outstanding,93.5);assert.equal(proposal.action.invoice.alreadyPaid,false);assert.equal(proposal.action.invoice.clientPhone,null);
  assert.deepEqual(proposal.action.invoice.lineItems,[{description:'Web Design',quantity:1,unitPrice:85,amount:85,confidence:.99}]);
  assert.deepEqual(proposal.action.paymentEvidence,draft.action.paymentEvidence);assert.match(corrected.answer,/reply yes/i);
  const before=await ledger();assert.equal(before.invoices.length,0);
  return {...f,scope,bytes,handler,turn,persist,review,ledger,draft,proposal,before,executions,providerCalls,get currentMessage(){return currentMessage;}};
 }catch(error){await f.close();throw error;}
}

test('event257 retained PDF proposal uses the guarded confirmation writer after a later yes without a provider decision',async()=>{
 const f=await fixture();try{
  const executionStart=f.executions.length,providerStart=f.providerCalls.length;
  const savedReply=await f.turn('pdf-confirm','yes');
  assert.match(savedReply.answer,/Saved invoice INV-2026-0001/);
  const confirmCalls=f.executions.slice(executionStart).filter(({args})=>args.operation==='confirm');
  assert.ok(confirmCalls.length===1,JSON.stringify({savedReply,executions:f.executions.slice(executionStart),providerCalls:f.providerCalls.slice(providerStart)}));
  assert.equal(f.executions.slice(executionStart).some(({args})=>args.operation==='create'),false);
  assert.equal(f.providerCalls.length,providerStart,'an explicit owner yes selects the guarded confirmation operation before asking the provider');
  const state=await f.ledger();assert.equal(state.invoices.length,1);const invoice=state.invoices[0];
  assert.equal(Number(invoice.total_amount),93.5);assert.equal(Number(invoice.metadata.subtotal),85);assert.equal(Number(invoice.metadata.tax),8.5);
  assert.equal(Number(invoice.metadata.outstanding_amount),93.5);assert.equal(Number(invoice.amount_paid),0);
  assert.equal(invoice.currency,'USD');assert.equal(invoice.status,'draft');assert.equal(invoice.customer_phone,null);
  assert.equal(invoice.metadata.client_phone,null);assert.equal(Number(invoice.reminder_count),0);
  assert.equal(invoice.metadata.printed_invoice_number,'INV-3337');assert.equal(invoice.metadata.followup_state,'draft');assert.equal(invoice.metadata.next_follow_up_at,null);
  assert.equal(state.payments,0);assert.equal(state.customerOutbound,0);assert.equal(state.directReceipts,0);
  assert.equal(state.savedReviews,1);assert.equal(state.files,1);
  const file=(await f.db.query('select * from invoice_files where invoice_id=$1',[invoice.id])).rows[0];assert.equal(file.mime_type,'application/pdf');
  const stored=await f.supabase.storage.from('invoice-files').download(file.storage_path);assert.equal(stored.error,null);
  assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),f.bytes);
  const savedReview=await f.review();assert.equal(savedReview.action.stage,'saved');
  assert.equal((await f.handler({...f.scope,messageId:'pdf-confirm',message:'yes'})).replayed,true);
  assert.deepEqual(await f.ledger(),state);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a nonconfirming later message, confirmation embedded in the correction, and a foreign owner scope cannot save the retained PDF',async()=>{
 const f=await fixture();try{
  const proposal=f.proposal,before=f.before;
  const nonconfirm=await f.turn('pdf-not-confirm','Thanks, I will check it.');
  assert.doesNotMatch(nonconfirm.answer,/Saved invoice/);assert.deepEqual(await f.review(),proposal);assert.deepEqual(await f.ledger(),before);
  const foreign=await f.handler({...f.scope,workspaceId:randomUUID(),messageId:'foreign-yes',message:'yes'});
  assert.equal(foreign,'');assert.deepEqual(await f.review(),proposal);assert.deepEqual(await f.ledger(),before);
  const combined=await f.turn('same-message','My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders. yes');
  assert.doesNotMatch(combined.answer,/Saved invoice/);assert.deepEqual(await f.review(),proposal);assert.deepEqual(await f.ledger(),before);
  assert.equal(f.executions.some(({args})=>args.operation==='confirm'),false);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('expired and stale retained proposals cannot be confirmed by a later yes',async()=>{
 const expired=await fixture({mutateBeforeConfirm:'expire'});try{
  const reply=await expired.turn('expired-yes','yes');assert.doesNotMatch(reply.answer,/Saved invoice/);
  assert.equal((await expired.ledger()).invoices.length,0);assert.equal(expired.executions.filter(({args})=>args.operation==='confirm').length,1);
 }finally{await expired.close();}
 const stale=await fixture({mutateBeforeConfirm:'stale'});try{
  const reply=await stale.turn('stale-yes','yes');assert.doesNotMatch(reply.answer,/Saved invoice/);
  assert.equal((await stale.ledger()).invoices.length,0);assert.equal(stale.executions.filter(({args})=>args.operation==='confirm').length,1);
  assert.deepEqual(stale.errors,[]);
 }finally{await stale.close();}
});

test('an explicit cancel retires the proposal without saving its invoice or source file',async()=>{
 const f=await fixture();try{
  const reply=await f.turn('pdf-cancel','cancel');assert.doesNotMatch(reply.answer,/Saved invoice/);
  const review=await f.review();assert.equal(review.action.stage,'canceled');assert.equal((await f.ledger()).invoices.length,0);
  assert.equal((await f.ledger()).files,0);assert.equal(f.executions.filter(({args})=>args.operation==='cancel').length,1);
  assert.equal(f.executions.some(({args})=>args.operation==='confirm'),false);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('lost confirmation acknowledgement resumes safely without retrying or duplicating the saved invoice and source PDF',async()=>{
 const f=await fixture({throwAfterConfirm:true});try{
  const scope={...f.scope,messageId:'pdf-confirm',message:'yes',allowDeferred:true};
  await f.persist('pdf-confirm','yes');
  const interrupted=await f.handler(scope);assert.equal(interrupted.deferred,true,JSON.stringify(interrupted));
  let state=await f.ledger();assert.equal(state.invoices.length,1,JSON.stringify({state,interrupted,executions:f.executions,errors:f.errors}));assert.equal(state.savedReviews,1,JSON.stringify({state,interrupted,executions:f.executions}));assert.equal(state.files,1);
  const resumed=await f.handler({...scope,checkpoint:interrupted.checkpoint});
  assert.match(resumed.answer,/interrupted|result must be checked/i);assert.doesNotMatch(resumed.answer,/Saved invoice/);
  state=await f.ledger();assert.equal(state.invoices.length,1);assert.equal(state.savedReviews,1);assert.equal(state.files,1);
  assert.equal(f.executions.filter(({args})=>args.operation==='confirm').length,1);
  const file=(await f.db.query('select * from invoice_files where workspace_id=$1',[f.scope.workspaceId])).rows[0];
  const stored=await f.supabase.storage.from('invoice-files').download(file.storage_path);
  assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),f.bytes);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
