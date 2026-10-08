import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';

const phoneFor=index=>`+1555555020${index}`;

test('invoice review accepts NULL and owner-bound message evidence but rejects another customer context',async()=>{
 const f=await createOfflineSqlNetwork(),{db}=f;
 try{
  const cases=['null','bound','other'];
  for(const [index,customerCase]of cases.entries()){
   const ownerId=randomUUID(),phone=phoneFor(index),sourceId=`direction-${customerCase}`;
   await db.query('insert into auth.users(id) values($1)',[ownerId]);
   await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
   const workspaceId=(await db.query("select (public.create_workspace('Invoice evidence fixture',$1)).id",[randomUUID()])).rows[0].id;
   const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
   await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
   assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) result',[phone,verification.code])).rows[0].result.ok,true);
   const ownerCustomerId=(await db.query('select customer_id from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
   const otherCustomerId=(await db.query("insert into customers(workspace_id,name) values($1,'Different customer') returning id",[workspaceId])).rows[0].id;
   const reviewAction={type:'invoice_review_draft',stage:'incomplete',missingFields:['direction'],validationIssues:[],
    currencySource:'photo',sourceMessageId:`image-${customerCase}`,
    invoice:{invoiceNumber:'INV-SCOPE',clientName:'Acme',total:10,currency:'USD',direction:'uncertain'}};
   const draft=(await db.query(`insert into whatsapp_pending_actions
    (workspace_id,customer_id,phone,action,source,version,generation,expires_at)
    values($1,$2,$3,$4,'whatsapp',1,1,now()+interval '15 minutes') returning id,version`,
    [workspaceId,ownerCustomerId,phone,JSON.stringify(reviewAction)])).rows[0];
   const message='We issued this invoice.';
   await db.query(`insert into whatsapp_inbound_events
    (provider_message_id,phone_number_id,sender_phone,message_type,message_text,status)
    values($1,'fixture',$2,'text',$3,'processing')`,[sourceId,phone,message]);
   const messageCustomerId=customerCase==='null'?null:customerCase==='bound'?ownerCustomerId:otherCustomerId;
   await db.query(`insert into whatsapp_messages
    (workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key)
    values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)`,
    [workspaceId,messageCustomerId,phone,message,sourceId]);
   const proposal={...reviewAction,stage:'proposal',missingFields:[],
    invoice:{...reviewAction.invoice,direction:'receivable'},
    ownerProvidedFacts:{direction:{value:'receivable',sourceMessageId:sourceId}}};
   const transition=()=>db.query(`select * from public.whatsapp_transition_invoice_review
    ($1,$2,$3,$4,$5,'incomplete',$6)`,[draft.id,draft.version,workspaceId,ownerCustomerId,phone,JSON.stringify(proposal)]);
   if(customerCase==='other')await assert.rejects(transition(),/invoice review fact source is outside owner scope/);
   else{
    const result=await transition();
    assert.equal(result.rows.length,1,`${customerCase} owner inbound message remains valid evidence`);
    assert.equal(result.rows[0].action.stage,'proposal');
   }
   assert.equal((await db.query('select customer_id from whatsapp_messages where provider_message_id=$1',[sourceId])).rows[0].customer_id,messageCustomerId);
  }
 }finally{await f.close();}
});

test('cloud inbound persists an owner turn with NULL customer_id and owner review continues through SQL',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f;
 try{
  const ownerId=randomUUID(),phone='+15555550210',messageId='cloud-owner-direction';
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Cloud owner fixture',$1)).id",[randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) result',[phone,verification.code])).rows[0].result.ok,true);
  const customerId=(await db.query('select customer_id from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const action={type:'invoice_review_draft',stage:'incomplete',sourceMessageId:'image-cloud',currencySource:'photo',
   missingFields:['direction'],validationIssues:[],invoice:{invoiceNumber:'INV-CLOUD',clientName:'Acme',invoiceDate:'2026-10-01',
    dueDate:'2026-10-31',total:10,currency:'USD',direction:'uncertain'}};
  const draft=(await db.query(`insert into whatsapp_pending_actions
   (workspace_id,customer_id,phone,action,source,version,generation,expires_at)
   values($1,$2,$3,$4,'whatsapp',1,1,now()+interval '15 minutes') returning id,version`,
   [workspaceId,customerId,phone,JSON.stringify(action)])).rows[0];
  const message='We issued this invoice.';
  const event=(await db.query(`insert into whatsapp_inbound_events
   (provider_message_id,phone_number_id,sender_phone,message_type,message_text,status)
   values($1,'fixture',$2,'text',$3,'processing') returning id,received_at`,[messageId,phone,message])).rows[0];
  let agentCalls=0,directionResult;
  const ownerHandler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
   replyStore:null,authorize:async()=>true,agentFactory:async({tools})=>{
    agentCalls++;
    directionResult=await tools.execute('workspaceData',{operation:'reviewAttachment',table:'invoices',values:{invoice_direction:'receivable'}});
    assert.equal(directionResult.ok,true,JSON.stringify(directionResult));
    assert.equal(directionResult.stage,'proposal');
    return {answer:'Direction recorded.'};
   }});
  const inbox={async claim(){return [{id:event.id,attempts:1,provider_message_id:messageId,phone_number_id:'fixture',
    sender_phone:phone,message_type:'text',message_text:message,received_at:event.received_at,status:'processing'}];},
   async complete(){},async defer(...args){throw new Error(`unexpected defer ${args[1]||''}`);}};
  const runtime=createInboundRuntime({supabase,inbox,outbound:{async sendTypingIndicator(){return {status:'accepted'};},
   async sendServiceReply(){return {status:'accepted'};}},onOwnerMessage:ownerHandler,logger:{info(){},warn(){},error(){}}});
  const outcome=await runtime.processPending();
  assert.deepEqual(outcome,{claimed:1,completed:1});
  const savedMessage=(await db.query('select customer_id,audience,direction,body from whatsapp_messages where provider_message_id=$1',[messageId])).rows[0];
  assert.equal(savedMessage.customer_id,null);assert.equal(savedMessage.audience,'owner');assert.equal(savedMessage.direction,'inbound');
  const current=(await db.query('select version,action from whatsapp_pending_actions where id=$1',[draft.id])).rows[0];
  assert.equal(current.version,2,JSON.stringify({current,outcome,agentCalls,directionResult,errors:f.errors}));assert.equal(current.action.stage,'proposal');
  assert.deepEqual(current.action.ownerProvidedFacts.direction,{value:'receivable',sourceMessageId:messageId});
  for(const table of ['invoices','payments'])assert.equal((await db.query(`select count(*)::int count from ${table}`)).rows[0].count,0,table);
  assert.equal((await db.query("select count(*)::int count from whatsapp_messages where audience='customer'")).rows[0].count,0);
 }finally{await f.close();}
});
