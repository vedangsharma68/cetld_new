import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

const question='How much does Offline Ledger Company still owe on QA-2048, and what payments have been recorded?';

async function fixture(){
 const f=await createOfflineSqlNetwork(),{db}=f,ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+12025550137';
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  const workspace=async(actor,label)=>{
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
   return (await db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id;
  };
  const foreignWorkspaceId=await workspace(foreignOwner,'Foreign invoice query fixture'),workspaceId=await workspace(ownerId,'Invoice query fixture');
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const insertInvoice=async(ws,name,total)=>{
   const customer=(await db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[ws,name])).rows[0].id;
   return (await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-31','USD',$3,'draft',$4) returning *",
    [ws,customer,total,{invoice_direction:'receivable',printed_invoice_number:'QA-2048',source_document:{name:'offline-original.pdf'},followup_state:'paused',next_follow_up_at:null}])).rows[0];
  };
  const invoice=await insertInvoice(workspaceId,'Offline Ledger Company',1234.56);
  const foreignInvoice=await insertInvoice(foreignWorkspaceId,'Offline Ledger Company',9999);
  await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
  await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  await db.query('select public.record_invoice_payment($1,$2,400,$3,$4,false)',[workspaceId,invoice.id,'query-fixture-payment','Original received payment']);
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const scope={workspaceId,ownerId,customerId,phone};
  const inbound=async(id,message)=>db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
  const snapshot=async()=> (await db.query("select jsonb_build_object('invoice',(select to_jsonb(i) from invoices i where id=$1),'payments',(select jsonb_agg(to_jsonb(p) order by p.id) from payments p where invoice_id=$1),'reversals',(select jsonb_agg(to_jsonb(r) order by r.id) from payment_reversals r where invoice_id=$1),'customerOutbound',(select count(*) from whatsapp_messages where workspace_id=$2 and audience='customer' and direction='outbound')) value",[invoice.id,workspaceId])).rows[0].value;
  return {...f,scope,workspaceId,foreignWorkspaceId,invoice,foreignInvoice,inbound,snapshot};
 }catch(error){await f.close();throw error;}
}

function nativeQueryHandler(f,{transformRead=null}={}){
 const executions=[],providerRequests=[],outputs=[];let providerCalls=0;
 const selectedRead={operation:'read',table:'invoices',columns:['invoice_number','currency','total_amount','amount_paid','status'],
  filters:[{column:'invoice_number',operator:'eq',value:'QA-2048'},{column:'customer_name',operator:'eq',value:'Offline Ledger Company'}]};
 const handler=createOwnerMessageHandler({supabase:f.supabase,
  env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
  logger:{info(){},warn(){},error(){}},
  toolsFactory:options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,async execute(name,args,context){
    executions.push({name,args:structuredClone(args)});
    const actual=await tools.execute(name,args,context);
    const result=name==='workspaceData'&&args.operation==='read'&&args.table==='invoices'&&transformRead?transformRead(actual,args):actual;
    outputs.push(structuredClone(result));return result;
   }};
  },
  fetchImpl:async(url,init)=>{
   providerCalls++;assert.equal(new URL(url).hostname,'api.cloudflare.com');
   const body=JSON.parse(init.body);providerRequests.push(body);
   const toolMessages=body.messages.filter(item=>item.role==='tool');
   if(providerCalls<=2){
    return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:`invoice-read-${providerCalls}`,type:'function',function:{name:'workspaceData',arguments:JSON.stringify(selectedRead)}}]}}]});
   }
   // Reproduce a final model draft that ignores the actual invoice/payment read.
   return Response.json({choices:[{finish_reason:'stop',message:{content:'I cannot verify any recorded payments. The invoice remains unpaid, so Offline Ledger Company owes USD 1234.56.'}}]});
  }});
 return {handler,executions,outputs,providerRequests,providerCalls:()=>providerCalls};
}

async function runQuery(f,id,{transformRead=null,message=question}={}){
 const run=nativeQueryHandler(f,{transformRead});await f.inbound(id,message);
 const reply=await run.handler({...f.scope,messageId:id,message});
 return {reply,run};
}

test('natural invoice payment-history question recovers from cached reread and an unsafe draft using verified SQL evidence',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),{reply,run}=await runQuery(f,'event266-natural-history');
  assert.equal(run.executions.filter(x=>x.name==='workspaceData'&&x.args.operation==='read'&&x.args.table==='invoices').length,1,JSON.stringify({reply,executions:run.executions}));
  assert.equal(run.executions.filter(x=>x.name==='workspaceData'&&x.args.operation!=='read').length,0);
  assert.equal(run.providerRequests.length>=3,true,'transcript includes initial read, repeated cached-read request, and final draft');
  assert.equal(run.providerRequests[1].messages.some(item=>item.role==='tool'),true);
  assert.match(reply.answer,/1234\.56/,JSON.stringify({reply,outputs:run.outputs}));assert.match(reply.answer,/400(?:\.00)?/,JSON.stringify({reply,outputs:run.outputs}));assert.match(reply.answer,/834\.56/);
  assert.match(reply.answer,/payment history/i);assert.match(reply.answer,/No changes were made/i);
  assert.doesNotMatch(reply.answer,/unpaid|no payments|no payment history/i);
  const after=await f.snapshot();assert.deepEqual(after,before);assert.equal(after.invoice.amount_paid,400);assert.equal(after.payments.length,1);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('missing verified payment-history proof fails closed instead of repeating the model draft',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),{reply,run}=await runQuery(f,'event266-history-proof-missing',{transformRead:result=>{const {paymentHistory,...rest}=result;return rest;}});
  assert.equal(run.executions.filter(x=>x.name==='workspaceData'&&x.args.operation==='read').length,1);
  assert.doesNotMatch(reply.answer,/1234\.56|400(?:\.00)?|834\.56/);
  assert.doesNotMatch(reply.answer,/still owes|has recorded|payment history: [0-9]/i);
  assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a verified owner cannot use the same invoice alias to read another workspace',async()=>{
 const f=await fixture();try{
  const run=nativeQueryHandler(f),before=await f.snapshot();
  const foreignBefore=(await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.foreignInvoice.id])).rows[0].value;
  const reply=await run.handler({...f.scope,workspaceId:f.foreignWorkspaceId,messageId:'event266-wrong-workspace',message:question});
  assert.equal(reply,'');assert.equal(run.executions.length,0);assert.equal(run.providerCalls(),0);
  assert.deepEqual(await f.snapshot(),before);
  assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.foreignInvoice.id])).rows[0].value,foreignBefore);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('ambiguous invoice and a workspace version change cannot produce a verified balance summary',async t=>{
 for(const fault of ['ambiguous','changed-version'])await t.test(fault,async()=>{
  const f=await fixture();try{
   if(fault==='ambiguous'){
    const customer=(await f.db.query("insert into customers(workspace_id,name) values($1,'Offline Ledger Company') returning id",[f.workspaceId])).rows[0].id;
    await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-31','USD',120,'draft',$3)",[f.workspaceId,customer,{invoice_direction:'receivable',printed_invoice_number:'QA-2048'}]);
   }else{
    let changed=false;
    f.intercept(async url=>{
     if(!changed&&url.pathname==='/rest/v1/payment_reversals'){
      changed=true;await f.db.query('update invoices set updated_at=updated_at+interval \'1 second\' where id=$1',[f.invoice.id]);
     }
    });
   }
   const before=await f.snapshot(),{reply,run}=await runQuery(f,`event266-${fault}`);
   assert.equal(run.executions.filter(x=>x.name==='workspaceData'&&x.args.operation==='read').length,1);
   assert.doesNotMatch(reply.answer,/1234\.56|400(?:\.00)?|834\.56/);
   const after=await f.snapshot();
   if(fault==='changed-version')assert.notEqual(after.invoice.updated_at,before.invoice.updated_at);
   assert.deepEqual({...after,invoice:{...after.invoice,updated_at:before.invoice.updated_at}},before);assert.equal(before.customerOutbound,0);
   assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
 });
});

test('verified payment history retains an immutable payment and reversal in the safe summary',async()=>{
 const f=await fixture();try{
  await f.inbound('event266-reversal-prepare','Reopen invoice QA-2048');
  const prepare=(await f.db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) value",[
   f.workspaceId,f.scope.ownerId,f.scope.phone,'event266-reversal-prepare','Reopen invoice QA-2048',f.invoice.id])).rows[0].value;
  assert.equal(prepare.ok,true,JSON.stringify(prepare));
  const pending=(await f.db.query("select id,version from whatsapp_pending_actions where workspace_id=$1 and action->>'proposalId'=$2 and consumed_at is null",[f.workspaceId,prepare.proposalId])).rows[0];
  assert.ok(pending);
  await f.inbound('event266-reversal-confirm','yes');
  const confirmed=(await f.db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'confirm',null,$6,$7,$8,null) value",[
   f.workspaceId,f.scope.ownerId,f.scope.phone,'event266-reversal-confirm','yes',prepare.proposalId,pending.id,pending.version])).rows[0].value;
  assert.equal(confirmed.completed,true,JSON.stringify(confirmed));
  const before=await f.snapshot(),{reply,run}=await runQuery(f,'event266-reversal-history');
  assert.equal(run.executions.filter(x=>x.name==='workspaceData'&&x.args.operation==='read'&&x.args.table==='invoices').length,1);
  assert.match(reply.answer,/1234\.56/);assert.match(reply.answer,/400(?:\.00)?/);assert.match(reply.answer,/0(?:\.00)?/);
  assert.match(reply.answer,/Reversed/i);assert.match(reply.answer,/Net/i);assert.match(reply.answer,/No changes were made/i);
  assert.deepEqual(await f.snapshot(),before);assert.equal(before.payments.length,1);assert.equal(before.reversals.length,1);
  assert.equal(Number(before.invoice.amount_paid),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
