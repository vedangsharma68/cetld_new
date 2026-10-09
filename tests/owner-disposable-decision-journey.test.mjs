import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {AIProvider} from '../ai/provider.mjs';

const phone='+12025550107';
const request='Record a USD 70 test payment against invoice SIM-8192 for Decision Fixture Workshop. This is only a dummy bookkeeping entry. Keep customer messages and reminders off.';

async function fixture(){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID();
 const env={NODE_ENV:'test',GEMINI_API_KEY:'isolated decision-journey fixture',CRON_SECRET:'isolated decision-journey signing fixture'};
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Disposable decision journey',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"buttons\"}' where workspace_id=$1",[workspaceId]);
  const contactId=(await db.query("insert into customers(workspace_id,name) values($1,'Decision Fixture Workshop') returning id",[workspaceId])).rows[0].id;
  const invoiceId=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'SIM-8192','2026-10-01','2026-10-31','USD',240,'draft',
      '{"invoice_direction":"receivable","printed_invoice_number":"SIM-8192","followup_state":"paused","next_follow_up_at":null}') returning id`,[workspaceId,contactId])).rows[0].id;
  const scope={workspaceId,ownerId,customerId,phone},decisions=[];
  const persist=async(id,message,{interactionId=null,type='text'}={})=>{
   await db.query(`insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,interaction_id)
    values($1,'fixture',$2,$3,$4,'processing',$5)`,[id,phone,type,message,interactionId]);
   await db.query(`insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key)
    values($1,null,$2,'inbound','owner',$3,$4,'received',$5,$5)`,[workspaceId,phone,message,type==='interactive'?'interactive':'text',id]);
  };
  const state=async()=> (await db.query(`select jsonb_build_object(
   'invoice',(select to_jsonb(i) from invoices i where i.workspace_id=$1 and i.id=$2),
   'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from payments p where p.workspace_id=$1),
   'receipts',(select count(*) from whatsapp_direct_write_receipts where workspace_id=$1),
   'ownerReceipts',(select count(*) from whatsapp_owner_action_receipts where workspace_id=$1),
   'customerOutbound',(select count(*) from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound')) value`,[workspaceId,invoiceId])).rows[0].value;
  const toolsFactory=options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,
    async decideButton(args){const result=await tools.decideButton(args);decisions.push({args,result});return result;},
   };
  };
  const response=parts=>Response.json({candidates:[{content:{parts},finishReason:'STOP'}]});
  const providerFactory=options=>new AIProvider({...options,primaryModel:'gemini-3.5-flash-lite',fallbackModel:null});
  const fetchImpl=async(url,init)=>{
   assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com','all model traffic stays inside the mocked provider');
   const body=JSON.parse(init.body);
   const functionCall={functionCall:{name:'workspaceData',args:{operation:'create',table:'payments',filters:[{column:'invoice_number',operator:'eq',value:'SIM-8192'}],values:{amount:70,currency:'USD'}}}};
   if(body.tools)return response([functionCall]);
   const toolResults=body.contents.flatMap(row=>row.parts||[]).flatMap(part=>part.functionResponse?[part.functionResponse.response]:[]);
   const latest=toolResults.at(-1);
   return response([{text:latest?.completed?'Payment decision completed.':latest?.proposal?'A USD 70 payment is proposed. Reply yes to confirm or cancel.':'No changes were made.'}]);
  };
  const handler=createOwnerMessageHandler({supabase,env,toolsFactory,providerFactory,fetchImpl,logger:{info(){},warn(){},error(){}}});
  const pending=async()=> (await db.query("select * from whatsapp_pending_actions where workspace_id=$1 and action->>'type'='owner_invoice_payment' order by id desc limit 1",[workspaceId])).rows[0];
  return {...f,db,supabase,env,scope,invoiceId,persist,state,handler,pending,decisions};
 }catch(error){await f.close();throw error;}
}

test('a signed cancel retires a partial-payment proposal and a stale confirm or replay cannot record it',async()=>{
 const f=await fixture();
 try{
  const before=await f.state();
  await f.persist('disposable-payment-proposal',request);
  const proposed=await f.handler({...f.scope,messageId:'disposable-payment-proposal',message:request});
  const pending=await f.pending();
  assert.ok(pending,JSON.stringify({proposed,errors:f.errors}));
  assert.equal(pending.action.type,'owner_invoice_payment');
  assert.deepEqual(pending.action.changes,{amount:70,currency:'USD'});
  assert.equal(proposed.buttons?.length,2,JSON.stringify(proposed));
  assert.match(proposed.answer,/propos|USD 70/i);
  assert.deepEqual(await f.state(),before);

  const [confirm,cancel]=proposed.buttons;
  await f.persist('disposable-payment-cancel','Cancel',{interactionId:cancel.id,type:'interactive'});
  const canceled=await f.handler({...f.scope,messageId:'disposable-payment-cancel',message:'Cancel',interactionId:cancel.id});
  assert.equal(f.decisions.length,1,JSON.stringify({canceled,decisions:f.decisions,errors:f.errors}));
  assert.equal(f.decisions[0].result.ok,true,JSON.stringify(f.decisions[0]));
  assert.equal(f.decisions[0].result.action,'pending.cancelled');
  assert.ok((await f.pending()).consumed_at,'the SQL writer must retire the canceled payment proposal');
  const afterCancel=await f.state();
  assert.deepEqual(afterCancel.invoice,before.invoice);
  assert.deepEqual(afterCancel.payments,before.payments);
  assert.equal(afterCancel.receipts,1);assert.equal(afterCancel.ownerReceipts,1);
  assert.equal(afterCancel.customerOutbound,0);

  await f.persist('disposable-stale-payment-confirm','Confirm',{interactionId:confirm.id,type:'interactive'});
  const staleConfirm=await f.handler({...f.scope,messageId:'disposable-stale-payment-confirm',message:'Confirm',interactionId:confirm.id});
  assert.notEqual(f.decisions.at(-1)?.args?.decision,'confirm','a consumed proposal cannot authorize its old confirm button');
  assert.deepEqual(await f.state(),afterCancel);
  assert.ok((await f.pending()).consumed_at,'the old confirm button must leave the canceled proposal retired');
  assert.doesNotMatch(staleConfirm?.answer||'',/payment recorded|recorded USD 70/i);

  const replay=await f.handler({...f.scope,messageId:'disposable-payment-cancel',message:'Cancel',interactionId:cancel.id});
  assert.equal(replay.replayed,true);
  assert.equal(f.decisions.length,1,'replaying the cancellation must not decide again');
  assert.deepEqual(await f.state(),afterCancel);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
