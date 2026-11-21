import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fixture} from './fixtures/private-invoice.mjs';import {createInboundRuntime,SupabaseInboundInbox} from '../automation/whatsapp/cloud-inbound.mjs';import {createServiceDeliveryStore} from '../automation/whatsapp/service-delivery.mjs';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'},logger={info(){},warn(){},error(){}};
test('real yielded progress acknowledgement respects its backoff while unfinished and unrelated inbox work complete',async()=>{
 const f=await fixture(),timer=globalThis.setTimeout;try{
  const id='wamid.fairness-parent',other='wamid.fairness-other',sent=[],handled=[];let fault=true,armed=false,ackClaims=0,inboxClaims=0;
  const enqueue=async(messageId,message)=>f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text',$3,now(),'pending')",[messageId,f.scope.phone,message]);
  await enqueue(id,'Unfinished work');
  const supabase={storage:f.supabase.storage,from:table=>{const q=f.supabase.from(table);if(table==='whatsapp_inbound_events'){const select=q.select.bind(q);q.select=(...args)=>{const query=select(...args),single=query.maybeSingle.bind(query);query.maybeSingle=async()=>{if(args[0]==='*'&&armed){armed=false;if(fault)return {error:{code:'08006',message:'Transient acknowledgement authority failure'}};}return single();};return query;};}return q;},rpc:async(name,args)=>{const r=await f.supabase.rpc(name,args);if(name==='whatsapp_claim_reserved_reply'&&args.p_phase==='ack'&&r.data===true){ackClaims++;armed=true;}if(name==='whatsapp_claim_inbound_events')inboxClaims++;return r;}};
  globalThis.setTimeout=(cb,ms,...args)=>timer(cb,ms===60000?5:ms,...args);
  const runtime=()=>createInboundRuntime({supabase,env,logger,onOwnerMessage:async input=>{handled.push(input.messageId);if(input.messageId===id&&handled.filter(x=>x===id).length===1){await new Promise(r=>timer(r,50));return {deferred:true};}return {answer:input.messageId===id?'Original final reply':'Unrelated final reply'};},onBoundMessage:()=>assert.fail('Owner scope must remain owner scope'),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.fairness-send-'+sent.length}]});}});
  await runtime().processPending();assert.equal(ackClaims,1);assert.equal(sent.length,0);
  const parent=(await f.db.query('select * from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];assert.equal(parent.status,'pending');
  const ack=(await f.db.query("select * from app.whatsapp_service_deliveries where event_id=$1 and phase='ack'",[parent.id])).rows[0];assert.equal(ack.status,'pending');assert.ok(Date.parse(ack.next_attempt_at)>Date.now());
  await enqueue(other,'Independent work');const before=inboxClaims;
  await runtime().processPending();assert.equal(ackClaims,1,'parent due time cannot bypass phase backoff');assert.ok(inboxClaims>before,'ordinary inbox work must be claimed');
  assert.deepEqual(sent.map(p=>p.text.body).sort(),['Original final reply','Unrelated final reply']);assert.equal(handled.filter(x=>x===id).length,2);assert.equal(handled.filter(x=>x===other).length,1);
  assert.equal((await f.db.query('select status from whatsapp_inbound_events where id=$1',[parent.id])).rows[0].status,'done');
  await runtime().processPending();assert.equal(ackClaims,1);assert.equal(sent.length,2);
  fault=false;await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 second' where event_id=$1 and phase='ack'",[parent.id]);
  await runtime().processPending();assert.equal(sent.length,3);assert.equal(sent[2].text.body,ack.request.input.body);assert.equal(ackClaims,2);
  await runtime().processPending();assert.equal(sent.length,3);assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key=$1",['ack:'+id])).rows[0].status,'accepted');
 }finally{globalThis.setTimeout=timer;await f.close();}
});
test('real worker releases a repeated phase without ending the run or starving other delivery and inbox work',async()=>{
 const f=await fixture();try{
  const ids=['wamid.duplicate-first','wamid.duplicate-second'],events=[],sent=[];let armed=false,claims=0,repeated=false;
  for(const id of ids){const e=(await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status,claim_token) values($1,'123456',$2,'text','Operation',now(),'processing',$3) returning *",[id,f.scope.phone,randomUUID()])).rows[0];events.push(e);await createServiceDeliveryStore(f.supabase).save({workspaceId:f.scope.workspaceId,to:f.scope.phone,messageId:id,kind:'normal',audience:'owner',phase:'ack',body:'Stored ack '+id,businessName:'Offline Studio'});await f.db.query("update whatsapp_inbound_events set status='done',claim_token=null,claimed_at=null where id=$1",[e.id]);}
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values('wamid.duplicate-ordinary','123456',$1,'text','Ordinary work',now(),'pending')",[f.scope.phone]);
  const supabase={storage:f.supabase.storage,from:table=>{const q=f.supabase.from(table);if(table==='whatsapp_inbound_events'){const select=q.select.bind(q);q.select=(...args)=>{const query=select(...args),single=query.maybeSingle.bind(query);query.maybeSingle=async()=>{if(args[0]==='*'&&armed){armed=false;return {error:{code:'08006',message:'Known-unsent phase fault'}};}return single();};return query;};}return q;},rpc:async(name,args)=>{const r=await f.supabase.rpc(name,args);if(name==='whatsapp_claim_reserved_reply'&&args.p_message_id===ids[0]&&args.p_phase==='ack'&&r.data===true){armed=true;claims++;}return r;}};
  const inbox=new SupabaseInboundInbox(supabase,{env}),claim=inbox.claimDelivery.bind(inbox);inbox.claimDelivery=async excluded=>{
   // Simulate a stale/repeated lease response once. All actual claims, leases,
   // sender checks and dispatch still run against the disposable SQL database.
   if(excluded.length&&!repeated){repeated=true;await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 second' where event_id=$1",[events[0].id]);return claim([]);}return claim(excluded);
  };
  const runtime=createInboundRuntime({supabase,inbox,env,logger,onOwnerMessage:async()=>({answer:'Ordinary independent answer'}),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.duplicate-send-'+sent.length}]});}});
  await runtime.processPending();assert.equal(repeated,true);assert.equal(claims,1);assert.deepEqual(sent.map(p=>p.text.body).sort(),['Ordinary independent answer','Stored ack '+ids[1]]);assert.equal((await f.db.query("select status from app.whatsapp_service_deliveries where event_id=$1",[events[0].id])).rows[0].status,'pending');assert.equal((await f.db.query("select status from whatsapp_inbound_events where provider_message_id='wamid.duplicate-ordinary'")).rows[0].status,'done');
 }finally{await f.close();}
});
