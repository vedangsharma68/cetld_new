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
  // Orphaned receipts that carry handoff evidence stay callback-reconcilable.
  await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Orphaned handoff with provider identity',kind:'normal',status:'pending',key:'reply:wamid.orphan-provider'});
  await f.db.query("update whatsapp_messages set provider_message_id='wamid.orphan-provider' where idempotency_key='reply:wamid.orphan-provider'");
  await store.record({workspaceId:f.scope.workspaceId,phone:f.scope.phone,direction:'outbound',audience:'owner',body:'Orphaned handoff with dispatch fence',kind:'normal',status:'pending',key:'reply:wamid.orphan-fenced'});
  await f.db.query("update whatsapp_messages set dispatch_started_at=now() where idempotency_key='reply:wamid.orphan-fenced'");
  // Settled history the reconciliation must not rewrite.
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) select 'wamid.settled-'||n,'123456',$1,'text','Hello',now()-interval '2 days','done' from generate_series(1,50)n",[f.scope.phone]);
  await f.db.query("insert into app.whatsapp_service_deliveries(event_id,workspace_id,phase,request,status) select e.id,$1,'answer','{}','accepted' from whatsapp_inbound_events e where e.provider_message_id like 'wamid.settled-%'",[f.scope.workspaceId]);
  const settledBefore=(await f.db.query("select id,reply_has_pending_intent from whatsapp_inbound_events where provider_message_id like 'wamid.settled-%' order by id")).rows;
  // Count event-row writes during the migration: the rollup refresh must stay
  // bounded by the transitioned set, never the full delivery history.
  await f.db.exec(`create table public._refresh_audit(event_id bigint);
create or replace function public._refresh_audit_trigger() returns trigger language plpgsql as $$begin insert into public._refresh_audit values(new.id);return new;end$$;
drop trigger if exists _refresh_audit on public.whatsapp_inbound_events;
create trigger _refresh_audit after update on public.whatsapp_inbound_events for each row execute function public._refresh_audit_trigger();`);
  const canonicalBefore=(await f.db.query('select app.private_invoice_canonical_revision() revision')).rows[0].revision;
  await f.db.exec(sql);await f.db.exec(sql);
  assert.equal((await f.db.query('select app.private_invoice_canonical_revision() revision')).rows[0].revision,canonicalBefore);
  assert.match((await f.db.query('select app.private_invoice_admission_revision() revision')).rows[0].revision,/^[a-f0-9]{64}$/);
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='old-answer:orphan'")).rows[0].status,'blocked');
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='reply:wamid.orphan-provider'")).rows[0].status,'unknown');
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='reply:wamid.orphan-fenced'")).rows[0].status,'unknown');
  for(const {id,kind,body}of rows){const receipt=(await f.db.query('select * from whatsapp_messages where idempotency_key=$1',['reply:'+id])).rows[0];assert.equal(receipt.body,body);assert.equal(receipt.status,kind==='ready'?'pending':['fenced','claimed'].includes(kind)?'unknown':'blocked');}
  // A later delivered callback still reconciles a provider-identified orphan,
  // while an expired orphan stays terminally blocked.
  await store.status({messageId:'wamid.orphan-provider',phone:f.scope.phone,status:'delivered'});
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='reply:wamid.orphan-provider'")).rows[0].status,'delivered');
  await store.status({messageId:'old-answer:orphan',phone:f.scope.phone,status:'delivered'});
  assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='old-answer:orphan'")).rows[0].status,'blocked');
  // The rollup refresh rewrote only the four transitioned events.
  assert.equal((await f.db.query('select count(distinct event_id)::int n from public._refresh_audit')).rows[0].n,4);
  assert.deepEqual((await f.db.query("select id,reply_has_pending_intent from whatsapp_inbound_events where provider_message_id like 'wamid.settled-%' order by id")).rows,settledBefore);
  assert.equal((await f.db.query('select count(*)::int n from app.whatsapp_service_deliveries')).rows[0].n,54);
  const runtime=()=>createInboundRuntime({supabase:f.supabase,env,logger:{info(){},warn(){},error(){}},onOwnerMessage:()=>assert.fail('Saved body must not regenerate'),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.legacy-answer-sent'}]});}});
  await runtime().processPending();await runtime().processPending();assert.equal(sent.length,1);assert.equal(sent[0].text.body,rows[0].body);
 }finally{await f.close();}
});

test('a snapshot read that outlives the worker budget expires retryable with a safe diagnostic and the queue keeps moving',async()=>{
 const f=await fixture();try{
  const body='You can review your invoice.',sent=[],logs=[];let stalled=true,models=0;
  const envWithBudget={...env,WHATSAPP_PROCESS_BUDGET_MS:'6000'};
  for(const n of [1,2])await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now(),'pending')",['wamid.snapshot-stall-'+n,f.scope.phone]);
  const supabase={storage:f.supabase.storage,from:f.supabase.from.bind(f.supabase),rpc:(name,args)=>name==='whatsapp_dispatch_privacy_snapshot'&&stalled?new Promise(()=>{}):f.supabase.rpc(name,args)};
  const runtime=()=>createInboundRuntime({supabase,env:envWithBudget,logger:{info(){},warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},onOwnerMessage:async()=>{models++;return {answer:body};},fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.stall-sent'}]});}});
  const first=await runtime().processPending();
  assert.equal(sent.length,0);assert.equal(first.completed,0);assert.equal(models,1);
  assert.ok(logs.some(args=>args.some(x=>x?.category==='snapshot_unavailable')),JSON.stringify(logs).slice(0,300));
  assert.ok(!JSON.stringify(logs).includes(body));
  const receipt=(await f.db.query("select status from whatsapp_messages where idempotency_key like 'reply:wamid.snapshot-stall-%'")).rows;
  assert.equal(receipt.length,1);assert.equal(receipt[0].status,'pending');
  // The second event was never claimed or leased past the deadline.
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_inbound_events where provider_message_id like 'wamid.snapshot-stall-%' and status='pending'")).rows[0].n,2);
  stalled=false;await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 minute'");await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id like 'wamid.snapshot-stall-%'");
  await runtime().processPending();await runtime().processPending();
  assert.equal(sent.length,2);assert.equal(models,2);assert.ok(sent.every(p=>p.text.body===body));
 }finally{await f.close();}
});

test('worker startup refuses to claim when the live admission revision differs from the build',async()=>{
 const f=await fixture();try{
  const runtime=()=>createInboundRuntime({supabase:f.supabase,env:{},logger:{error(){},warn(){},info(){}}});
  assert.equal((await runtime().processPending()).claimed,0);
  await f.db.exec("create or replace function app.private_invoice_admission_revision() returns text language sql immutable set search_path='' as $$select repeat('0',64)::text$$");
  await assert.rejects(runtime().processPending(),/admission revision/i);
  await f.db.exec('drop function public.whatsapp_dispatch_admission_revision()');
  await assert.rejects(runtime().processPending(),/admission revision/i);
 }finally{await f.close();}
});
