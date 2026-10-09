import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerSafetyTools} from '../automation/whatsapp/owner-agent.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {invoiceReviewUnpaidResolution} from '../automation/whatsapp/invoice-review-payment-resolution.mjs';
import {originalRetainedUnpaidInstruction,retainedUnpaidWordingCases,retainedUnpaidWordingNegatives} from './fixtures/retained-unpaid-wording.mjs';

const migrationName='20261008193550_invoice_review_inferred_currency_unpaid_correction.sql';
const instruction=originalRetainedUnpaidInstruction;
const action={type:'invoice_review_draft',stage:'incomplete',missingFields:['direction'],
 validationIssues:['PAYMENT_RECORD_REQUIRES_REVIEW','PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD'],
 currencySource:'photo',currencyEvidence:'inferred AUD based on Australian address',sourceMessageId:'image-source',
 invoice:{invoiceNumber:'INV-3337',clientName:'Test Business',subtotal:85,tax:8.5,total:93.5,outstanding:0,
  currency:'AUD',direction:'uncertain',alreadyPaid:false},paymentEvidence:{status:'paid',text:'PAID stamp; Amount due $0.00'}};
const contradictory=[instruction+' We received USD 10.',instruction+' We got a payment yesterday.',instruction+' A deposit was collected.',
 instruction+' I paid USD 10.',instruction+' The customer sent USD 10.',instruction+' We collected a deposit.',instruction+' USD 10 was paid.',
 instruction.replace('The currency is USD.','I think the currency is USD.'),instruction.replace('The currency is USD.','The currency is probably USD.'),
 instruction+' Payment has been received.',instruction+' This invoice is paid.',instruction+' Change the customer to Elsewhere.',
 instruction.replace('currency is USD','currency is AUD'),instruction.replace('93.50','92.50'),
 instruction.replace('no payment has been received','payment has been received'),instruction.replace('incorrect','correct'),
 ...retainedUnpaidWordingNegatives];

test('retained zero-balance correction accepts equivalent complete facts and rejects unknown or contradictory clauses',()=>{
 const resolve=(message,review=action)=>invoiceReviewUnpaidResolution({action:review,message,messageId:'correction-source'});
 assert.deepEqual(resolve(instruction),{status:'unpaid',outstanding:93.5,currency:'USD',sourceMessageId:'correction-source',
  ownerInstruction:instruction,extractedFacts:{currency:'AUD',outstanding:0}});
 for(const wording of retainedUnpaidWordingCases){
  const review=wording.total===action.invoice.total?action:{...action,invoice:{...action.invoice,total:wording.total,subtotal:wording.total,tax:0}};
  assert.deepEqual(resolve(wording.message,review),{status:'unpaid',outstanding:wording.total,currency:wording.currency,sourceMessageId:'correction-source',
   ownerInstruction:wording.message,extractedFacts:{currency:'AUD',outstanding:0}},wording.name);
  const tools=createOwnerSafetyTools({scope:{},pendingAtStart:{id:30,version:2,action:review},message:wording.message,messageId:'correction-source',
   ownerStore:{async query(){throw Error('retained review must not query unrelated customers');}}});
  assert.deepEqual(tools.getAttachmentReviewContinuation(),{currency:wording.currency,invoice_direction:'receivable'},wording.name);
 }
 const tools=createOwnerSafetyTools({scope:{},pendingAtStart:{id:30,version:2,action},message:instruction,messageId:'correction-source',
  ownerStore:{async query(){throw Error('retained review must not query unrelated customers');}}});
 assert.deepEqual(tools.getAttachmentReviewContinuation(),{currency:'USD',invoice_direction:'receivable'});
 assert.equal(tools.getAttachmentReviewContext().invoice.clientName,'Test Business');
 for(const message of [...contradictory,`"${instruction}"`,instruction+'?',instruction.replace('My business issued','Maybe my business issued')])
  assert.equal(resolve(message),null,message);
 for(const review of [{...action,validationIssues:[...action.validationIssues,'UNCERTAIN_TOTAL']},
  {...action,invoice:{...action.invoice,tax:9}}, {...action,invoice:{...action.invoice,outstanding:1}},
  {...action,currencySource:'user'}, {...action,ownerProvidedFacts:{currency:{value:'AUD',sourceMessageId:'old'}}},
  {...action,paymentEvidence:{status:'partial',text:'PAID'}}, {...action,paymentStatusResolution:{status:'unpaid'}}])
  assert.equal(resolve(instruction,review),null);
});

for(const [lineEndings,wording] of [['LF',retainedUnpaidWordingCases[0]],['CRLF',retainedUnpaidWordingCases[0]],['LF',retainedUnpaidWordingCases[1]],['LF',retainedUnpaidWordingCases[2]]])test(`native image-shaped extraction corrects retained AUD/zero balance with ${wording.name}${wording===retainedUnpaidWordingCases[1]?' and NULL owner transcript':''} under ${lineEndings} SQL only after a later yes`,async()=>{
 const instruction=wording.message;
 const f=await createOfflineSqlNetwork({excludeMigrations:[migrationName]}),{db,supabase}=f;
 const ownerId=randomUUID(),phone='+15555550130';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Retained review fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const facts={invoiceNumber:'INV-3337',customerName:'Test Business',invoiceDate:'2026-10-01',dueDate:'2026-10-31',
   subtotal:85,tax:8.5,total:93.5,outstandingAmount:0,currency:'AUD',direction:'uncertain',clientPhone:null,clientPhoneRaw:null,
   clientEmail:null,notes:'Payment due within 30 days.',currencySource:action.currencyEvidence,addressHint:'Australia',paymentTerms:'Net 30',
   paymentStatus:'paid',paymentStatusEvidence:'PAID stamp; Amount due $0.00'};
  const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),
   lineItems:[{description:'Service',quantity:1,unitPrice:85,amount:85,confidence:.99}],lineItemsConfidence:.99};
  // No original image was supplied for this regression. These fixture bytes
  // travel through the native image request with the reported extraction facts.
  const bytes=Buffer.from([255,216,255,0,0,0]),results=[],contracts=[];let providerCalls=0,extractions=0,confirming=false;
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
   logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
    providerCalls++;const body=JSON.parse(init.body);
    if(new URL(url).hostname==='api.cloudflare.com')return Response.json({error:{message:'isolated primary unavailable'}},{status:503});
    assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
    const native=parts=>Response.json({candidates:[{content:{role:'model',parts},finishReason:'STOP'}]});
    if(body.generationConfig?.responseMimeType==='application/json'){
     extractions++;assert.equal(body.contents.flatMap(item=>item.parts||[]).find(part=>part.inlineData)?.inlineData.data,bytes.toString('base64'));
     return native([{text:JSON.stringify(wire)}]);
    }
    const tool=body.contents.flatMap(item=>item.parts||[]).findLast(part=>part.functionResponse)?.functionResponse;
    if(!tool){contracts.push(body.tools);return native([{functionCall:{name:'workspaceData',args:confirming?{operation:'confirm'}:
     {operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD',status:'unpaid'}}},thoughtSignature:'fixture-native-signature'}]);}
    results.push(tool.response);
    return native([{text:tool.response.completed?'Saved invoice INV-2026-0001 for Test Business, USD 93.50.':
     tool.response.requiresLaterConfirmation?'Invoice INV-3337 for Test Business, USD 93.50. Reply yes to save it, or cancel.':
     'The sample invoice cannot be logged due to missing currency and customer name.'}]);
   }});
  const persist=async(id,message,media)=>{
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'fixture',$2,$3,$4,'processing',$5)",[id,phone,media?'image':'text',message,media?id:null]);
   // Cloud ingestion stores owner transcripts without a debtor/customer id.
   // Exercise that shape through the full equivalent correction and later save.
   const transcriptCustomerId=wording===retainedUnpaidWordingCases[1]?null:customerId;
   await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,transcriptCustomerId,phone,message,id]);
   if(media)await db.query('insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,$2,$3,$4)',[id,media.mimeType,bytes,bytes.length]);
  };
  const turn=async(id,message,media)=>{confirming=message==='yes';await persist(id,message,media);return handler({workspaceId,ownerId,customerId,phone,messageId:id,message,...(media?{media}:{})});};
  const review=async()=>(await db.query("select id,version,action from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='image-source' order by created_at desc limit 1",[workspaceId])).rows[0];
  await turn('image-source','Log this sample invoice for testing. Keep customer messages and reminders off.',{bytes,mimeType:'image/jpeg',fileName:'fixture.jpg'});
  const draft=await review();assert.equal(draft.action.stage,'incomplete');assert.deepEqual(draft.action.missingFields,['direction']);
  assert.equal(draft.action.invoice.currency,'AUD');assert.equal(draft.action.invoice.outstanding,0);assert.equal(draft.action.invoice.total,93.5);
  assert.deepEqual(draft.action.validationIssues,action.validationIssues);assert.equal(draft.action.currencySource,'photo');
  assert.equal(draft.action.currencyEvidence,action.currencyEvidence);assert.equal(draft.action.paymentEvidence.status,'paid');
  const candidate=(id,text,reviewAction=draft.action,currency='USD')=>({...reviewAction,stage:'proposal',missingFields:[],currencySource:'user',validationIssues:[],
   invoice:{...reviewAction.invoice,currency,outstanding:reviewAction.invoice.total,direction:'receivable'},
   ownerProvidedFacts:{currency:{value:currency,sourceMessageId:id},direction:{value:'receivable',sourceMessageId:id}},
   paymentStatusResolution:{status:'unpaid',outstanding:reviewAction.invoice.total,currency,sourceMessageId:id,ownerInstruction:text,
    extractedFacts:{currency:reviewAction.invoice.currency,outstanding:reviewAction.invoice.outstanding}}});
  const transition=(next,{version=draft.version,workspace=workspaceId,customer=customerId,targetPhone=phone}={})=>
   db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',[draft.id,version,workspace,customer,targetPhone,'incomplete',next]);
  await persist('sql-positive',instruction);const valid=candidate('sql-positive',instruction);
  const routine=async()=>(await db.query("select prosrc,md5(replace(prosrc,chr(13),'')) normalized_md5,proowner,proacl,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const predecessor=await routine();assert.equal(predecessor.normalized_md5,'0ec3c131390877826e57e864b4d9ed22');
  if(lineEndings==='CRLF')await db.exec(predecessor.definition.replaceAll('\n','\r\n'));
  await assert.rejects(transition(valid),/invoice review unpaid resolution lacks explicit evidence/,'installed predecessor reproduces the zero-balance rejection');
  const beforeCalls=results.length,blocked=await turn('before-migration',instruction);
  assert.deepEqual(await review(),draft,'failed SQL correction leaves the original durable review intact');
  assert.match(blocked.answer,/INV-3337/);assert.match(blocked.answer,/Test Business/);assert.match(blocked.answer,/correction could not be recorded/i);assert.match(blocked.answer,/Nothing was saved/);
  assert.doesNotMatch(blocked.answer,/missing currency|customer name|reply yes/i);
  assert.equal(results.slice(beforeCalls).some(result=>result.requiresLaterConfirmation||result.completed),false);
  assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/invoice review unpaid resolution/);f.errors.length=0;
  const untouched=async()=>(await db.query("select oid,prosrc,proowner,proacl,prosecdef,proconfig from pg_proc where pronamespace in ('public'::regnamespace,'app'::regnamespace) and oid<>'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure order by oid")).rows;
  const otherRoutines=await untouched(),security=({proowner,proacl,prosecdef,proconfig})=>({proowner,proacl,prosecdef,proconfig});
  const migration=await readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
  await db.exec(lineEndings==='CRLF'?migration.replaceAll('\n','\r\n'):migration);
  assert.deepEqual(security(await routine()),security(predecessor));assert.deepEqual(await untouched(),otherRoutines);
  const installed=await routine();await db.exec(migration);assert.deepEqual(await routine(),installed,'migration is idempotent');
  for(const [index,phrase] of retainedUnpaidWordingCases.entries()){
   const id='sql-wording-'+index;await persist(id,phrase.message);
   const retained=phrase.total===draft.action.invoice.total?draft.action:{...draft.action,invoice:{...draft.action.invoice,total:phrase.total,subtotal:phrase.total,tax:0}};
   await db.exec('begin');
   try{
    await db.query('update whatsapp_pending_actions set action=$2 where id=$1',[draft.id,JSON.stringify(retained)]);
    const accepted=(await transition(candidate(id,phrase.message,retained,phrase.currency))).rows[0];
    assert.equal(accepted.action.stage,'proposal',phrase.name);assert.equal(accepted.action.invoice.currency,phrase.currency,phrase.name);
    assert.equal(accepted.action.invoice.outstanding,phrase.total,phrase.name);
   }finally{await db.exec('rollback');}
  }
  for(const params of [{version:draft.version+1},{workspace:randomUUID()},{customer:randomUUID()},{targetPhone:'+15555559999'}])assert.equal((await transition(valid,params)).rows.length,0);
  for(const tamper of [{...valid,invoice:{...valid.invoice,total:94}}, {...valid,invoice:{...valid.invoice,clientName:'Elsewhere'}},
   {...valid,paymentEvidence:{...valid.paymentEvidence,text:'tampered'}}, {...valid,sourceMessageId:'fabricated'},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{currency:'USD',outstanding:0}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{currency:'AUD',outstanding:93.5}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,ownerInstruction:instruction+' extra'}},
   {...valid,ownerProvidedFacts:{...valid.ownerProvidedFacts,currency:{value:'USD',sourceMessageId:'wrong'}}}])await assert.rejects(transition(tamper),/invoice review/);
  for(let index=0;index<contradictory.length;index++){const id='negative-'+index;await persist(id,contradictory[index]);await assert.rejects(transition(candidate(id,contradictory[index])),/invoice review/);}
  await db.query("update whatsapp_pending_actions set action=jsonb_set(action,'{validationIssues}',$2) where id=$1",[draft.id,JSON.stringify([...action.validationIssues,'UNCERTAIN_TOTAL'])]);
  await assert.rejects(transition(valid),/invoice review unpaid resolution/);
  await db.query("update whatsapp_pending_actions set action=jsonb_set($2,'{invoice,tax}','9') where id=$1",[draft.id,JSON.stringify(draft.action)]);
  await assert.rejects(transition(valid),/invoice review zero balance correction/);
  await db.query('update whatsapp_pending_actions set action=$2 where id=$1',[draft.id,JSON.stringify(draft.action)]);
  await db.query("update whatsapp_inbound_events set status='done' where provider_message_id='sql-positive'");await assert.rejects(transition(valid),/source is outside current owner scope/);
  await db.query("update whatsapp_inbound_events set status='processing' where provider_message_id='sql-positive'");
  await db.query("update whatsapp_messages set phone='+15555559999' where provider_message_id='sql-positive'");await assert.rejects(transition(valid),/source is outside current owner scope/);
  await db.query("update whatsapp_messages set phone=$1 where provider_message_id='sql-positive'",[phone]);
  await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 second' where id=$1",[draft.id]);assert.equal((await transition(valid)).rows.length,0);
  await db.query("update whatsapp_pending_actions set expires_at=now()+interval '15 minutes',consumed_at=now() where id=$1",[draft.id]);assert.equal((await transition(valid)).rows.length,0);
  await db.query('update whatsapp_pending_actions set consumed_at=null where id=$1',[draft.id]);
  const clarificationContract=contracts.length,startResults=results.length,clarified=await turn('correction-source',instruction);
  const proposal=await review();assert.equal(proposal.id,draft.id);assert.equal(proposal.action.stage,'proposal',JSON.stringify({proposal,results,clarified,errors:f.errors}));
  assert.equal(proposal.action.invoice.currency,'USD');assert.equal(proposal.action.invoice.outstanding,93.5);assert.equal(proposal.action.invoice.direction,'receivable');
  const sourceFacts=invoice=>Object.fromEntries(Object.entries(invoice).filter(([key])=>!['currency','outstanding','direction'].includes(key)));
  assert.deepEqual(sourceFacts(proposal.action.invoice),sourceFacts(draft.action.invoice));
  for(const key of ['paymentEvidence','sourceMessageId','currencyEvidence','assumptions','warnings','dueDateSource'])assert.deepEqual(proposal.action[key],draft.action[key],key);
  assert.deepEqual(proposal.action.validationIssues,[]);assert.deepEqual(proposal.action.paymentStatusResolution.extractedFacts,{currency:'AUD',outstanding:0});
  assert.equal(proposal.action.paymentStatusResolution.ownerInstruction,instruction);assert.equal(proposal.action.paymentStatusResolution.sourceMessageId,'correction-source');
  assert.deepEqual(proposal.action.ownerProvidedFacts,{currency:{value:'USD',sourceMessageId:'correction-source'},direction:{value:'receivable',sourceMessageId:'correction-source'}});
  assert.match(clarified.answer,/reply yes/i);assert.doesNotMatch(clarified.answer,/customer name|which customer|verified customer target/i);
  assert.equal(results.slice(startResults).some(result=>result.requiresLaterConfirmation===true),true);assert.equal(results.slice(startResults).some(result=>result.completed===true),false);
  assert.deepEqual(contracts[clarificationContract][0].functionDeclarations[0].parametersJsonSchema.properties.operation.enum,['reviewAttachment']);
  assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from invoice_files')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
  for(const table of ['payment_reversals','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,table);
  assert.deepEqual((await db.query("select action->>'type' type from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null",[workspaceId])).rows,[{type:'invoice_review_draft'}]);
  assert.equal(f.requests.some(request=>request.body?.p_operation==='invoice.create'||request.body?.p_operations?.some(operation=>operation.operation==='invoice.create')),false);
  const pending=createWhatsAppPendingActionStore({supabase});
  for(const [id,text] of [['correction-source',instruction],['later-question','What is the total?']]){
   const safety=createOwnerSafetyTools({supabase,scope:{workspaceId,ownerId,customerId,phone},pending,pendingAtStart:proposal,pendingInitialState:proposal,
    ownerStore:{workspaceId,userId:ownerId,role:'owner',async query(){throw Error('unconfirmed review must not read unrelated records');}},
    invoiceStoreFactory:()=>{throw Error('unconfirmed review must not construct a ledger writer');},authorize:async()=>true,
    sourceMediaReader:async()=>({bytes,mimeType:'image/jpeg'}),message:text,messageId:id,logger:{error(){}}});
   const rejected=await safety.execute('ingestInvoiceAttachment',{});assert.equal(rejected.ok,false);assert.equal(rejected.code,'INVALID');assert.match(rejected.message,/explicitly confirm|later message/);assert.deepEqual(await review(),proposal);
  }
  const savedReply=await turn('confirm-source','yes');assert.match(savedReply.answer,/Saved invoice INV-2026-0001/);
  const saved=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows;assert.equal(saved.length,1);
  assert.equal(Number(saved[0].total_amount),93.5);assert.equal(Number(saved[0].amount_paid),0);assert.equal(saved[0].currency,'USD');assert.equal(saved[0].status,'draft');
  assert.equal(saved[0].metadata.printed_invoice_number,'INV-3337');assert.equal(saved[0].metadata.invoice_direction,'receivable');assert.equal(saved[0].metadata.followup_state,'draft');
  assert.equal(saved[0].metadata.next_follow_up_at,null);
  const files=(await db.query('select * from invoice_files where workspace_id=$1',[workspaceId])).rows;assert.equal(files.length,1);
  const stored=await supabase.storage.from('invoice-files').download(files[0].storage_path);assert.equal(stored.error,null);assert.deepEqual(Buffer.from(await stored.data.arrayBuffer()),bytes);
  const savedReview=await review();assert.equal(savedReview.action.stage,'saved');assert.deepEqual(savedReview.action.paymentStatusResolution,proposal.action.paymentStatusResolution);assert.deepEqual(savedReview.action.paymentEvidence,draft.action.paymentEvidence);
  const calls=providerCalls,replay=await handler({workspaceId,ownerId,customerId,phone,messageId:'confirm-source',message:'yes'});assert.equal(replay.replayed,true);assert.equal(providerCalls,calls);assert.equal(extractions,1);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('retained correction source guard rejects unknown or mixed sources and historical guard rejects the new body',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[migrationName]}),{db}=f;
 try{
  const migration=await readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
  const routine=async()=>(await db.query("select prosrc,proowner,proacl,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const predecessor=await routine();
  for(const definition of [predecessor.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\r'),
   predecessor.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\n  -- source drift')]){
   await db.exec(definition);const drift=await routine();await assert.rejects(db.exec(migration),/Unexpected retained invoice review (?:source|line endings); no changes applied/);await db.exec('rollback');assert.deepEqual(await routine(),drift);
  }
  await db.exec(predecessor.definition);await db.exec(migration);const fixed=await routine();
  await db.exec(migration.replaceAll('\n','\r\n'));assert.deepEqual(await routine(),fixed,'reapplying a CRLF migration is idempotent');
  await db.exec(fixed.definition.replaceAll('\n','\r\n'));const fixedCrlf=await routine();await db.exec(migration);assert.deepEqual(await routine(),fixedCrlf,'known CRLF forward source stays unchanged');
  const oldMigration=await readFile(new URL('../supabase/migrations/20261008153500_owner_live_clarification_evidence.sql',import.meta.url),'utf8');
  await assert.rejects(db.exec(oldMigration),/Unexpected installed owner evidence source/);await db.exec('rollback');assert.deepEqual(await routine(),fixedCrlf);
 }finally{await f.close();}
});

test('retained correction acknowledgement and deadline failures never claim an unchanged review or retry a ledger write',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550131';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Correction failure fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const scope={workspaceId,ownerId,customerId,phone},basePending=createWhatsAppPendingActionStore({supabase});
  for(const mode of ['ack-after-commit','deadline-after-failure','deadline-before-transition','authorization-after-failure']){
   const token=await basePending.beginInvoiceReview(scope);
   const draft=await basePending.transitionInvoiceReview({...token,...scope,fromStage:'extracting',action:{...action,
    invoice:{...action.invoice,invoiceDate:'2026-10-01',dueDate:'2026-10-31',lineItems:[]}}});
   const messageId='failure-'+mode;
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,instruction]);
   await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,customerId,phone,instruction,messageId]);
   const controller=new AbortController();let reads=0,transitions=0,authorized=true,ledgerWriters=0;
   if(mode==='deadline-before-transition')controller.abort();
   const pending={...basePending,async loadInvoiceReview(input){reads++;return basePending.loadInvoiceReview(input);},
    async transitionInvoiceReview(input){transitions++;
     if(mode==='ack-after-commit')await basePending.transitionInvoiceReview(input);
     if(mode==='deadline-after-failure')controller.abort();
     if(mode==='authorization-after-failure')authorized=false;
     throw Object.assign(new Error('lost transition acknowledgement'),{code:'UNAVAILABLE'});
    }};
   const tools=createOwnerSafetyTools({supabase,scope,pending,pendingAtStart:draft,pendingInitialState:draft,
    ownerStore:{workspaceId,userId:ownerId,role:'owner',async query(){throw Error('correction must not query unrelated records');}},
    invoiceStoreFactory:()=>{ledgerWriters++;throw Error('correction must not construct a ledger writer');},authorize:async()=>authorized,
    message:instruction,messageId,signal:controller.signal,logger:{error(){}}});
   const output=await tools.execute('continueInvoiceReview',{currency:'USD',direction:'receivable'});
   assert.equal(output.ok,false);assert.equal(ledgerWriters,0);assert.doesNotMatch(output.message,/Nothing was saved|correction could not be recorded/);
   assert.equal((await tools.execute('proposeInvoiceCreation',{})).code,'PENDING','the failed correction cannot fall through to a generic create');
   const current=await basePending.loadInvoiceReview(scope);
   if(mode==='ack-after-commit'){
    assert.equal(reads,2);assert.equal(transitions,1);assert.equal(current.action.stage,'proposal');assert.equal(current.version,draft.version+1);
    assert.equal(current.action.invoice.currency,'USD');assert.equal(current.action.invoice.outstanding,93.5);
   }else{
    assert.equal(reads,1,'expired or unauthorized failure must not reread');assert.deepEqual(current,draft);
    assert.equal(transitions,mode==='deadline-before-transition'?0:1);
   }
  }
  for(const table of ['invoices','invoice_files','payments','payment_reversals','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])
   assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,table);
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
