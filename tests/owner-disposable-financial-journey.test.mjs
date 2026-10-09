import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';

// Only the provider transport is simulated. Native tool calls enter the default
// handler/toolset, real Supabase SDK and migrated SQL; no fixture writes a receipt.
test('disposable native owner journey preserves one receipt through excess, edits and confirmed reversal',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),otherOwner=randomUUID(),phone='+15555550168';
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[ownerId,otherOwner]);
  const workspace=async(actor,label)=>{
   await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
   return (await db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id;
  };
  const foreignWorkspace=await workspace(otherOwner,'Foreign disposable studio'),workspaceId=await workspace(ownerId,'Disposable studio');
  const verify=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verify.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
  const seed=async(ws,total)=>{
   const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Synthetic Workshop') returning id",[ws])).rows[0].id;
   return (await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,currency,status,metadata) values($1,$2,'AUTO','2026-10-01','2099-01-01',$3,'USD','sent',$4) returning id,invoice_number",[ws,customer,total,{invoice_direction:'receivable',printed_invoice_number:'SIM-2048',source_document:{name:'synthetic-original.pdf'}}])).rows[0];
  };
  const invoice=await seed(workspaceId,100),foreign=await seed(foreignWorkspace,300),scope={workspaceId,ownerId,customerId,phone};
  const read=async id=>(await db.query('select to_jsonb(i) value from invoices i where id=$1',[id])).rows[0].value;
  const foreignBefore=await read(foreign.id),outputs=[],nativeRequests=[];let operation=null;
  const target=[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}];
  const finalText=value=>{
   if(value?.action==='invoice.reopened')return `Reopened invoice ${invoice.invoice_number} in USD, reversing USD 40 and restoring the balance to USD 140. Original payment receipts remain in history. No cash refund was sent. Reminders are paused.`;
   if(value?.requiresConfirmation&&value?.reversalAmount!==undefined)return `Reopen invoice ${invoice.invoice_number} in USD, reversing USD 40 and restoring the balance to USD 140? Original payment receipts remain in history. No refund is sent. Reminders will be paused after confirmation. Reply yes to confirm or cancel.`;
   if(value?.completed){const row=value.record;return row?`Updated invoice ${row.invoice_number}: total USD ${row.total_amount}, paid USD ${row.amount_paid}, outstanding USD ${row.outstanding_amount??Math.max(row.total_amount-row.amount_paid,0)}, overpayment USD ${row.overpayment_amount??Math.max(row.amount_paid-row.total_amount,0)}. Due date ${row.due_date}. Notes: ${row.notes||'none'}.`: 'The confirmed action completed.';}
   return 'No changes were made.';
  };
  const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},
   toolsFactory:options=>{const tools=createOwnerWorkspaceTools(options);return {...tools,async execute(...args){const value=await tools.execute(...args);outputs.push(value);return value;}};},
   fetchImpl:async(url,init)=>{
    assert.equal(new URL(url).hostname,'api.cloudflare.com');const wire=JSON.parse(init.body);nativeRequests.push(wire);
    const result=wire.messages.findLast(item=>item.role==='tool');
    if(wire.tools&&!result){assert.ok(operation,'unexpected model-selected write');return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'disposable-operation',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(operation)}}]}}]});}
    return Response.json({choices:[{finish_reason:'stop',message:{content:finalText(result?JSON.parse(result.content):null)}}]});
   }});
  const turn=async(id,message,args=null)=>{
   operation=args;await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'isolated',$2,'text',$3,'processing')",[id,phone,message]);
   const reply=await handler({...scope,messageId:id,message});assert.equal(reply.plannerFailure,undefined,JSON.stringify({id,reply,outputs:outputs.slice(-2),errors:f.errors}));
   assert.deepEqual(await read(foreign.id),foreignBefore,'same reference in another tenant must remain unchanged');
   return reply;
  };
  const history=async()=>(await db.query('select to_jsonb(p) value from payments p where invoice_id=$1 order by id',[invoice.id])).rows.map(x=>x.value);
  const auditCount=async()=>(await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n;
  const project=async(total,paid,excess)=>{const row=await read(invoice.id);assert.equal(row.total_amount,total);assert.equal(row.amount_paid,paid);assert.equal(row.metadata.outstanding_amount,Math.max(total-paid,0));assert.equal(row.metadata.overpayment_amount,excess);assert.equal(row.currency,'USD');assert.deepEqual(row.metadata.source_document,{name:'synthetic-original.pdf'});return row;};
  const proposal=await turn('journey-payment-proposal',`Record a USD 40 partial payment for invoice ${invoice.invoice_number} for Synthetic Workshop. Keep customer messages and reminders off.`);
  assert.match(proposal.answer,/Proposed a USD 40/);assert.deepEqual(await history(),[]);assert.equal(nativeRequests.length,0,'bounded payment selection runs before model planning');
  const confirmation=await turn('journey-payment-confirm','yes');assert.match(confirmation.answer,/remaining balance is USD 60/);
  const original=await history();assert.equal(original.length,1);assert.equal(original[0].amount,40);
  const callsBeforeReplay=f.requests.length;const replay=await handler({...scope,messageId:'journey-payment-confirm',message:'yes'});assert.equal(replay.replayed,true);assert.deepEqual(await history(),original);
  assert.equal(f.requests.slice(callsBeforeReplay).some(request=>request.url.endsWith('/rpc/whatsapp_confirm_owner_invoice')),false);
  for(const [total,excess] of [[30,10],[140,0]]){
   await turn('journey-total-'+total,`Correct invoice ${invoice.invoice_number} total to USD ${total}. Keep its payment history.`,{operation:'update',table:'invoices',filters:target,values:{total_amount:total}});
   assert.equal(outputs.at(-1).completed,true,JSON.stringify(outputs.at(-1)));await project(total,40,excess);assert.deepEqual(await history(),original);
  }
  await turn('journey-details',`Change invoice ${invoice.invoice_number} due date to 2099-02-01 and notes to Corrected service date. Keep total USD 140 and payment history.`,{operation:'update',table:'invoices',filters:target,values:{due_date:'2099-02-01',notes:'Corrected service date'}});
  assert.equal(outputs.at(-1).completed,true);const beforeCurrency=await project(140,40,0);assert.equal(beforeCurrency.due_date,'2099-02-01');assert.equal(beforeCurrency.notes,'Corrected service date');assert.deepEqual(await history(),original);
  await turn('journey-currency',`Change invoice ${invoice.invoice_number} currency to INR.`,{operation:'update',table:'invoices',filters:target,values:{currency:'INR'}});
  assert.equal(outputs.at(-1).code,'PAYMENT_GUARD');assert.deepEqual(await read(invoice.id),beforeCurrency);assert.equal(await auditCount(),3);
  const preview=await turn('journey-reopen',`Mark invoice ${invoice.invoice_number} unpaid.`,{operation:'update',table:'invoices',filters:target,values:{status:'unpaid'}});
  assert.equal(outputs.at(-1).requiresConfirmation,true,JSON.stringify({preview,last:outputs.at(-1)}));assert.deepEqual(await history(),original);assert.equal((await db.query('select count(*)::int n from payment_reversals')).rows[0].n,0);
  await turn('journey-reopen-confirm','yes',{operation:'confirm'});assert.equal(outputs.at(-1).action,'invoice.reopened');assert.deepEqual(await history(),original);
  const reversed=(await db.query('select * from payment_reversals where invoice_id=$1',[invoice.id])).rows;assert.equal(reversed.length,1);assert.equal(Number(reversed[0].amount),40);assert.equal(reversed[0].payment_id,original[0].id);
  const reopened=await read(invoice.id);assert.equal(reopened.amount_paid,0);assert.equal(reopened.total_amount,140);assert.equal(reopened.followup_state,'paused');assert.equal(reopened.next_follow_up_at,null);
  assert.equal((await handler({...scope,messageId:'journey-reopen-confirm',message:'yes'})).replayed,true);assert.equal((await db.query('select count(*)::int n from payment_reversals')).rows[0].n,1);
  await turn('journey-currency-after-reversal',`Change invoice ${invoice.invoice_number} currency to INR.`,{operation:'update',table:'invoices',filters:target,values:{currency:'INR'}});
  assert.equal(outputs.at(-1).code,'PAYMENT_GUARD');assert.deepEqual(await read(invoice.id),reopened);assert.deepEqual(await history(),original);
  assert.ok(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')));assert.ok(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_invoice_reopening')));
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
