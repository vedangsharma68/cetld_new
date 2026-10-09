import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {CoreAutomationStore} from '../automation/core-store.mjs';
import {createAutomationRuntime} from '../automation/runtime.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';

const phone='+919871367051',waba='1734116767674237';
const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',
  WHATSAPP_PROVIDER:'first_party_meta',WHATSAPP_REMINDER_PAYMENT_MODE:'local_verified',
  AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_REMINDERS_ENABLED:'true',
  WHATSAPP_REMINDER_RECEIPTS_ENABLED:'true',WHATSAPP_REMINDER_SCHEDULER_ENABLED:'true',
  WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture-graph-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',
  WHATSAPP_WABA_ID:waba,WHATSAPP_GRAPH_API_VERSION:'v24.0',WHATSAPP_APP_SECRET:'fixture-signature'};
const logger={log(){},warn(){},error(){}};

async function setup(){
  const graph=[];let uncertain=false;
  // The only Graph traffic is captured below by the offline SQL fixture; no network request is sent externally.
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');assert.equal(options.method,'POST');
    graph.push(JSON.parse(options.body));if(uncertain)throw Error('interrupted synthetic transport');
    return Response.json({messages:[{id:`wamid.fixture.${graph.length}`}]});
  }});
  try{
    await f.db.exec(await readFile(new URL('../supabase/migrations/20261005070000_approved_whatsapp_reminders.sql',import.meta.url),'utf8'));
  }
  catch(error){await f.close();throw error;}
  const ownerId=randomUUID(),foreignOwner=randomUUID();
  await f.db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
  async function workspace(actor){
    await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
    const id=(await f.db.query('select (public.create_workspace($1,$2)).id',['Fixture studio',randomUUID()])).rows[0].id;
    await f.db.exec('reset role');return id;
  }
  const workspaceId=await workspace(ownerId),foreignWs=await workspace(foreignOwner);
  await f.db.query("update workspace_settings set business_name='Fixture studio',default_timezone='UTC',follow_up_preferences=$2 where workspace_id=$1",[workspaceId,JSON.stringify({tone:'professional',firstReminderDays:0,cadenceDays:1,maxReminders:3,contactStart:'00:00',contactEnd:'23:59',allowedWeekdays:[0,1,2,3,4,5,6]})]);
  const customerId=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture customer',$2) returning id",[workspaceId,phone])).rows[0].id;
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'inbound_message','fixture-v1',array['invoice_updates'])",[workspaceId,customerId,phone]);
  async function invoice(number){
    const id=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,$3,current_date-2,current_date-1,'USD',125,'sent','{\"invoice_direction\":\"receivable\"}') returning id",[workspaceId,customerId,number])).rows[0].id;
    await f.db.query("update invoices set metadata=metadata||jsonb_build_object('followup_state','approved','approved_reminder_text',E'Legacy reviewed draft\\n\\nFixture studio','approved_preferences_updated_at',(select updated_at from workspace_settings where workspace_id=$2)),next_follow_up_at=now()-interval '1 minute' where id=$1",[id,workspaceId]);
    return id;
  }
  const invoiceId=await invoice('INV-001'),scope={ownerId,workspaceId,invoiceId};
  const configured={...env,AUTOMATION_WORKSPACES:JSON.stringify([{ownerId,workspaceId}])};
  const store=new CoreAutomationStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:f.fetchImpl});
  const runtime=createAutomationRuntime({env:configured,store,supabase:f.supabase,fetchImpl:f.fetchImpl});
  const inbound=createInboundRuntime({env:configured,supabase:f.supabase,fetchImpl:f.fetchImpl,logger});
  const webhook=createWhatsAppWebhookHandler({env:configured,fetchImpl:f.fetchImpl,logger,runtime:inbound});
  async function stop(){
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[{id:'fixture-stop',from:phone.slice(1),type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'STOP'}}]}}]}]}));
    const response={code:null,setHeader(){},status(code){this.code=code;return this},json(){return this},send(){return this}};
    await webhook({method:'POST',rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}},response);
    return response.code;
  }
  return {...f,ownerId,foreignOwner,workspaceId,foreignWs,customerId,invoice,scope,store,runtime,graph,stop,uncertain(){uncertain=true}};
}

test('synthetic approved-reminder lifecycle composes tenant gate, owner pause/resume, dedup, uncertain quarantine, and STOP',async()=>{
  const f=await setup();try{
    const otherScope={ownerId:f.foreignOwner,workspaceId:f.workspaceId,invoiceId:f.scope.invoiceId};
    assert.equal((await f.supabase.rpc('cetld_core_check_local_reminder_payment',{p_owner_id:otherScope.ownerId,p_workspace_id:otherScope.workspaceId,p_invoice_id:otherScope.invoiceId})).data.ok,false);
    assert.equal(f.graph.length,0);

    await f.runtime.pause(f.scope);await f.runtime.tick(f.scope);assert.equal(f.graph.length,0);
    await f.runtime.resume(f.scope);
    await f.db.query("update invoices set next_follow_up_at=now()-interval '1 minute' where id=$1",[f.scope.invoiceId]);
    assert.equal((await f.runtime.tick(f.scope)).results[0]?.status,'sent');
    assert.equal(f.graph.length,1);
    const sent=f.graph[0].template;
    assert.equal(sent.name,'cetld_invoice_update_v2');assert.equal(sent.language.code,'en');
    assert.deepEqual(sent.components[0].parameters.map(parameter=>parameter.text),['Fixture studio',(await f.store.getInvoice(f.scope)).invoice_number,'Fixture customer']);
    assert.equal((await f.runtime.tick(f.scope)).processed,0);assert.equal(f.graph.length,1);

    const uncertainId=await f.invoice('INV-UNCERTAIN');
    f.uncertain();await f.runtime.tick(f.scope);await f.runtime.tick(f.scope);
    assert.equal(f.graph.length,2);
    assert.equal((await f.db.query('select status from cetld_core_automation_delivery_claims where invoice_id=$1',[uncertainId])).rows[0].status,'quarantined');

    const graphBeforeStop=f.graph.length;
    assert.equal(await f.stop(),200);
    assert.equal(await f.stop(),200); // Same provider event is an idempotent webhook replay.
    assert.equal(f.graph.length,graphBeforeStop);
    assert.equal((await f.db.query('select revoked_at is not null as stopped from whatsapp_consents where workspace_id=$1',[f.workspaceId])).rows[0].stopped,true);
    assert.equal((await f.db.query('select count(*)::int n from whatsapp_global_suppressions where phone=$1',[phone])).rows[0].n,1);
    assert.equal((await f.store.getInvoice(f.scope)).followup_state,'paused');
    await f.runtime.tick(f.scope);assert.equal(f.graph.length,2);
    assert.equal((await f.supabase.rpc('cetld_core_check_local_reminder_payment',{p_owner_id:f.ownerId,p_workspace_id:f.foreignWs,p_invoice_id:f.scope.invoiceId})).data.ok,false);
  }finally{await f.close();}
});
