import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const baseline=process.env.CETLD_PAYMENT_BASELINE||process.env.CETLD_PAYMENT_LEADING_BASELINE;
const base=baseline?pathToFileURL(baseline+'/'):new URL('../',import.meta.url);
const {createOfflineSqlNetwork}=await import(new URL('tests/fixtures/offline-sql-network.mjs',base));
const {createOwnerMessageHandler}=await import(new URL('automation/whatsapp/owner-handler.mjs',base));
const {AIProvider}=await import(new URL('ai/provider.mjs',base));
const {createOwnerWorkspaceTools}=await import(new URL('automation/whatsapp/owner-workspace-tools.mjs',base));
const prompt='Record a USD 500 test payment against invoice SB-10442 for Northwind Systems LLC. This is only a dummy bookkeeping entry. Keep customer messages and reminders off.';
const livePrompt='Record a USD 500 partial payment for the dummy invoice SB-10442 for Northwind Systems LLC. Keep customer messages and reminders off.';
const newMigration='20261008153500_owner_live_clarification_evidence.sql';
const leadingPrompt='For test invoice INV-2026-6769 for Northwind Systems LLC, record a partial payment of USD 500. This is a dummy bookkeeping entry only; keep messages and reminders off.';
const target=[{column:'invoice_number',operator:'eq',value:'SB-10442'}];
const proposal={operation:'create',table:'payments',filters:target,values:{amount:500,currency:'USD'}};
async function fixture(options={}){
 const excludeMigrations=options.excludeMigrations?.includes(newMigration)
  ?[...options.excludeMigrations,'20261008193550_invoice_review_inferred_currency_unpaid_correction.sql','20261009015001_owner_payment_factual_instruction.sql']:options.excludeMigrations;
 const f=await createOfflineSqlNetwork({...options,excludeMigrations}),{db,supabase}=f,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+12025550107';
 await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
 const workspace=async owner=>{await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);return (await db.query("select (create_workspace('Payment fixture',$1)).id",[randomUUID()])).rows[0].id;};
 const foreignWorkspace=await workspace(foreignOwner),workspaceId=await workspace(ownerId);
 const v=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,v.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 const ids=[];
 for(const ws of [workspaceId,foreignWorkspace]){
  const client=(await db.query("insert into customers(workspace_id,name) values($1,'Northwind Systems LLC') returning id",[ws])).rows[0].id;
  ids.push((await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-31','USD',951.52,'draft',$3) returning id",[ws,client,{invoice_direction:'receivable',printed_invoice_number:'SB-10442',source_document:{name:'original-source'},followup_state:'paused',next_follow_up_at:null}])).rows[0].id);
 }
 for(let index=0;index<6;index++)await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,(select customer_id from invoices where id=$2),'AUTO','2026-10-01','2026-10-31','USD',$3,'draft',$4)",[workspaceId,ids[0],100+index,{invoice_direction:'receivable',printed_invoice_number:'FIXTURE-OTHER-'+index,followup_state:'paused',next_follow_up_at:null}]);
 if(options.invoiceNumber)await db.query('update invoices set invoice_number=$2 where id=$1',[ids[0],options.invoiceNumber]);
 await db.query("insert into invoice_files(workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes) values($1,$2,$3,'original.pdf','application/pdf',123)",[workspaceId,ids[0],workspaceId+'/original.pdf']);
 const scope={workspaceId,ownerId,customerId,phone};
 await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
 const snapshot=async()=> (await db.query("select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i) order by id) from invoices i),'payments',(select jsonb_agg(to_jsonb(p) order by id) from payments p),'reversals',(select jsonb_agg(to_jsonb(r) order by id) from payment_reversals r),'files',(select jsonb_agg(to_jsonb(f) order by id) from invoice_files f),'outbound',(select count(*) from whatsapp_messages where audience='customer')) value")).rows[0].value;
 const inbound=async(id,message)=>db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
 return {...f,scope,ids,snapshot,inbound};
}
function handlerFor(f,{readTwice=false,readOnce=false,readTarget=target,operation=proposal,confirmation=false,repairPlan=null,planningMessage=null,keepReading=false,finalFunctionCall=false,transformToolResult=null,boundedPayment=true}={}){
 let calls=0;const outputs=[],requests=[],planningRequests=[];
 const response=parts=>Response.json({candidates:[{content:{parts},finishReason:'STOP'}]});
 const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',GEMINI_API_KEY:'isolated'},logger:{info(){},warn(){},error(){}},toolsFactory:options=>{
  const tools=createOwnerWorkspaceTools(options);
  return {...tools,supportsBoundedPaymentProposal:boundedPayment&&tools.supportsBoundedPaymentProposal,async execute(name,args,context){
   const actual=await tools.execute(name,args,context),result=transformToolResult?transformToolResult(actual,args):actual;
   outputs.push(result);return result;
  }};
 },providerFactory:options=>new AIProvider({...options,primaryModel:'gemini-3.5-flash-lite',fallbackModel:null}),fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');const body=JSON.parse(init.body);calls++;requests.push(body);
  if(body.generationConfig?.responseMimeType==='application/json'){
   planningRequests.push(body);assert.ok(repairPlan,'Unexpected planning request');
   const wire=JSON.stringify(body);assert.match(wire,/BATCH_SHAPE/);assert.ok(wire.includes(planningMessage));assert.match(wire,/payments/);assert.match(wire,/currency/);assert.match(wire,/amount/);
   return response([{text:JSON.stringify(repairPlan)}]);
  }
  const tools=body.contents.flatMap(row=>row.parts).flatMap(part=>part.functionResponse?[part.functionResponse.response]:[]),last=tools.at(-1);
  if(!body.tools&&finalFunctionCall)return response([{functionCall:{name:'workspaceData',args:{operation:'read',table:'invoices',filters:readTarget}}}]);
  if(!body.tools)return response([{text:last?.completed?`Recorded USD ${last.paymentAmount||500} payment. The remaining balance is USD ${last.outstandingAmount??451.52}. Reminders are paused.`:last?.proposal?'Proposed a USD 500 payment. The remaining balance would be USD 451.52. Reply yes to confirm or cancel.':'No changes were made.'}]);
  if(confirmation)return response([{functionCall:{name:'workspaceData',args:{operation:'confirm'}}}]);
  if(keepReading||readTwice&&tools.length<2||readOnce&&tools.length<1)return response([{functionCall:{name:'workspaceData',args:{operation:'read',table:'invoices',...(readOnce||tools.length?{filters:readTarget}:{}),columns:['invoice_number','customer_name','total_amount','amount_paid','currency','status']}},thoughtSignature:'c2ln'}]);
  return response([{functionCall:{name:'workspaceData',args:operation}}]);
 }});
 return {handler,outputs,requests,planningRequests,calls:()=>calls};
}
test('production tools select the scoped read and USD500 proposal before native planning, then later confirm exactly USD500',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),run=handlerFor(f,{readTwice:true});
  await f.inbound('payment-propose',prompt);const turn={...f.scope,messageId:'payment-propose',message:prompt};const result=await run.handler(turn);
  assert.equal(run.outputs[0].rows.length,1);
  if(process.env.CETLD_PAYMENT_BASELINE){assert.equal(run.calls(),3);assert.equal(run.requests[2].tools,undefined);assert.equal(run.outputs.some(out=>out.proposal),false);assert.deepEqual(await f.snapshot(),before);return;}
  assert.equal(run.calls(),0,JSON.stringify({result,outputs:run.outputs}));assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify(run.outputs));
  assert.equal(run.outputs.at(-1).details.paymentAmount,500);assert.equal(run.outputs.at(-1).details.outstandingAmount,451.52);
  assert.deepEqual(await f.snapshot(),before);assert.match(result.answer,/Proposed a USD 500/);
  const pending=(await f.db.query("select * from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null",[f.scope.workspaceId])).rows[0];
  assert.deepEqual(pending.action.changes,{amount:500,currency:'USD'});
  const confirm=handlerFor(f,{confirmation:true});await f.inbound('payment-confirm','yes');const saved=await confirm.handler({...f.scope,messageId:'payment-confirm',message:'yes'});
  assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify({saved,outputs:confirm.outputs,errors:f.errors}));assert.match(saved.answer,/remaining balance is USD 451.52/);
  const after=await f.snapshot(),invoice=after.invoices.find(row=>row.id===f.ids[0]);
  assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.status,'draft');assert.equal(invoice.currency,'USD');assert.equal(invoice.metadata.next_follow_up_at,null);assert.deepEqual(invoice.metadata.source_document,{name:'original-source'});
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);assert.equal(after.outbound,0);assert.deepEqual(after.files,before.files);
  assert.deepEqual(after.invoices.find(row=>row.id===f.ids[1]),before.invoices.find(row=>row.id===f.ids[1]));
  assert.deepEqual(after.invoices.filter(row=>row.id!==f.ids[0]),before.invoices.filter(row=>row.id!==f.ids[0]));
  const calls=confirm.calls();assert.equal((await confirm.handler({...f.scope,messageId:'payment-confirm',message:'yes'})).replayed,true);assert.equal(confirm.calls(),calls);assert.deepEqual(await f.snapshot(),after);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('one exact native read queues the canonical payment before an invalid model batch can run', {skip:Boolean(baseline)},async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
  const before=await f.snapshot(),currentTarget=[{column:'invoice_number',operator:'eq',value:'INV-2026-6769'}];
  await f.inbound('bounded-leading',leadingPrompt);
  const run=handlerFor(f,{readOnce:true,readTarget:currentTarget,operation:{operations:[{...proposal,filters:currentTarget}]}});
  const reply=await run.handler({...f.scope,messageId:'bounded-leading',message:leadingPrompt});
  assert.equal(run.calls(),0,JSON.stringify({reply,outputs:run.outputs}));assert.equal(run.planningRequests.length,0);
  assert.equal(run.outputs[0].rows.length,1);assert.equal(run.outputs.at(-1).proposal,true);
  assert.equal(run.outputs.at(-1).details.paymentAmount,500);assert.equal(run.outputs.at(-1).details.outstandingAmount,451.52);
  assert.equal(reply.answer,'Proposed a USD 500.00 payment for invoice INV-2026-6769. The remaining balance would be USD 451.52. Reply yes to confirm or cancel.');
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows;
  assert.equal(pending.length,1);assert.deepEqual(pending[0].action.changes,{amount:500,currency:'USD'});
  assert.equal(pending[0].action.requestedInvoiceNumber,'INV-2026-6769');assert.equal(pending[0].action.sourceMessageId,'bounded-leading');
  assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('exact live wording proposes locally despite endless native reads and a final function call, then confirms only USD500', {skip:Boolean(baseline)},async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
  const before=await f.snapshot();await f.inbound('endless-native-propose',livePrompt);
  const run=handlerFor(f,{keepReading:true,finalFunctionCall:true,readTwice:true});
  const reply=await run.handler({...f.scope,messageId:'endless-native-propose',message:livePrompt});
  assert.equal(run.calls(),0,JSON.stringify({reply,outputs:run.outputs}));
  assert.equal(run.requests.every(request=>Boolean(request.tools)),true,'proposal must not require a final model call');
  assert.equal(run.outputs[0].rows.length,1);assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify(run.outputs));
  assert.equal(reply.answer,'Proposed a USD 500.00 payment for invoice SB-10442. The remaining balance would be USD 451.52. Reply yes to confirm or cancel.');
  const pending=(await f.db.query("select * from whatsapp_pending_actions where consumed_at is null and action->>'type'='owner_invoice_payment'")).rows;
  assert.equal(pending.length,1);assert.deepEqual(pending[0].action.changes,{amount:500,currency:'USD'});
  assert.equal(pending[0].action.requestedInvoiceNumber,'SB-10442');assert.equal(pending[0].action.sourceMessageId,'endless-native-propose');
  assert.deepEqual(await f.snapshot(),before);
  await f.inbound('endless-native-confirm','yes');const confirm=handlerFor(f,{confirmation:true});
  const saved=await confirm.handler({...f.scope,messageId:'endless-native-confirm',message:'yes'});
  assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify({saved,outputs:confirm.outputs}));
  assert.equal(confirm.outputs.at(-1).paymentAmount,500);assert.equal(confirm.outputs.at(-1).outstandingAmount,451.52);
  const after=await f.snapshot(),invoice=after.invoices.find(row=>row.id===f.ids[0]);
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);
  assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.status,'draft');assert.equal(invoice.currency,'USD');
  assert.equal(invoice.metadata.next_follow_up_at,null);assert.deepEqual(invoice.metadata.source_document,{name:'original-source'});
  assert.deepEqual(after.files,before.files);assert.equal(after.outbound,0);
  assert.deepEqual(after.invoices.filter(row=>row.id!==f.ids[0]),before.invoices.filter(row=>row.id!==f.ids[0]));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('a wrong-target or truncated native invoice read cannot authorize the canonical proposal', {skip:Boolean(baseline)},async()=>{
 for(const [label,options]of [
  ['wrong-target',{transformToolResult:result=>result.operation==='read'?{...result,lookupInvoiceNumber:'OTHER',rows:result.rows.map(row=>({...row,invoice_number:'OTHER'}))}:result}],
  ['truncated',{transformToolResult:result=>result.operation==='read'?{...result,truncated:true}:result}],
 ]){
  const f=await fixture();try{
   const before=await f.snapshot(),id='bounded-read-'+label;await f.inbound(id,livePrompt);
   const run=handlerFor(f,{keepReading:true,readOnce:true,...options});
   const reply=await run.handler({...f.scope,messageId:id,message:livePrompt});
   assert.equal(run.outputs[0].rows.length,1);assert.equal(run.outputs.some(output=>output.proposal),false,JSON.stringify({reply,outputs:run.outputs}));
   assert.equal(run.outputs.some(output=>output.operation==='create'),false);assert.doesNotMatch(reply.answer,/Proposed|Recorded/);
   assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions where consumed_at is null')).rows[0].n,0);
   assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
 }
});
test('leading invoice syntax repairs native BATCH_SHAPE to a single model-selected payment and later confirms exactly USD500', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
  const {requestedOwnerPayment}=await import(new URL('automation/whatsapp/owner-payment-intent.mjs',base));
  for(const text of [prompt,leadingPrompt,'For invoice INV-2026-6769, log payment of USD 500.',
   'He said "'+leadingPrompt+'"','Do not '+leadingPrompt,'Can I '+leadingPrompt,'Yesterday I '+leadingPrompt,
   leadingPrompt+' Instead pay USD 600.',leadingPrompt.replace('record a partial','do not record a partial'),leadingPrompt.replace('USD 500.','USD 500?'),leadingPrompt.replace('USD 500','USD 500 or EUR 500')]){
   assert.deepEqual((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,requestedOwnerPayment(text),text);
  }
  const before=await f.snapshot(),currentTarget=[{column:'invoice_number',operator:'eq',value:'INV-2026-6769'}],single={...proposal,filters:currentTarget};
  await f.inbound('leading-propose',leadingPrompt);
  // An adapter without the bounded capability still rejects/repairs malformed
  // native operations through its normal validator and planner.
  const run=handlerFor(f,{boundedPayment:false,operation:{operations:[single]},repairPlan:single,planningMessage:leadingPrompt});
  const result=await run.handler({...f.scope,messageId:'leading-propose',message:leadingPrompt,history:[{role:'assistant',content:'Enter the payment amount for this invoice.'}]});
  assert.equal(run.planningRequests.length,1);assert.equal(run.calls(),3);
  if(process.env.CETLD_PAYMENT_LEADING_BASELINE){assert.equal(run.outputs.at(-1).ok,false);assert.equal(run.outputs.at(-1).planningRepair.validationCode,'BATCH_SHAPE');assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);return;}
  assert.equal(run.outputs.at(-1).planningRepair.validationCode,'BATCH_SHAPE');assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify({result,outputs:run.outputs,errors:f.errors}));
  assert.equal(run.outputs.at(-1).details.paymentAmount,500);assert.equal(run.outputs.at(-1).details.outstandingAmount,451.52);assert.deepEqual(await f.snapshot(),before);
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows[0];assert.deepEqual(pending.action.changes,{amount:500,currency:'USD'});assert.equal(pending.action.requestedInvoiceNumber,'INV-2026-6769');
  await f.inbound('leading-confirm','yes');const confirm=handlerFor(f,{confirmation:true});await confirm.handler({...f.scope,messageId:'leading-confirm',message:'yes'});
  assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify(confirm.outputs));assert.equal(confirm.outputs.at(-1).outstandingAmount,451.52);
  const after=await f.snapshot(),invoice=after.invoices.find(row=>row.id===f.ids[0]);assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.status,'draft');
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);assert.deepEqual(after.files,before.files);assert.deepEqual(invoice.metadata.source_document,before.invoices.find(row=>row.id===f.ids[0]).metadata.source_document);assert.equal(invoice.metadata.printed_invoice_number,'SB-10442');assert.equal(invoice.metadata.next_follow_up_at,null);assert.equal(after.outbound,0);
  assert.deepEqual(after.invoices.filter(row=>row.id!==f.ids[0]),before.invoices.filter(row=>row.id!==f.ids[0]));
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_owner_action_receipts where provider_message_id='leading-confirm'")).rows[0].n,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('allowed messages-off tails agree in JS and SQL and both instruction forms confirm exact partial amounts', {skip:Boolean(baseline)},async()=>{
 const {requestedOwnerPayment}=await import(new URL('automation/whatsapp/owner-payment-intent.mjs',base));
 const tails=['','This is only a dummy bookkeeping entry.','Keep customer messages and reminders off.','No customer messages or reminders.','This is only a dummy bookkeeping entry. Keep customer messages and reminders off.','This is only a dummy bookkeeping entry. No customer messages or reminders.','This is a dummy bookkeeping entry only; keep messages and reminders off.'];
 for(const [index,instruction]of ['Record a USD 500 test payment against invoice SB-10442 for Northwind Systems LLC.','For test invoice INV-2026-6769 for Northwind Systems LLC, record a partial payment of USD 500.'].entries()){
  const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
   for(const tail of tails){const text=instruction+' '+tail;assert.deepEqual((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,requestedOwnerPayment(text),text);assert.notEqual(requestedOwnerPayment(text),null);}
   for(const text of [instruction.replace('USD 500','USD 500 or EUR 500'),instruction.replace('Northwind Systems LLC','Northwind or Acme'),instruction.replace('USD','NOT'),instruction.replace(index?'INV-2026-6769':'SB-10442','or'),'Do not '+instruction,'He said "'+instruction+'"',instruction+' Instead pay USD 600.']){
    assert.equal(requestedOwnerPayment(text),null,text);assert.equal((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,null,text);
   }
   const message=instruction+' No customer messages or reminders.',id='allowed-tail-'+index,before=await f.snapshot();await f.inbound(id,message);
   const operation={...proposal,filters:[{column:'invoice_number',operator:'eq',value:index?'INV-2026-6769':'SB-10442'}]},run=handlerFor(f,{operation});await run.handler({...f.scope,messageId:id,message});assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify(run.outputs));assert.deepEqual(await f.snapshot(),before);
   await f.inbound(id+'-confirm','yes');const confirm=handlerFor(f,{confirmation:true});await confirm.handler({...f.scope,messageId:id+'-confirm',message:'yes'});assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify(confirm.outputs));assert.equal(confirm.outputs.at(-1).outstandingAmount,451.52);
   const after=await f.snapshot(),invoice=after.invoices.find(row=>row.id===f.ids[0]);assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.status,'draft');assert.equal(invoice.metadata.next_follow_up_at,null);assert.deepEqual(invoice.metadata.source_document,{name:'original-source'});assert.deepEqual(after.files,before.files);assert.equal(after.outbound,0);assert.deepEqual(after.invoices.filter(row=>row.id!==f.ids[0]),before.invoices.filter(row=>row.id!==f.ids[0]));
  }finally{await f.close();}
 }
});
test('payment batches remain invalid even when the planning repair proposes a two-item batch', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
  const before=await f.snapshot(),single={...proposal,filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-6769'}]};await f.inbound('leading-batch',leadingPrompt);
  const run=handlerFor(f,{boundedPayment:false,operation:{operations:[single]},repairPlan:{operations:[single,single]},planningMessage:leadingPrompt});await run.handler({...f.scope,messageId:'leading-batch',message:leadingPrompt});
  assert.equal(run.planningRequests.length,1);assert.equal(run.outputs.at(-1).validationCode,'BATCH_SHAPE');assert.equal(run.outputs.at(-1).writeAttempted,false);assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);
 }finally{await f.close();}
});
test('amount proposal rejects currency, full-settlement fallback, wrong target and quoted/negated requests', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture();try{
  const before=await f.snapshot();
  for(const [id,message,operation] of [
   ['wrong-currency',prompt,{...proposal,values:{amount:500,currency:'EUR'}}],
   ['full-settle',prompt,{operation:'update',table:'invoices',filters:target,values:{status:'paid'}}],
   ['wrong-target',prompt,{...proposal,filters:[{column:'invoice_number',operator:'eq',value:'OTHER'}]}],
   ['quoted','He said "'+prompt+'"',proposal],['negated','Do not '+prompt,proposal],['question','Can I '+prompt+'?',proposal],
  ]){await f.inbound(id,message);const run=handlerFor(f,{boundedPayment:false,operation});await run.handler({...f.scope,messageId:id,message});assert.equal(run.outputs.at(-1).ok,false,JSON.stringify({id,outputs:run.outputs}));assert.deepEqual(await f.snapshot(),before);}
 }finally{await f.close();}
});

test('partial confirmation preserves an original receipt and refuses a tampered currency or owner source', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture();try{
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}';set role authenticated`);
  await f.db.query('select record_invoice_payment($1,$2,100,$3,$4,false)',[f.scope.workspaceId,f.ids[0],'original-fixture-receipt','Original immutable receipt']);
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const original=(await f.db.query('select to_jsonb(p) value from payments p')).rows[0].value;
  const run=handlerFor(f);await f.inbound('history-propose',prompt);await run.handler({...f.scope,messageId:'history-propose',message:prompt});
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows[0];
  const snapshot=await f.snapshot();
  await f.db.query("update whatsapp_pending_actions set action=jsonb_set(action,'{changes,currency}','\"EUR\"') where id=$1",[pending.id]);
  await f.inbound('tampered-currency','yes');const invoke=id=>f.db.query('select whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) value',[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,pending.id,pending.version,id]);
  assert.equal((await invoke('tampered-currency')).rows[0].value.reason,'invalid_payment');assert.deepEqual(await f.snapshot(),snapshot);
  await f.db.query('update whatsapp_pending_actions set action=$2 where id=$1',[pending.id,pending.action]);
  await f.db.query("update whatsapp_inbound_events set message_text='He said record USD 500 payment against invoice SB-10442' where provider_message_id='history-propose'");
  await f.inbound('tampered-source','yes');assert.equal((await invoke('tampered-source')).rows[0].value.reason,'invalid_payment');assert.deepEqual(await f.snapshot(),snapshot);
  await f.db.query("update whatsapp_inbound_events set message_text=$1 where provider_message_id='history-propose'",[prompt]);
  await f.inbound('history-confirm','yes');const confirmed=handlerFor(f,{confirmation:true});await confirmed.handler({...f.scope,messageId:'history-confirm',message:'yes'});
  assert.equal(confirmed.outputs.at(-1).completed,true);const after=await f.snapshot();assert.equal(after.payments.length,2);assert.deepEqual(after.payments.find(p=>p.id===original.id),original);assert.equal(after.invoices.find(i=>i.id===f.ids[0]).amount_paid,600);assert.equal(confirmed.outputs.at(-1).outstandingAmount,351.52);assert.equal(after.outbound,0);
 }finally{await f.close();}
});
test('failed post-write readback never claims completion or executes a second payment', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture();try{
  await f.inbound('uncertain-propose',prompt);await handlerFor(f).handler({...f.scope,messageId:'uncertain-propose',message:prompt});
  f.intercept((url,options)=>{if(url.pathname==='/rest/v1/payments'&&options.method==='GET')throw new Error('isolated lost readback');});
  await f.inbound('uncertain-confirm','yes');const run=handlerFor(f,{confirmation:true});const reply=await run.handler({...f.scope,messageId:'uncertain-confirm',message:'yes'});
  assert.equal(run.outputs.some(out=>out.completed===true),false);assert.doesNotMatch(reply.answer,/Recorded USD 500|remaining balance is USD 451/);
  const after=await f.snapshot();assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.invoices.find(i=>i.id===f.ids[0]).amount_paid,500);assert.equal(after.outbound,0);
  assert.equal(f.requests.filter(r=>r.url.includes('/rpc/whatsapp_confirm_owner_invoice_action')).length,1);
 }finally{await f.close();}
});

test('forward migration is idempotent, refuses installed drift and preserves existing routine ACLs', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const {readFile}=await import('node:fs/promises');const sql=await readFile(new URL('supabase/migrations/20261008031733_owner_partial_payment_confirmation.sql',base),'utf8');
 const f=await fixture({excludeMigrations:[newMigration]});try{
  const routines=async()=> (await f.db.query("select proname,md5(prosrc) hash,proacl::text acl,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname in ('whatsapp_confirm_owner_invoice_action','whatsapp_apply_direct_owner_write','owner_payment_instruction') order by proname")).rows;
  const before=await routines(),state=await f.snapshot();
  await f.db.exec('set role service_role');assert.equal((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value.ok,true);await f.db.exec('reset role');
  assert.equal(before.find(r=>r.proname==='owner_payment_instruction').anon,false);assert.equal(before.find(r=>r.proname==='owner_payment_instruction').authenticated,false);assert.equal(before.find(r=>r.proname==='owner_payment_instruction').service,false);
  for(const name of ['whatsapp_confirm_owner_invoice_action','whatsapp_apply_direct_owner_write']){const row=before.find(r=>r.proname===name);assert.equal(row.anon,false);assert.equal(row.authenticated,false);assert.equal(row.service,true);}
  await f.db.exec(sql);assert.deepEqual(await routines(),before);assert.deepEqual(await f.snapshot(),state);
  const parserDefinition=(await f.db.query("select pg_get_functiondef('app.owner_payment_instruction(text)'::regprocedure) definition")).rows[0].definition;
  const parserEnd=parserDefinition.lastIndexOf('$function$');await f.db.exec(parserDefinition.slice(0,parserEnd)+'\n-- isolated parser source drift\n'+parserDefinition.slice(parserEnd));
  const parserDrifted=await routines();assert.equal((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value.ok,false);await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner payment instruction source/);await f.db.exec('rollback');assert.deepEqual(await routines(),parserDrifted);assert.deepEqual(await f.snapshot(),state);await f.db.exec(parserDefinition);
  const definition=(await f.db.query("select pg_get_functiondef('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure) definition")).rows[0].definition;
  assert.ok(definition.includes('$function$'));const end=definition.lastIndexOf('$function$');await f.db.exec(definition.slice(0,end)+'\n-- isolated source drift\n'+definition.slice(end));
  const drifted=await routines();await assert.rejects(()=>f.db.exec(sql),/Unexpected installed.*source/);await f.db.exec('rollback');
  assert.deepEqual(await routines(),drifted);assert.deepEqual(await f.snapshot(),state);assert.equal((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value.ok,false);
 }finally{await f.close();}
});

test('new runtime on old production SQL fails closed without any partial proposal or full settlement', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769',excludeMigrations:['20261008031733_owner_partial_payment_confirmation.sql',newMigration]});try{
  const before=await f.snapshot();
  for(const [id,message,operation]of [['old-schema-propose',prompt,proposal],['old-schema-leading',leadingPrompt,{...proposal,filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-6769'}]}]]){
   await f.inbound(id,message);const run=handlerFor(f,{readTwice:true,readTarget:operation.filters,operation});const reply=await run.handler({...f.scope,messageId:id,message});
   assert.equal(run.outputs.at(-1).ok,false);assert.equal(run.outputs.some(out=>out.proposal),false);assert.doesNotMatch(reply.answer,/Proposed|Recorded/);
  }
  await f.db.exec("create function public.whatsapp_owner_partial_payment_capability() returns jsonb language sql as $$select '{\"ok\":true,\"version\":1}'::jsonb$$");
  await f.inbound('old-capability-propose',leadingPrompt);const oldCapability=handlerFor(f,{operation:{...proposal,filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-6769'}]}});await oldCapability.handler({...f.scope,messageId:'old-capability-propose',message:leadingPrompt});assert.equal(oldCapability.outputs.at(-1).ok,false);assert.equal(oldCapability.outputs.some(out=>out.proposal),false);
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_pending_actions where consumed_at is null and action->>'type'='owner_invoice_payment'")).rows[0].n,0);
  await f.inbound('old-schema-yes','yes');await handlerFor(f,{confirmation:true}).handler({...f.scope,messageId:'old-schema-yes',message:'yes'});assert.deepEqual(await f.snapshot(),before);
  const {createOwnerDirectRuntime}=await import(new URL('automation/whatsapp/owner-direct-runtime.mjs',base));let called=false;
  const runtime=createOwnerDirectRuntime({supabase:f.supabase,scope:f.scope,message:'Confirm',messageId:'old-schema-button',authorize:async()=>true,adapter:{apply:async()=>{called=true;throw Error('must not execute');}}});
  assert.equal((await runtime.decideButton({interactionId:'oab1.fixture.signature',decision:'confirm',pending:{action:{type:'owner_invoice_payment',changes:{amount:500,currency:'USD'}}}})).ok,false);assert.equal(called,false);assert.deepEqual(await f.snapshot(),before);
 }finally{await f.close();}
});

test('a genuine signed amount proposal confirms through the button adapter and preserves full-settlement compatibility', {skip:Boolean(process.env.CETLD_PAYMENT_BASELINE)},async()=>{
 const f=await fixture();try{
  await f.inbound('button-propose',prompt);await handlerFor(f).handler({...f.scope,messageId:'button-propose',message:prompt});
  const pending=(await f.db.query('select to_jsonb(p) value from whatsapp_pending_actions p where consumed_at is null')).rows[0].value;
  await f.db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"buttons\"}' where workspace_id=$1",[f.scope.workspaceId]);
  const {createOwnerActionButtons,verifyOwnerActionButton}=await import(new URL('automation/whatsapp/owner-action-buttons.mjs',base));
  const env={CRON_SECRET:'isolated signing fixture'},buttons=createOwnerActionButtons({scope:f.scope,action:pending,env});assert.equal(buttons.length,2);
  const verified=verifyOwnerActionButton({id:buttons[0].id,scope:f.scope,action:pending,env});assert.equal(verified.valid,true,JSON.stringify(verified));
  await f.inbound('button-confirm','Confirm');await f.db.query("update whatsapp_inbound_events set interaction_id=$1,message_type='interactive' where provider_message_id='button-confirm'",[buttons[0].id]);
  const {createOwnerDirectRuntime}=await import(new URL('automation/whatsapp/owner-direct-runtime.mjs',base));
  const runtime=createOwnerDirectRuntime({supabase:f.supabase,scope:f.scope,message:'Confirm',messageId:'button-confirm',authorize:async()=>true});
  const result=await runtime.decideButton({interactionId:buttons[0].id,decision:verified.decision,pending});assert.equal(result.completed,true,JSON.stringify({result,errors:f.errors}));assert.equal(result.paymentAmount,500);assert.equal(result.outstandingAmount,451.52);
  const after=await f.snapshot();assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.outbound,0);
  await f.inbound('legacy-paid-propose','Mark invoice SB-10442 paid.');const legacy=handlerFor(f,{operation:{operation:'update',table:'invoices',filters:target,values:{status:'paid'}}});await legacy.handler({...f.scope,messageId:'legacy-paid-propose',message:'Mark invoice SB-10442 paid.'});
  assert.equal(legacy.outputs.at(-1).proposal,true);const full=(await f.db.query("select * from whatsapp_pending_actions where consumed_at is null")).rows[0];assert.deepEqual(full.action.changes,{status:'paid'});
  await f.inbound('legacy-paid-confirm','yes');const fullResult=(await f.db.query('select whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) value',[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,full.id,full.version,'legacy-paid-confirm'])).rows[0].value;assert.equal(fullResult.ok,true);
  const final=await f.snapshot();assert.equal(final.payments.length,2);assert.equal(final.payments.find(p=>p.settle_remaining).amount,451.52);assert.equal(final.invoices.find(i=>i.id===f.ids[0]).amount_paid,951.52);assert.equal(final.invoices.find(i=>i.id===f.ids[0]).status,'paid');assert.equal(final.outbound,0);
 }finally{await f.close();}
});

test('exact live partial-payment wording uses the production native routing and immutable source SQL',async()=>{
 const f=await fixture({invoiceNumber:'INV-2026-6769'});try{
  const {requestedOwnerPayment,ownerPaymentAmountMentioned}=await import(new URL('automation/whatsapp/owner-payment-intent.mjs',base));
  assert.deepEqual(requestedOwnerPayment(livePrompt),{amount:500,currency:'USD',invoiceNumber:'SB-10442',customerName:'Northwind Systems LLC'});
  for(const text of [livePrompt,livePrompt.replace('partial payment','payment'),livePrompt.replace('the dummy invoice','invoice'),
    'He said "'+livePrompt+'"','Do not '+livePrompt,livePrompt+' Instead pay USD 600.',livePrompt.replace('USD 500','USD 500 or EUR 500')]){
   assert.deepEqual((await f.db.query('select app.owner_payment_instruction($1) value',[text])).rows[0].value,requestedOwnerPayment(text));
  }
  const before=await f.snapshot();await f.inbound('live-phrase-propose',livePrompt);
  const run=handlerFor(f,{readTwice:true});const reply=await run.handler({...f.scope,messageId:'live-phrase-propose',message:livePrompt});
  assert.equal(run.outputs[0].rows.length,1);assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify({reply,outputs:run.outputs}));
  assert.deepEqual(await f.snapshot(),before);const pending=(await f.db.query("select * from whatsapp_pending_actions where consumed_at is null")).rows[0];
  assert.deepEqual(pending.action.changes,{amount:500,currency:'USD'});assert.equal(pending.action.sourceMessageId,'live-phrase-propose');assert.equal(pending.action.requestedInvoiceNumber,'SB-10442');
  await f.inbound('live-phrase-confirm','yes');const confirm=handlerFor(f,{confirmation:true});await confirm.handler({...f.scope,messageId:'live-phrase-confirm',message:'yes'});
  assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify(confirm.outputs));assert.equal(confirm.outputs.at(-1).outstandingAmount,451.52);
  const after=await f.snapshot(),invoice=after.invoices.find(i=>i.id===f.ids[0]);assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.status,'draft');assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);assert.deepEqual(after.files,before.files);assert.equal(after.outbound,0);assert.deepEqual(after.invoices.filter(i=>i.id!==f.ids[0]),before.invoices.filter(i=>i.id!==f.ids[0]));
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('unsupported partial and amount wording cannot stage or confirm full settlement',async()=>{
 const f=await fixture();try{
  const {requestedOwnerPayment,ownerPaymentAmountMentioned}=await import(new URL('automation/whatsapp/owner-payment-intent.mjs',base));
  const before=await f.snapshot();
  for(const [index,text]of ['Record a USD 500 partial payment for invoice SB-10442 or SB-10443.','Record a partial payment of 500 for invoice SB-10442.','Log a payment of USD 500 for this invoice.','He said "'+livePrompt+'"',livePrompt+' Instead pay USD 600.'].entries()){
   assert.equal(requestedOwnerPayment(text),null);assert.equal(ownerPaymentAmountMentioned(text),true);
   assert.equal((await f.db.query('select app.owner_payment_amount_mentioned($1) value',[text])).rows[0].value,true);
   const id='unsupported-amount-'+index;await f.inbound(id,text);const run=handlerFor(f,{operation:{operation:'update',table:'invoices',filters:target,values:{status:'paid'}}});await run.handler({...f.scope,messageId:id,message:text});assert.equal(run.outputs.at(-1).ok,false);assert.equal(run.outputs.at(-1).proposal,undefined);
   // Simulate a legacy/misrouted proposal bypassing runtime: SQL must independently deny it.
   await f.db.query("update whatsapp_pending_actions set consumed_at=now() where consumed_at is null");
   const invoice=(await f.db.query('select * from invoices where id=$1',[f.ids[0]])).rows[0];
   const {createDirectOwnerWriteAdapter}=await import(new URL('automation/whatsapp/direct-owner-write.mjs',base));
   const adapter=createDirectOwnerWriteAdapter({supabase:f.supabase});
   const direct=await adapter.apply({workspaceId:f.scope.workspaceId,ownerId:f.scope.ownerId,phone:f.scope.phone,providerMessageId:id,authorization:{kind:'instruction',quote:text},operation:'invoice.update',targetId:invoice.id,expectedUpdatedAt:new Date(invoice.updated_at).toISOString(),payload:{status:'paid'}});
   assert.equal(direct.ok,false);assert.equal(direct.code,'PAYMENT_GUARD');assert.deepEqual(await f.snapshot(),before);
   const action={type:'owner_invoice_payment',invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,expectedUpdatedAt:new Date(invoice.updated_at).toISOString(),changes:{status:'paid'},sourceMessageId:id};
   const pending=(await f.db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,generation) values($1,$2,$3,$4,'whatsapp',$5) returning *",[f.scope.workspaceId,f.scope.customerId,f.scope.phone,action,900])).rows[0];
   await f.inbound(id+'-confirm','yes');const result=(await f.db.query('select whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) value',[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,pending.id,pending.version,id+'-confirm'])).rows[0].value;
   assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(await f.snapshot(),before);
  }
 }finally{await f.close();}
});
test('previous version-2 SQL cannot expose a confirmable new wording proposal',async()=>{
 const f=await fixture({excludeMigrations:[newMigration]});try{
  assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:2});
  assert.equal((await f.db.query('select app.owner_payment_instruction($1) value',[livePrompt])).rows[0].value,null,'the installed version-2 source parser rejects the exact live wording');
  const before=await f.snapshot();await f.inbound('v2-live',livePrompt);const run=handlerFor(f);await run.handler({...f.scope,messageId:'v2-live',message:livePrompt});
  assert.equal(run.outputs.at(-1).code,'UNAVAILABLE');assert.equal(run.outputs.some(o=>o.proposal),false);assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);
 }finally{await f.close();}
});

async function seedReview249(f,{expiresAt='2000-01-01T00:00:00Z',stage='incomplete'}={}){
 const action={type:'invoice_review_draft',stage,sourceMessageId:'event-249-old-attachment',missingFields:['currency'],invoice:{invoiceNumber:'OLD-249',total:951.52}};
 await f.db.query('insert into whatsapp_pending_actions(id,workspace_id,customer_id,phone,action,source,version,generation,expires_at) values(29,$1,$2,$3,$4,\'whatsapp\',1,29,$5)',
  [f.scope.workspaceId,f.scope.customerId,f.scope.phone,action,expiresAt]);
 // Reviews outside each dimension of the verified conversation must survive.
 const foreign=(await f.db.query('select workspace_id,customer_id from invoices where id=$1',[f.ids[1]])).rows[0];
 for(const [id,workspaceId,customerId,phone]of [
  [30,foreign.workspace_id,foreign.customer_id,f.scope.phone],
  [31,f.scope.workspaceId,(await f.db.query('select customer_id from invoices where id=$1',[f.ids[0]])).rows[0].customer_id,f.scope.phone],
  [32,f.scope.workspaceId,f.scope.customerId,'+12025550199'],
 ])await f.db.query('insert into whatsapp_pending_actions(id,workspace_id,customer_id,phone,action,source,version,generation,expires_at) values($1,$2,$3,$4,$5,\'whatsapp\',1,29,$6)',[id,workspaceId,customerId,phone,action,'2000-01-01T00:00:00Z']);
 return (await f.db.query('select to_jsonb(p) value from whatsapp_pending_actions p where id in (30,31,32) order by id')).rows.map(row=>row.value);
}

for(const [label,expiresAt,stage,retired]of [
 ['expired incomplete','2000-01-01T00:00:00Z','incomplete',true],
 ['undated incomplete',null,'incomplete',true],
 ['future incomplete','2100-01-01T00:00:00Z','incomplete',false],
 ['expired saving','2000-01-01T00:00:00Z','saving',false],
])test(`verified native owner turn ${label} review 29 before USD500 proposal`,async()=>{
 const f=await fixture();try{
  const otherReviews=await seedReview249(f,{expiresAt,stage}),before=await f.snapshot();
  await f.inbound('review249-payment',livePrompt);
  const run=handlerFor(f,{readOnce:true}),result=await run.handler({...f.scope,messageId:'review249-payment',message:livePrompt});
  const old=(await f.db.query('select * from whatsapp_pending_actions where id=29')).rows[0];
  assert.equal(Boolean(old.consumed_at),retired,JSON.stringify({result,outputs:run.outputs,errors:f.errors}));
  assert.equal(run.outputs.some(out=>out.proposal),retired,JSON.stringify({result,outputs:run.outputs}));
  assert.deepEqual(await f.snapshot(),before,'proposal or blocked review cannot write ledger or customer messages');
  const reviewLoads=f.requests.filter(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_load_invoice_review'));
  assert.equal(reviewLoads.length,1);assert.deepEqual(reviewLoads[0].body,{p_workspace_id:f.scope.workspaceId,p_customer_id:f.scope.customerId,p_phone:f.scope.phone});
  const contextQueries=f.requests.filter(request=>new URL(request.url).pathname==='/rest/v1/whatsapp_pending_actions'&&new URL(request.url).searchParams.get('consumed_at')==='is.null');
  assert.ok(contextQueries.length>=2,'refresh pending action after review RPC');
  assert.ok(f.requests.filter(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_load_pending_action_state')).length>=2,'refresh CAS state after review RPC');
  assert.deepEqual((await f.db.query('select to_jsonb(p) value from whatsapp_pending_actions p where id in (30,31,32) order by id')).rows.map(row=>row.value),otherReviews);
  if(retired){
   assert.match(result.answer,/Proposed a USD 500/);assert.doesNotMatch(result.answer,/Recorded/);
   const pending=(await f.db.query("select * from whatsapp_pending_actions where workspace_id=$1 and customer_id=$2 and phone=$3 and consumed_at is null",[f.scope.workspaceId,f.scope.customerId,f.scope.phone])).rows[0];
   assert.equal(pending.generation,30);assert.deepEqual(pending.action.changes,{amount:500,currency:'USD'});
   const store=f.requests.find(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_store_pending_action'));
   assert.equal(store.body.p_expected_generation,29);assert.equal(store.body.p_expected_id,null);assert.equal(store.body.p_expected_version,null);
   const calls=run.calls();assert.equal((await run.handler({...f.scope,messageId:'review249-payment',message:livePrompt})).replayed,true);assert.equal(run.calls(),calls);
   await f.inbound('review249-yes','yes');const confirm=handlerFor(f,{confirmation:true});await confirm.handler({...f.scope,messageId:'review249-yes',message:'yes'});
   assert.equal(confirm.outputs.at(-1).completed,true,JSON.stringify(confirm.outputs));
   const after=await f.snapshot(),invoice=after.invoices.find(row=>row.id===f.ids[0]);
   assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);assert.equal(after.outbound,0);
   assert.deepEqual(after.files,before.files);assert.deepEqual(after.invoices.filter(row=>row.id!==f.ids[0]),before.invoices.filter(row=>row.id!==f.ids[0]));
  }else{
   assert.ok(run.outputs.some(out=>out.code==='PENDING'),JSON.stringify(run.outputs));assert.doesNotMatch(result.answer,/Proposed|Recorded/);
   assert.equal(f.requests.some(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_expire_owner_pending')),false,'saving is never passed to generic expiration');
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const fault of ['review-rpc','state-reload','action-reload','proposal-cas'])test(`review249 ${fault} failure cannot stage a partial payment`,async()=>{
 const f=await fixture();try{
  await seedReview249(f);const before=await f.snapshot();let stateReads=0,actionReads=0,failed=false;
  f.intercept(async(url,options)=>{
   const rpc=url.pathname;
   if(rpc.endsWith('/rpc/whatsapp_load_pending_action_state'))stateReads++;
   if(rpc==='/rest/v1/whatsapp_pending_actions'&&url.searchParams.get('consumed_at')==='is.null')actionReads++;
   if(fault==='review-rpc'&&rpc.endsWith('/rpc/whatsapp_load_invoice_review')||fault==='state-reload'&&stateReads===2&&rpc.endsWith('/rpc/whatsapp_load_pending_action_state')||fault==='action-reload'&&actionReads>=2&&rpc==='/rest/v1/whatsapp_pending_actions'){
    failed=true;throw Error('isolated '+fault);
   }
   if(fault==='proposal-cas'&&rpc.endsWith('/rpc/whatsapp_store_pending_action')){
    failed=true;await f.db.exec('update whatsapp_pending_actions set generation=30 where id=29');
   }
  });
  await f.inbound('review249-fault',livePrompt);const run=handlerFor(f,{readOnce:true}),reply=await run.handler({...f.scope,messageId:'review249-fault',message:livePrompt});
  assert.equal(failed,true);assert.equal(run.outputs.some(out=>out.proposal),false,JSON.stringify({reply,outputs:run.outputs}));assert.doesNotMatch(reply.answer,/Proposed|Recorded/);
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_pending_actions where action->>'type'='owner_invoice_payment'")).rows[0].n,0);
  assert.deepEqual(await f.snapshot(),before);
 }finally{await f.close();}
});

for(const fault of ['wrong-owner','wrong-workspace','wrong-phone'])test(`review249 ${fault} cannot reach review retirement`,async()=>{
 const f=await fixture();try{
  await seedReview249(f);const rows=(await f.db.query('select to_jsonb(p) value from whatsapp_pending_actions p order by id')).rows;
  const invalid={...f.scope,...(fault==='wrong-owner'?{ownerId:randomUUID()}:fault==='wrong-workspace'?{workspaceId:randomUUID()}:{phone:'+12025550198'})};
  const run=handlerFor(f,{readOnce:true});assert.equal(await run.handler({...invalid,messageId:'review249-denied',message:livePrompt}), '');assert.equal(run.calls(),0);
  assert.equal(f.requests.some(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_load_invoice_review')),false);
  assert.deepEqual((await f.db.query('select to_jsonb(p) value from whatsapp_pending_actions p order by id')).rows,rows);
 }finally{await f.close();}
});

test('review249 context completing after request timeout cannot reach provider or proposal',async t=>{
 const f=await fixture();try{
  await seedReview249(f);const before=await f.snapshot();let release,entered;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.intercept(async url=>{if(url.pathname.endsWith('/rpc/whatsapp_load_invoice_review')){entered();await waiting;}});
  const run=handlerFor(f,{readOnce:true});
  const pending=run.handler({...f.scope,messageId:'review249-timeout',message:livePrompt});
  await started;
  // Expire the request only after the RPC starts; shared CPU load must not
  // cause authorization to time out before this deliberately stalled read.
  const expiredNow=Date.now()+60_000;t.mock.method(Date,'now',()=>expiredNow);
  release();
  const reply=await pending;assert.equal(reply.plannerFailure?.code,'OWNER_AGENT_TOOL_FAILED');
  assert.equal(run.calls(),0);assert.equal(f.requests.some(request=>new URL(request.url).pathname.endsWith('/rpc/whatsapp_store_pending_action')),false);assert.deepEqual(await f.snapshot(),before);
 }finally{await f.close();}
});
