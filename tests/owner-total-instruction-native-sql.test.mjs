import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {createOwnerScopedStore} from '../ai/whatsapp-channel.mjs';

const number='INV-2026-6771';
const request=`Change test invoice ${number} total to USD 30 with zero tax. Keep its existing USD 40 payment.`;
async function fixture({lineItems=[{description:'Synthetic service',quantity:1,unitPrice:100,amount:100,confidence:1}]}={}){
 const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+12025550169';
 await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
 const workspace=async actor=>{
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
  return (await db.query("select (create_workspace('Total instruction fixture',$1)).id",[randomUUID()])).rows[0].id;
 };
 const foreignWorkspace=await workspace(foreignOwner),workspaceId=await workspace(ownerId);
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id,ids=[];
 for(const ws of [workspaceId,foreignWorkspace]){
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Synthetic service fixture') returning id",[ws])).rows[0].id;
  ids.push((await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2099-01-01','USD',100,'draft',$3) returning id",[ws,customer,{invoice_direction:'receivable',printed_invoice_number:number,subtotal:100,tax:0,line_items:lineItems,source_document:{name:'synthetic.pdf'},followup_state:'paused',next_follow_up_at:null}])).rows[0].id);
 }
 await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
 const scope={workspaceId,ownerId,customerId,phone},outputs=[],executions=[];let providerCalls=0,afterRead=null;
 const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},
  toolsFactory:options=>{const tools=createOwnerWorkspaceTools(options);return {...tools,async execute(name,args,context){
   executions.push({name,args});const result=await tools.execute(name,args,context);outputs.push(result);
   if(args.operation==='read'&&afterRead){const operation=afterRead;afterRead=null;await operation();}return result;
  }};},fetchImpl:async()=>{providerCalls++;throw Error('This clear instruction must not depend on model planning');}});
 const turn=async(id,message)=>{
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing') on conflict(provider_message_id) do nothing",[id,phone,message]);
  return handler({...scope,messageId:id,message});
 };
 const read=async id=>(await db.query('select to_jsonb(i) value from invoices i where id=$1',[id])).rows[0].value;
 const history=async()=>(await db.query("select 'payment' kind,to_jsonb(p) value from payments p where invoice_id=$1 union all select 'reversal',to_jsonb(r) from payment_reversals r where invoice_id=$1 order by kind",[ids[0]])).rows;
 return {...f,scope,ids,turn,handler,read,history,outputs,executions,providerCalls:()=>providerCalls,onRead:operation=>{afterRead=operation;}};
}

test('event306 exact total instruction adjusts one service line, retains USD40 once, reports USD10 excess and recovers a lost reply',async()=>{
 const f=await fixture();try{
  const foreign=await f.read(f.ids[1]);
  assert.match((await f.turn('total-payment-propose',`Record a USD 40 payment on test invoice ${number}.`)).answer,/Record USD 40/);
  assert.match((await f.turn('total-payment-confirm','yes')).answer,/Balance: USD 60/);
  const original=await f.history();assert.equal(original.length,1);assert.equal(original[0].value.amount,40);
  const calls=f.providerCalls(),offset=f.executions.length,reply=await f.turn('event306-total',request);
  assert.equal(reply.plannerFailure,undefined,JSON.stringify(reply));assert.equal(f.providerCalls(),calls);
  assert.deepEqual(f.executions.slice(offset).map(x=>x.args.operation),['read','update']);
  const row=await f.read(f.ids[0]);assert.equal(row.total_amount,30);assert.equal(row.amount_paid,40);assert.equal(row.currency,'USD');
  assert.equal(row.metadata.subtotal,30);assert.equal(row.metadata.tax,0);assert.equal(row.metadata.line_items[0].amount,30);assert.equal(row.metadata.line_items[0].unitPrice,30);
  assert.equal(row.metadata.outstanding_amount,0);assert.equal(row.metadata.overpayment_amount,10);
  assert.deepEqual(row.metadata.source_document,{name:'synthetic.pdf'});assert.ok(['paused','cancelled'].includes(row.followup_state));assert.equal(row.next_follow_up_at,null);
  assert.match(reply.answer,/Total: USD 30/);assert.match(reply.answer,/Paid: USD 40\.00/);assert.match(reply.answer,/Issued outstanding: USD 0\.00/);assert.match(reply.answer,/Overpayment: USD 10\.00/);
  assert.deepEqual(await f.history(),original);assert.deepEqual(await f.read(f.ids[1]),foreign);
  const audit=await f.db.query('select * from invoice_correction_audits where invoice_id=$1',[f.ids[0]]);assert.equal(audit.rows.length,1);
  assert.equal((await f.turn('event306-total',request)).replayed,true);assert.deepEqual(await f.read(f.ids[0]),row);
  await f.db.query('delete from whatsapp_messages where workspace_id=$1 and idempotency_key=$2',[f.scope.workspaceId,'reply:event306-total']);
  const recovered=await f.turn('event306-total',request);assert.match(recovered.answer,/Overpayment: USD 10\.00/);
  assert.deepEqual(await f.read(f.ids[0]),row);assert.deepEqual(await f.history(),original);
  assert.equal((await f.db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[f.ids[0]])).rows[0].n,1);
  await f.db.query('delete from whatsapp_messages where workspace_id=$1 and idempotency_key=$2',[f.scope.workspaceId,'reply:event306-total']);
  await f.db.query("update invoices set notes='Later fixture edit' where id=$1",[f.ids[0]]);
  const current=await f.read(f.ids[0]),attempts=f.executions.length,uncertain=await f.turn('event306-total',request);
  assert.match(uncertain.answer,/could not verify the prior invoice correction state/);assert.equal(f.executions.length,attempts);
  assert.deepEqual(await f.read(f.ids[0]),current);assert.deepEqual(await f.history(),original);assert.equal(f.providerCalls(),calls);
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('an unitemized invoice corrects once and a later currency preread cannot replace the original version guard',async()=>{
 const f=await fixture({lineItems:[]});try{
  await f.turn('plain-payment-propose',`Record a USD 40 payment on test invoice ${number}.`);await f.turn('plain-payment-confirm','yes');
  const original=await f.history(),reply=await f.turn('plain-total',request);assert.match(reply.answer,/Overpayment: USD 10\.00/);
  const before=await f.read(f.ids[0]);assert.equal(before.total_amount,30);assert.deepEqual(before.metadata.line_items,[]);assert.deepEqual(await f.history(),original);
  const message=request.replace('USD 30','USD 35'),messageId='currency-preread-stale';
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,f.scope.phone,message]);
  await f.db.query("update invoices set notes='Concurrent currency preread fixture' where id=$1",[f.ids[0]]);const current=await f.read(f.ids[0]);
  const authorize=input=>authorizeOwnerPhone({supabase:f.supabase,...input});
  const ownerStore=createOwnerScopedStore({supabase:f.supabase,...f.scope,authorize:()=>authorize(f.scope)});
  const tools=createOwnerWorkspaceTools({supabase:f.supabase,scope:f.scope,ownerStore,message,messageId,config:{},botPreferences:{confirmationMode:'direct'},
    authorize,logger:{info(){},warn(){},error(){}}});
  const result=await tools.execute('workspaceData',{operation:'update',table:'invoices',filters:[{column:'id',operator:'eq',value:f.ids[0]}],values:{total_amount:35,subtotal:35,tax:0}},
    {invoiceCorrectionReadGuard:{id:f.ids[0],updatedAt:before.updated_at}});
  assert.equal(result.code,'STALE');assert.equal(result.writeAttempted,false);assert.deepEqual(await f.read(f.ids[0]),current);assert.deepEqual(await f.history(),original);
  assert.equal((await f.db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[f.ids[0]])).rows[0].n,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('multiple item allocation is clarified without changing the paid invoice or consulting a planner',async()=>{
 const f=await fixture({lineItems:[{description:'First',quantity:1,unitPrice:60,amount:60},{description:'Second',quantity:1,unitPrice:40,amount:40}]});try{
  await f.turn('multi-payment-propose',`Record a USD 40 payment on test invoice ${number}.`);await f.turn('multi-payment-confirm','yes');
  const before=await f.read(f.ids[0]),history=await f.history(),calls=f.providerCalls();
  const result=await f.turn('multi-total',request);assert.match(result.answer,/corrected line item amounts/);assert.match(result.answer,/No change was made/);
  assert.equal(result.plannerFailure,undefined);assert.equal(f.providerCalls(),calls);assert.deepEqual(await f.read(f.ids[0]),before);assert.deepEqual(await f.history(),history);
  assert.equal((await f.db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[f.ids[0]])).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a concurrent change after the total preread and inconsistent retained payment or currency all refuse without financial writes',async()=>{
 const f=await fixture();try{
  await f.turn('guard-payment-propose',`Record a USD 40 payment on test invoice ${number}.`);await f.turn('guard-payment-confirm','yes');
  const before=await f.read(f.ids[0]),history=await f.history(),calls=f.providerCalls();
  for(const [id,message,pattern] of [
   ['wrong-retained',request.replace('USD 40 payment','USD 50 payment'),/recorded paid amount differs/i],
   ['wrong-currency',request.replaceAll('USD','EUR'),/current currency/i],
  ]){assert.match((await f.turn(id,message)).answer,pattern);assert.deepEqual(await f.read(f.ids[0]),before);assert.deepEqual(await f.history(),history);}
  f.onRead(()=>f.db.query("update invoices set notes='Concurrent fixture edit' where id=$1",[f.ids[0]]));
  const result=await f.turn('stale-total',request);assert.match(result.answer,/invoice changed/i);assert.equal(result.plannerFailure,undefined);
  const after=await f.read(f.ids[0]);assert.equal(after.total_amount,100);assert.equal(after.amount_paid,40);assert.equal(after.notes,'Concurrent fixture edit');
  assert.deepEqual(after.metadata,before.metadata);assert.deepEqual(await f.history(),history);assert.equal(f.providerCalls(),calls);
  assert.equal((await f.db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[f.ids[0]])).rows[0].n,0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
