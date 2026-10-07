import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {createOwnerDirectRuntime} from '../automation/whatsapp/owner-direct-runtime.mjs';
import {createInvoiceCorrectionClient} from '../invoice/correction-client.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';

// Production SDK, consolidated workspaceData route, verified owner runtime,
// persisted receipt readback and the full SQL chain. All HTTP is isolated.
test('audited total corrections preserve net receipts and reversals across real workspaceData/SQL routes',async t=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,owner=randomUUID(),stranger=randomUUID(),phone='+919871367051';
 const asOwner=async(actor=owner)=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
 const asService=async()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
 try{
  await db.query('insert into auth.users(id) values($1),($2)',[owner,stranger]);await asOwner();
  const workspaceId=(await db.query("select (public.create_workspace('Total correction fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await asService();assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) v',[phone,verification.code])).rows[0].v.ok,true);
  const binding=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId:owner,customerId:binding.customer_id,phone};
  await db.exec('reset role');await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
  const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Invoice fixture') returning id",[workspaceId])).rows[0].id;
  const invoice=async(label,{paid=0,metadata={},due='2099-01-01'}={})=>{
   await db.exec('reset role');
   const row=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,'2026-10-01',$4,'USD',100,'sent',$5) returning to_jsonb(invoices) row",[workspaceId,customer,label,due,{invoice_direction:'receivable',printed_invoice_number:label,source_document:{name:'fixture.pdf'},...metadata}])).rows[0].row;
   if(paid){await asOwner();await db.query('select record_invoice_payment($1,$2,$3,$4,$5,false)',[workspaceId,row.id,paid,randomUUID(),'Original immutable receipt']);}
   return row.id;
  };
  const read=async id=>{await db.exec('reset role');return (await db.query('select to_jsonb(i) row from invoices i where id=$1',[id])).rows[0].row;};
  const history=async id=>{await db.exec('reset role');return (await db.query("select * from (select 'payment' kind,to_jsonb(p) row from payments p where invoice_id=$1 union all select 'reversal',to_jsonb(r) from payment_reversals r where invoice_id=$1) history order by kind,row->>'id'",[id])).rows;};
  const inbound=async(id,message)=>{await asService();await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing') on conflict(provider_message_id) do nothing",[id,phone,message]);};
  const route=async(id,values,{messageId=randomUUID(),message='Correct this invoice total',actor=owner}={})=>{
   await inbound(messageId,message);
   const activeScope={...scope,ownerId:actor};
   const authorize=async candidate=>candidate?.workspaceId===workspaceId&&candidate?.ownerId===owner;
   const runtime=createOwnerDirectRuntime({supabase,scope:activeScope,message,messageId,authorize});
   const tool=createWorkspaceDataTool({supabase,scope:activeScope,authorize,message,messageId,confirmationMode:'direct',executeDirectOperation:(params,ctx)=>runtime.execute(params,ctx)});
   return tool.execute({operation:'update',table:'invoices',filters:[{column:'id',operator:'eq',value:id}],values});
  };
  const projection=(row,total,paid)=>{
   assert.equal(row.total_amount,total);assert.equal(row.amount_paid,paid);assert.equal(row.metadata.outstanding_amount,Math.max(total-paid,0));assert.equal(row.metadata.overpayment_amount,Math.max(paid-total,0));
   assert.equal(row.currency,'USD');assert.equal(row.next_follow_up_at,null);assert.ok(['paused','cancelled'].includes(row.followup_state));
   assert.deepEqual(row.metadata.source_document,{name:'fixture.pdf'});
   if(paid>=total)assert.equal(row.status,'paid');else assert.notEqual(row.status,'paid');
  };
  await t.test('partial payments: increases, decreases, overpayment, repeated edits and nonfinancial edit',async()=>{
   const id=await invoice('PARTIAL',{paid:40}),original=await history(id);
   for(const total of [150,60,30,25,90]){
    const result=await route(id,{total_amount:total,currency:'USD'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.completed,true);projection(await read(id),total,40);assert.equal(result.record.overpayment_amount,Math.max(40-total,0));assert.deepEqual(await history(id),original);
   }
   const result=await route(id,{notes:'Explanation only'});assert.equal(result.ok,true);projection(await read(id),90,40);assert.deepEqual(await history(id),original);
   const readResult=await createWorkspaceDataTool({supabase,scope,authorize:async()=>true}).execute({operation:'read',table:'invoices',columns:['invoice_number','total_amount','amount_paid','outstanding_amount','overpayment_amount'],filters:[{column:'id',operator:'eq',value:id}]});
   assert.deepEqual(readResult.rows,[{invoice_number:(await read(id)).invoice_number,total_amount:90,amount_paid:40,outstanding_amount:50,overpayment_amount:0}]);
  });
  await t.test('actual default owner handler advertises consolidated tools and routes amount-only edits into audited correction SQL',async()=>{
   const id=await invoice('HANDLER',{paid:50}),original=await history(id),message='Correct this invoice total to USD 30',messageId='actual-handler-total';
   await inbound(messageId,message);const outputs=[];
   const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
    authorize:input=>authorizeOwnerPhone({supabase,...input}),
    providerFactory:()=>({async generate({messages,tools}){
     if(tools)assert.deepEqual(tools.map(tool=>tool.function.name),['getAIProviderConfiguration','workspaceData']);
     const result=messages.findLast(item=>item.role==='tool');
     if(!result)return {model:'fixture',toolCalls:[{id:'actual-correction',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'update',table:'invoices',filters:[{column:'id',operator:'eq',value:id}],values:{total_amount:30,currency:'USD'}})}}]};
     const value=JSON.parse(result.content);outputs.push(value);
     return {model:'fixture',content:value.completed?'Invoice total corrected to USD 30. Payments remain USD 50; overpayment USD 20.':'The invoice correction failed.'};
    }})});
   const response=await handler({...scope,message,messageId});
   assert.equal(outputs.at(-1)?.completed,true,JSON.stringify({response,outputs,errors:f.errors}));
   assert.match(response.answer,/overpayment USD 20/);projection(await read(id),30,50);assert.deepEqual(await history(id),original);
   assert.ok(f.requests.some(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')));
   assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[id])).rows[0].n,1);
   const requestCount=f.requests.filter(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length;
   const replay=await handler({...scope,message,messageId});assert.equal(replay.replayed,true);
   assert.equal(f.requests.filter(request=>request.url.endsWith('/rpc/whatsapp_correct_owner_invoice')).length,requestCount);assert.deepEqual(await history(id),original);
  });
  await t.test('full payment and itemization correction retains original payment and protects currency/classification',async()=>{
   const id=await invoice('FULL',{paid:100,metadata:{subtotal:100,tax:0,line_items:[{description:'Original',amount:100}]}}),original=await history(id);
   const reduced=await route(id,{total_amount:80,subtotal:80,line_items:[{description:'Corrected',amount:80}]});assert.equal(reduced.ok,true,JSON.stringify(reduced));projection(await read(id),80,100);assert.equal(reduced.record.overpayment_amount,20);assert.deepEqual(await history(id),original);
   for(const values of [{currency:'INR'},{invoice_direction:'payable'},{invoice_number:'RENAMED'},{customer_id:customer}]){const result=await route(id,values);assert.equal(result.ok,false);assert.equal(result.code,'PAYMENT_GUARD');}
   const increased=await route(id,{total_amount:140,subtotal:140,line_items:[{description:'Corrected again',amount:140}]});assert.equal(increased.ok,true);projection(await read(id),140,100);assert.equal(increased.record.status,'sent');assert.deepEqual(await history(id),original);
   assert.equal((await route(id,{total_amount:130})).code,'INVALID_TOTAL','scalar change cannot silently contradict existing itemization');
  });
  await t.test('reversed receipt and later new payment are retained while only their net balance counts',async()=>{
   const id=await invoice('REVERSED',{paid:100});
   await inbound('reopen-source','Mark invoice unpaid');
   const proposal=(await db.query("select whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) v",[workspaceId,owner,phone,'reopen-source','Mark invoice unpaid',id])).rows[0].v;
   assert.equal(proposal.ok,true,JSON.stringify(proposal));
   const pending=(await db.query('select id,version from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null order by generation desc limit 1',[workspaceId])).rows[0];
   await inbound('reopen-confirm','YES');
   const reopened=(await db.query("select whatsapp_invoice_reopening($1,$2,$3,$4,$5,'confirm',null,$6,$7,$8) v",[workspaceId,owner,phone,'reopen-confirm','YES',proposal.proposalId,pending.id,pending.version])).rows[0].v;
   assert.equal(reopened.ok,true,JSON.stringify(reopened));
   await asOwner();await db.query('select record_invoice_payment($1,$2,20,$3,$4,false)',[workspaceId,id,randomUUID(),'New receipt after reversal']);
   const original=await history(id);assert.equal(original.length,3);
   const result=await route(id,{total_amount:10});assert.equal(result.ok,true,JSON.stringify(result));projection(await read(id),10,20);assert.deepEqual(await history(id),original);
  });
  await t.test('correction invalidates a reviewed reopening button; replay cannot reverse edited invoices',async()=>{
   const id=await invoice('STALE-BUTTON',{paid:100}),original=await history(id);
   await inbound('stale-button-prepare','Mark invoice unpaid');
   const preview=(await db.query("select whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) v",[workspaceId,owner,phone,'stale-button-prepare','Mark invoice unpaid',id])).rows[0].v;
   assert.equal(preview.ok,true,JSON.stringify(preview));
   const pending=(await db.query('select id,version from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null order by generation desc limit 1',[workspaceId])).rows[0];
   const result=await route(id,{total_amount:80});assert.equal(result.ok,true,JSON.stringify(result));projection(await read(id),80,100);
   await db.exec('reset role');assert.equal((await db.query('select state from invoice_reopening_proposals where id=$1',[preview.proposalId])).rows[0].state,'stale');
   const interaction='oab1.fixture.stale';await inbound('stale-button-click','Confirm');await db.query('update whatsapp_inbound_events set interaction_id=$2 where provider_message_id=$1',['stale-button-click',interaction]);
   const click=async()=>(await db.query("select whatsapp_invoice_reopening($1,$2,$3,$4,$5,'confirm',null,$6,$7,$8,$9) v",[workspaceId,owner,phone,'stale-button-click','Confirm',preview.proposalId,pending.id,pending.version,interaction])).rows[0].v;
   assert.equal((await click()).code,'STALE');assert.equal((await click()).code,'STALE');assert.deepEqual(await history(id),original);
   await db.exec('reset role');await db.query('update whatsapp_pending_actions set consumed_at=now() where id=$1',[pending.id]);
  });
  await t.test('dashboard exact retries, lost responses and stale replays are verified against current storage',async()=>{
   const id=await invoice('DASHBOARD',{paid:50}),before=await read(id),original=await history(id);await asOwner();
   const correct=createInvoiceCorrectionClient(supabase),input={workspaceId,invoiceId:id,expectedUpdatedAt:before.updated_at,requestId:randomUUID(),values:{total_amount:40}};
   let lostAcknowledgement=true;
   const interrupted=createClient('https://fixture.supabase.test','isolated-fixture-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(...args)=>{
    const response=await f.fetchImpl(...args);
    if(lostAcknowledgement&&String(args[0]).endsWith('/rpc/owner_correct_invoice')){lostAcknowledgement=false;throw Error('fixture lost write acknowledgement');}
    return response;
   }}});
   await assert.rejects(createInvoiceCorrectionClient(interrupted)(input),error=>/lost write acknowledgement/.test(error.message));
   const corrected=await correct(input);assert.equal(corrected.replayed,true);projection(corrected.record,40,50);assert.equal((await correct(input)).replayed,true);
   assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[id])).rows[0].n,1);
   await assert.rejects(correct({...input,requestId:randomUUID(),values:{total_amount:35}}),e=>e.code==='STALE');
   const later=await correct({...input,expectedUpdatedAt:corrected.record.updated_at,requestId:randomUUID(),values:{notes:'Later correction'}});assert.equal(later.completed,true);
   await assert.rejects(correct(input),e=>e.code==='STALE');assert.deepEqual(await history(id),original);
  });
  await t.test('scope, external ledger, inconsistent payments, terminal state and direct SQL bypass fail closed',async()=>{
   const id=await invoice('GUARDS',{paid:30}),before=await read(id);
   assert.equal((await route(id,{total_amount:20},{actor:stranger})).ok,false);
   await db.exec('reset role');await db.query("update invoices set external_provider='quickbooks',external_invoice_id='external' where id=$1",[id]);
   assert.equal((await route(id,{total_amount:20})).code,'EXTERNAL_ACCOUNTING');assert.equal((await route(id,{notes:'Local annotation'})).ok,true);
   const mismatch=await invoice('MISMATCH');await db.exec('reset role');await db.query('update invoices set amount_paid=10 where id=$1',[mismatch]);
   assert.equal((await route(mismatch,{total_amount:20})).code,'LEDGER_MISMATCH');
   const terminal=await invoice('TERMINAL');await db.exec('reset role');await db.query("update invoices set status='void' where id=$1",[terminal]);assert.equal((await route(terminal,{total_amount:20})).code,'TERMINAL');
   const local=await invoice('NO-BYPASS',{paid:50});await asOwner();
   await db.exec("set app.owner_invoice_correction_id='pretend-authorization'");
   await assert.rejects(db.query('update invoices set total_amount=40 where id=$1',[local]),/audited invoice correction|cannot change|permission denied/);
   await assert.rejects(db.query('insert into app.invoice_total_correction_context values(pg_backend_pid(),txid_current(),$1)',[local]),/permission denied/);
   await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from app.invoice_total_correction_context')).rows[0].n,0);
   const actual=await read(id);assert.equal(actual.total_amount,before.total_amount);assert.equal(actual.amount_paid,before.amount_paid);
  });
 }finally{await f.close();}
});
