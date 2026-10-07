import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {runWorkerOnce} from '../automation/worker.mjs';
import {handleAutomationRequest} from '../automation/routes.mjs';
import {MockWhatsAppProvider} from '../automation/whatsapp/mock.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {createWhatsAppProvider} from '../automation/whatsapp/factory.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';

const phone='+919871367051',owner=randomUUID(),foreignOwner=randomUUID();
const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture-service-key',
  AUTOMATION_APP_URL:'https://automation.fixture.test',AUTOMATION_WORKER_SECRET:'fixture-worker-secret-'.repeat(3),
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_PROVIDER:'mock',WHATSAPP_OUTBOUND_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'isolated-graph-token',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_WABA_ID:'654321',
  WHATSAPP_GRAPH_API_VERSION:'v23.0',WHATSAPP_APP_SECRET:'isolated-signature-secret',
  CLOUDFLARE_ACCOUNT_ID:'isolated-account',CLOUDFLARE_API_TOKEN:'isolated-model-token'};
const logger={error(){},warn(){},log(){}};
function response(){return {code:200,body:null,setHeader(){},status(value){this.code=value;return this},json(value){this.body=value;return this},send(value){this.body=value;return this}};}
function workspaceResults(calls){
  return calls.flatMap(call=>call.messages.filter(message=>message.role==='user'&&message.content.includes('Workspace results:\n'))
    .flatMap(message=>JSON.parse(message.content.split('Workspace results:\n')[1])));
}
function hasResultValue(value,expected){
  if(Array.isArray(value))return value.some(item=>hasResultValue(item,expected));
  if(value&&typeof value==='object')return Object.values(value).some(item=>hasResultValue(item,expected));
  return value===expected||(typeof expected==='number'&&typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&Number(value)===expected);
}

async function setup(){
  let modelArgs={},modelMode='read',graphMode='accepted',reminderMode='accepted',graphCalls=[],modelCalls=[],hook=null;
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    if(url.origin==='https://graph.facebook.com'){
      const payload=JSON.parse(options.body);graphCalls.push(payload);
      if(hook)await hook(payload);
      if(graphMode==='unknown')throw Error('isolated response lost after transmission');
      if(graphMode==='failed')return Response.json({error:{message:'isolated rejection'}},{status:400});
      return Response.json({messages:[{id:`fixture-graph-${graphCalls.length}`}],success:true});
    }
    if(url.origin==='https://api.cloudflare.com'){
      const payload=JSON.parse(options.body);modelCalls.push(payload);
      const hasResult=!payload.tools||payload.messages.some(message=>message.role==='tool');
      const message=hasResult?{content:'Your invoice information is shown in your account.'}:{content:'',tool_calls:[{
        id:`fixture-read-${modelCalls.length}`,type:'function',function:{name:modelMode==='owner-tool'?'workspaceData':'getInvoices',
          arguments:JSON.stringify(modelMode==='owner-tool'?{operation:'read',table:'workspace_settings'}:modelArgs)}}]};
      return Response.json({choices:[{message,finish_reason:hasResult?'stop':'tool_calls'}]});
    }
    throw Error(`Unmocked external fixture route ${url.origin}`);
  }});
  const {db}=f;
  await db.query('insert into auth.users(id) values($1),($2)',[owner,foreignOwner]);
  async function workspace(user,label){
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${user}';set role authenticated`);
    const id=(await db.query('select (public.create_workspace($1,$2)).id',[label,`fixture-${randomUUID()}`])).rows[0].id;
    await db.exec('reset role');return id;
  }
  const workspaceId=await workspace(owner,'Fixture studio'),foreignWs=await workspace(foreignOwner,'Foreign secret studio');
  await db.query("update workspace_settings set business_name='Fixture studio',default_timezone='Asia/Kolkata',follow_up_preferences=$2 where workspace_id=$1",[
    workspaceId,JSON.stringify({firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],pauseOnReply:true})]);
  await db.query("insert into workspace_ai_settings(workspace_id,primary_model,fallback_model) values($1,'@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/mistralai/mistral-small-3.1-24b-instruct') on conflict(workspace_id) do update set primary_model=excluded.primary_model,fallback_model=excluded.fallback_model",[workspaceId]);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture recipient',$2) returning id",[workspaceId,phone])).rows[0].id;
  const foreignCustomer=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Foreign private recipient','+12025550199') returning id",[foreignWs])).rows[0].id;
  await db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const invoiceId=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'RECIPIENT-001',current_date-10,current_date-1,'USD',125,'sent',$3) returning id`,[workspaceId,customerId,JSON.stringify({invoice_direction:'receivable',client_name:'Fixture recipient',approved_reminder_text:'Invoice update for the fixture recipient.\n\nFixture studio',followup_state:'draft'})])).rows[0].id;
  const foreignInvoice=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata)
    values($1,$2,'PRIVATE-SECRET',current_date-10,current_date-1,'USD',999,'sent','{"invoice_direction":"receivable","client_name":"Foreign private recipient"}') returning id`,[foreignWs,foreignCustomer])).rows[0].id;
  await db.query(`update invoices set metadata=metadata||jsonb_build_object('followup_state','approved',
    'approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$1)) where id=$2`,[workspaceId,invoiceId]);
  await db.query("update invoices set next_follow_up_at=now()-interval '1 minute' where id=$1",[invoiceId]);
  const scope={ownerId:owner,workspaceId,invoiceId};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const reminderCalls=[];
  const provider=new MockWhatsAppProvider({failurePredicate:input=>{reminderCalls.push(structuredClone(input));return reminderMode==='failed';},unknownDeliveryPredicate:()=>reminderMode==='unknown'}),runtime=createAutomationRuntime({env,fetchImpl:f.fetchImpl,store,provider});
  const bound=createWhatsAppBoundMessageHandler({env,fetchImpl:f.fetchImpl,supabase:f.supabase,logger});
  const inbound=createInboundRuntime({env,fetchImpl:f.fetchImpl,supabase:f.supabase,logger,onBoundMessage:bound,
    onOwnerMessage:()=>{throw Error('Recipient must not reach owner handler')}});
  const webhook=createWhatsAppWebhookHandler({env,runtime:inbound,logger});
  async function receive(text,id=`fixture-inbound-${randomUUID()}`){
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:env.WHATSAPP_WABA_ID,changes:[{field:'messages',value:{
      metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id,from:phone.slice(1),type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:text}}]}}]}]}));
    const res=response();await webhook({method:'POST',rawBody,headers:{'x-hub-signature-256':`sha256=${createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`}},res);
    assert.equal(res.code,200,JSON.stringify({body:res.body,errors:f.errors}));
    return {id,processed:await inbound.processPending()};
  }
  return {...f,scope,customerId,foreignWs,foreignCustomer,foreignInvoice,store,provider,runtime,inbound,receive,
    get reminderCalls(){return reminderCalls},get graphCalls(){return graphCalls},get modelCalls(){return modelCalls},
    model(args={},mode='read'){modelArgs=args;modelMode=mode},reminder(mode){reminderMode=mode},graph(mode,callback=null){graphMode=mode;hook=callback}};
}

test('real worker, API, SQL claims and reminder engine send one scoped mock reminder and respect pause/resume/paid stop',async()=>{
  const f=await setup();try{
    const workerEnv={...env,AUTOMATION_WORKSPACES:JSON.stringify([{workspaceId:f.scope.workspaceId,ownerId:owner}])};
    async function transport(url,options){
      assert.equal(String(url),'https://automation.fixture.test/api/automation');
      const res=response();await handleAutomationRequest({method:options.method,headers:{authorization:options.headers.Authorization},body:JSON.parse(options.body)},res,{env,runtime:f.runtime});
      return Response.json(res.body,{status:res.code});
    }
    const denied=await f.runtime.tick({workspaceId:f.scope.workspaceId,ownerId:foreignOwner});
    assert.equal(denied.results[0].reason,'not_claimed');assert.equal(f.reminderCalls.length,0);
    assert.equal((await runWorkerOnce({env:workerEnv,fetchImpl:transport}))[0].ok,true);
    const row=await f.store.getInvoice(f.scope);assert.equal(row.reminder_count,1);
    assert.equal(f.reminderCalls.length,1);assert.equal(f.reminderCalls[0].customerId,f.customerId);assert.equal(f.reminderCalls[0].invoiceId,f.scope.invoiceId);
    const messages=(await f.db.query('select * from cetld_core_automation_messages')).rows;
    assert.equal(messages.length,1);assert.equal(messages[0].workspace_id,f.scope.workspaceId);assert.equal(messages[0].invoice_id,f.scope.invoiceId);
    assert.equal(messages[0].payload.to,phone);assert.equal(messages[0].payload.body,row.metadata.approved_reminder_text);assert.equal(messages[0].status,'sent');
    await runWorkerOnce({env:workerEnv,fetchImpl:transport});assert.equal((await f.db.query('select count(*)::int as n from cetld_core_automation_messages')).rows[0].n,1);
    await f.runtime.pause(f.scope);assert.equal((await f.runtime.tick(f.scope)).processed,0);
    await f.runtime.resume(f.scope);assert.equal((await f.store.getInvoice(f.scope)).followup_state,'approved');
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
    await f.db.query('select public.record_invoice_payment($1,$2,$3,$4,$5,false)',[f.scope.workspaceId,f.scope.invoiceId,125,'fixture transfer','fixture-paid-receipt']);
    await f.db.exec('reset role');
    assert.equal((await f.db.query('select count(*)::int as n from payments')).rows[0].n,1);
    await assert.rejects(f.runtime.resume(f.scope),/Paid invoices/);
    assert.equal((await f.runtime.tick(f.scope)).processed,0);
    assert.equal((await f.store.getInvoice({...f.scope,invoiceId:f.foreignInvoice})),null);
    assert.equal(f.graphCalls.length,0);
  }finally{await f.close();}
});

test('signed recipient webhook runs real customer handler/outbound, pauses without inventing payment and isolates other customers',async()=>{
  const f=await setup();try{
    // A timestamp can contain the foreign amount's digits without leaking its record.
    await f.db.query("update invoices set created_at='2026-10-07T10:24:30.999Z' where id=$1",[f.scope.invoiceId]);
    const ownNumber=(await f.db.query('select invoice_number from invoices where id=$1',[f.scope.invoiceId])).rows[0].invoice_number;
    const reply=await f.receive('What is my invoice status?');assert.equal(reply.processed.completed,1);
    const row=await f.store.getInvoice(f.scope);assert.equal(row.followup_state,'paused');assert.equal(row.next_follow_up_at,null);assert.equal(Number(row.amount_paid),0);
    assert.equal((await f.db.query('select count(*)::int as n from payments')).rows[0].n,0);
    const tools=workspaceResults(f.modelCalls);
    assert(JSON.stringify(tools).includes('2026-10-07T10:24:30.999'),JSON.stringify(tools));
    assert(hasResultValue(tools,ownNumber),JSON.stringify(f.modelCalls));
    assert(!hasResultValue(tools,'Foreign private recipient')&&!hasResultValue(tools,'PRIVATE-SECRET')&&!hasResultValue(tools,999));
    const final=(await f.db.query("select * from whatsapp_messages where direction='outbound'")).rows;
    assert.equal(final.length,1);assert.equal(final[0].status,'accepted');assert.equal(final[0].customer_id,f.customerId);assert.equal(final[0].audience,'customer');
    assert(f.graphCalls.some(call=>call.type==='text'&&call.to===phone.slice(1)));
    const modelsBefore=f.modelCalls.length;
    await f.receive('Change the invoice amount to 1');assert.equal(f.modelCalls.length,modelsBefore);
    assert.equal(Number((await f.store.getInvoice(f.scope)).total_amount),125);
    f.model({customerId:f.foreignCustomer});await f.receive('Show the other customer invoices');
    const foreignResult=workspaceResults([f.modelCalls.at(-1)]);
    assert(!hasResultValue(foreignResult,'Foreign private recipient')&&!hasResultValue(foreignResult,'PRIVATE-SECRET')&&!hasResultValue(foreignResult,999));
    f.model({},'owner-tool');await f.receive('Show the business settings');
    assert(f.modelCalls.filter(call=>call.tools).every(call=>!call.tools.some(tool=>tool.function?.name==='workspaceData')));
    assert(!f.requests.some(request=>/whatsapp_apply_direct_owner_write|whatsapp_workspace_data_propose/.test(request.url)));
    assert.equal(Number((await f.store.getInvoice(f.scope)).total_amount),125);

  }finally{await f.close();}
});

test('STOP is durable before acknowledgement and blocks actual Cloud replies while exposing the separate mock-reminder consent gap',async()=>{
  const f=await setup();try{
    const result=await f.receive('STOP','fixture-stop');assert.equal(result.processed.completed,1);
    assert.equal((await f.db.query('select count(*)::int as n from whatsapp_global_suppressions where phone=$1',[phone])).rows[0].n,1);
    assert((await f.db.query('select revoked_at from whatsapp_consents where workspace_id=$1',[f.scope.workspaceId])).rows[0].revoked_at);
    // Existing STOP SQL revokes consent but does not cancel core schedules.
    assert((await f.store.getInvoice(f.scope)).next_follow_up_at);
    const graphCount=f.graphCalls.length,modelCount=f.modelCalls.length;
    await f.receive('STOP','fixture-stop');await f.receive('Show my invoice');
    assert.equal(f.graphCalls.length,graphCount);assert.equal(f.modelCalls.length,modelCount);
    await f.runtime.resume(f.scope);await f.db.query("update invoices set next_follow_up_at=now()-interval '1 minute' where id=$1",[f.scope.invoiceId]);
    // The mock reminder bridge currently lacks the Cloud adapter's consent guard.
    const tick=await f.runtime.tick(f.scope);assert(tick.results.some(result=>result.status==='sent'));
    assert.equal(f.graphCalls.length,graphCount);
  }finally{await f.close();}
});

test('production reminder factory and Cloud API preserve the existing collection hold',()=>{
  assert.throws(()=>createWhatsAppProvider({mode:'meta',environment:'production'}),/not configured/);
  assert.throws(()=>createWhatsAppProvider({mode:'mock',environment:'production'}),/disabled/);
  assert.equal(createWhatsAppOutbound({env:{},supabase:{from(){throw Error('must not access database')}}}).sendReminder,undefined);
});

test('owner-local morning window schedules after midnight without claiming or sending early',async()=>{
  const f=await setup();try{
    await f.db.query("update workspace_settings set follow_up_preferences=follow_up_preferences||'{\"contactStart\":\"09:00\",\"contactEnd\":\"18:00\"}'::jsonb where workspace_id=$1",[f.scope.workspaceId]);
    await f.db.query(`update invoices set metadata=metadata||jsonb_build_object('followup_state','approved',
      'approved_reminder_text',E'Invoice update.\n\nFixture studio','approved_preferences_updated_at',
      (select updated_at from workspace_settings where workspace_id=$1)) where id=$2`,[f.scope.workspaceId,f.scope.invoiceId]);
    await f.db.query("update invoices set next_follow_up_at='2026-10-05T01:00:00Z' where id=$1",[f.scope.invoiceId]);
    const runtime=createAutomationRuntime({env,store:f.store,provider:f.provider,clock:()=>new Date('2026-10-05T02:00:00Z')});
    const result=await runtime.tick(f.scope);assert.equal(result.results[0].reason,'contact_hours');
    assert.equal(new Date((await f.store.getInvoice(f.scope)).next_follow_up_at).toISOString(),'2026-10-05T03:30:00.000Z');
    assert.equal(f.reminderCalls.length,0);assert.equal((await f.db.query('select count(*)::int as n from cetld_core_automation_delivery_claims')).rows[0].n,0);
  }finally{await f.close();}
});

test('SQL reminder claims quarantine unknown delivery and bound confirmed-failure retry attempts',async()=>{
  for(const mode of ['unknown','failed']){
    const f=await setup();try{
      f.reminder(mode);
      for(let attempt=0;attempt<4;attempt++)await f.runtime.tick(f.scope);
      const claim=(await f.db.query('select status,attempts from cetld_core_automation_delivery_claims')).rows[0];
      assert.equal(claim.status,mode==='unknown'?'quarantined':'failed');assert.equal(claim.attempts,mode==='unknown'?1:3);
      assert.equal(f.provider.size,1);assert.equal((await f.store.getInvoice(f.scope)).reminder_count,0);
      assert.equal((await f.db.query('select count(*)::int as n from cetld_core_automation_messages')).rows[0].n,1);
    }finally{await f.close();}
  }
});

test('caught interrupted reminder receipt quarantines accepted dispatch without resending',async()=>{
  const f=await setup();try{
    f.intercept(url=>{if(url.pathname==='/rest/v1/rpc/cetld_core_mark_sent')throw Error('isolated receipt response interrupted');});
    assert.deepEqual((await f.runtime.tick(f.scope)).results[0],{invoiceId:f.scope.invoiceId,status:'quarantined',reason:'receipt_not_committed'});
    assert.equal(f.reminderCalls.length,1);assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
    f.intercept(null);await f.db.exec("update cetld_core_automation_delivery_claims set lease_until=now()-interval '1 minute'");
    await f.runtime.tick(f.scope);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
    assert.equal(f.reminderCalls.length,1);assert.equal((await f.store.getInvoice(f.scope)).reminder_count,0);
  }finally{await f.close();}
});

test('killed worker sending lease stays blocked in current SQL until receipt reconciliation is implemented',async()=>{
  const f=await setup();try{
    const [claim]=await f.store.claimDueFollowups({...f.scope,now:new Date().toISOString(),limit:1});
    const auth=await f.store.authorizeDelivery({...f.scope,claimId:claim.id});assert.equal(auth.authorized,true);
    await f.provider.sendReminder({...f.scope,customerId:f.customerId,to:phone,body:'Fixture reminder',idempotencyKey:`reminder:${f.scope.workspaceId}:${claim.id}`});
    // Simulate a worker ending after transmission with no receipt/failure write.
    await f.db.exec("update cetld_core_automation_delivery_claims set lease_until=now()-interval '1 minute'");
    await f.runtime.tick(f.scope);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'sending');
    assert.equal(f.reminderCalls.length,1);assert.equal((await f.store.getInvoice(f.scope)).reminder_count,0);
  }finally{await f.close();}
});

test('recipient response lost after Graph transmission retains unknown receipt and duplicate webhook does not resend',async()=>{
  const f=await setup();try{
    f.graph('unknown');const result=await f.receive('What is my invoice status?','fixture-recipient-uncertain');
    assert.equal(result.processed.completed,1);
    const receipt=(await f.db.query("select status from whatsapp_messages where direction='outbound'")).rows[0];
    assert.equal(receipt.status,'unknown');
    const sends=f.graphCalls.length,models=f.modelCalls.length;
    await f.receive('What is my invoice status?','fixture-recipient-uncertain');
    assert.equal(f.graphCalls.length,sends);assert.equal(f.modelCalls.length,models);
    assert.equal((await f.db.query("select status from whatsapp_inbound_events where provider_message_id='fixture-recipient-uncertain'")).rows[0].status,'done');
  }finally{await f.close();}
});
