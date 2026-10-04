import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {FollowUpEngine} from '../automation/engine.mjs';
import {createFirstPartyReminderProvider} from '../automation/whatsapp/cloud-reminders.mjs';
import {createDurableReminderProvider,createFirstPartyReminderReceiptStore} from '../automation/whatsapp/reminder-receipts.mjs';
import {createLocalReminderPaymentChecker} from '../automation/local-reminder-payment.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';

const phone='+919871367051';
const template={status:'APPROVED',category:'UTILITY',useCase:'first_party_invoice_reminder',name:'fixture_first_party_invoice_reminder',language:'en',
  revision:'fixture-approved-v1',wabaId:'654321',phoneNumberId:'123456',
  body:'Hello {{2}}, invoice {{3}} has {{4}} {{5}} remaining, due {{6}}. Reply STOP anytime.\n\n{{1}}'};
const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture-service-key',
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'isolated-graph-token',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_WABA_ID:'654321',
  WHATSAPP_GRAPH_API_VERSION:'v23.0',WHATSAPP_APP_SECRET:'isolated-signature-secret'};
const logger={log(){},warn(){},error(){}};

async function setup(){
  const graph=[];let mode='accepted',sendHook=null;
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');const payload=JSON.parse(options.body);graph.push(payload);
    if(sendHook)await sendHook(payload);
    if(mode==='unknown')throw Error('isolated dispatch interrupted');
    return Response.json({messages:[{id:'fixture-accepted'}]});
  }});
  await f.db.exec(await readFile(new URL('../proposals/20261004_disabled_first_party_reminder_durability.sql',import.meta.url),'utf8'));
  const ownerId=randomUUID(),foreignOwner=randomUUID();
  await f.db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  async function workspace(actor,label){
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
    const id=(await f.db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id;
    await f.db.exec('reset role');return id;
  }
  const workspaceId=await workspace(ownerId,'Fixture studio'),foreignWs=await workspace(foreignOwner,'Other tenant');
  await f.db.query("update workspace_settings set business_name='Fixture studio',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[
    workspaceId,JSON.stringify({firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6]})]);
  const customerId=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture recipient',$2) returning id",[workspaceId,phone])).rows[0].id;
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const invoice=(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'FIXTURE',current_date-10,current_date-1,'USD',125,'sent','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customerId])).rows[0];
  const body=template.body.replace(/\{\{([1-6])\}\}/g,(_,n)=>['Fixture studio','Fixture recipient',invoice.invoice_number,'125.00','USD',new Date(invoice.due_date).toISOString().slice(0,10)][Number(n)-1]);
  await f.db.query(`update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',$2::text,
    'approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$3)),next_follow_up_at=now()-interval '1 minute' where id=$1`,[invoice.id,body,workspaceId]);
  await f.db.query(`insert into app.first_party_reminder_templates(workspace_id,owner_id,waba_id,phone_number_id,name,language,revision,body,approved,approval_reference,approved_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,true,'OFFLINE FIXTURE ONLY',now())`,[workspaceId,ownerId,template.wabaId,template.phoneNumberId,template.name,template.language,template.revision,template.body]);
  const scope={ownerId,workspaceId,invoiceId:invoice.id};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const rawProvider=createFirstPartyReminderProvider({env,supabase:f.supabase,store,ownerId,workspaceId,templateSnapshot:template,fetchImpl:f.fetchImpl});
  const receiptStore=createFirstPartyReminderReceiptStore({supabase:f.supabase,env});
  const provider=createDurableReminderProvider({provider:rawProvider,receiptStore});
  const paymentChecker=createLocalReminderPaymentChecker({supabase:f.supabase,ownerId,workspaceId});
  const engine=new FollowUpEngine({store,provider,paymentChecker});
  const inbound=createInboundRuntime({env,supabase:f.supabase,fetchImpl:f.fetchImpl,reminderReceiptStore:receiptStore,logger});
  const webhook=createWhatsAppWebhookHandler({env,runtime:inbound,logger});
  async function callback({status='delivered',token=graph[0]?.biz_opaque_callback_data,messageId='fixture-accepted',recipient=phone,waba=env.WHATSAPP_WABA_ID,phoneId=env.WHATSAPP_PHONE_NUMBER_ID,validSignature=true}={}){
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneId},statuses:[{id:messageId,status,recipient_id:recipient.slice(1),biz_opaque_callback_data:token}]}}]}]}));
    const res={code:null,body:null,status(c){this.code=c;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},setHeader(){}};
    await webhook({method:'POST',rawBody,headers:{'x-hub-signature-256':`sha256=${createHmac('sha256',validSignature?env.WHATSAPP_APP_SECRET:'wrong').update(rawBody).digest('hex')}`}},res);
    return res;
  }
  async function prepare(){
    const [claim]=await store.claimDueFollowups({...scope,now:new Date().toISOString(),limit:1});
    const settings=await store.getWorkspacePreferences(scope);
    assert.equal((await store.authorizeDelivery({...scope,claimId:claim.id,preferencesVersion:settings.updated_at})).authorized,true);
    return {workspaceId,invoiceId:invoice.id,customerId,to:phone,body,idempotencyKey:`reminder:${workspaceId}:${claim.id}`};
  }
  return {...f,scope,foreignOwner,foreignWs,customerId,store,provider,rawProvider,paymentChecker,engine,graph,callback,prepare,webhook,
    mode(value){mode=value},onSend(callback){sendHook=callback}};
}

test('actual additive proposal SQL + real engine/local payment checker/adapter saves one accepted receipt/count and signed statuses stay monotonic',async()=>{
  const f=await setup();try{
    await f.db.exec('set role service_role');
    const result=await f.engine.run(f.scope);await f.db.exec('reset role');assert.equal(result.status,'sent',JSON.stringify({result,errors:f.errors}));
    assert.equal(f.graph.length,1);assert.equal((await f.store.getInvoice(f.scope)).reminder_count,1);
    assert.equal((await f.callback()).code,200);assert.equal((await f.callback({status:'read'})).code,200);
    await f.callback({status:'sent'});await f.callback({status:'failed'});
    const d=(await f.db.query('select * from app.first_party_reminder_dispatches')).rows[0];assert.equal(d.state,'read');assert.equal(d.counted,true);
    assert.equal((await f.store.getInvoice(f.scope)).reminder_count,1);await f.engine.run(f.scope);assert.equal(f.graph.length,1);
  }finally{await f.close()}
});

test('signed failure after HTTP acceptance pauses exact reviewed state without recount/resend; delivery supersedes audit state only',async()=>{
  const f=await setup();try{
    assert.equal((await f.engine.run(f.scope)).status,'sent');
    await f.callback({status:'failed'});await f.callback({status:'failed'});await f.callback({status:'sent'});
    let d=(await f.db.query('select * from app.first_party_reminder_dispatches')).rows[0];
    assert.equal(d.state,'failed');assert.equal(d.counted,true);
    let invoice=await f.store.getInvoice(f.scope);
    assert.equal(invoice.reminder_count,1);assert.equal(invoice.followup_state,'paused');assert.equal(invoice.next_follow_up_at,null);
    assert.equal(invoice.metadata.approved_reminder_text,undefined);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'failed');
    await f.engine.run(f.scope);assert.equal(f.graph.length,1);
    await f.callback({status:'delivered'});await f.callback({status:'read'});
    d=(await f.db.query('select * from app.first_party_reminder_dispatches')).rows[0];assert.equal(d.state,'read');
    invoice=await f.store.getInvoice(f.scope);assert.equal(invoice.reminder_count,1);assert.equal(invoice.followup_state,'paused');
    assert.equal((await f.db.query("select count(*)::int n from app.first_party_reminder_receipt_events where status='failed'")).rows[0].n,1);
  }finally{await f.close()}
});

test('signed failure before HTTP finalize cannot resurrect acceptance, count, schedule or report sent',async()=>{
  const f=await setup();try{
    f.onSend(async()=>{assert.equal((await f.callback({status:'failed'})).code,200)});
    const result=await f.engine.run(f.scope);assert.equal(result.status,'failed');assert.equal(result.reason,'signed_provider_failure');
    let invoice=await f.store.getInvoice(f.scope);assert.equal(invoice.reminder_count,0);assert.equal(invoice.followup_state,'paused');assert.equal(invoice.next_follow_up_at,null);
    assert.equal((await f.db.query('select state from app.first_party_reminder_dispatches')).rows[0].state,'failed');
    await f.engine.run(f.scope);assert.equal(f.graph.length,1);
    await f.callback({status:'delivered'});await f.callback({status:'delivered'});
    invoice=await f.store.getInvoice(f.scope);assert.equal(invoice.reminder_count,1);assert.equal(invoice.followup_state,'paused');assert.equal(invoice.next_follow_up_at,null);
    assert.equal((await f.db.query('select state from app.first_party_reminder_dispatches')).rows[0].state,'delivered');
  }finally{await f.close()}
});

test('signed failure preserves newer paid, STOP, and owner-edited invoice facts',async()=>{
  for(const change of ['paid','stop','owner']){
    const f=await setup();try{
      assert.equal((await f.engine.run(f.scope)).status,'sent');
      if(change==='paid'){
        await f.db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[f.scope.ownerId]);
        await f.db.query("select public.record_invoice_payment($1,$2,125,'fixture-payment','offline',false)",[f.scope.workspaceId,f.scope.invoiceId]);
      }
      if(change==='stop')await f.supabase.rpc('whatsapp_revoke_phone',{p_workspace_id:f.scope.workspaceId,p_phone:phone,p_via:'stop',p_message_id:'fixture-stop'});
      if(change==='owner')await f.db.query("update invoices set metadata=metadata||'{\"notes\":\"new owner note\"}',followup_state='draft',next_follow_up_at=null where id=$1",[f.scope.invoiceId]);
      const before=(await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.scope.invoiceId])).rows[0].value;
      await f.callback({status:'failed'});
      const after=(await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.scope.invoiceId])).rows[0].value;
      assert.deepEqual(after,before,change);assert.equal(after.reminder_count,1);assert.equal(f.graph.length,1);
    }finally{await f.close()}
  }
});

test('installed SQL source orders phone/settings before invoice and mixed batch children (single-connection evidence only)',async()=>{
  const f=await setup();try{
    for(const name of ['cetld_core_authorize_first_party_reminder','cetld_core_record_first_party_receipt']){
      const def=(await f.db.query("select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",[name])).rows[0].def;
      assert(def.indexOf('pg_advisory_xact_lock')<def.indexOf('from public.workspace_settings'));
      assert(def.indexOf('from public.workspace_settings')<def.indexOf('from public.invoices'));
      assert.equal((def.match(/workspace_settings[^;]*for share/g)||[]).length,1);
    }
    const def=(await f.db.query("select pg_get_functiondef('public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb)'::regprocedure) def")).rows[0].def;
    assert(def.indexOf('hashtextextended(p_phone,0)')<def.indexOf('from public.workspace_settings'));
    assert(def.indexOf('from public.workspace_settings')<def.indexOf('for v_item in'));
    const contacts=(await f.db.query("select pg_get_functiondef(t.tgfoid) def from pg_trigger t where t.tgrelid='public.customers'::regclass and not t.tgisinternal")).rows;
    assert(contacts.length>0);for(const {def} of contacts)assert(!/update\s+(public\.)?invoices/i.test(def));
    const settings=(await f.db.query("select pg_get_functiondef('app.invalidate_core_followup_approvals()'::regprocedure) def")).rows[0].def;
    assert.match(settings,/update public\.invoices/);
    const direct=(await f.db.query("select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='whatsapp_apply_direct_owner_write'")).rows[0].def;
    assert(direct.indexOf('hashtextextended(p_phone,0)')<direct.indexOf("elsif p_operation='settings.update'"));
    const customer=direct.slice(direct.indexOf("elsif p_operation='customer.update'"),direct.indexOf("elsif p_operation='customer.delete'"));
    assert(customer.length>0);assert(!/update\s+public\.invoices/i.test(customer));
  }finally{await f.close()}
});

test('old recovered receipt cannot claim a newer already-counted invoice version for its later failure',async()=>{
  const f=await setup();try{
    const input=await f.prepare();const accepted=await f.provider.sendReminder(input);assert.equal(accepted.status,'accepted');
    // A later reviewed state has already counted an attempt. The old receipt
    // must not label that unchanged row as its own reconciliation write.
    await f.db.query("update invoices set reminder_count=1,metadata=metadata||'{\"notes\":\"new review\"}' where id=$1",[f.scope.invoiceId]);
    assert.equal((await f.provider.finalizeReminder({idempotencyKey:input.idempotencyKey,providerMessageId:accepted.providerMessageId})).ok,true);
    const d=(await f.db.query('select * from app.first_party_reminder_dispatches')).rows[0];assert.equal(d.counted,true);assert.equal(d.reconciled_invoice_version,null);
    const before=(await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.scope.invoiceId])).rows[0].value;
    await f.callback({status:'failed'});
    assert.deepEqual((await f.db.query('select to_jsonb(i) value from invoices i where id=$1',[f.scope.invoiceId])).rows[0].value,before);
    assert.equal(f.graph.length,1);
  }finally{await f.close()}
});

test('forward batch lock migration patches installed coordinator only, preserves ACL/private engine, and fails closed on repeated markers',async()=>{
  const f=await setup();try{
    const signature='public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb)';
    const snapshot=async()=>(await f.db.query("select pg_get_functiondef($1::regprocedure) def,(select proacl::text from pg_proc where oid=$1::regprocedure) acl,(select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname='whatsapp_apply_owner_batch_operation') engine",[signature])).rows[0];
    const installed=await snapshot();
    const before=installed.def.replace('  -- Owner phone before settings, matching child operations and STOP.\n  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));\n','')
      .replace('  -- Settings before any invoice/customer child, including mixed settings batches.\n  perform 1 from public.workspace_settings where workspace_id=p_workspace_id for update;\n','');
    assert.notEqual(before,installed.def);await f.db.exec(before);
    const previous=await snapshot();assert.equal(previous.acl,installed.acl);assert.equal(previous.engine,installed.engine);
    const sql=await readFile(new URL('../supabase/migrations/20261004216000_owner_batch_settings_lock.sql',import.meta.url),'utf8');
    await f.db.exec(sql);assert.deepEqual(await snapshot(),installed);
    await assert.rejects(f.db.exec(sql),/unexpected installed owner batch lock markers/);await f.db.exec('rollback');
    assert.deepEqual(await snapshot(),installed);
    await f.db.exec('set role authenticated');
    await assert.rejects(f.db.query('select public.whatsapp_apply_owner_batch(null,null,null,null,null,null)'),e=>e.code==='42501');
    await f.db.exec('reset role');
  }finally{await f.close()}
});

test('grants deny anon/authenticated registry/receipt/payment access, and service RPCs enforce actual tenant',async()=>{
  const f=await setup();try{
    for(const role of ['anon','authenticated']){
      await f.db.exec(`set role ${role}`);
      await assert.rejects(f.db.query('select * from app.first_party_reminder_templates'),e=>e.code==='42501');
      await assert.rejects(f.db.query('select public.cetld_core_check_local_reminder_payment($1,$2,$3)',Object.values(f.scope)),e=>e.code==='42501');
      await f.db.exec('reset role');
    }
    await f.db.exec('set role service_role');
    await assert.rejects(f.db.query("insert into app.first_party_reminder_templates(workspace_id,owner_id,waba_id,phone_number_id,name,language,revision,body) values($1,$2,'654321','123456','forged','en','v1','fake')",[f.scope.workspaceId,f.scope.ownerId]),e=>e.code==='42501');
    await f.db.exec('reset role');
    assert.equal((await f.supabase.rpc('cetld_core_check_local_reminder_payment',{p_owner_id:f.foreignOwner,p_workspace_id:f.scope.workspaceId,p_invoice_id:f.scope.invoiceId})).data.ok,false);
    const input=await f.prepare();const fake=createFirstPartyReminderProvider({env,supabase:f.supabase,store:f.store,ownerId:f.foreignOwner,workspaceId:f.scope.workspaceId,templateSnapshot:template,fetchImpl:f.fetchImpl});
    const disabled=createDurableReminderProvider({provider:f.rawProvider,receiptStore:createFirstPartyReminderReceiptStore({supabase:f.supabase,env:{...env,WHATSAPP_REMINDER_RECEIPTS_ENABLED:undefined}})});
    assert.equal((await disabled.sendReminder(input)).reason,'receipt_backend_disabled');
    assert.equal((await fake.sendReminder(input)).status,'blocked');assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('actual gate verifies canonical fingerprint, template registry/account/revision and current factual snapshot; replay cannot dispatch',async()=>{
  const f=await setup();try{
    const input=await f.prepare();let original;
    f.intercept(async(url,options)=>{
      if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder')){original=JSON.parse(options.body);throw Error('capture before reservation');}
    });
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');f.intercept(null);
    const snapshot=original.p_snapshot;
    assert.equal((await f.db.query('select app.reminder_canonical_json($1::jsonb) as v',[JSON.stringify(snapshot)])).rows[0].v.includes('OFFLINE'),false);
    assert.equal((await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{...original,p_snapshot_hash:'0'.repeat(64)})).data.authorized,false);
    const edited=structuredClone(snapshot);edited.template.parameters[3]='999.00';
    assert.equal((await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{...original,p_snapshot:edited,p_snapshot_hash:reminderFingerprint(edited)})).data.authorized,false);
    for(const field of ['revision','wabaId','phoneNumberId']){
      const altered=structuredClone(snapshot);altered.template[field]='wrong';
      assert.equal((await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{...original,p_snapshot:altered,p_snapshot_hash:reminderFingerprint(altered)})).data.authorized,false);
    }
    const concurrent=await Promise.all([f.rawProvider.sendReminder(input),f.rawProvider.sendReminder(input)]);
    assert.equal(concurrent.filter(result=>result.status==='accepted').length,1,JSON.stringify(f.errors));
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');assert.equal(f.graph.length,1);
    await f.db.exec('update app.first_party_reminder_templates set approved=false');
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');
  }finally{await f.close()}
});

test('actual STOP transaction pauses own matching future schedules/claims, preserves ledger and rejects callback scope/signature forgery',async()=>{
  const f=await setup();try{
    const input=await f.prepare();assert.equal((await f.rawProvider.sendReminder(input)).status,'accepted');
    const before=(await f.store.getInvoice(f.scope));
    const stop=await f.supabase.rpc('whatsapp_revoke_phone',{p_workspace_id:f.scope.workspaceId,p_phone:phone,p_via:'stop',p_message_id:'fixture-stop'});
    assert.equal(stop.error,null);assert.equal((await f.store.getInvoice(f.scope)).followup_state,'paused');
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');
    assert.equal((await f.callback({validSignature:false})).code,403);
    await f.callback({recipient:'+919818685252'});await f.callback({waba:'555555'});await f.callback({token:'0'.repeat(64)});
    assert.equal((await f.store.getInvoice(f.scope)).reminder_count,0);
    assert.equal((await f.callback()).code,200);await f.callback();
    const after=await f.store.getInvoice(f.scope);assert.equal(after.reminder_count,1);assert.equal(after.followup_state,'paused');assert.equal(after.next_follow_up_at,null);
    assert.equal(after.total_amount,before.total_amount);assert.equal(after.amount_paid,before.amount_paid);
    assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);
  }finally{await f.close()}
});

test('killed reserved sending lease quarantines without retry; signed receipt recovers exactly once after paid/pause changes',async()=>{
  const f=await setup();try{
    const input=await f.prepare();f.mode('unknown');assert.equal((await f.rawProvider.sendReminder(input)).status,'unknown');
    await f.db.exec("update app.first_party_reminder_dispatches set lease_until=now()-interval '1 second';update cetld_core_automation_delivery_claims set lease_until=now()-interval '1 second'");
    const result=await f.supabase.rpc('cetld_core_quarantine_first_party_leases',{p_owner_id:f.scope.ownerId,p_workspace_id:f.scope.workspaceId,p_now:new Date().toISOString()});
    assert.equal(result.data,1,JSON.stringify({result,errors:f.errors}));assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');assert.equal(f.graph.length,1);
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}';set role authenticated`);
    await f.db.query('select public.record_invoice_payment($1,$2,125,$3,null,false)',[f.scope.workspaceId,f.scope.invoiceId,'fixture-paid-after-unknown']);
    await f.db.exec('reset role');
    assert.equal((await f.callback()).code,200);await f.callback();
    const row=await f.store.getInvoice(f.scope);assert.equal(row.reminder_count,1);assert.equal(row.status,'paid');assert.equal(row.followup_state,'cancelled');assert.equal(row.next_follow_up_at,null);
  }finally{await f.close()}
});

test('local payment checker rejects mismatched allocations and linked external accounting instead of changing financial facts',async()=>{
  const f=await setup();try{
    assert.deepEqual(await f.paymentChecker(f.scope),{paidMinor:0});
    await f.db.query('update invoices set amount_paid=25 where id=$1',[f.scope.invoiceId]);
    await assert.rejects(f.paymentChecker(f.scope),/verification unavailable/);
    // Trusted fixture seed represents accounting linkage; an owner cannot assign it.
    await f.db.exec("set request.jwt.claim.role='service_role'");
    await f.db.query("update invoices set amount_paid=0,external_provider='zoho_books',external_invoice_id='fixture-external' where id=$1",[f.scope.invoiceId]);
    await assert.rejects(f.paymentChecker(f.scope),/verification unavailable/);
    await assert.rejects(f.paymentChecker({...f.scope,workspaceId:f.foreignWs}),/scope mismatch/);
    assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('local checker nets immutable original payments against exact reversal audits without deleting receipts',async()=>{
  const f=await setup();try{
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.scope.ownerId}';set role authenticated`);
    const payment=(await f.db.query('select (public.record_invoice_payment($1,$2,25,$3,null,false)).id',[f.scope.workspaceId,f.scope.invoiceId,'fixture-partial-payment'])).rows[0].id;
    await f.db.exec('reset role');assert.deepEqual(await f.paymentChecker(f.scope),{paidMinor:2500});
    // Fixture represents a completed, separately tested owner reopening. This
    // test verifies the checker projection; it does not approve a new reversal.
    const proposal=(await f.db.query(`insert into invoice_reopening_proposals(workspace_id,owner_id,phone,invoice_id,source_message_id,
      invoice_number,currency,amount,expected_updated_at,ledger_fingerprint,payment_ids,state)
      select workspace_id,$2,$3,id,'fixture-reopen',invoice_number,currency,25,updated_at,'fixture-audit',array[$4::uuid],'confirmed'
      from invoices where id=$1 returning id`,[f.scope.invoiceId,f.scope.ownerId,phone,payment])).rows[0].id;
    await f.db.query(`insert into payment_reversals(workspace_id,invoice_id,payment_id,proposal_id,amount,actor_id) values($1,$2,$3,$4,25,$5)`,
      [f.scope.workspaceId,f.scope.invoiceId,payment,proposal,f.scope.ownerId]);
    await f.db.query('update invoices set amount_paid=0 where id=$1',[f.scope.invoiceId]);
    assert.deepEqual(await f.paymentChecker(f.scope),{paidMinor:0});
    assert.equal((await f.db.query('select count(*)::int n from payments where id=$1',[payment])).rows[0].n,1);
    await assert.rejects(f.db.query('update payment_reversals set amount=20 where payment_id=$1',[payment]),e=>e.code==='42501');
  }finally{await f.close()}
});

test('signed STOP webhook invokes real revocation/cancellation without sends or unrelated tenant changes',async()=>{
  const f=await setup();try{
    await f.prepare();
    const foreignCustomer=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Unrelated recipient','+919818685252') returning id",[f.foreignWs])).rows[0].id;
    const foreignInvoice=(await f.db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
      values($1,$2,'UNRELATED',current_date-1,current_date+1,'USD',45,'sent','{"invoice_direction":"receivable"}') returning *`,[f.foreignWs,foreignCustomer])).rows[0];
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:env.WHATSAPP_WABA_ID,changes:[{field:'messages',value:{
      metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id:'fixture-stop-event',from:phone.slice(1),type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'STOP'}}]}}]}]}));
    const res=()=>({code:null,status(c){this.code=c;return this},json(){return this},send(){return this},setHeader(){}});
    const request={method:'POST',rawBody,headers:{'x-hub-signature-256':`sha256=${createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`}};
    const first=res();await f.webhook(request,first);assert.equal(first.code,200);
    const repeat=res();await f.webhook(request,repeat);assert.equal(repeat.code,200);
    assert.equal((await f.store.getInvoice(f.scope)).followup_state,'paused');
    assert.equal((await f.db.query('select revoked_at is not null as stopped from whatsapp_consents where workspace_id=$1',[f.scope.workspaceId])).rows[0].stopped,true);
    assert.deepEqual((await f.db.query('select * from invoices where id=$1',[foreignInvoice.id])).rows[0],foreignInvoice);
    assert.equal(f.graph.length,0);assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);
  }finally{await f.close()}
});

test('canonical JS/Postgres fingerprints agree for Unicode, nested arrays and escaped text; private audits/revisions remain immutable',async()=>{
  const f=await setup();try{
    const value={text:'José ☕\nline',nested:{z:null,a:[true,1,'quoted "text"']}};
    const sql=(await f.db.query("select encode(sha256(convert_to(app.reminder_canonical_json($1::jsonb),'UTF8')),'hex') as hash",[JSON.stringify(value)])).rows[0].hash;
    assert.equal(sql,reminderFingerprint(value));
    await assert.rejects(f.db.exec("update app.first_party_reminder_templates set body='Unreviewed changed copy'"),e=>e.code==='42501');
    await f.engine.run(f.scope);
    await assert.rejects(f.db.exec("update app.first_party_reminder_receipt_events set status='read'"),e=>e.code==='42501');
  }finally{await f.close()}
});

test('cleared current customer phone defeats stale invoice and original metadata fallback',async()=>{
  const f=await setup();try{
    await f.db.query("update invoices set customer_phone=$2,metadata=metadata||jsonb_build_object('debtor_phone',$2::text) where id=$1",[f.scope.invoiceId,phone]);
    await f.db.query('update customers set phone=null where id=$1',[f.customerId]);
    assert.equal((await f.store.getInvoice(f.scope)).customerPhone,null);
    assert.equal((await f.engine.run(f.scope)).status,'skipped');assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('killed worker before final gate reservation quarantines scoped sending lease with no blind retry',async()=>{
  const f=await setup();try{
    await f.prepare();await f.db.exec("update cetld_core_automation_delivery_claims set lease_until=now()-interval '1 second'");
    const result=await f.supabase.rpc('cetld_core_quarantine_first_party_leases',{p_owner_id:f.scope.ownerId,p_workspace_id:f.scope.workspaceId,p_now:new Date().toISOString()});
    assert.equal(result.data,1,JSON.stringify(f.errors));
    assert.equal((await f.db.query('select count(*)::int n from app.first_party_reminder_dispatches')).rows[0].n,0);
    await f.engine.run(f.scope);assert.equal(f.graph.length,0);
  }finally{await f.close()}
});

test('signed delivery arriving before HTTP response reconciles before engine receipt without duplicate count or fictitious failure',async()=>{
  const f=await setup();try{
    f.onSend(async payload=>assert.equal((await f.callback({token:payload.biz_opaque_callback_data})).code,200));
    assert.equal((await f.engine.run(f.scope)).status,'sent');assert.equal(f.graph.length,1);
    assert.equal((await f.store.getInvoice(f.scope)).reminder_count,1);
    assert.equal((await f.db.query('select state from app.first_party_reminder_dispatches')).rows[0].state,'delivered');
  }finally{await f.close()}
});

test('accepted receipt committed before connection interruption is recovered through signed callback without resend',async()=>{
  const f=await setup();try{
    let interrupted=false;f.intercept(async(url,options)=>{
      if(url.pathname.endsWith('/rpc/cetld_core_record_first_party_receipt')&&!interrupted){
        interrupted=true;const args=JSON.parse(options.body);
        await f.db.query('select public.cetld_core_record_first_party_receipt($1,$2,$3,$4,$5,$6)',
          [args.p_callback_token,args.p_waba_id,args.p_phone_number_id,args.p_phone,args.p_message_id,args.p_status]);
        throw Error('isolated committed response lost');
      }
    });
    const result=await f.engine.run(f.scope);assert.equal(result.status,'quarantined');assert.equal(result.reason,'receipt_not_committed');
    f.intercept(null);assert.equal((await f.callback()).code,200);await f.engine.run(f.scope);
    assert.equal(f.graph.length,1);assert.equal((await f.store.getInvoice(f.scope)).reminder_count,1);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'sent');
  }finally{await f.close()}
});

for(const [label,mutation] of [
  ['STOP',"insert into whatsapp_global_suppressions(phone) values('+919871367051')"],
  ['current phone',"update customers set phone=null where id=(select customer_id from invoices where id=$1)"],
  ['invoice version',"update invoices set notes='changed during final gate' where id=$1"],
  ['payable direction',"update invoices set metadata=metadata||'{\"invoice_direction\":\"payable\"}' where id=$1"],
  ['preferences',"update workspace_settings set business_name='Changed studio' where workspace_id=(select workspace_id from invoices where id=$1)"],
  ['approval revocation',"update app.first_party_reminder_templates set approved=false"],
])test(`actual final SQL gate rejects concurrent ${label} change before HTTP`,async()=>{
  const f=await setup();try{
    const input=await f.prepare();f.intercept(async url=>{
      if(url.pathname.endsWith('/rpc/cetld_core_authorize_first_party_reminder'))await f.db.query(mutation,mutation.includes('$1')?[f.scope.invoiceId]:[]);
    });
    assert.equal((await f.rawProvider.sendReminder(input)).status,'blocked');assert.equal(f.graph.length,0);
    assert.equal((await f.db.query('select count(*)::int n from app.first_party_reminder_dispatches')).rows[0].n,0);
  }finally{await f.close()}
});
