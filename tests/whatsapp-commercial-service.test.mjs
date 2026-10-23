import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createInboundRuntime,SupabaseInboundInbox} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

const OWNER='+12025550198',CUSTOMER='+12025550199',OTHER='+12025550197';
const logger={log(){},info(){},warn(){},error(){}};
const migration=new URL('../supabase/migrations/20261023201719_commercial_transactional_owner_replies.sql',import.meta.url);
const response=()=>({code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});

async function setup(t,{environment={},handler,realOwnerHandler=false,boundHandler}={}){
  let liveCalls=0;
  const forbidden=()=>{liveCalls++;throw Error('Live network forbidden');};
  t.mock.method(globalThis,'fetch',forbidden);t.mock.method(http,'request',forbidden);t.mock.method(https,'request',forbidden);
  const graph=[],uploads=[];
  const f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
    assert.equal(url.origin,'https://graph.facebook.com');
    if(url.pathname.endsWith('/media'))return Response.json({id:'fake-media'});
    graph.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.fake.'+graph.length}]});
  }});
  t.after(async()=>{assert.equal(liveCalls,0);await f.close();});
  const transport=async(url,options)=>{
    // The offline REST fixture accepts JSON, while Graph media uses FormData.
    // Handle that injected transport boundary without forwarding to any network.
    if(String(url).endsWith('/media')){uploads.push(options.body);return Response.json({id:'fake-media'});}
    return f.fetchImpl(url,options);
  };
  const env={WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_ALLOWLIST:undefined,
    WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fake-token',WHATSAPP_APP_SECRET:'fake-webhook-secret',
    WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'1734116767674237',WHATSAPP_GRAPH_API_VERSION:'v24.0',...environment};
  const {db,supabase}=f,ownerId=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query('select (create_workspace($1,$2)).id',['Fixture business',randomUUID()])).rows[0].id;
  const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,OWNER])).rows[0];
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[OWNER,verification.code])).rows[0].value.ok,true);
  // Keep real code/membership/linked-phone proof, remove ALL owner customer consent.
  await db.query('delete from whatsapp_consents where phone=$1',[OWNER]);
  const customerId=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Fixture customer',$2) returning id",[workspaceId,CUSTOMER])).rows[0].id;
  const inbox=new SupabaseInboundInbox(supabase,{env});
  const runtime=createInboundRuntime({env,supabase,fetchImpl:transport,logger,
    onBoundMessage:boundHandler,
    onOwnerMessage:realOwnerHandler?createOwnerMessageHandler({supabase,env,fetchImpl:transport,logger,
      providerFactory:()=>({generate(){assert.fail('A real standalone owner greeting must not call an LLM');}})})
      :handler|| (async()=>({answer:'Owner reply from verified context.'}))});
  const webhook=createWhatsAppWebhookHandler({env,runtime,logger});
  async function signed(text,{phone=CUSTOMER,timestamp=new Date(),signature=true,id='wamid.'+randomUUID(),waba=env.WHATSAPP_WABA_ID,receivingNumber=env.WHATSAPP_PHONE_NUMBER_ID}={}){
    const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{
      metadata:{phone_number_id:receivingNumber},messages:[{id,from:phone.slice(1),type:'text',text:{body:text},timestamp:String(Math.floor(Number(timestamp)/1000))}],
    }}]}]}));
    const res=response();await webhook({method:'POST',rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',signature?env.WHATSAPP_APP_SECRET:'wrong').update(rawBody).digest('hex')}},res);
    return {id,res};
  }
  async function event(text='Hello',options={}){
    const {id,res}=await signed(text,options);assert.equal(res.code,200);
    return (await inbox.claim(1)).find(e=>e.provider_message_id===id);
  }
  async function bindCustomer(e){
    await createConversationStore(supabase).record({workspaceId,customerId,phone:CUSTOMER,direction:'inbound',audience:'customer',
      body:e.message_text,status:'received',providerMessageId:e.provider_message_id,key:`inbound:${e.provider_message_id}`});
  }
  const outbound=createWhatsAppOutbound({env,supabase,fetchImpl:transport,logger,
    authorizeInboundReply:async input=>{
      if(input.audience!=='owner')return inbox.claimReply(input);
      const result=await supabase.rpc('whatsapp_claim_service_owner_reply',{p_provider_message_id:input.messageId,
        p_sender_phone:input.phone,p_workspace_id:input.workspaceId,p_phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID,p_phase:input.phase||'answer'});
      if(result.error)throw result.error;return {allowed:result.data===true};
    }});
  const args=e=>({workspaceId,to:e.sender_phone,body:'A transactional answer.',lastInboundAt:e.provider_timestamp,
    messageId:e.provider_message_id,businessName:'Fixture business'});
  return {...f,env,ownerId,workspaceId,customerId,inbox,runtime,signed,event,bindCustomer,outbound,args,graph,uploads,
    deliveries:()=>graph.filter(p=>p.to)};
}

test('commercial owner replies use actual code proof without any customer consent row',async t=>{
  const f=await setup(t);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_consents where phone=$1',[OWNER])).rows[0].n,0);
  assert.equal((await f.db.query('select count(*)::int n from whatsapp_resolve_verified_owner($1)',[OWNER])).rows[0].n,0,
    'legacy resolver is intentionally unchanged');
  await f.signed('Hello',{phone:OWNER});
  assert.equal((await f.runtime.processPending()).completed,1);
  assert.equal(f.deliveries().length,1);assert.equal(f.deliveries()[0].to,OWNER.slice(1));
  assert.equal(f.deliveries()[0].text.body,'Owner reply from verified context.');
  assert.equal(f.errors.length,0,JSON.stringify(f.errors));
});

for(const flag of [undefined,'false'])test(`flag ${flag}: original unbound routing makes no new service-authority calls`,async t=>{
  const f=await setup(t,{environment:{WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:flag,WHATSAPP_TEST_ALLOWLIST:'+919871367051'}});
  await f.signed('Hello');await f.runtime.processPending();
  assert.equal(f.graph.length,0,'main leaves an unbound non-QA sender without an outbound verification');
  assert.equal(f.requests.filter(r=>/\/rpc\/whatsapp_(?:resolve_service_owner|claim_service_owner_reply)$/.test(new URL(r.url).pathname)).length,0);
});

test('commercial real owner handler and durable receipts deliver a greeting with no owner customer consent',async t=>{
  const f=await setup(t,{realOwnerHandler:true});
  await f.signed('Hello',{phone:OWNER});await f.runtime.processPending();
  assert.equal(f.deliveries().length,1);
  assert.equal(f.deliveries()[0].text.body,'Hi! What do you need help with?');
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_messages where direction='outbound' and audience='owner' and status='accepted'")).rows[0].n,1);
  assert.equal(f.errors.length,0,JSON.stringify(f.errors));
});

for(const method of ['sendServiceReply','sendServiceMedia'])test(`commercial ${method} rejects spoofed owner audience`,async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  const result=await f.outbound[method]({...f.args(e),audience:'owner',caption:'Private owner answer',media:{bytes:Buffer.from('fake'),mimeType:'application/pdf'}});
  assert.equal(result.reason,'owner_binding_mismatch');assert.equal(f.graph.length,0);assert.equal(f.uploads.length,0);
});

for(const [label,patch,reason] of [
  ['wrong recipient',{to:OTHER},'inbound_context_mismatch'],
  ['missing message',{messageId:undefined},'missing_inbound_context'],
  ['invented message',{messageId:'wamid.not-in-inbox'},'inbound_context_mismatch'],
  ['spoofed START kind',{kind:'start_confirmation'},'inbound_kind_mismatch'],
  ['spoofed STOP kind',{kind:'stop_confirmation'},'inbound_kind_mismatch'],
  ['null business with normal kind',{workspaceId:null},'inbound_context_mismatch'],
])test(`commercial transactional ${label} cannot create reply authority`,async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),...patch})).reason,reason);assert.equal(f.graph.length,0);
});

test('commercial normal customer reply requires the recorded original business, even when phone exists in another business',async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.ownerId}';set role authenticated`);
  const foreign=(await f.db.query('select (create_workspace($1,$2)).id',['Other business',randomUUID()])).rows[0].id;
  await f.db.exec('reset role');
  await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Another customer',$2)",[foreign,CUSTOMER]);
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),workspaceId:foreign,businessName:'Other business'})).reason,'inbound_context_mismatch');
  assert.equal(f.graph.length,0);
});

for(const [label,sql] of [
  ['wrong receiving business number',"update whatsapp_inbound_events set phone_number_id='999999' where provider_message_id=$1"],
  ['stale provider time',"update whatsapp_inbound_events set provider_timestamp=clock_timestamp()-interval '25 hours' where provider_message_id=$1"],
  ['future provider time',"update whatsapp_inbound_events set provider_timestamp=clock_timestamp()+interval '1 hour' where provider_message_id=$1"],
  ['completed context',"update whatsapp_inbound_events set status='done' where provider_message_id=$1"],
])test(`commercial ${label} blocks even with a claimed fresh caller timestamp`,async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  await f.db.query(sql,[e.provider_message_id]);
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),lastInboundAt:new Date().toISOString()})).status,'blocked');assert.equal(f.graph.length,0);
});

test('commercial customer transactional reply needs inbound context, not proactive customer consent',async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  assert.equal((await f.outbound.sendServiceReply(f.args(e))).status,'accepted');assert.equal(f.deliveries().length,1);
  const proactive=await f.outbound.sendInvoiceUpdateTemplate({workspaceId:f.workspaceId,to:CUSTOMER});
  assert.deepEqual(proactive,{status:'blocked',reason:'missing_consent'});assert.equal(f.deliveries().length,1);
});

test('commercial UNSET allowlist skips only narrowing: valid service context passes and missing consent still blocks proactive send',async t=>{
  const f=await setup(t,{environment:{WHATSAPP_TEST_ALLOWLIST:undefined}});
  assert.equal(f.env.WHATSAPP_TEST_ALLOWLIST,undefined);
  const e=await f.event();await f.bindCustomer(e);
  assert.equal((await f.outbound.sendServiceReply(f.args(e))).status,'accepted');
  assert.equal((await f.outbound.sendInvoiceUpdateTemplate({workspaceId:f.workspaceId,to:CUSTOMER})).reason,'missing_consent');
  assert.equal(f.deliveries().length,1);
});

test('commercial allowlist containment also narrows transactional replies',async t=>{
  const f=await setup(t,{environment:{WHATSAPP_TEST_ALLOWLIST:'+919818685252'}}),e=await f.event();
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),workspaceId:null,kind:'verification',businessName:'CETLD'})).reason,'test_allowlist');
  assert.equal(f.graph.length,0);
});

test('commercial owner identity ignores an unrelated suppressed customer; own STOP still blocks until START',async t=>{
  const f=await setup(t);
  await f.db.query('insert into whatsapp_global_suppressions(phone) values($1)',[CUSTOMER]);
  await f.db.query('insert into whatsapp_suppressions(workspace_id,phone,reason) values($1,$2,$3)',[f.workspaceId,CUSTOMER,'stop']);
  await f.signed('Hello',{phone:OWNER});await f.runtime.processPending();assert.equal(f.deliveries().length,1);
  await f.signed('STOP',{phone:OWNER});await f.runtime.processPending();assert.equal(f.deliveries().length,2);
  assert.match(f.deliveries().at(-1).text.body,/updates are off/);
  await f.signed('Hello',{phone:OWNER});await f.runtime.processPending();assert.equal(f.deliveries().length,2);
  await f.signed('START',{phone:OWNER});await f.runtime.processPending();assert.equal(f.deliveries().length,3);
  await f.signed('Hello',{phone:OWNER});await f.runtime.processPending();assert.equal(f.deliveries().length,4);
  assert.equal(f.deliveries().at(-1).text.body,'Owner reply from verified context.');
});

test('commercial suppressed customer gets one STOP acknowledgment, no other reply until START',async t=>{
  const f=await setup(t);
  await f.signed('STOP');await f.runtime.processPending();assert.equal(f.deliveries().length,1);
  await f.signed('Hello');await f.runtime.processPending();assert.equal(f.deliveries().length,1);
  await f.signed('STOP');await f.runtime.processPending();assert.equal(f.deliveries().length,1);
  await f.signed('START');await f.runtime.processPending();assert.equal(f.deliveries().length,2);
  assert.match(f.deliveries().at(-1).text.body,/receive WhatsApp updates again/);
  await f.signed('Hello');await f.runtime.processPending();assert.equal(f.deliveries().length,3);
  assert.match(f.deliveries().at(-1).text.body,/verify your WhatsApp number/);
});

test('commercial onboarding, failed link and START are authenticated fixed transactional replies without a business binding',async t=>{
  const f=await setup(t);
  for(const text of ['Hello','LINK 000000','START']){await f.signed(text);await f.runtime.processPending();}
  assert.equal(f.deliveries().length,3);
  assert.match(f.deliveries()[0].text.body,/verify your WhatsApp number/);
  assert.match(f.deliveries()[1].text.body,/couldn’t link this number/);
  assert.match(f.deliveries()[2].text.body,/receive WhatsApp updates again/);
});

test('commercial successful link uses real code verification and can then reply without the generated customer consent',async t=>{
  const f=await setup(t);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${f.ownerId}';set role authenticated`);
  const code=(await f.db.query('select * from owner_start_whatsapp_verification($1,$2)',[f.workspaceId,CUSTOMER])).rows[0].code;
  await f.db.exec('reset role');
  await f.signed('LINK '+code);await f.runtime.processPending();assert.equal(f.deliveries().length,1);
  assert.match(f.deliveries()[0].text.body,/Connected/);
  await f.db.query('delete from whatsapp_consents where phone=$1',[CUSTOMER]);
  await f.signed('Hello');await f.runtime.processPending();assert.equal(f.deliveries().length,2);
  assert.equal(f.deliveries().at(-1).text.body,'Owner reply from verified context.');
});

test('commercial signed fallback works with null business; unsigned, wrong-WABA and wrong-number events create no authority',async t=>{
  const f=await setup(t),e=await f.event();
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),workspaceId:null,kind:'verification',businessName:'CETLD'})).status,'accepted');
  const bad=await f.signed('Hello',{signature:false});assert.equal(bad.res.code,403);
  assert.equal((await f.outbound.sendServiceReply({...f.args(e),workspaceId:null,kind:'verification',businessName:'CETLD',messageId:bad.id})).status,'blocked');
  for(const patch of [{waba:'999999'},{receivingNumber:'999999'}]){
    const other=await f.signed('Hello',patch);assert.equal(other.res.code,200);
    assert.equal((await f.outbound.sendServiceReply({...f.args(e),workspaceId:null,kind:'verification',businessName:'CETLD',messageId:other.id})).status,'blocked');
  }
  assert.equal(f.deliveries().length,1);
});

for(const finalAttempt of [false,true])test(`commercial actual ${finalAttempt?'final-attempt':'processing-error'} fallback delivers through its existing fixed verification form`,async t=>{
  const f=await setup(t,{boundHandler:()=>{throw Error('Injected bound-handler failure');}});
  await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture',array['invoice_updates'])",[f.workspaceId,f.customerId,CUSTOMER]);
  const {id}=await f.signed('Hello');
  if(finalAttempt)await f.db.query('update whatsapp_inbound_events set attempts=4 where provider_message_id=$1',[id]);
  await f.runtime.processPending();
  assert.equal(f.deliveries().length,1);assert.match(f.deliveries()[0].text.body,/verify your WhatsApp number/);
  assert.ok((await f.db.query('select reply_claimed_at from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0].reply_claimed_at);
});

test('commercial verified owner media and progress acknowledgments use the real service owner claims without consent',async t=>{
  const f=await setup(t),ack=await f.event('Hello',{phone:OWNER});
  assert.equal((await f.outbound.sendServiceReply({...f.args(ack),audience:'owner',phase:'ack'})).status,'accepted');
  const media=await f.event('Hello again',{phone:OWNER});
  assert.equal((await f.outbound.sendServiceMedia({...f.args(media),audience:'owner',caption:'Owner invoice file',media:{bytes:Buffer.from('fake pdf'),mimeType:'application/pdf',fileName:'fixture.pdf'}})).status,'accepted');
  assert.equal(f.deliveries().length,2);assert.equal(f.deliveries()[1].type,'document');
});

test('commercial STOP between reply preparation and claim denies a normal customer reply',async t=>{
  const f=await setup(t),e=await f.event();await f.bindCustomer(e);
  f.intercept(async url=>{
    if(url.pathname.endsWith('/rpc/whatsapp_claim_inbound_reply')){
      await f.db.query('insert into whatsapp_global_suppressions(phone) values($1)',[CUSTOMER]);
    }
  });
  assert.equal((await f.outbound.sendServiceReply(f.args(e))).reason,'globally_suppressed');assert.equal(f.deliveries().length,0);
});

test('commercial owner SQL claim rechecks binding, sender, receiving number, window and idempotency without changing legacy routines',async t=>{
  const f=await setup(t),e=await f.event('Hello',{phone:OWNER});
  const prior=(await f.db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where proname in ('whatsapp_resolve_verified_owner','whatsapp_claim_owner_reply','whatsapp_claim_owner_ack') order by 1")).rows;
  await f.db.exec(await readFile(migration,'utf8'));
  assert.deepEqual((await f.db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where proname in ('whatsapp_resolve_verified_owner','whatsapp_claim_owner_reply','whatsapp_claim_owner_ack') order by 1")).rows,prior);
  const args={p_provider_message_id:e.provider_message_id,p_sender_phone:OWNER,p_workspace_id:f.workspaceId,p_phone_number_id:f.env.WHATSAPP_PHONE_NUMBER_ID,p_phase:'answer'};
  for(const patch of [{p_sender_phone:CUSTOMER},{p_workspace_id:randomUUID()},{p_phone_number_id:'999999'},{p_phase:'invented'}]){
    assert.equal((await f.supabase.rpc('whatsapp_claim_service_owner_reply',{...args,...patch})).data,false);
  }
  await f.db.query("update whatsapp_inbound_events set provider_timestamp=clock_timestamp()-interval '25 hours' where provider_message_id=$1",[e.provider_message_id]);
  assert.equal((await f.supabase.rpc('whatsapp_claim_service_owner_reply',args)).data,false);
  await f.db.query('update whatsapp_inbound_events set provider_timestamp=clock_timestamp() where provider_message_id=$1',[e.provider_message_id]);
  await f.db.query('update whatsapp_owner_verifications set verified_at=null where phone=$1',[OWNER]);
  assert.equal((await f.supabase.rpc('whatsapp_claim_service_owner_reply',args)).data,false);
  await f.db.query('update whatsapp_owner_verifications set verified_at=clock_timestamp() where phone=$1',[OWNER]);
  assert.equal((await f.supabase.rpc('whatsapp_claim_service_owner_reply',args)).data,true);
  assert.equal((await f.supabase.rpc('whatsapp_claim_service_owner_reply',args)).data,false);
  for(const role of ['anon','authenticated']){
    await f.db.exec('set role '+role);
    await assert.rejects(f.db.query('select * from whatsapp_resolve_service_owner($1)',[OWNER]),/permission denied/);
    await assert.rejects(f.db.query('select whatsapp_claim_service_owner_reply($1,$2,$3,$4,$5)',[e.provider_message_id,OWNER,f.workspaceId,f.env.WHATSAPP_PHONE_NUMBER_ID,'answer']),/permission denied/);
    await f.db.exec('reset role');
  }
  assert.equal(f.graph.length,0);
});
