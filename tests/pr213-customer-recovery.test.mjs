import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
const logger={info(){},warn(){},error(){}};
for(const failure of ['claim-ack','binding-after-fence','first-intent-old-event','uncertain-http'])test('saved customer intent owns recovery: '+failure,async()=>{
 const f=await fixture();try{
  const phone='+12025550888',id='wamid.customer-'+failure,stamp=new Date(Date.now()-2*3600000).toISOString(),sent=[];
  const customer=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Customer Grove',$2) returning id",[f.scope.workspaceId,phone])).rows[0].id;
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,received_at,status) values($1,'123456',$2,'text','Please help with gardening',$3,$3,'pending')",[id,phone,stamp]);
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture',array['invoice_updates'])",[f.scope.workspaceId,customer,phone]);
  const store=createConversationStore(f.supabase);const original='The stored gardening response\n\n- Offline Studio';
  await store.record({workspaceId:f.scope.workspaceId,customerId:customer,phone,direction:'inbound',audience:'customer',body:'Please help with gardening',status:'received',providerMessageId:id,key:'inbound:'+id});
  if(failure!=='first-intent-old-event')await store.record({workspaceId:f.scope.workspaceId,customerId:customer,phone,direction:'outbound',audience:'customer',body:original,status:'pending',kind:'normal',key:'reply:'+id});
  let injected=false,afterFence=false;
  const supabase={from:table=>{
   const query=f.supabase.from(table);
   if(table==='customers'&&failure==='binding-after-fence'){
    const select=query.select.bind(query);query.select=(...args)=>{const q=select(...args),single=q.maybeSingle.bind(q);q.maybeSingle=async()=>{if(afterFence&&!injected){injected=true;return {error:{code:'08006',message:'Transient binding read'}};}return single();};return q;};
   }return query;
  },rpc:async(name,args)=>{
   if(name==='whatsapp_dispatch_privacy_snapshot'&&failure==='first-intent-old-event'&&!injected){injected=true;return {error:{code:'57014',message:'Snapshot timeout'}};}
   const result=await f.supabase.rpc(name,args);
   if(name==='whatsapp_begin_reply_dispatch'&&result.data===true)afterFence=true;
   if(name==='whatsapp_claim_reserved_reply'&&result.data===true&&failure==='claim-ack'&&!injected){injected=true;return {error:{code:'08006',message:'Committed claim acknowledgement lost'}};}
   return result;
  }};
  const runtime=()=>createInboundRuntime({supabase,env,logger,onBoundMessage:async()=>({answer:'The stored gardening response'}),fetchImpl:async(_,init)=>{
   const body=JSON.parse(init.body);if(body.status==='read')return Response.json({success:true});sent.push(body);
   if(failure==='uncertain-http')throw Error('HTTP response lost');return Response.json({messages:[{id:'wamid.customer-delivered'}]});
  }});
  await runtime().processPending();
  let event=(await f.db.query('select * from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];
  if(failure==='uncertain-http'){assert.equal(sent.length,1);assert.equal(event.status,'done');}
  else{assert.equal(sent.length,0);assert.equal(event.status,'pending');assert.equal(event.reply_has_pending_intent,true);assert.equal(event.reply_dispatch_started_at,null);assert.notEqual(event.error_code,'INBOUND_DEAD_LETTER');}
  await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);await runtime().processPending();
  assert.equal(sent.length,1);assert.equal(sent[0].type,'text');assert.equal(sent[0].text.body,original);assert.ok(!JSON.stringify(sent).includes('Contact the business'));
  const receipt=(await f.db.query('select * from whatsapp_messages where idempotency_key=$1 and direction=\'outbound\'',['reply:'+id])).rows[0];assert.equal(receipt.body,original);
  if(failure!=='uncertain-http'){assert.equal(receipt.status,'accepted');await store.status({messageId:'wamid.customer-delivered',phone,status:'delivered'});assert.equal((await f.db.query('select status from whatsapp_messages where id=$1',[receipt.id])).rows[0].status,'delivered');}
  await runtime().processPending();assert.equal(sent.length,1);
 }finally{await f.close();}
});
