import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createWhatsAppProcessHandler} from '../api/whatsapp-process.js';
import {createReminderCronHandler} from '../automation/reminder-cron.mjs';
import {createScheduledOwnerTestGate,scheduledOwnerTestMode,SCHEDULED_OWNER_TEST as fixed} from '../automation/scheduled-owner-test.mjs';
import {REMINDER_TEMPLATES} from '../automation/whatsapp/reminder-templates.mjs';
import {runWorkerOnce} from '../automation/worker.mjs';
import {handleAutomationRequest} from '../automation/routes.mjs';

const invoiceId='a1000000-0000-4000-8000-000000000001';
const base={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',
  WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',
  WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:fixed.phone,WHATSAPP_ACCESS_TOKEN:'fixture-graph-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',
  WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',CRON_SECRET:'fixture-cron',
  AUTOMATION_APP_URL:'https://fixture.app.test',AUTOMATION_WORKER_SECRET:'fixture-worker-'.repeat(3),
  WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED:'true',WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID:invoiceId,
  AUTOMATION_WORKSPACES:JSON.stringify([{ownerId:fixed.ownerId,workspaceId:fixed.workspaceId}])};
const response=()=>({code:null,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return this;}});

test('scheduled test is absent by default; partial, false, protected and broadened configurations fail closed',async()=>{
  assert.deepEqual(scheduledOwnerTestMode({}),{mode:'off'});
  assert.equal(scheduledOwnerTestMode(base).mode,'test');
  const invalid=[{WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED:undefined},{WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID:undefined},
    {WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED:'false'},{WHATSAPP_SCHEDULED_OWNER_TEST_ENABLED:''},
    {WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID:'invalid'},
    {WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID:'f86e28bd-16a8-4c83-a03d-05302f7f3ff6'},
    {WHATSAPP_PROVIDER:'mock'},{AUTOMATION_WORKSPACES:'invalid'},{AUTOMATION_WORKSPACES:'[]'},
    {AUTOMATION_WORKSPACES:JSON.stringify([{ownerId:randomUUID(),workspaceId:fixed.workspaceId}])},
    {AUTOMATION_WORKSPACES:JSON.stringify([{ownerId:fixed.ownerId,workspaceId:randomUUID()}])},
    {AUTOMATION_WORKSPACES:JSON.stringify([{ownerId:fixed.ownerId,workspaceId:fixed.workspaceId,invoiceId}])},
    {AUTOMATION_WORKSPACES:JSON.stringify([{ownerId:fixed.ownerId,workspaceId:fixed.workspaceId},{ownerId:randomUUID(),workspaceId:randomUUID()}])}];
  for(const patch of invalid){
    const env={...base,...patch};assert.equal(scheduledOwnerTestMode(env).mode,'blocked',JSON.stringify(patch));
    assert.deepEqual(await runWorkerOnce({env,fetchImpl:()=>assert.fail('invalid test must not contact API')}),[]);
    const runtime=createAutomationRuntime({env,store:{getWorkspacePreferences:()=>assert.fail('must not read'),getInvoice:()=>assert.fail('must not read')}});
    assert.equal((await runtime.tick(fixed)).processed,0);
    const res=response();await createReminderCronHandler({env,runtimeFactory:()=>assert.fail('must not construct runtime')})({method:'GET',headers:{authorization:'Bearer fixture-cron'}},res);
    assert.equal(res.code,200);assert.equal(res.payload.disabled,true);
  }
});

async function setup({transport='accepted',footer='Reply STOP to opt out'}={}){
  const graph=[];
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');
    if(options.method==='GET'){
      if(url.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:base.WHATSAPP_PHONE_NUMBER_ID,display_phone_number:'+917303338959'}]});
      const name=url.searchParams.get('name'),entry=REMINDER_TEMPLATES.find(t=>t.name===name);
      return Response.json({data:[{id:'123456789012345',name,language:'en',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',components:[{type:'BODY',text:entry.body},{type:'FOOTER',text:footer}]}]});
    }
    assert.equal(options.method,'POST');graph.push(JSON.parse(options.body));
    if(transport==='unknown')throw Error('fixture lost response');
    if(transport==='failed')return Response.json({error:'fixture rejection'},{status:400});
    return Response.json({messages:[{id:'wamid.fixture.scheduled'}]});
  }});
  try{
    await f.db.exec(await readFile(new URL('../supabase/migrations/20261005070000_approved_whatsapp_reminders.sql',import.meta.url),'utf8'));
    const foreignOwner=randomUUID(),foreignWs=randomUUID();
    for(const [ownerId,workspaceId] of [[fixed.ownerId,fixed.workspaceId],[foreignOwner,foreignWs]]){
      await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
      await f.db.query("insert into workspaces(id,owner_id,name,slug) values($1,$2,'Fixture studio',$3)",[workspaceId,ownerId,randomUUID()]);
      await f.db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'owner')",[workspaceId,ownerId]);
      await f.db.query("insert into workspace_settings(workspace_id,business_name,default_timezone,follow_up_preferences) values($1,'Fixture studio','UTC',$2)",[workspaceId,JSON.stringify({tone:'professional',firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],dailySummary:true})]);
    }
    const customerId=(await f.db.query("insert into customers(workspace_id,name,phone,metadata) values($1,'Fixture owner',$2,'{\"whatsapp_owner\":true}') returning id",[fixed.workspaceId,fixed.phone])).rows[0].id;
    await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories,consented_by) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'],$4)",[fixed.workspaceId,customerId,fixed.phone,fixed.ownerId]);
    await f.db.query("insert into whatsapp_owner_verifications(workspace_id,phone,requested_by,code_hash,expires_at,verified_at) values($1,$2,$3,'fixture-no-secret',now(),now())",[fixed.workspaceId,fixed.phone,fixed.ownerId]);
    await f.db.query('update workspace_settings set whatsapp_owner_phone=$2 where workspace_id=$1',[fixed.workspaceId,fixed.phone]);
    async function invoice(id,workspaceId,customer){
      await f.db.query("insert into invoices(id,workspace_id,customer_id,invoice_number,notes,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,$4,$5,current_date-2,current_date-1,'USD',1,'sent','{\"invoice_direction\":\"receivable\"}')",[id,workspaceId,customer,fixed.sourceNumber,fixed.note]);
      await f.db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Legacy reviewed draft\n\nFixture studio','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)),next_follow_up_at=now()-interval '1 minute' where id=$1",[id,workspaceId]);
    }
    await invoice(invoiceId,fixed.workspaceId,customerId);
    const otherId=randomUUID(),foreignId=randomUUID();
    const foreignCustomer=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Foreign fixture','+919818685252') returning id",[foreignWs])).rows[0].id;
    await invoice(otherId,fixed.workspaceId,customerId);await invoice(foreignId,foreignWs,foreignCustomer);
    const scope={ownerId:fixed.ownerId,workspaceId:fixed.workspaceId,invoiceId};
    const store=new CoreAutomationStore({url:base.SUPABASE_URL,key:base.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
    store.listDueInvoices=()=>assert.fail('test must never scan due invoices');
    store.dailySummary=()=>assert.fail('test must never scan daily events');
    function runtime(env=base){return createAutomationRuntime({env,store,supabase:f.supabase,fetchImpl:f.fetchImpl});}
    async function cron(){const res=response();await createWhatsAppProcessHandler({processHandler:()=>assert.fail('wrong scheduler'),reminderHandler:createReminderCronHandler({env:base,runtimeFactory:()=>runtime()})})({method:'GET',headers:{'x-vercel-cron-schedule':'0 4 * * *',authorization:'Bearer fixture-cron'}},res);return res;}
    const others=()=>f.db.query('select to_jsonb(i) as row from invoices i where id<>$1 order by id',[invoiceId]).then(r=>r.rows);
    return {...f,graph,scope,store,runtime,cron,others,customerId,foreignOwner,foreignWs,otherId,foreignId,invoice};
  }catch(error){await f.close();throw error;}
}

function assertNarrowQueries(f){
  for(const r of f.requests){
    const u=new URL(r.url);
    if(u.pathname.endsWith('/invoices')){
      assert.equal(u.searchParams.get('id'),`eq.${invoiceId}`,'invoice query must have exact fixture ID');
      assert.equal(u.searchParams.get('workspace_id'),`eq.${fixed.workspaceId}`);
    }
    if(u.pathname.endsWith('/rpc/cetld_core_claim_due_followups')){
      assert.equal(r.body.p_invoice_id,invoiceId);assert.equal(r.body.p_workspace_id,fixed.workspaceId);assert.equal(r.body.p_limit,1);
    }
    assert.ok(!u.pathname.endsWith('/rpc/cetld_core_quarantine_first_party_leases'),'no workspace lease sweep');
    if(u.pathname.endsWith('/cetld_core_automation_events')&&r.method==='GET')assert.equal(u.searchParams.get('idempotency_key'),`eq.${fixed.attemptKey}`,'no daily event scan');
  }
}

test('real 04:00 scheduler route and SQL engine target only the fresh invoice; recreating runtime cannot repeat attempt',async()=>{
  const f=await setup();try{
    const before=await f.others();
    const res=await f.cron();assert.equal(res.code,200);assert.equal(res.payload.results[0]?.results[0]?.status,'sent',JSON.stringify({res,errors:f.errors}));
    assert.equal(f.graph.length,1);assert.equal(f.graph[0].to,fixed.phone.slice(1));assert.equal(f.graph[0].template.name,'cetld_invoice_update_v2');
    assert.equal((await f.db.query('select count(*)::int n from cetld_core_automation_events where idempotency_key=$1',[fixed.attemptKey])).rows[0].n,1);
    assert.equal((await f.runtime().tick(fixed)).alreadyAttempted,true);assert.equal(f.graph.length,1);
    assert.deepEqual(await f.others(),before);assertNarrowQueries(f);
    assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.deepEqual((await f.db.query('select total_amount::float8 total,amount_paid::float8 paid from invoices where id=$1',[invoiceId])).rows[0],{total:1,paid:0});
    const changedEnv={...base,WHATSAPP_SCHEDULED_OWNER_TEST_INVOICE_ID:f.otherId};
    assert.equal((await f.runtime(changedEnv).tick(fixed)).alreadyAttempted,true,'changing fixture cannot reset durable identity');
  }finally{await f.close();}
});

test('foreign workspace, owner, or invoice scope stops before any database or provider request',async()=>{
  const store={getInvoice:()=>assert.fail('must not read'),getWorkspacePreferences:()=>assert.fail('must not read')};
  const runtime=createAutomationRuntime({env:base,store,fetchImpl:()=>assert.fail('must not fetch')});
  for(const scope of [{...fixed,workspaceId:randomUUID()},{...fixed,ownerId:randomUUID()},{...fixed,invoiceId:randomUUID()}]){
    assert.equal((await runtime.tick(scope)).processed,0);
  }
});

for(const condition of ['future','paused','paid','dispute','revoked','suppressed','external-ledger','wrong-label','wrong-phone','unapproved-template','wrong-footer','contact-hours'])
  test(`scheduled isolation preserves normal ${condition} stop`,async()=>{
    const f=await setup({footer:condition==='wrong-footer'?'Wrong fixture footer':'Reply STOP to opt out'});try{
      if(condition==='future')await f.db.query("update invoices set next_follow_up_at=now()+interval '1 day' where id=$1",[invoiceId]);
      if(condition==='paused')await f.db.query("update invoices set metadata=metadata||'{\"followup_state\":\"paused\"}' where id=$1",[invoiceId]);
      if(condition==='paid')await f.db.query("update invoices set amount_paid=1,status='paid' where id=$1",[invoiceId]);
      if(condition==='dispute')await f.db.query("update invoices set metadata=metadata||'{\"followup_exception\":{\"type\":\"dispute\"}}' where id=$1",[invoiceId]);
      if(condition==='revoked')await f.db.query("update whatsapp_consents set revoked_at=now(),revoked_via='manual' where workspace_id=$1",[fixed.workspaceId]);
      if(condition==='suppressed')await f.db.query('insert into whatsapp_global_suppressions(phone) values($1)',[fixed.phone]);
      if(condition==='external-ledger')await f.db.query("update invoices set metadata=metadata||'{\"bookkeeping_record_id\":\"external-fixture\",\"bookkeeping_provider\":\"zoho\"}' where id=$1",[invoiceId]);
      if(condition==='wrong-label')await f.db.query("update invoices set notes='not the reviewed fixture' where id=$1",[invoiceId]);
      if(condition==='wrong-phone')await f.db.query("update customers set phone='+919818685252' where id=$1",[f.customerId]);
      if(condition==='unapproved-template')await f.db.query("update app.first_party_reminder_templates set approved=false where name='cetld_invoice_update_v2'");
      if(condition==='contact-hours'){
        const hour=new Date().getUTCHours(),start=(hour+2)%24;
        await f.db.query("update workspace_settings set follow_up_preferences=follow_up_preferences||$2::jsonb where workspace_id=$1",[fixed.workspaceId,JSON.stringify({contactStart:`${String(start).padStart(2,'0')}:00`,contactEnd:`${String(start).padStart(2,'0')}:30`})]);
      }
      const before=await f.others();await f.cron();assert.equal(f.graph.length,0,condition);assert.deepEqual(await f.others(),before);assertNarrowQueries(f);
    }finally{await f.close();}
  });

for(const transport of ['unknown','failed'])test(`durable identity survives ${transport} provider response and recreated scheduler`,async()=>{
  const f=await setup({transport});try{
    await f.cron();assert.equal(f.graph.length,1);assert.equal((await f.runtime().tick(fixed)).alreadyAttempted,true);assert.equal(f.graph.length,1);
  }finally{await f.close();}
});

test('atomic one-use reservation survives concurrent contenders, lost acknowledgement, and later final SQL rejection',async()=>{
  const f=await setup();try{
    const testMode=scheduledOwnerTestMode(base),gate=()=>createScheduledOwnerTestGate({test:testMode,env:base,supabase:f.supabase,store:f.store,fetchImpl:f.fetchImpl});
    const wins=await Promise.all([gate().claimAttempt(),gate().claimAttempt(),gate().claimAttempt()]);
    assert.equal(wins.filter(Boolean).length,1);assert.equal(await gate().consumed(),true);assert.equal((await f.runtime().tick(fixed)).alreadyAttempted,true);assert.equal(f.graph.length,0);
  }finally{await f.close();}
  const lost=await setup();try{
    let failed=false;
    const fetchImpl=async(input,options)=>{const res=await lost.fetchImpl(input,options);if(options?.method==='POST'&&new URL(String(input)).pathname.endsWith('/cetld_core_automation_events')&&!failed){failed=true;throw Error('fixture acknowledgement lost after commit');}return res;};
    const {createClient}=await import('@supabase/supabase-js');
    const client=createClient(base.SUPABASE_URL,'fixture-key',{auth:{persistSession:false},global:{fetch:fetchImpl}});
    const gate=createScheduledOwnerTestGate({test:scheduledOwnerTestMode(base),env:base,supabase:client,store:lost.store,fetchImpl});
    await assert.rejects(gate.claimAttempt());assert.equal(await gate.consumed(),true);assert.equal((await lost.runtime().tick(fixed)).alreadyAttempted,true);assert.equal(lost.graph.length,0);
  }finally{await lost.close();}
  const rejected=await setup();try{
    rejected.intercept(async url=>{if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await rejected.db.query('insert into whatsapp_global_suppressions(phone) values($1) on conflict do nothing',[fixed.phone]);});
    await rejected.cron();assert.equal(rejected.graph.length,0);assert.equal((await rejected.runtime().tick(fixed)).alreadyAttempted,true);
  }finally{await rejected.close();}
});

test('worker uses a distinct authenticated test action; API rejects it without test mode and ignores caller invoice/recipient',async()=>{
  let request;
  await runWorkerOnce({env:base,fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return Response.json({});}});
  assert.deepEqual(request,{action:'scheduled-owner-test-tick',workspaceId:fixed.workspaceId,ownerId:fixed.ownerId});
  const req={method:'POST',headers:{authorization:`Bearer ${base.AUTOMATION_WORKER_SECRET}`},body:{...request,invoiceId:randomUUID(),to:'+919818685252'}};
  let res=response();await handleAutomationRequest(req,res,{env:{AUTOMATION_WORKER_SECRET:base.AUTOMATION_WORKER_SECRET},runtime:{tick:()=>assert.fail('must not tick')}});assert.equal(res.code,409);
  res=response();await handleAutomationRequest(req,res,{env:base,runtime:{tick:async scope=>{assert.deepEqual(scope,{workspaceId:fixed.workspaceId,ownerId:fixed.ownerId});return {processed:0};}}});assert.equal(res.code,200);
});

// PGlite serializes SQL statements; these overlapping JS flows prove the real
// claim/reservation path, not cross-connection PostgreSQL lock contention.
test('overlapping scheduler flows dispatch at most once and preserve every other invoice',async()=>{
  const f=await setup();try{
    const before=await f.others();await Promise.all([f.cron(),f.cron(),f.cron()]);
    assert.equal(f.graph.length,1);assert.deepEqual(await f.others(),before);assertNarrowQueries(f);
    assert.equal((await f.runtime().tick(fixed)).alreadyAttempted,true);
  }finally{await f.close();}
});
