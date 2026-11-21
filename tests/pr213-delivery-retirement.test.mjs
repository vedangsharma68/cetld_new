import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fixture} from './fixtures/private-invoice.mjs';import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';import {createServiceDeliveryStore} from '../automation/whatsapp/service-delivery.mjs';import {assertDispatchServerReady} from '../signup-rollout.mjs';
import '../automation/whatsapp/cloud-outbound.mjs';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'},logger={info(){},warn(){},error(){}};
for(const prefix of [[],['expired'],['fenced'],['expired','fenced'],Array.from({length:10},(_,i)=>i%2?'fenced':'expired')])test('real worker drains retirement progress before a five-second ack cutoff: '+(prefix.join('/')||'sendable control'),async()=>{
 const f=await fixture();try{
  const store=createServiceDeliveryStore(f.supabase),sent=[],retired=[];
  const stage=async(id,expiry)=>{
   const event=(await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status,claim_token) values($1,'123456',$2,'text','Operation',clock_timestamp()-interval '24 hours'+$3::interval,'processing',$4) returning *",[id,f.scope.phone,expiry,randomUUID()])).rows[0];
   await store.save({workspaceId:f.scope.workspaceId,to:f.scope.phone,messageId:id,kind:'normal',audience:'owner',phase:'ack',body:'Immutable progress '+id,businessName:'Offline Studio'});
   await f.db.query("update whatsapp_inbound_events set status='done',claim_token=null,claimed_at=null,processed_at=clock_timestamp() where id=$1",[event.id]);return event;
  };
  for(const [i,kind]of prefix.entries()){
   const event=await stage('wamid.retire-'+i,kind==='expired'?'-1 hour':'1 hour');
   if(kind==='fenced')await f.db.query('update whatsapp_inbound_events set ack_dispatch_started_at=clock_timestamp(),ack_dispatch_nonce=$2 where id=$1',[event.id,randomUUID()]);
   retired.push({kind,event,markers:(await f.db.query('select ack_dispatch_started_at,ack_dispatch_nonce from whatsapp_inbound_events where id=$1',[event.id])).rows[0]});
  }
  const target=await stage('wamid.five-second-target','5 seconds'),cutoff=new Date(target.provider_timestamp).getTime()+24*3600000;
  const runtime=()=>createInboundRuntime({supabase:f.supabase,env,logger,onOwnerMessage:()=>assert.fail('Completed parents cannot regenerate work'),onBoundMessage:()=>assert.fail('Ack cannot change audience'),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});assert.ok(Date.now()<cutoff,'transport must start within the original service window');sent.push(p);return Response.json({messages:[{id:'wamid.retirement-delivered'}]});}});
  const first=await runtime().processPending(),initialSends=sent.length;
  const beforeCutoff=(await f.db.query("select status from app.whatsapp_service_deliveries where event_id=$1 and phase='ack'",[target.id])).rows[0].status;
  await new Promise(r=>setTimeout(r,Math.max(0,cutoff-Date.now()+100)));
  const second=await runtime().processPending();
  assert.equal(initialSends,1,JSON.stringify({prefix,first,beforeCutoff,second}));assert.equal(first.claimed,1);assert.equal(first.completed,1);assert.equal(beforeCutoff,'accepted');assert.equal(sent.length,1);assert.equal(sent[0].text.body,'Immutable progress '+target.provider_message_id);assert.equal(second.claimed,0);
  for(const {kind,event,markers}of retired){assert.equal((await f.db.query('select status from app.whatsapp_service_deliveries where event_id=$1',[event.id])).rows[0].status,kind==='expired'?'blocked':'quarantined');assert.deepEqual((await f.db.query('select ack_dispatch_started_at,ack_dispatch_nonce from whatsapp_inbound_events where id=$1',[event.id])).rows[0],markers);}
  assert.equal((await f.db.query('select status from whatsapp_inbound_events where id=$1',[target.id])).rows[0].status,'done');
 }finally{await f.close();}
});
test('frontend and worker enforce the same readiness version before either claim API',async()=>{
 const f=await fixture();try{
  const status=(await f.supabase.rpc('whatsapp_service_delivery_status',{})).data,claims=[];
  for(const value of [{...status,version:99},{...status,version:undefined},{...status,version:'1'},{...status,queueRevision:99},{...status,ready:false}]){
   const supabase={storage:f.supabase.storage,from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>{if(name==='whatsapp_service_delivery_status')return {data:value};if(name.includes('claim'))claims.push(name);return f.supabase.rpc(name,args);}};
   await assert.rejects(assertDispatchServerReady({url:'https://fixture.supabase.test',key:'fixture'},{fetchImpl:async()=>Response.json(value)}),/four/);
   await assert.rejects(createInboundRuntime({supabase,env,logger}).processPending(),/four/);assert.equal(claims.length,0,'incompatible schema cannot claim work');
  }
  assert.equal((await createInboundRuntime({supabase:f.supabase,env,logger}).processPending()).claimed,0);
 }finally{await f.close();}
});
