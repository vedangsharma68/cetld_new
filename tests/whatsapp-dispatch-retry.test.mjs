import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
const logger={info(){},warn(){},error(){}};
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'local-test-only',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
test('snapshot outage defers before claim; reconstructed worker reuses the pending body and delivers exactly once',async()=>{
 const f=await fixture();try{
 const id='wamid.snapshot-retry';let fail=true,deliveries=0;const sent=[];
 const supabase={from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{if(name==='whatsapp_dispatch_privacy_snapshot'&&fail)return {data:null,error:{code:'57014',message:'Recipient privacy snapshot unavailable'}};return f.supabase.rpc(name,args);}};
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now(),'pending')",[id,f.scope.phone]);
 const runtime=answer=>createInboundRuntime({supabase,env,logger,onOwnerMessage:async()=>({answer}),fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).hostname,'graph.facebook.com');const body=JSON.parse(init.body);if(body.status==='read')return Response.json({success:true});
  deliveries++;sent.push(body);return Response.json({messages:[{id:'wamid.delivered-once'}]});
 }});
 await runtime('The original safe answer').processPending();
 let event=(await f.db.query('select status,error_code,reply_claimed_at from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];
 assert.equal(event.status,'pending');assert.equal(event.error_code,'OWNER_REPLY_NOT_ACCEPTED');assert.equal(event.reply_claimed_at,null);assert.equal(deliveries,0);
 let rows=(await f.db.query('select body,status from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(rows[0].body,'The original safe answer');
 fail=false;await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);
 await runtime('A newly generated answer must not replace the saved body').processPending();
 assert.equal(deliveries,1);assert.equal(sent[0].text.body,'The original safe answer');
 rows=(await f.db.query('select body,status,provider_message_id from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'accepted');assert.equal(rows[0].provider_message_id,'wamid.delivered-once');
 // Force lease recovery after the accepted send. The durable reply claim still
 // prevents another Graph request, even if a worker tries to process it again.
 await f.db.query("update whatsapp_inbound_events set status='pending',next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);
 await Promise.all([runtime('Changed again').processPending(),runtime('Concurrent worker').processPending()]);assert.equal(deliveries,1);
 const store=createConversationStore(f.supabase);await store.status({messageId:'wamid.delivered-once',phone:f.scope.phone,status:'delivered'});
 assert.equal((await f.db.query('select status from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows[0].status,'delivered');
 }finally{await f.close();}
});
test('a deferred pending reply older than the service window cannot send or claim',async()=>{
 const f=await fixture();try{
 const id='wamid.stale-snapshot-retry';const timestamp=new Date(Date.now()-25*3600_000).toISOString();let sends=0,claims=0;
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',$3,'processing')",[id,f.scope.phone,timestamp]);
 const store=createConversationStore(f.supabase);await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Saved safe answer',status:'pending',kind:'normal',key:'reply:'+id});
 const sender=createWhatsAppOutbound({supabase:f.supabase,env,logger,conversationStore:store,authorizeInboundReply:async()=>{claims++;return {allowed:true};},fetchImpl:async()=>{sends++;throw Error('Stale send');}});
 const result=await sender.sendServiceReply({workspaceId:f.scope.workspaceId,to:f.scope.phone,body:'Saved safe answer',lastInboundAt:timestamp,kind:'normal',audience:'owner',messageId:id,businessName:'Offline Studio'});
 assert.equal(result.status,'blocked');assert.equal(result.reason,'service_window_closed');assert.equal(claims,0);assert.equal(sends,0);
 assert.equal((await f.db.query('select status from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows[0].status,'pending');
 }finally{await f.close();}
});
