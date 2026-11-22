import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './fixtures/private-invoice.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';

// Reviewer round 17 (independent): is the activeDeadlineAt closure shared
// across concurrent HTTP requests in the real runtime?
// Verdict encoded here: NO. The only production entry (api/whatsapp.js,
// also reached by api/whatsapp-process.js) never injects `runtime`, so
// webhook.mjs run() constructs a fresh createInboundRuntime per request and
// each request makes exactly one processPending call. activeDeadlineAt is
// per-instance; overlapping requests hold separate closures. The overlap
// hazard exists only when a runtime instance is injected and shared, which
// is test-only wiring. These tests pin that invariant so a future refactor
// toward a shared singleton fails loudly instead of silently reopening the
// worker-starvation finding (P2-1).
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'};

test('production wiring constructs one inbound runtime per request (no shared deadline state)',async()=>{
 const api=await readFile(new URL('../api/whatsapp.js',import.meta.url),'utf8');
 const call=api.match(/createWhatsAppWebhookHandler\(\s*\{([\s\S]*?)\}\s*\)/);
 assert.ok(call,'api/whatsapp.js must construct the webhook handler');
 assert.ok(!/\bruntime\s*[:,]/.test(call[1]),'api/whatsapp.js must not inject a shared runtime instance');
 const cron=await readFile(new URL('../api/whatsapp-process.js',import.meta.url),'utf8');
 assert.ok(!/createInboundRuntime|\.processPending\(/.test(cron),'the cron entry must delegate to the per-request webhook handler');
 const webhook=await readFile(new URL('../automation/whatsapp/webhook.mjs',import.meta.url),'utf8');
 assert.ok(/const run = \(\) => \{\s*if \(runtime\) return runtime;\s*const supabase/.test(webhook),'webhook run() must construct a fresh runtime when none is injected');
});

test('overlapping processPending invocations on separate instances keep independent deadlines and both recover',async()=>{
 const f=await fixture();let stalled=true;try{
  for(const n of [1,2])await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Hello',now(),'pending')",['wamid.deadline-iso-'+n,f.scope.phone]);
  const supabase={storage:f.supabase.storage,from:f.supabase.from.bind(f.supabase),rpc:(name,args)=>name==='whatsapp_dispatch_privacy_snapshot'&&stalled?new Promise(()=>{}):f.supabase.rpc(name,args)};
  const envWithBudget={...env,WHATSAPP_PROCESS_BUDGET_MS:'6000'};
  const logsA=[],logsB=[],sent=[];
  const mk=logs=>createInboundRuntime({supabase,env:envWithBudget,logger:{info(){},warn:(...a)=>logs.push(a),error:(...a)=>logs.push(a)},onOwnerMessage:async()=>({answer:'You can review your invoice.'}),fetchImpl:async(_,init)=>{const p=JSON.parse(init.body);if(p.status==='read')return Response.json({success:true});sent.push(p);return Response.json({messages:[{id:'wamid.iso-sent'}]});}});
  const a=mk(logsA),b=mk(logsB);
  const t0=Date.now();
  const [ra,rb]=await Promise.all([a.processPending(),b.processPending()]);
  const elapsed=Date.now()-t0;
  assert.equal(ra.completed,0);assert.equal(rb.completed,0);assert.equal(sent.length,0);
  assert.ok(elapsed<12000,'each instance expired at its own ~6s budget, concurrently: '+elapsed+'ms');
  assert.ok(logsA.some(args=>args.some(x=>x?.category==='snapshot_unavailable')),'instance A logged its own snapshot_unavailable');
  assert.ok(logsB.some(args=>args.some(x=>x?.category==='snapshot_unavailable')),'instance B logged its own snapshot_unavailable');
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_inbound_events where provider_message_id like 'wamid.deadline-iso-%' and status='pending'")).rows[0].n,2);
  stalled=false;await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 minute'");await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where provider_message_id like 'wamid.deadline-iso-%'");
  const a2=mk(logsA),b2=mk(logsB);
  await a2.processPending();await b2.processPending();await a2.processPending();await b2.processPending();
  assert.equal(sent.length,2,'both stalled replies recover and send');
 }finally{await f.close();}
});
