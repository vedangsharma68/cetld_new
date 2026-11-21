import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {fixture} from './fixtures/private-invoice.mjs';import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
test('snapshot unavailability preserves saved body, retries after reconstruction and emits only safe diagnostics',async()=>{
 const f=await fixture();try{
  const id='wamid.snapshot-recovery',body='You can review your invoice.',sent=[],logs=[];let outage=true,models=0;
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now(),'pending')",[id,f.scope.phone]);
  const supabase={storage:f.supabase.storage,from:f.supabase.from.bind(f.supabase),rpc:async(name,args)=>name==='whatsapp_dispatch_privacy_snapshot'&&outage?{error:{code:'57014',message:'SECRET snapshot terms'}}:f.supabase.rpc(name,args)};
  const runtime=()=>createInboundRuntime({supabase,env,logger:{info(){},warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},onOwnerMessage:async()=>{models++;return {answer:body};},fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.snapshot-sent'}]});}});
  await runtime().processPending();assert.equal(sent.length,0);
  let receipt=(await f.db.query("select * from whatsapp_messages where idempotency_key=$1",['reply:'+id])).rows[0];assert.equal(receipt.status,'pending');assert.equal(receipt.body,body);assert.equal(receipt.dispatch_started_at,null);
  assert.equal((await f.db.query('select d.status from app.whatsapp_service_deliveries d join whatsapp_inbound_events e on e.id=d.event_id where e.provider_message_id=$1',[id])).rows[0].status,'pending');
  outage=false;await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 minute'");await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id=$1",[id]);
  await runtime().processPending();assert.equal(sent.length,1);assert.equal(sent[0].text.body,body);await runtime().processPending();assert.equal(sent.length,1);assert.equal(models,1);
  assert.ok(logs.some(args=>args.some(x=>x?.category==='snapshot_unavailable')));assert.ok(!JSON.stringify(logs).includes('SECRET'));
 }finally{await f.close();}
});
test('populated legacy answers reconcile once, expire stale/orphan receipts and quarantine uncertain handoffs',async()=>{
 const f=await fixture();try{
  const sql=await readFile(new URL('../supabase/migrations/20261121212253_whatsapp_admission_recovery.sql',import.meta.url),'utf8'),store=createConversationStore(f.supabase),sent=[];
  const rows=[];
  for(const kind of ['ready','expired','fenced','claimed','orphan']){
   const id='wamid.legacy-answer-'+kind,body='Stored legacy answer '+kind;
   if(kind!=='orphan')await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now()-$3::interval,'done')",[id,f.scope.phone,kind==='expired'?'25 hours':'1 hour']);
   await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body,kind:'normal',status:'pending',key:'reply:'+id});
   if(kind==='fenced')await f.db.query("update whatsapp_inbound_events set reply_dispatch_started_at=now() where provider_message_id=$1",[id]);
   if(kind==='claimed')await f.db.query("update whatsapp_inbound_events set reply_claimed_at=now() where provider_message_id=$1",[id]);rows.push({id,kind,body});
  }
  await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Historical reply without a recoverable event key',kind:'normal',status:'pending',key:'old-answer:orphan'});
  await f.db.exec(sql);await f.db.exec(sql);
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='old-answer:orphan'")).rows[0].status,'blocked');
  for(const {id,kind,body}of rows){const receipt=(await f.db.query('select * from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows[0];assert.equal(receipt.body,body);assert.equal(receipt.status,kind==='ready'?'pending':['fenced','claimed'].includes(kind)?'unknown':'blocked');}
  assert.equal((await f.db.query('select count(*)::int n from app.whatsapp_service_deliveries')).rows[0].n,4);
  const runtime=()=>createInboundRuntime({supabase:f.supabase,env,logger:{info(){},warn(){},error(){}},onOwnerMessage:()=>assert.fail('Saved body must not regenerate'),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.legacy-answer-sent'}]});}});
  await runtime().processPending();await runtime().processPending();assert.equal(sent.length,1);assert.equal(sent[0].text.body,rows[0].body);
 }finally{await f.close();}
});
