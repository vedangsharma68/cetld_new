import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

const failedPrompt='Record a USD 500 partial payment on the dummy Northwind Systems LLC invoice SB-10442. Leave USD 451.52 outstanding. This is a test bookkeeping entry; do not send any customer messages or reminders.';
async function fixture(){
 const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+12025550252';
 await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
 const workspace=async actor=>{
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
  return (await db.query("select (create_workspace('Business payment fixture',$1)).id",[randomUUID()])).rows[0].id;
 };
 const foreignWorkspace=await workspace(foreignOwner),workspaceId=await workspace(ownerId);
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id,ids=[];
 for(const ws of [workspaceId,foreignWorkspace]){
  const client=(await db.query("insert into customers(workspace_id,name) values($1,'Northwind Systems LLC') returning id",[ws])).rows[0].id;
  ids.push((await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-31','USD',951.52,'draft',$3) returning id",[ws,client,{invoice_direction:'receivable',printed_invoice_number:'SB-10442',source_document:{name:'original.pdf'},followup_state:'paused',next_follow_up_at:null}])).rows[0].id);
 }
 await db.query("insert into invoice_files(workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes) values($1,$2,$3,'original.pdf','application/pdf',123)",[workspaceId,ids[0],workspaceId+'/original.pdf']);
 await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
 const scope={workspaceId,ownerId,customerId,phone};
 const inbound=async(id,message)=>db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
 const snapshot=async()=> (await db.query("select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i) order by id) from invoices i),'payments',(select jsonb_agg(to_jsonb(p) order by id) from payments p),'reversals',(select jsonb_agg(to_jsonb(r) order by id) from payment_reversals r),'files',(select jsonb_agg(to_jsonb(f) order by id) from invoice_files f),'outbound',(select count(*) from whatsapp_messages where audience='customer')) value")).rows[0].value;
 return {...f,scope,ids,inbound,snapshot};
}
function nativeHandler(f,{transform=null}={}){
 let calls=0,mode='malformed';const outputs=[],executions=[];
 const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},toolsFactory:options=>{
  const tools=createOwnerWorkspaceTools(options);
  return {...tools,async execute(name,args,context){
   executions.push({name,args});
   const actual=await tools.execute(name,args,context),result=transform?transform(actual,args):actual;
   outputs.push(result);return result;
  }};
 },fetchImpl:async(url,init)=>{
  calls++;assert.equal(new URL(url).hostname,'api.cloudflare.com');
  const body=JSON.parse(init.body),tool=body.messages.findLast(item=>item.role==='tool');
  assert.equal(body.model,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  // This reproduces the observed INVALID class, not the unlogged production
  // arguments. A supported current request must never depend on this planner.
  if(mode==='malformed')return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'malformed-operation',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'recordPayment',invoice:'SB-10442',amount:500})}}]}}]});
  if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'later-confirmation',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}}]}}]});
  const result=JSON.parse(tool.content);
  return Response.json({choices:[{finish_reason:'stop',message:{content:result.completed?`Recorded ${result.currency} ${result.paymentAmount} payment. The remaining balance is ${result.currency} ${result.outstandingAmount}. Reminders are paused.`:'No payment was recorded.'}}]});
 }});
 return {handler,outputs,executions,calls:()=>calls,confirm:()=>{mode='confirm';}};
}

test('exact event252 business prompt uses production tools before Cloudflare and later records one exact payment',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),run=nativeHandler(f);await f.inbound('business-propose',failedPrompt);
  const scope={...f.scope,messageId:'business-propose',message:failedPrompt},reply=await run.handler(scope);
  assert.equal(run.calls(),0,JSON.stringify({reply,outputs:run.outputs}));
  assert.deepEqual(run.executions.map(x=>x.args.operation),['read','create']);
  assert.deepEqual(run.executions[0].args.filters,[{column:'invoice_number',operator:'eq',value:'SB-10442'},{column:'customer_name',operator:'eq',value:'Northwind Systems LLC'}]);
  assert.equal(run.outputs[0].rows.length,1);assert.equal(run.outputs[0].lookupInvoiceNumber,'SB-10442');assert.equal(run.outputs.at(-1).proposal,true);
  assert.match(reply.answer,/Proposed a USD 500\.00 payment/);assert.match(reply.answer,/remaining balance would be USD 451\.52/);assert.doesNotMatch(reply.answer,/Recorded/);
  assert.deepEqual(await f.snapshot(),before);
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows;
  assert.equal(pending.length,1);assert.equal(pending[0].action.sourceMessageId,'business-propose');assert.deepEqual(pending[0].action.changes,{amount:500,currency:'USD'});
  assert.equal((await run.handler(scope)).replayed,true);assert.equal(run.calls(),0);
  run.confirm();await f.inbound('business-yes','yes');const confirmScope={...f.scope,messageId:'business-yes',message:'yes'},saved=await run.handler(confirmScope);
  assert.equal(run.outputs.at(-1).completed,true,JSON.stringify({saved,outputs:run.outputs}));assert.match(saved.answer,/remaining balance is USD 451\.52/);
  const after=await f.snapshot(),invoice=after.invoices.find(x=>x.id===f.ids[0]);
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,500);assert.equal(after.payments[0].settle_remaining,false);
  assert.equal(invoice.amount_paid,500);assert.equal(invoice.total_amount,951.52);assert.equal(invoice.currency,'USD');assert.equal(invoice.status,'draft');
  assert.equal(invoice.metadata.next_follow_up_at,null);assert.deepEqual(invoice.metadata.source_document,{name:'original.pdf'});assert.deepEqual(after.files,before.files);
  assert.deepEqual(after.invoices.find(x=>x.id===f.ids[1]),before.invoices.find(x=>x.id===f.ids[1]));assert.equal(after.outbound,0);
  const calls=run.calls();assert.equal((await run.handler(confirmScope)).replayed,true);assert.equal(run.calls(),calls);assert.deepEqual(await f.snapshot(),after);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('ordinary invoice-first wording preserves a different customer, currency, amount and explicit remainder',async()=>{
 const f=await fixture();try{
  await f.db.query("update customers set name='Riverside Studio' where id=(select customer_id from invoices where id=$1)",[f.ids[0]]);
  await f.db.query("update invoices set currency='CHF',total_amount=42,metadata=jsonb_set(metadata,'{printed_invoice_number}','\"RW-24\"') where id=$1",[f.ids[0]]);
  const message='For invoice number RW-24 for Riverside Studio, please log a payment of CHF 12.25. Keep CHF 29.75 remaining. No customer messages or reminders.';
  const before=await f.snapshot(),run=nativeHandler(f);await f.inbound('other-currency-propose',message);
  const reply=await run.handler({...f.scope,messageId:'other-currency-propose',message});assert.equal(run.calls(),0);assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify({reply,outputs:run.outputs}));
  assert.match(reply.answer,/CHF 12\.25/);assert.match(reply.answer,/CHF 29\.75/);assert.deepEqual(await f.snapshot(),before);
  run.confirm();await f.inbound('other-currency-yes','yes');const saved=await run.handler({...f.scope,messageId:'other-currency-yes',message:'yes'});
  assert.equal(run.outputs.at(-1).completed,true,JSON.stringify({saved,outputs:run.outputs}));
  const after=await f.snapshot(),invoice=after.invoices.find(x=>x.id===f.ids[0]);assert.equal(invoice.currency,'CHF');assert.equal(invoice.total_amount,42);assert.equal(invoice.amount_paid,12.25);
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,12.25);assert.equal(after.outbound,0);assert.deepEqual(after.files,before.files);
  assert.deepEqual(after.invoices.find(x=>x.id===f.ids[1]),before.invoices.find(x=>x.id===f.ids[1]));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const fault of ['wrong-customer','missing','ambiguous','truncated','wrong-read','read-failure','wrong-remainder','old-capability'])test(`business payment ${fault} refuses without model fallback, broader reads or ledger changes`,async()=>{
 const f=await fixture();try{
  if(fault==='ambiguous'){
   const duplicateName=(await f.db.query("insert into customers(workspace_id,name) values($1,'Northwind Systems LLC') returning id",[f.scope.workspaceId])).rows[0].id;
   await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) select workspace_id,$2,'AUTO',issue_date,due_date,currency,total_amount,status,metadata from invoices where id=$1",[f.ids[0],duplicateName]);
  }
  if(fault==='old-capability')await f.db.exec("create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb language sql as $$select '{\"ok\":true,\"version\":3}'::jsonb$$");
  if(fault==='read-failure')f.intercept(url=>{if(url.pathname==='/rest/v1/invoices')throw Error('isolated invoice context read failure');});
  const run=nativeHandler(f,{transform:(result,args)=>args.operation!=='read'?result:fault==='truncated'?{...result,truncated:true}:fault==='wrong-read'?{...result,lookupInvoiceNumber:'OTHER',rows:[{...result.rows?.[0],invoice_number:'OTHER'}]}:result});
  const message=fault==='wrong-customer'?failedPrompt.replace('Northwind Systems LLC','Other Business LLC'):fault==='missing'?failedPrompt.replace('SB-10442','MISSING-42'):fault==='wrong-remainder'?failedPrompt.replace('451.52','450.00'):failedPrompt;
  const before=await f.snapshot();await f.inbound('business-'+fault,message);const reply=await run.handler({...f.scope,messageId:'business-'+fault,message});
  assert.equal(run.calls(),0,JSON.stringify({reply,outputs:run.outputs}));assert.equal(run.outputs.some(x=>x.proposal||x.completed),false);assert.doesNotMatch(reply.answer,/Proposed|Recorded/);
  assert.equal(run.executions.filter(x=>x.args.operation==='read').length,1);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);assert.deepEqual(await f.snapshot(),before);
  if(fault!=='read-failure')assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('an interrupted proposal checkpoint cannot replay a payment operation or create a second proposal',async()=>{
 const f=await fixture();try{
  const run=nativeHandler(f),before=await f.snapshot();let persisted;
  await f.inbound('interrupted-business',failedPrompt);
  const scope={...f.scope,messageId:'interrupted-business',message:failedPrompt,allowDeferred:true};
  const interrupted=await run.handler({...scope,onCheckpoint:async checkpoint=>{
   if(checkpoint.uncertainWrite==='owner-payment-proposal'){
    persisted=structuredClone(checkpoint);
    throw Object.assign(Error('isolated interruption after checkpoint persistence'),{code:'OWNER_AGENT_TIMEOUT'});
   }
  }});
  assert.equal(interrupted.deferred,true,JSON.stringify(interrupted));assert.ok(persisted);assert.equal(persisted.boundedPaymentReadSelected,true);assert.equal(persisted.boundedPaymentSelected,true);
  assert.equal(run.executions.filter(x=>x.args.operation==='create').length,0);assert.equal(run.calls(),0);assert.deepEqual(await f.snapshot(),before);
  const resumed=await run.handler({...scope,checkpoint:persisted});
  assert.equal(resumed.deferred,undefined);assert.equal(run.executions.filter(x=>x.args.operation==='create').length,0);assert.equal(run.calls(),0);
  assert.doesNotMatch(resumed.answer,/Proposed|Recorded/);assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);assert.deepEqual(await f.snapshot(),before);
 }finally{await f.close();}
});

test('a deferred server-selected invoice read resumes to one proposal with its original customer constraint',async()=>{
 const f=await fixture();try{
  const run=nativeHandler(f),before=await f.snapshot();let persisted;
  await f.inbound('deferred-business-read',failedPrompt);
  const scope={...f.scope,messageId:'deferred-business-read',message:failedPrompt,allowDeferred:true};
  const interrupted=await run.handler({...scope,onCheckpoint:async checkpoint=>{
   if(checkpoint.pendingToolCalls?.[0]?.call?.id==='owner-payment-read'){
    persisted=structuredClone(checkpoint);
    throw Object.assign(Error('isolated deferred read checkpoint'),{code:'OWNER_AGENT_TIMEOUT'});
   }
  }});
  assert.equal(interrupted.deferred,true);assert.ok(persisted);assert.equal(persisted.boundedPaymentReadSelected,true);assert.equal(run.executions.length,0);
  const resumed=await run.handler({...scope,checkpoint:persisted});
  assert.equal(run.calls(),0);assert.equal(run.executions.filter(x=>x.args.operation==='read').length,1);assert.equal(run.executions.filter(x=>x.args.operation==='create').length,1);
  assert.deepEqual(run.executions[0].args.filters,[{column:'invoice_number',operator:'eq',value:'SB-10442'},{column:'customer_name',operator:'eq',value:'Northwind Systems LLC'}]);
  assert.equal(run.outputs.at(-1).proposal,true,JSON.stringify({resumed,outputs:run.outputs}));assert.match(resumed.answer,/Proposed a USD 500\.00/);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,1);assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('SQL independently rejects a wrong requested remainder even when a valid staged action was tampered afterwards',async()=>{
 const f=await fixture();try{
  const run=nativeHandler(f);await f.inbound('remainder-source',failedPrompt);await run.handler({...f.scope,messageId:'remainder-source',message:failedPrompt});
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows[0];assert.ok(pending);
  const before=await f.snapshot();await f.db.query('update whatsapp_inbound_events set message_text=$1 where provider_message_id=$2',[failedPrompt.replace('451.52','450.00'),'remainder-source']);
  await f.inbound('remainder-yes','yes');const rejected=(await f.db.query('select whatsapp_confirm_owner_invoice_action($1,$2,$3,$4,$5,$6,true) value',[f.scope.workspaceId,f.scope.ownerId,f.scope.phone,pending.id,pending.version,'remainder-yes'])).rows[0].value;
  assert.equal(rejected.ok,false);assert.equal(rejected.reason,'invalid_payment');assert.deepEqual(await f.snapshot(),before);
 }finally{await f.close();}
});

const bookkeepingPrompt='Record a USD 40 partial bookkeeping payment on the disposable QA invoice INV-2026-6771. Leave USD 60 outstanding. Keep reminders paused and do not contact anyone.';
async function disposableInvoice(f){
 await f.db.query("update customers set name='QA Fixture Customer' where id=(select customer_id from invoices where id=$1)",[f.ids[0]]);
 await f.db.query("update invoices set total_amount=100,metadata=jsonb_set(metadata,'{printed_invoice_number}','\"INV-2026-6771\"') where id=$1",[f.ids[0]]);
}
test('event278 exact bookkeeping request proposes through native SQL; cancel and stale yes write nothing, a fresh confirmed proposal records exactly USD40',async()=>{
 const f=await fixture();try{
  await disposableInvoice(f);const before=await f.snapshot(),run=nativeHandler(f);
  const turn=async(id,message)=>{await f.inbound(id,message);return run.handler({...f.scope,messageId:id,message});};
  const proposed=await turn('event278-propose',bookkeepingPrompt);
  assert.equal(run.calls(),0,JSON.stringify({proposed,outputs:run.outputs}));assert.match(proposed.answer,/Proposed a USD 40\.00/);assert.match(proposed.answer,/USD 60\.00/);assert.doesNotMatch(proposed.answer,/external|connected ledger|Recorded/i);
  assert.deepEqual(run.executions[0].args.filters,[{column:'invoice_number',operator:'eq',value:'INV-2026-6771'}]);assert.deepEqual(await f.snapshot(),before);
  const canceled=await turn('event278-cancel','cancel');assert.match(canceled.answer,/cancel/i);assert.deepEqual(await f.snapshot(),before);
  run.confirm();const stale=await turn('event278-stale-yes','yes');assert.doesNotMatch(stale.answer,/Recorded/);assert.deepEqual(await f.snapshot(),before);
  const fresh=await turn('event278-fresh-propose',bookkeepingPrompt);assert.match(fresh.answer,/Proposed a USD 40\.00/);assert.deepEqual(await f.snapshot(),before);
  const saved=await turn('event278-fresh-yes','yes');assert.match(saved.answer,/Recorded USD 40/);assert.match(saved.answer,/USD 60/);
  const after=await f.snapshot(),invoice=after.invoices.find(x=>x.id===f.ids[0]);assert.equal(invoice.total_amount,100);assert.equal(invoice.amount_paid,40);assert.equal(invoice.currency,'USD');assert.equal(invoice.metadata.followup_state,'paused');assert.equal(invoice.metadata.next_follow_up_at,null);
  assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,40);assert.equal(after.payments[0].settle_remaining,false);assert.deepEqual(after.files,before.files);assert.deepEqual(after.invoices.find(x=>x.id===f.ids[1]),before.invoices.find(x=>x.id===f.ids[1]));assert.equal(after.outbound,0);
  assert.equal((await run.handler({...f.scope,messageId:'event278-fresh-yes',message:'yes'})).replayed,true);assert.deepEqual(await f.snapshot(),after);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
for(const fault of ['missing-feature','external-ledger','wrong-remainder'])test(`event278 ${fault} gives grounded refusal without planner fallback or writes`,async()=>{
 const f=await fixture();try{
  await disposableInvoice(f);
  if(fault==='missing-feature')await f.db.exec("create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb language sql as $$select '{\"ok\":true,\"version\":4}'::jsonb$$");
  if(fault==='external-ledger')await f.db.query("update invoices set external_provider='zoho_books',external_invoice_id='external-fixture' where id=$1",[f.ids[0]]);
  const message=fault==='wrong-remainder'?bookkeepingPrompt.replace('USD 60','USD 59'):bookkeepingPrompt;
  const before=await f.snapshot(),run=nativeHandler(f);await f.inbound('event278-'+fault,message);const reply=await run.handler({...f.scope,messageId:'event278-'+fault,message});
  assert.equal(run.calls(),0,JSON.stringify({reply,outputs:run.outputs}));assert.equal(run.outputs.some(x=>x.proposal||x.completed),false);assert.doesNotMatch(reply.answer,/Proposed|Recorded/);
  if(fault==='external-ledger')assert.match(reply.answer,/connected ledger/);else assert.doesNotMatch(reply.answer,/external|connected ledger/i);
  assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.query('select count(*)::int n from whatsapp_pending_actions')).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('event278 later typed confirmation fails closed when the bookkeeping capability disappears',async()=>{
 const f=await fixture();try{
  await disposableInvoice(f);const run=nativeHandler(f);await f.inbound('capability-propose',bookkeepingPrompt);await run.handler({...f.scope,messageId:'capability-propose',message:bookkeepingPrompt});
  const pending=(await f.db.query('select * from whatsapp_pending_actions where consumed_at is null')).rows[0];assert.equal(pending.action.instructionVersion,5);
  await f.db.exec("create or replace function public.whatsapp_owner_partial_payment_capability() returns jsonb language sql as $$select '{\"ok\":true,\"version\":4}'::jsonb$$");
  const before=await f.snapshot();run.confirm();await f.inbound('capability-yes','yes');const reply=await run.handler({...f.scope,messageId:'capability-yes',message:'yes'});
  assert.doesNotMatch(reply.answer,/Recorded/);assert.doesNotMatch(reply.answer,/external|connected ledger/i);assert.deepEqual(await f.snapshot(),before);assert.equal(run.outputs.at(-1).code,'UNAVAILABLE');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
