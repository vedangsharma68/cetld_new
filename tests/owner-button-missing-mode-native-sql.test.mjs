import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createOwnerActionButtons,verifyOwnerActionButton} from '../automation/whatsapp/owner-action-buttons.mjs';

const phone='+12025550107';
const secret='isolated-event259-owner-button-secret';
const message='Record a USD 500 test payment against invoice SB-10442 for Northwind Systems LLC. This is only a dummy bookkeeping entry. Keep customer messages and reminders off.';
const target=[{column:'invoice_number',operator:'eq',value:'SB-10442'}];

async function fixture({confirmationMode=null}={}){
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID();
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (public.create_workspace('Event259 null button mode',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 if(confirmationMode)await db.query('update workspace_settings set owner_bot_preferences=owner_bot_preferences||$1::jsonb where workspace_id=$2',[JSON.stringify({confirmationMode}),workspaceId]);
 const contactId=(await db.query("insert into customers(workspace_id,name) values($1,'Northwind Systems LLC') returning id",[workspaceId])).rows[0].id;
 const invoiceId=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
  values($1,$2,'SB-10442','2026-10-01','2026-10-31','USD',951.52,'draft',
   '{"invoice_direction":"receivable","printed_invoice_number":"SB-10442","followup_state":"paused","next_follow_up_at":null,"source_document":{"name":"original-source"}}') returning id`,[workspaceId,contactId])).rows[0].id;
 // The migration-created preference object intentionally has no confirmationMode unless this is the explicit-mode control.
 const setting=(await db.query('select owner_bot_preferences from workspace_settings where workspace_id=$1',[workspaceId])).rows[0];
 assert.equal(setting.owner_bot_preferences?.confirmationMode,confirmationMode||undefined);
 assert.equal((await db.query("select owner_bot_preferences->>'confirmationMode' value from workspace_settings where workspace_id=$1",[workspaceId])).rows[0].value,confirmationMode);
 // The proposal should match the event's stable pending-action reference.
 await db.query("select setval(pg_get_serial_sequence('public.whatsapp_pending_actions','id'),32,true)");
 const scope={workspaceId,ownerId,customerId,phone},executions=[],decisions=[],providerCalls=[];
 const env={NODE_ENV:'test',GEMINI_API_KEY:'isolated',CRON_SECRET:secret};
 const persist=async(id,text,{interactionId=null,type='text'}={})=>{
  await db.query(`insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,interaction_id)
   values($1,'fixture',$2,$3,$4,'processing',$5)`,[id,phone,type,text,interactionId]);
  // Cloud ingestion does not associate the owner transcript with a debtor contact.
  await db.query(`insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key)
   values($1,null,$2,'inbound','owner',$3,$4,'received',$5,$5)`,[workspaceId,phone,text,type==='interactive'?'interactive':'text',id]);
 };
 const workspaceCall=args=>({id:'deliberately-malformed-event259-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}});
 const handler=createOwnerMessageHandler({supabase,env,logger:{info(){},warn(){},error(){}},
  providerFactory:()=>({async generate(){providerCalls.push('malformed-create');return {toolCalls:[workspaceCall({operation:'create',table:'invoices',values:{invoice_number:'INVENTED',customer_name:'Invented customer',total_amount:1,currency:'USD'}})]};}}),
  toolsFactory:options=>{
   const tools=createOwnerWorkspaceTools(options);
   return {...tools,
    async execute(name,args,context){const result=await tools.execute(name,args,context);executions.push({name,args,result});return result;},
    async decideButton(args){const result=await tools.decideButton(args);decisions.push({args,result});return result;},
   };
  },
  fetchImpl:async url=>{providerCalls.push(String(url));throw Error('unexpected provider/network call');},
 });
 const pending=async()=>(await db.query("select * from whatsapp_pending_actions where workspace_id=$1 and consumed_at is null and action->>'type'='owner_invoice_payment'",[workspaceId])).rows[0]||null;
 const snapshot=async()=>(await db.query(`select jsonb_build_object(
  'invoice',(select to_jsonb(i) from invoices i where i.workspace_id=$1 and i.id=$2),
  'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from payments p where p.workspace_id=$1),
  'directReceipts',(select coalesce(jsonb_agg(to_jsonb(r) order by r.provider_message_id),'[]') from whatsapp_direct_write_receipts r where r.workspace_id=$1),
  'ownerReceipts',(select count(*) from whatsapp_owner_action_receipts r where r.workspace_id=$1),
  'customerOutbound',(select count(*) from whatsapp_messages where workspace_id=$1 and audience='customer' and direction='outbound')) value`,[workspaceId,invoiceId])).rows[0].value;
 try{return {...f,db,supabase,scope,invoiceId,contactId,env,executions,decisions,providerCalls,persist,handler,pending,snapshot};}
 catch(error){await f.close();throw error;}
}

async function propose(f,id='event259-proposal'){
 await f.persist(id,message);
 const response=await f.handler({...f.scope,messageId:id,message});
 const pending=await f.pending();assert.ok(pending,JSON.stringify({response,executions:f.executions,errors:f.errors}));
 assert.equal(Number(pending.id),33);assert.equal(pending.action.type,'owner_invoice_payment');
 assert.deepEqual(pending.action.changes,{amount:500,currency:'USD'});assert.equal(pending.action.requestedInvoiceNumber,'SB-10442');
 assert.equal(pending.action.sourceMessageId,id);
 assert.match(response.answer,/propos|USD 500/i);
 return {pending,response};
}

async function sendButton(f,pending,id,offeredButtons=null){
 const buttons=offeredButtons||createOwnerActionButtons({scope:f.scope,action:pending,env:f.env});
 assert.deepEqual(buttons.map(button=>button.title),['Confirm','Cancel']);
 const signed=buttons[0].id;assert.ok(signed.startsWith('oab1.'));assert.equal(Buffer.byteLength(signed),153);
 const verified=verifyOwnerActionButton({id:signed,scope:f.scope,action:pending,env:f.env});
 assert.deepEqual(verified,{decision:'confirm',valid:true});
 await f.persist(id,'Confirm',{interactionId:signed,type:'interactive'});
 const envelope=(await f.db.query('select message_type,interaction_id,message_text from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];
 assert.equal(envelope.message_type,'interactive');assert.equal(envelope.interaction_id,signed);assert.equal(envelope.message_text,'Confirm');
 const transcript=(await f.db.query('select customer_id,kind,body from whatsapp_messages where provider_message_id=$1',[id])).rows[0];
 assert.equal(transcript.customer_id,null);assert.equal(transcript.kind,'interactive');assert.equal(transcript.body,'Confirm');
 return signed;
}

test('event259: missing mode uses guarded typed confirmation and bypasses malformed create planning',async()=>{
 const f=await fixture();try{
  const initial=await f.snapshot();assert.equal(initial.payments.length,0);assert.equal(initial.directReceipts.length,0);
  const {pending:proposal,response:proposalReply}=await propose(f);const beforeClick=await f.snapshot();
  assert.equal(Number(beforeClick.invoice.total_amount),951.52);assert.equal(Number(beforeClick.invoice.amount_paid),0);
  assert.equal(beforeClick.invoice.metadata.printed_invoice_number,'SB-10442');
  assert.equal((await f.db.query("select owner_bot_preferences->>'confirmationMode' value from workspace_settings where workspace_id=$1",[f.scope.workspaceId])).rows[0].value,null);
  assert.equal(proposalReply.buttons,undefined,JSON.stringify({proposalReply,preference:(await f.db.query('select owner_bot_preferences from workspace_settings where workspace_id=$1',[f.scope.workspaceId])).rows[0]}));

  // An older still-live signed button remains rejected by SQL when mode is
  // missing; the fix must align defaults without opening both auth paths.
  const oldButtons=createOwnerActionButtons({scope:f.scope,action:proposal,env:f.env});assert.equal(oldButtons.length,2);
  await sendButton(f,proposal,'event259-default-button',oldButtons);
  const oldInteraction=(await f.db.query("select interaction_id from whatsapp_inbound_events where provider_message_id='event259-default-button'")).rows[0].interaction_id;
  const buttonReply=await f.handler({...f.scope,messageId:'event259-default-button',message:'Confirm',interactionId:oldInteraction});
  assert.equal(f.decisions.length,1);assert.equal(f.decisions[0].result.code,'INVALID_AUTHORIZATION',JSON.stringify({buttonReply,decision:f.decisions[0]}));
  assert.deepEqual(await f.snapshot(),beforeClick,'the legacy null-mode button must not persist a payment or receipt');

  const providerCallsBeforeYes=f.providerCalls.length;
  await f.persist('event259-typed-confirm','yes');
  const typed=await f.handler({...f.scope,messageId:'event259-typed-confirm',message:'yes'});
  assert.equal(f.providerCalls.length,providerCallsBeforeYes,'current explicit yes selects scoped payment confirmation before another malformed provider create');
  const typedResult=f.executions.at(-1)?.result;
  assert.equal(typedResult?.completed,true,JSON.stringify({typed,typedResult,executions:f.executions,errors:f.errors}));
  assert.equal(typedResult.paymentAmount,500);assert.equal(typedResult.outstandingAmount,451.52);
  const after=await f.snapshot();assert.equal(after.payments.length,1);assert.equal(Number(after.payments[0].amount),500);
  assert.equal(after.payments[0].settle_remaining,false);assert.equal(Number(after.invoice.amount_paid),500);
  assert.equal(Number(after.invoice.total_amount),951.52);assert.equal(after.invoice.status,'draft');
  assert.equal(after.invoice.currency,'USD');assert.equal(after.invoice.customer_phone,null);assert.equal(after.invoice.metadata.next_follow_up_at,null);
  assert.equal(after.directReceipts.length,0);assert.equal(after.ownerReceipts,1);assert.equal(after.customerOutbound,0);
  assert.equal((await f.pending()),null);
  const replay=await f.handler({...f.scope,messageId:'event259-typed-confirm',message:'yes'});
  assert.equal(replay.replayed,true);assert.equal((await f.snapshot()).payments.length,1);assert.equal((await f.snapshot()).ownerReceipts,1);
  assert.equal(f.providerCalls.length,providerCallsBeforeYes);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('event259 explicit buttons mode confirms the actual signed interactive envelope once and rejects stale/wrong-scope buttons',async()=>{
 const f=await fixture({confirmationMode:'buttons'});try{
  const {pending:proposal,response:proposalReply}=await propose(f,'event259-buttons-proposal');
  assert.equal(proposalReply.buttons?.length,2,JSON.stringify(proposalReply));
  const oldButton=proposalReply.buttons[0].id;
  await f.db.query('update whatsapp_pending_actions set version=version+1 where id=$1',[proposal.id]);
  await f.persist('event259-stale-button','Confirm',{interactionId:oldButton,type:'interactive'});
  const stale=await f.handler({...f.scope,messageId:'event259-stale-button',message:'Confirm',interactionId:oldButton});
  assert.equal(f.decisions.length,0);assert.doesNotMatch(stale.answer,/payment recorded|Recorded USD 500/i);
  const changed=await f.pending();assert.equal(changed.version,proposal.version+1);assert.equal((await f.snapshot()).payments.length,0);

  const currentButtons=createOwnerActionButtons({scope:f.scope,action:changed,env:f.env});
  await f.persist('event259-wrong-scope-button','Confirm',{interactionId:currentButtons[0].id,type:'interactive'});
  const wrongScope=await f.handler({...f.scope,workspaceId:randomUUID(),messageId:'event259-wrong-scope-button',message:'Confirm',interactionId:currentButtons[0].id});
  assert.equal(wrongScope,'');assert.equal(f.decisions.length,0);assert.equal((await f.snapshot()).payments.length,0);

  await sendButton(f,changed,'event259-explicit-buttons-confirm',currentButtons);
  const interactionId=(await f.db.query("select interaction_id from whatsapp_inbound_events where provider_message_id='event259-explicit-buttons-confirm'")).rows[0].interaction_id;
  const confirmed=await f.handler({...f.scope,messageId:'event259-explicit-buttons-confirm',message:'Confirm',interactionId});
  assert.equal(f.decisions.length,1);assert.equal(f.decisions[0].result.completed,true,JSON.stringify({confirmed,decision:f.decisions[0],errors:f.errors}));
  assert.equal(f.decisions[0].result.paymentAmount,500);assert.equal(f.decisions[0].result.outstandingAmount,451.52);
  const after=await f.snapshot();assert.equal(after.payments.length,1);assert.equal(Number(after.payments[0].amount),500);
  assert.equal(after.payments[0].settle_remaining,false);assert.equal(Number(after.invoice.amount_paid),500);
  assert.equal(Number(after.invoice.total_amount),951.52);assert.equal(after.invoice.status,'draft');assert.equal(after.invoice.customer_phone,null);
  assert.equal(after.directReceipts.length,1);assert.equal(after.ownerReceipts,1);assert.equal(after.customerOutbound,0);
  const replay=await f.handler({...f.scope,messageId:'event259-explicit-buttons-confirm',message:'Confirm',interactionId});
  assert.equal(replay.replayed,true);assert.equal((await f.snapshot()).payments.length,1);assert.equal((await f.snapshot()).directReceipts.length,1);
  assert.equal(f.decisions.length,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
