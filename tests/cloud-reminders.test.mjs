import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createFirstPartyReminderProvider} from '../automation/whatsapp/cloud-reminders.mjs';

const phone='+919871367051';
const template={status:'APPROVED',category:'UTILITY',useCase:'first_party_invoice_reminder',name:'fixture_first_party_invoice_reminder',language:'en',
  revision:'fixture-approved-v1',wabaId:'654321',phoneNumberId:'123456',
  body:'Hello {{2}}, invoice {{3}} has {{4}} {{5}} remaining, due {{6}}. Reply STOP anytime.\n\n{{1}}'};
const env={NODE_ENV:'test',WHATSAPP_PROVIDER:'mock',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture-service-key',
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:phone,
  WHATSAPP_ACCESS_TOKEN:'isolated-graph-token',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_WABA_ID:'654321',WHATSAPP_GRAPH_API_VERSION:'v23.0'};

async function setup({gate=true}={}) {
  const graph=[];let mode='accepted';
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');graph.push(JSON.parse(options.body));
    if(mode==='unknown')throw Error('isolated response lost');
    if(mode==='failed')return Response.json({error:'fixture rejection'},{status:400});
    if(mode==='server-error')return Response.json({error:'fixture server ambiguity'},{status:503});
    if(mode==='invalid')return Response.json({messages:[]});
    return Response.json({messages:[{id:'fixture-accepted'}]});
  }});
  const ownerId=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await f.db.query('select (public.create_workspace($1,$2)).id',['Fixture studio',randomUUID()])).rows[0].id;
  await f.db.exec('reset role');
  await f.db.query("update workspace_settings set business_name='Fixture studio',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[
    workspaceId,JSON.stringify({firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6]})]);
  const customerId=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture recipient',$2) returning id",[workspaceId,phone])).rows[0].id;
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const invoice=(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'FIXTURE',current_date-10,current_date-1,'USD',125,'sent','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customerId])).rows[0];
  const body=template.body.replace(/\{\{([1-6])\}\}/g,(_,n)=>['Fixture studio','Fixture recipient',invoice.invoice_number,'125.00','USD',new Date(invoice.due_date).toISOString().slice(0,10)][Number(n)-1]);
  await f.db.query(`update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',$2::text,
    'approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$3)),next_follow_up_at=now()-interval '1 minute' where id=$1`,[invoice.id,body,workspaceId]);
  if(gate)await f.db.exec(await readFile(new URL('./fixtures/proposed-reminder-gate.sql',import.meta.url),'utf8'));
  const scope={ownerId,workspaceId,invoiceId:invoice.id};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const provider=options=>createFirstPartyReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,templateSnapshot:template,fetchImpl:f.fetchImpl,...options});
  async function prepare(){
    const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
    const settings=await store.getWorkspacePreferences(scope);
    assert.equal((await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at})).authorized,true);
    return {workspaceId,invoiceId:invoice.id,customerId,to:phone,body,idempotencyKey:`reminder:${workspaceId}:${claim.id}`};
  }
  return {...f,scope,customerId,body,graph,store,provider,prepare,mode(value){mode=value}};
}

test('unmodified deployed schema fails closed: missing final reminder gate never sends HTTP',async()=>{
  const f=await setup({gate:false});try{
    const input=await f.prepare();assert.deepEqual(await f.provider().sendReminder(input),{status:'blocked',reason:'atomic_gate_unavailable'});
    assert.equal(f.graph.length,0);
    assert.equal((await f.db.query("select count(*)::int as n from pg_proc where proname='cetld_core_authorize_first_party_reminder'")).rows[0].n,0);
  }finally{await f.close()}
});

test('actual engine, core store, SQL and disabled candidate adapter produce one factual template and durable receipt offline',async()=>{
  const f=await setup();try{
    const runtime=createAutomationRuntime({env,store:f.store,provider:f.provider(),fetchImpl:f.fetchImpl});
    const result=await runtime.tick(f.scope);assert.equal(result.results[0].status,'sent',JSON.stringify({result,errors:f.errors}));
    assert.equal(f.graph.length,1);assert.equal(f.graph[0].to,phone.slice(1));assert.equal(f.graph[0].type,'template');
    assert.equal(f.graph[0].template.name,template.name);assert.match(f.graph[0].biz_opaque_callback_data,/^[a-f0-9]{64}$/);
    const params=f.graph[0].template.components[0].parameters.map(p=>p.text);
    assert.equal(template.body.replace(/\{\{([1-6])\}\}/g,(_,n)=>params[Number(n)-1]),f.body);
    assert.equal((await f.store.getInvoice(f.scope)).reminder_count,1);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'sent');
    await runtime.tick(f.scope);assert.equal(f.graph.length,1);
  }finally{await f.close()}
});

test('default disabled, QA, owner/customer scope, template/body/review and fresh consent guards deny before dispatch',async()=>{
  const f=await setup();try{
    const input=await f.prepare();
    for(const [options,patch,reason] of [
      [{env:{...env,WHATSAPP_REMINDERS_ENABLED:undefined}}, {},'disabled'],
      [{env:{...env,WHATSAPP_WABA_ID:undefined}}, {},'missing_configuration'],
      [{templateSnapshot:{...template,wabaId:'555555'}},{},'template_account_mismatch'],
      [{templateSnapshot:{...template,phoneNumberId:'555555'}},{},'template_account_mismatch'],
      [{templateSnapshot:{...template,revision:undefined}},{},'unreviewed_template'],
      [{}, {to:'+12025550199'},'test_allowlist'],[{}, {workspaceId:randomUUID()},'scope'],
      [{ownerId:randomUUID()}, {},'atomic_gate_denied'],[{}, {customerId:randomUUID()},'customer_changed'],
      [{}, {idempotencyKey:'invented'},'idempotency_key'],[{templateSnapshot:{...template,useCase:'third_party_collection'}},{},'unreviewed_template'],
      [{}, {body:'Unreviewed replacement'},'reviewed_body_mismatch'],
    ])assert.equal((await f.provider(options).sendReminder({...input,...patch})).reason,reason);
    await f.db.query("update whatsapp_consents set revoked_at=now(),revoked_via='stop' where workspace_id=$1",[f.scope.workspaceId]);
    assert.equal((await f.provider().sendReminder(input)).reason,'revoked');
    assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('STOP between reads and final gate is denied; paused and paid invoices cannot dispatch',async()=>{
  const f=await setup();try{
    const input=await f.prepare();
    f.intercept(async(url)=>{
      if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))
        await f.db.query("insert into whatsapp_global_suppressions(phone) values($1)",[phone]);
    });
    assert.equal((await f.provider().sendReminder(input)).reason,'atomic_gate_denied',JSON.stringify(f.errors));assert.equal(f.graph.length,0);
    f.intercept(null);await f.db.query('delete from whatsapp_global_suppressions where phone=$1',[phone]);
    await f.db.query("update invoices set followup_state='paused' where id=$1",[input.invoiceId]);
    assert.equal((await f.provider().sendReminder(input)).reason,'paused_or_unreviewed');
    await f.db.query("update invoices set status='paid',amount_paid=total_amount where id=$1",[input.invoiceId]);
    assert.equal((await f.provider().sendReminder(input)).reason,'invoice_not_remindable');
    assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

for(const [label,mutation] of [
  ['invoice version',"update invoices set notes='changed during authorization' where id=$1"],
  // Isolated lifecycle context simulates a concurrent authorized soft-delete.
  ['deletion',`with lifecycle_context as (insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
    values(pg_backend_pid(),txid_current(),$1) returning invoice_id)
    update invoices set deleted_at=now(),deleted_by=(select owner_id from workspaces where id=invoices.workspace_id)
    where id in (select invoice_id from lifecycle_context)`],
  ['customer phone',"update customers set phone='+919818685252' where id=(select customer_id from invoices where id=$1)"],
  ['preferences',"update workspace_settings set business_name='Changed studio' where workspace_id=(select workspace_id from invoices where id=$1)"],
])test(`final proposed offline gate rejects concurrent ${label} change`,async()=>{
  const f=await setup();try{
    const input=await f.prepare();f.intercept(async url=>{
      if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await f.db.query(mutation,[input.invoiceId]);
    });
    assert.equal((await f.provider().sendReminder(input)).reason,'atomic_gate_denied',JSON.stringify(f.errors));assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('concurrent adapter calls reserve one dispatch; server template snapshot is immutable',async()=>{
  const f=await setup();try{
    const input=await f.prepare(),snapshot=structuredClone(template),provider=f.provider({templateSnapshot:snapshot});
    snapshot.name='mutated_template';snapshot.body='Unreviewed mutation';
    const results=await Promise.all([provider.sendReminder(input),provider.sendReminder(input)]);
    assert.equal(results.filter(r=>r.status==='accepted').length,1);assert.equal(f.graph.length,1);
    assert.equal(f.graph[0].template.name,template.name);
  }finally{await f.close()}
});

test('actual adapter lost HTTP response quarantines actual core claim and never retries',async()=>{
  const f=await setup();try{
    f.mode('unknown');const runtime=createAutomationRuntime({env,store:f.store,provider:f.provider(),fetchImpl:f.fetchImpl});
    assert.equal((await runtime.tick(f.scope)).results[0].status,'quarantined');
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
    assert.equal((await f.store.getInvoice(f.scope)).reminder_count,0);
    await runtime.tick(f.scope);assert.equal(f.graph.length,1);
  }finally{await f.close()}
});

for(const [mode,status] of [['accepted','accepted'],['failed','failed'],['server-error','unknown'],['unknown','unknown'],['invalid','unknown']])
  test(`HTTP ${mode} is reported truthfully and durable dispatch reservation blocks repeated calls`,async()=>{
    const f=await setup();try{
      const input=await f.prepare();f.mode(mode);const provider=f.provider();
      assert.equal((await provider.sendReminder(input)).status,status);
      assert.equal((await provider.sendReminder(input)).reason,'atomic_gate_denied');assert.equal(f.graph.length,1);
      const receipt=(await f.db.query('select * from fixture_reminder_dispatches')).rows[0];
      assert.equal(JSON.stringify(receipt).includes(env.WHATSAPP_ACCESS_TOKEN),false);
    }finally{await f.close()}
  });
