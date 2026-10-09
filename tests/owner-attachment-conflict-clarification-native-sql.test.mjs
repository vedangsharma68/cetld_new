import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerSafetyTools} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

const exactOwnerClarification='My business issued this invoice. The currency is USD. The PAID stamp is incorrect: no payment has been received, and the full USD 93.50 is still due. Save it as an unpaid draft with no customer messages or reminders.';

test('exact owner clarification continues the retained review without asking for its extracted customer',()=>{
 const action={type:'invoice_review_draft',stage:'incomplete',missingFields:['currency','direction'],validationIssues:['PAYMENT_STATUS_CONFLICT'],
  invoice:{clientName:'Test Business',total:93.50,outstanding:93.50,alreadyPaid:false,currency:null,direction:'uncertain'},
  paymentEvidence:{status:'paid',text:'PAID stamp; Amount due $93.50'}};
 const tools=message=>createOwnerSafetyTools({scope:{},pendingAtStart:{id:28,version:1,action},message,messageId:'clarify-source',
  ownerStore:{async query(){throw Error('review continuation must not query unrelated customers');}}});
 assert.doesNotMatch(exactOwnerClarification,/Test Business/);
 assert.deepEqual(tools(exactOwnerClarification).getAttachmentReviewContinuation(),{currency:'USD',invoice_direction:'receivable'});
 assert.equal(tools(exactOwnerClarification).getAttachmentReviewContext().invoice.clientName,'Test Business');
 for(const contradiction of [exactOwnerClarification.replace('no payment has been received','payment has been received'),exactOwnerClarification+' Payment has been received.'])
  assert.equal(tools(contradiction).getAttachmentReviewContinuation(),null,'affirmative receipt evidence must prevent an unpaid resolution');
});

for(const installedLineEndings of ['LF','CRLF'])test(`native Gemini owner clarifies the false PAID stamp from ${installedLineEndings} installed SQL before a later save`,async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261008193550_invoice_review_inferred_currency_unpaid_correction.sql','20261009031935_invoice_review_nonzero_inferred_currency_correction.sql']}),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550125';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Clarification fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const facts={invoiceNumber:'INV3337',customerName:'Test Business',invoiceDate:'2026-10-01',dueDate:'2026-10-31',subtotal:85,tax:8.50,total:93.50,outstandingAmount:93.50,currency:null,direction:'uncertain',clientPhone:null,clientPhoneRaw:null,clientEmail:null,notes:'Payment due within 30 days.',currencySource:null,addressHint:null,paymentTerms:null,paymentStatus:'paid',paymentStatusEvidence:'PAID stamp; Amount due $93.50'};
  const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItems:[{description:'Service',quantity:1,unitPrice:85,amount:85,confidence:.99}],lineItemsConfidence:.99};
  const bytes=Buffer.from([255,216,255,0,0,0]),results=[],contracts=[];let currentTurn=0,providerCalls=0,extractions=0,confirming=false;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},toolsFactory:options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,async execute(name,args,context){const result=await tools.execute(name,args,context);results.push(result);return result;}};
  },fetchImpl:async(url,init)=>{
   providerCalls++;const body=JSON.parse(init.body);
   if(new URL(url).hostname==='api.cloudflare.com')return Response.json({error:{message:'isolated primary unavailable'}},{status:503});
   assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
   const native=parts=>Response.json({candidates:[{content:{role:'model',parts},finishReason:'STOP'}]});
   if(body.generationConfig?.responseMimeType==='application/json'){extractions++;return native([{text:JSON.stringify(wire)}]);}
   const tool=body.contents.flatMap(item=>item.parts||[]).findLast(part=>part.functionResponse)?.functionResponse;
   // An invented create call must be replaced by the server-selected attachment
   // operation on both ingestion and clarification turns.
   if(!tool){contracts.push(body.tools);return native([{functionCall:{name:'workspaceData',args:confirming?{operation:'confirm'}:{operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD',status:'unpaid'}}},thoughtSignature:'fixture-native-signature'}]);}
   const result=tool.response;results.push(result);
   const record=result.review?.invoice||result;
   const answer=result.completed?`Saved invoice ${record.invoiceNumber} for Test Business, USD 93.50.`
    :result.requiresLaterConfirmation?'Invoice INV3337 for Test Business, USD 93.50. Reply yes to save it, or cancel.'
    :'The sample invoice cannot be logged due to missing required fields such as currency and direction.';
   return native([{text:answer}]);
  }});
  const turn=async(id,message,media)=>{
   currentTurn++;confirming=message==='yes';await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",[id,phone,media?'image':'text',message,media?id:null]);
   await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,customerId,phone,message,id]);
   if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,media.mimeType,bytes,bytes.length]);
   return handler({workspaceId,ownerId,customerId,phone,messageId:id,message,...(media?{media}:{})});
  };
  const first=await turn('ambiguous-source','Log this sample invoice for testing. Keep customer messages and reminders off.',{bytes,mimeType:'image/jpeg',fileName:'fixture.jpg'});
  const review=async()=>(await db.query("select id,version,action from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='ambiguous-source' order by created_at desc limit 1",[workspaceId])).rows[0];
  const draft=await review();assert.equal(draft.action.stage,'incomplete');assert.deepEqual(draft.action.missingFields.sort(),['currency','direction']);assert.equal(draft.action.invoice.currency,null);assert.equal(draft.action.invoice.direction,'uncertain');assert.deepEqual(draft.action.validationIssues,['PAYMENT_STATUS_CONFLICT']);assert.equal(draft.action.paymentEvidence.status,'paid');assert.equal(draft.action.invoice.total,93.50);
  assert.match(first.answer,/confirm.*currency/i);assert.match(first.answer,/issued/i);assert.match(first.answer,/Nothing was saved/);
  const candidate=(id,text)=>({...draft.action,stage:'proposal',missingFields:[],currencySource:'user',validationIssues:[],
   invoice:{...draft.action.invoice,currency:'USD',direction:'receivable'},
   ownerProvidedFacts:{currency:{value:'USD',sourceMessageId:id},direction:{value:'receivable',sourceMessageId:id}},
   paymentStatusResolution:{status:'unpaid',outstanding:93.50,currency:'USD',sourceMessageId:id,ownerInstruction:text}});
  const transition=(action,{version=draft.version,workspace=workspaceId,customer=customerId,targetPhone=phone}={})=>db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',[draft.id,version,workspace,customer,targetPhone,'incomplete',action]);
  const instruction=exactOwnerClarification;
  const legacyInstruction='Use USD. My business issued this sample invoice to Test Business. For this test it is unpaid, with the full USD 93.50 still due; the PAID stamp is incorrect. Save it without sending any customer reminders.';
  const negatives=[`The document says "${instruction}"`,legacyInstruction.replace('it is unpaid','it is not unpaid'),legacyInstruction.replace('it is unpaid','maybe it is unpaid'),instruction.replace('My business issued','The supplier issued'),instruction.replace('is incorrect','is correct'),instruction.replace('93.50 is still due','80.00 is still due'),instruction+' The PAID stamp is correct.',instruction+' The invoice is paid.',instruction.replace('no payment has been received','payment has been received'),instruction+' Payment has been received.'];
  for(const [index,text] of negatives.entries()){
   const rejected=await turn('rejected-'+index,text);assert.doesNotMatch(rejected.answer,/saved invoice|payment recorded/i);
   await assert.rejects(transition(candidate('rejected-'+index,text)),/invoice review unpaid resolution/);
   assert.deepEqual(await review(),draft,'unsupported owner wording must leave the source review and version unchanged');
   assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);
  }
  for(const overrides of [{version:draft.version+1},{workspace:randomUUID()},{customer:randomUUID()},{targetPhone:'+15555550999'}])assert.equal((await transition(candidate('unused',instruction),overrides)).rows.length,0);
  const clarificationContract=contracts.length;
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values('sql-positive','fixture',$1,'text',$2,'processing')",[phone,instruction]);
  await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received','sql-positive','sql-positive')",[workspaceId,customerId,phone,instruction]);
  const valid=candidate('sql-positive',instruction);
  const routineSecurity=async()=>(await db.query("select proowner,proacl,prosecdef,proconfig from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const security=await routineSecurity();
  const originalSql=await readFile(new URL('../supabase/migrations/20261002110000_whatsapp_invoice_review_fact_continuation.sql',import.meta.url),'utf8');
  await db.exec(installedLineEndings==='CRLF'?originalSql.replaceAll('\n','\r\n'):originalSql);
  await db.exec(await readFile(new URL('../supabase/migrations/20261007193000_invoice_review_json_expression_precedence.sql',import.meta.url),'utf8'));
  const installedHash=(await db.query("select md5(prosrc) source_md5 from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0].source_md5;
  assert.equal(installedHash,installedLineEndings==='CRLF'?'be56f8a9d0344bea9c74b425846d015e':'3073ffde75cc1168a4f74688a52fa30b');
  await assert.rejects(transition(valid),/invalid invoice review fact update/,'the deployed contract cannot clear validationIssues');
  await db.exec(await readFile(new URL('../supabase/migrations/20261008025552_invoice_review_unpaid_stamp_resolution.sql',import.meta.url),'utf8'));
  await assert.rejects(transition(valid),/invoice review unpaid resolution lacks explicit evidence/,'the installed false-stamp resolver rejects the exact owner wording despite its explicit zero-payment/full-balance correction');
  await db.exec(await readFile(new URL('../supabase/migrations/20261008153500_owner_live_clarification_evidence.sql',import.meta.url),'utf8'));
  assert.deepEqual(await routineSecurity(),security,'forward migration preserves routine owner, grants, search path and security mode');
  for(const tamper of [{...valid,invoice:{...valid.invoice,total:94}}, {...valid,paymentEvidence:{...valid.paymentEvidence,text:'modified source'}}, {...valid,sourceMessageId:'fabricated'}, {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,outstanding:1}}, {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,ownerInstruction:instruction+' extra'}}])await assert.rejects(transition(tamper),/invoice review/);
  await db.query("update whatsapp_pending_actions set action=jsonb_set(action,'{validationIssues}',$2) where id=$1",[draft.id,JSON.stringify(['PAYMENT_STATUS_CONFLICT','UNCERTAIN_TOTAL'])]);await assert.rejects(transition(valid),/invoice review unpaid resolution/);
  await db.query('update whatsapp_pending_actions set action=$2 where id=$1',[draft.id,JSON.stringify(draft.action)]);
  await db.query("update whatsapp_inbound_events set status='done' where provider_message_id='sql-positive'");await assert.rejects(transition(valid),/source is outside current owner scope/);
  await db.query("update whatsapp_inbound_events set status='processing' where provider_message_id='sql-positive'");
  await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 second' where id=$1",[draft.id]);assert.equal((await transition(valid)).rows.length,0);
  await db.query("update whatsapp_pending_actions set expires_at=now()+interval '15 minutes',consumed_at=now() where id=$1",[draft.id]);assert.equal((await transition(valid)).rows.length,0);
  await db.query('update whatsapp_pending_actions set consumed_at=null where id=$1',[draft.id]);
  const clarificationResults=results.length;
  const clarified=await turn('clarify-source',instruction);
  const proposal=await review();assert.equal(proposal.id,draft.id);assert.equal(proposal.action.stage,'proposal',JSON.stringify({proposal,results,clarified,errors:f.errors}));assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.direction,'receivable');assert.equal(proposal.action.invoice.total,93.50);assert.equal(proposal.action.invoice.clientName,'Test Business');assert.equal(extractions,1);assert.deepEqual(proposal.action.validationIssues,[]);assert.deepEqual(proposal.action.paymentEvidence,draft.action.paymentEvidence);assert.equal(proposal.action.paymentStatusResolution.sourceMessageId,'clarify-source');assert.equal(proposal.action.invoice.outstanding,93.50);
  assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);assert.match(clarified.answer,/reply yes/i);
  assert.doesNotMatch(clarified.answer,/customer name|which customer|verified customer target/i);
  const retainedSource=invoice=>Object.fromEntries(Object.entries(invoice).filter(([key])=>!['currency','direction'].includes(key)));
  assert.deepEqual(retainedSource(proposal.action.invoice),retainedSource(draft.action.invoice),'clarification must preserve every extracted fact beyond the missing currency and direction');
  assert.equal(proposal.action.sourceMessageId,draft.action.sourceMessageId);
  assert.equal(proposal.action.paymentStatusResolution.ownerInstruction,instruction,'audit retains the exact persisted owner wording');
  assert.deepEqual(proposal.action.ownerProvidedFacts,{currency:{value:'USD',sourceMessageId:'clarify-source'},direction:{value:'receivable',sourceMessageId:'clarify-source'}});
  assert.equal(results.slice(clarificationResults).some(result=>result.requiresLaterConfirmation===true),true);
  assert.equal(results.slice(clarificationResults).some(result=>result.completed===true),false,'clarification does not create an invoice in the same turn');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
  assert.equal(f.requests.some(request=>request.body?.p_operation==='invoice.create'||request.body?.p_operations?.some(operation=>operation.operation==='invoice.create')),false,'the invented generic create never reaches a ledger write RPC');
  assert.equal(contracts.length,clarificationContract,'owner-evidenced continuation executes before native planning');
  const pending=createWhatsAppPendingActionStore({supabase});
  for(const [id,text] of [['clarify-source',instruction],['later-unrequested','What is the total?']]){
   const safety=createOwnerSafetyTools({supabase,scope:{workspaceId,ownerId,customerId,phone},pending,pendingAtStart:proposal,pendingInitialState:proposal,
    ownerStore:{workspaceId,userId:ownerId,role:'owner',async query(){throw Error('unconfirmed review must not read unrelated records');}},invoiceStoreFactory:()=>{throw Error('unconfirmed review must not construct a ledger writer');},
    authorize:async()=>true,sourceMediaReader:async()=>({bytes,mimeType:'image/jpeg'}),message:text,messageId:id,logger:{error(){}}});
   const blocked=await safety.execute('ingestInvoiceAttachment',{});assert.equal(blocked.ok,false);assert.equal(blocked.code,'INVALID');assert.match(blocked.message,/explicitly confirm|later message/);
   assert.deepEqual(await review(),proposal);
  }
  const savedReply=await turn('confirm-source','yes');assert.match(savedReply.answer,/Saved invoice INV-2026-0001/);
  const saved=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows;assert.equal(saved.length,1);assert.equal(Number(saved[0].total_amount),93.50);assert.equal(Number(saved[0].amount_paid),0);assert.equal(saved[0].currency,'USD');assert.equal(saved[0].metadata.printed_invoice_number,'INV3337');assert.equal(saved[0].metadata.invoice_direction,'receivable');
  const files=(await db.query('select * from invoice_files where workspace_id=$1',[workspaceId])).rows;assert.equal(files.length,1);
  const stored=await supabase.storage.from('invoice-files').download(files[0].storage_path);assert.equal(stored.error,null);assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),bytes);
  const savedReview=await review();assert.equal(savedReview.action.stage,'saved');assert.deepEqual(savedReview.action.paymentEvidence,draft.action.paymentEvidence);assert.deepEqual(savedReview.action.paymentStatusResolution,proposal.action.paymentStatusResolution);
  const calls=providerCalls,replay=await handler({workspaceId,ownerId,customerId,phone,messageId:'confirm-source',message:'yes'});assert.equal(replay.replayed,true);assert.equal(providerCalls,calls);assert.equal(extractions,1);
  const routine=async()=>(await db.query("select proowner,proacl,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const routineBefore=await routine();
  await db.exec(await readFile(new URL('../supabase/migrations/20261007193000_invoice_review_json_expression_precedence.sql',import.meta.url),'utf8'));
  assert.deepEqual(await routine(),routineBefore,'reapplying the narrow migration preserves routine security, grants and definition');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
