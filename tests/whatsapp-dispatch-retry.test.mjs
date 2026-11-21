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

test('lost committed claim acknowledgement is recovered after two hours with one delivered send',async()=>{
 const f=await fixture();try{
 const id='wamid.lost-claim-ack',timestamp=new Date(Date.now()-2*3600_000).toISOString();let lose=true,deliveries=0;
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,received_at,status,error_code) values($1,'123456',$2,'text','Hello',$3,$3,'pending','OWNER_REPLY_NOT_ACCEPTED')",[id,f.scope.phone,timestamp]);
 const store=createConversationStore(f.supabase);await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Stored reply survives claim acknowledgement loss',kind:'normal',status:'pending',key:'reply:'+id});
 const supabase={from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{const result=await f.supabase.rpc(name,args);if(name==='whatsapp_claim_reserved_reply'&&result.data===true&&lose){lose=false;return {error:{code:'NETWORK_ACK_LOST',message:'Claim committed but response was lost'}};}return result;}};
 const runtime=()=>createInboundRuntime({supabase,env,logger,onOwnerMessage:async()=>({answer:'New answer is not the saved intent'}),fetchImpl:async(_,init)=>{const body=JSON.parse(init.body);if(body.status==='read')return Response.json({success:true});deliveries++;assert.equal(body.text.body,'Stored reply survives claim acknowledgement loss');return Response.json({messages:[{id:'wamid.claim-recovered'}]});}});
 await runtime().processPending();assert.equal(deliveries,0);let row=(await f.db.query('select * from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];assert.equal(row.status,'pending');assert.ok(row.reply_claimed_at);assert.equal(row.reply_dispatch_started_at,null);assert.equal(row.reply_has_pending_intent,true);
 await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);await runtime().processPending();assert.equal(deliveries,1);
 row=(await f.db.query('select * from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];assert.ok(row.reply_dispatch_started_at);assert.equal(row.status,'done');
 await store.status({messageId:'wamid.claim-recovered',phone:f.scope.phone,status:'delivered'});assert.equal((await f.db.query('select status from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows[0].status,'delivered');
 await runtime().processPending();assert.equal(deliveries,1);
 }finally{await f.close();}
});

test('service-window cutoff during a binding await fails closed before Graph',async()=>{
 const f=await fixture();try{
 const id='wamid.binding-cutoff';let now=Date.now(),sends=0;const initial=now;
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',$3,'processing')",[id,f.scope.phone,new Date(now-24*3600_000+10000).toISOString()]);
 const supabase={from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{const result=await f.supabase.rpc(name,args);if(name==='whatsapp_resolve_service_owner')now=initial+11000;return result;}};
 const sender=createWhatsAppOutbound({supabase,env,logger,clock:()=>new Date(now),authorizeInboundReply:async()=>({allowed:true}),fetchImpl:async()=>{sends++;return Response.json({});}});
 const result=await sender.sendServiceReply({workspaceId:f.scope.workspaceId,to:f.scope.phone,body:'Safe reply',lastInboundAt:new Date(initial-24*3600_000+10000).toISOString(),messageId:id,audience:'owner',businessName:'Offline Studio'});assert.equal(result.status,'blocked');assert.equal(result.reason,'service_window_closed');assert.equal(sends,0);
 }finally{await f.close();}
});

test('service-window cutoff after transport-fence await also prevents Graph',async()=>{
 const f=await fixture();try{
 const id='wamid.fence-cutoff';let now=Date.now(),sends=0;const initial=now,timestamp=new Date(now-24*3600_000+10000).toISOString();
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',$3,'processing')",[id,f.scope.phone,timestamp]);
 const supabase={from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{const result=await f.supabase.rpc(name,args);if(name==='whatsapp_begin_reply_dispatch')now=initial+11000;return result;}};
 const sender=createWhatsAppOutbound({supabase,env,logger,clock:()=>new Date(now),authorizeInboundReply:async input=>{const r=await f.supabase.rpc('whatsapp_claim_reserved_reply',{p_message_id:input.messageId,p_phone:input.phone,p_workspace_id:input.workspaceId,p_phone_number_id:'123456',p_kind:input.kind,p_phase:'answer',p_audience:'owner',p_commercial:true,p_nonce:input.reservationNonce});return {allowed:r.data===true};},fetchImpl:async()=>{sends++;return Response.json({});}});
 const result=await sender.sendServiceReply({workspaceId:f.scope.workspaceId,to:f.scope.phone,body:'Safe reply',lastInboundAt:timestamp,messageId:id,audience:'owner',businessName:'Offline Studio'});assert.equal(result.status,'blocked');assert.equal(result.reason,'service_window_closed');assert.equal(sends,0);
 }finally{await f.close();}
});


test('lost committed transport-fence acknowledgement reconciles only its own invocation and sends once',async()=>{
 const f=await fixture();try{
 const id='wamid.lost-fence-ack';let lose=true,sends=0;const nonces=[];
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now(),'pending')",[id,f.scope.phone]);
 const supabase={from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{const result=await f.supabase.rpc(name,args);if(name==='whatsapp_begin_reply_dispatch'){nonces.push(args.p_nonce);if(result.data===true&&lose){lose=false;return {error:{message:'Committed fence acknowledgement lost'}};}}return result;}};
 const runtime=()=>createInboundRuntime({supabase,env,logger,onOwnerMessage:async()=>({answer:'A safe answer'}),fetchImpl:async(_,init)=>{if(JSON.parse(init.body).status==='read')return Response.json({success:true});sends++;return Response.json({messages:[{id:'wamid.fence-once'}]});}});
 await runtime().processPending();assert.equal(sends,1);assert.equal(nonces.length,2);assert.equal(nonces[0],nonces[1]);
 await f.db.query("update whatsapp_inbound_events set status='pending',next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);await runtime().processPending();assert.equal(sends,1);
 }finally{await f.close();}
});
test('historical claimed replies without a registered handoff remain quarantined rather than duplicated',async()=>{
 const f=await fixture();try{
 const id='wamid.legacy-ambiguous';let sends=0;
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status,reply_claimed_at) values($1,'123456',$2,'text','Hello',now(),'pending',now())",[id,f.scope.phone]);
 const store=createConversationStore(f.supabase);await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Ambiguous historical intent',kind:'normal',status:'pending',key:'reply:'+id});
 const runtime=createInboundRuntime({supabase:f.supabase,env,logger,onOwnerMessage:async()=>({answer:'Different answer'}),fetchImpl:async(_,init)=>{if(JSON.parse(init.body).status==='read')return Response.json({success:true});sends++;return Response.json({messages:[{id:'must-not-send'}]});}});
 await runtime.processPending();assert.equal(sends,0);const row=(await f.db.query('select reply_claimed_at,reply_reservation_nonce from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];assert.ok(row.reply_claimed_at);assert.equal(row.reply_reservation_nonce,null);
 }finally{await f.close();}
});
