import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {REMINDER_TEMPLATES,selectReminderTemplate,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {parseMetaMessages,createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {reminderFingerprint} from '../automation/whatsapp/reminder-fingerprint.mjs';
import {createReminderCronHandler} from '../automation/reminder-cron.mjs';
import {approvedReminderProof} from '../automation/whatsapp/reminder-proof.mjs';

const phone='+919871367051',waba='1734116767674237';
const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',
  WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',
  WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture-graph-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',
  WHATSAPP_WABA_ID:waba,WHATSAPP_GRAPH_API_VERSION:'v24.0',WHATSAPP_APP_SECRET:'fixture-signature'};
const logger={log(){},warn(){},error(){}};

test('four approved templates use en, three facts and Settings tone/button variant, with neutral text',()=>{
  assert.equal(REMINDER_TEMPLATES.length,4);
  for(const entry of REMINDER_TEMPLATES){
    assert.equal(selectReminderTemplate({tone:entry.tone,templateButtons:entry.buttonVariant}),entry);
    const result=buildReminderTemplate(entry,['Fixture studio','INV-001','Fixture customer']);
    assert.equal(result.template.language.code,'en');assert.equal(result.template.components[0].parameters.length,3);
    assert.ok(result.body.includes('INV-001 for Fixture customer'));
    assert.doesNotMatch(result.body,/overdue|unpaid|owed/i);
  }
  assert.equal(selectReminderTemplate({tone:'firm'}).name,'cetld_invoice_update_v2');
  assert.throws(()=>buildReminderTemplate(REMINDER_TEMPLATES[0],['x','y']),/Invalid/);
  assert.throws(()=>buildReminderTemplate(REMINDER_TEMPLATES[0],['x','y','{{injected}}']),/Invalid/);
});

async function setup(preferences={}){
  const graph=[];let uncertain=false;
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');assert.equal(options.method,'POST');
    graph.push(JSON.parse(options.body));if(uncertain)throw Error('interrupted fixture transport');
    return Response.json({messages:[{id:'wamid.fixture.approved'}]});
  }});
  try{await f.db.exec(await readFile(new URL('../supabase/migrations/20261005070000_approved_whatsapp_reminders.sql',import.meta.url),'utf8'));}catch(error){await f.close();throw error;}
  const ownerId=randomUUID(),foreignOwner=randomUUID();
  await f.db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  async function workspace(actor){await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
    const id=(await f.db.query('select (public.create_workspace($1,$2)).id',['Fixture studio',randomUUID()])).rows[0].id;await f.db.exec('reset role');return id;}
  const workspaceId=await workspace(ownerId),foreignWs=await workspace(foreignOwner);
  await f.db.query("update workspace_settings set business_name='Fixture studio',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,JSON.stringify({tone:'professional',firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6],...preferences})]);
  const customerId=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture customer',$2) returning id",[workspaceId,phone])).rows[0].id;
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'])",[workspaceId,customerId,phone]);
  const invoiceId=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'INV-001',current_date-2,current_date-1,'USD',125,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[workspaceId,customerId])).rows[0].id;
  await f.db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Legacy reviewed draft\n\nFixture studio','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)),next_follow_up_at=now()-interval '1 minute' where id=$1",[invoiceId,workspaceId]);
  const scope={ownerId,workspaceId,invoiceId};
  const configured={...env,AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const runtime=createAutomationRuntime({env:configured,store,supabase:f.supabase,fetchImpl:f.fetchImpl});
  async function callback({status='delivered',token=graph[0]?.biz_opaque_callback_data,validSignature=true}={}){
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},statuses:[{id:'wamid.fixture.approved',status,recipient_id:phone.slice(1),biz_opaque_callback_data:token}]}}]}]}));
    const res={code:null,body:null,setHeader(){},status(c){this.code=c;return this},json(v){this.body=v;return this},send(v){this.body=v;return this}};
    await createWhatsAppWebhookHandler({env:configured,fetchImpl:f.fetchImpl,logger})({method:'POST',rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',validSignature?env.WHATSAPP_APP_SECRET:'wrong').update(rawBody).digest('hex')}},res);
    return res;
  }
  return {...f,scope,foreignOwner,foreignWs,customerId,configured,store,runtime,graph,callback,uncertain(){uncertain=true}};
}

test('real runtime + new forward SQL + signed webhook persist one three-parameter send and delivered receipt',async()=>{
  const f=await setup();try{
    assert.equal((await f.supabase.rpc('cetld_core_check_local_reminder_payment',{p_owner_id:f.foreignOwner,p_workspace_id:f.scope.workspaceId,p_invoice_id:f.scope.invoiceId})).data.ok,false);
    assert.equal((await f.supabase.rpc('cetld_core_authorize_first_party_reminder',{p_owner_id:f.foreignOwner,p_workspace_id:f.scope.workspaceId,p_claim_id:randomUUID(),p_snapshot:{},p_snapshot_hash:'a'.repeat(64)})).data.authorized,false);
    const result=await f.runtime.tick(f.scope);assert.equal(result.results[0]?.status,'sent',JSON.stringify({result,errors:f.errors}));
    assert.equal(f.graph.length,1);assert.equal(f.graph[0].template.name,'cetld_invoice_update_v2');
    assert.equal(f.graph[0].template.language.code,'en');assert.deepEqual(f.graph[0].template.components[0].parameters.map(p=>p.text),['Fixture studio',(await f.store.getInvoice(f.scope)).invoice_number,'Fixture customer']);
    assert.equal((await f.callback({validSignature:false})).code,403);
    assert.equal((await f.callback()).code,200);assert.equal((await f.callback()).code,200);
    assert.equal((await f.db.query('select state from app.first_party_reminder_dispatches')).rows[0].state,'delivered');
    assert.equal((await f.db.query('select status from whatsapp_messages where kind=\'reminder\'')).rows[0].status,'delivered');
    assert.equal((await f.db.query('select reminder_count from invoices where id=$1',[f.scope.invoiceId])).rows[0].reminder_count,1);
    await f.runtime.tick(f.scope);assert.equal(f.graph.length,1);
    const wrong=createApprovedReminderProvider({env:f.configured,supabase:f.supabase,store:f.store,ownerId:f.foreignOwner,workspaceId:f.foreignWs,fetchImpl:f.fetchImpl});
    assert.equal((await wrong.sendReminder({workspaceId:f.scope.workspaceId,invoiceId:f.scope.invoiceId,customerId:f.customerId,to:phone})).reason,'scope');
    await f.db.exec("set role authenticated");
    await assert.rejects(f.db.query('select * from app.first_party_reminder_dispatches'),/permission denied/);await f.db.exec('reset role');
  }finally{await f.close();}
});

test('single synthetic own-number proof verifies live-shaped metadata, reserves once and persists signed delivery without financial mutation',async()=>{
  const f=await setup();try{
    const fetchImpl=async(input,options)=>{
      const url=new URL(String(input));
      if(options.method==='GET'&&url.origin==='https://graph.facebook.com'){
        if(url.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:env.WHATSAPP_PHONE_NUMBER_ID,display_phone_number:'+917303338959'}]});
        const name=url.searchParams.get('name'),entry=REMINDER_TEMPLATES.find(t=>t.name===name);
        return Response.json({data:[{id:'123456789012345',name,language:'en',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:entry.body}]}]});
      }
      return f.fetchImpl(input,options);
    };
    const options={workspaceId:f.scope.workspaceId,ownerId:f.scope.ownerId,env:f.configured,supabase:f.supabase,fetchImpl};
    const preview=await approvedReminderProof(options);assert.equal(preview.synthetic,true);assert.equal(preview.recipient,phone);assert.ok(preview.text.includes('CETLD-TEST-20261005'));
    assert.equal(f.graph.length,0);
    const sent=await approvedReminderProof({...options,send:true});assert.equal(sent.status,'accepted');assert.equal(f.graph.length,1);
    const repeat=await approvedReminderProof({...options,send:true});assert.equal(repeat.status,'blocked');assert.equal(f.graph.length,1);
    assert.equal((await f.callback()).code,200);
    assert.equal((await f.db.query("select status from whatsapp_messages where idempotency_key='approved-template-proof:20261005'")).rows[0].status,'delivered');
    assert.equal((await f.db.query('select count(*)::int as n from invoices')).rows[0].n,1);
    assert.equal((await f.db.query('select reminder_count from invoices where id=$1',[f.scope.invoiceId])).rows[0].reminder_count,0);
    assert.equal((await f.db.query('select count(*)::int as n from payments')).rows[0].n,0);
  }finally{await f.close();}
});

test('consent/suppression and allowlist prevent Graph calls and pause the invoice',async()=>{
  const f=await setup();try{
    const provider=createApprovedReminderProvider({env:f.configured,supabase:f.supabase,store:f.store,...f.scope,fetchImpl:f.fetchImpl});
    assert.equal((await provider.sendReminder({...f.scope,customerId:f.customerId,to:'+15551234567'})).reason,'test_allowlist');
    await f.db.query("update whatsapp_consents set revoked_at=now(),revoked_via='manual' where workspace_id=$1",[f.scope.workspaceId]);
    await f.runtime.tick(f.scope);assert.equal(f.graph.length,0);
    await f.db.query("insert into whatsapp_global_suppressions(phone) values($1)",[phone]);
    await f.runtime.tick(f.scope);assert.equal(f.graph.length,0);
    assert.equal((await f.store.getInvoice(f.scope)).followup_state,'paused');
  }finally{await f.close();}
});

test('actual payment completion and an explicit owner pause each prevent scheduled sends',async()=>{
  for(const action of ['paid','pause']){
    const f=await setup();try{
      if(action==='paid')await f.db.query("insert into payments(workspace_id,invoice_id,amount,method) values($1,$2,125,'bank_transfer')",[f.scope.workspaceId,f.scope.invoiceId]);
      else await f.runtime.pause(f.scope);
      await f.runtime.tick(f.scope);assert.equal(f.graph.length,0);
      assert.equal((await f.store.getInvoice(f.scope)).followup_state,action==='paid'?'cancelled':'paused');
    }finally{await f.close();}
  }
});

test('professional button and gentle plain variants also dispatch through the actual forward SQL gate',async()=>{
  for(const preferences of [{tone:'professional',templateButtons:true},{tone:'gentle',templateButtons:false}]){
    const f=await setup(preferences);try{
      const result=await f.runtime.tick(f.scope);assert.equal(result.results[0]?.status,'sent');
      assert.equal(f.graph.length,1);assert.equal(f.graph[0].template.name,selectReminderTemplate(preferences).name);
      assert.equal(f.graph[0].template.language.code,'en');assert.equal(f.graph[0].template.components[0].parameters.length,3);
    }finally{await f.close();}
  }
});

test('interrupted accepted transport is quarantined and a repeated runtime call never resends',async()=>{
  const f=await setup();try{f.uncertain();await f.runtime.tick(f.scope);await f.runtime.tick(f.scope);
    assert.equal(f.graph.length,1);assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims')).rows[0].status,'quarantined');
  }finally{await f.close();}
});

test('gentle button variant uses approved body and receipt-scoped button tap pauses; repeated tap is harmless',async()=>{
  const f=await setup({tone:'gentle',templateButtons:true});try{
    await f.runtime.tick(f.scope);assert.equal(f.graph[0]?.template.name,'cetld_invoice_gentle_btn_v1');
    const payload={object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id:'wamid.fixture.button',from:phone.slice(1),type:'button',timestamp:'1791170000',context:{id:'wamid.fixture.approved'},button:{text:'Pause',payload:'pause'}}]}}]}]};
    const [parsed]=parseMetaMessages(payload,env.WHATSAPP_PHONE_NUMBER_ID,waba);assert.equal(parsed.interactionId,'rt1.wamid.fixture.approved');
    const args={p_phone:phone,p_context_message_id:'wamid.fixture.approved',p_message_id:parsed.provider_message_id,p_action:'pause'};
    const inbound=createInboundRuntime({env:f.configured,supabase:f.supabase,fetchImpl:f.fetchImpl,logger});
    await inbound.enqueue([parsed]);await inbound.processPending();
    assert.equal((await f.db.query('select action from app.first_party_reminder_button_events')).rows[0]?.action,'pause');
    assert.equal((await f.supabase.rpc('cetld_core_handle_reminder_button',args)).data.status,'duplicate');
    assert.equal((await f.store.getInvoice(f.scope)).followup_state,'paused');
    assert.equal((await f.supabase.rpc('cetld_core_handle_reminder_button',{...args,p_phone:'+919818685252',p_message_id:'different'})).data.ok,false);
    assert.equal((await f.db.query('select count(*)::int as n from app.first_party_reminder_button_events')).rows[0].n,1);
    const stopped=await f.supabase.rpc('cetld_core_handle_reminder_button',{...args,p_message_id:'wamid.fixture.stop',p_action:'stop'});
    assert.equal(stopped.data.status,'opt_out');assert.ok((await f.db.query('select revoked_at from whatsapp_consents')).rows[0].revoked_at);
    assert.equal(f.graph.length,1);
  }finally{await f.close();}
});

test('scheduled route reuses CRON_SECRET, defaults disabled, and runs only configured server scopes',async()=>{
  let calls=0;const workspaceId=randomUUID(),ownerId=randomUUID();
  const res=()=>({code:null,body:null,setHeader(){},status(c){this.code=c;return this},json(v){this.body=v;return this}});
  const options={env:{CRON_SECRET:'fixture-cron'},runtimeFactory(){calls++;throw Error('unexpected');}};
  const handler=createReminderCronHandler(options),unauthorized=res(),disabled=res();
  await handler({method:'GET',headers:{}},unauthorized);assert.equal(unauthorized.code,401);
  await handler({method:'GET',headers:{authorization:'Bearer fixture-cron'}},disabled);assert.equal(disabled.body.disabled,true);assert.equal(calls,0);
  const enabled=createReminderCronHandler({env:{...env,CRON_SECRET:'fixture-cron',AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])},runtimeFactory:()=>({async tick(scope){assert.deepEqual(scope,{ownerId,workspaceId});calls++;return {processed:0};}})});
  const result=res();await enabled({method:'GET',headers:{authorization:'Bearer fixture-cron'}},result);assert.equal(result.code,200);assert.equal(calls,1);
});
