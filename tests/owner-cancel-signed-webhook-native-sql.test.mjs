import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

const phone='+12025550281',waba='1234567890123456';
const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',
 WHATSAPP_PROVIDER:'first_party_meta',AUTOMATION_OUTBOUND_ENABLED:'true',WHATSAPP_OUTBOUND_ENABLED:'true',
 WHATSAPP_TEST_ALLOWLIST:phone,WHATSAPP_ACCESS_TOKEN:'fixture-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',
 WHATSAPP_GRAPH_API_VERSION:'v24.0',WHATSAPP_WABA_ID:waba,WHATSAPP_APP_SECRET:'fixture-signature',CLOUDFLARE_ACCOUNT_ID:'fixture',CLOUDFLARE_API_TOKEN:'fixture'};
const logger={log(){},info(){},warn(){},error(){}};
async function fixture(){
 const graph=[],f=await createOfflineSqlNetwork({externalFetch:async(url,options)=>{
  if(url.hostname==='graph.facebook.com'){
   graph.push(JSON.parse(options.body));return Response.json({messages:[{id:'wamid.fixture.'+graph.length}]});
  }
  assert.equal(url.hostname,'api.cloudflare.com');
  const body=JSON.parse(options.body),tool=body.messages.findLast(item=>item.role==='tool');
  if(!tool)return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'fixture-confirm',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}}]}}]});
  return Response.json({choices:[{finish_reason:'stop',message:{content:'There is no pending action to confirm. No payment was recorded.'}}]});
 }});
 try{
 const actors=[randomUUID(),randomUUID()],workspaces=[];
 await f.db.query('insert into auth.users(id) values($1),($2)',actors);
 for(const actor of actors){
  await f.db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${actor}';set role authenticated`);
  const workspace=(await f.db.query("select (create_workspace('Cancel fixture',$1)).id",[randomUUID()])).rows[0].id;
  workspaces.push(workspace);
  const verification=(await f.db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspace,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  assert.equal((await f.db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  if(workspaces.length===1){await f.db.query("update workspace_settings set whatsapp_owner_phone=null where workspace_id=$1",[workspace]);await f.db.query("update whatsapp_consents set revoked_at=now()-interval '1 day',revoked_via='manual' where workspace_id=$1 and phone=$2",[workspace,phone]);}
 }
 const [oldWorkspace,workspaceId]=workspaces,ownerId=actors[1];
 const client=(await f.db.query("insert into customers(workspace_id,name) values($1,'QA fixture') returning id",[workspaceId])).rows[0].id;
 const invoiceId=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'INV-SYNTHETIC-281',current_date,current_date+30,'USD',100,'draft','{\"invoice_direction\":\"receivable\",\"followup_state\":\"paused\"}') returning id",[workspaceId,client])).rows[0].id;
 await f.db.query("insert into invoice_files(workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes) values($1,$2,$3,'fixture.jpg','image/jpeg',123)",[workspaceId,invoiceId,workspaceId+'/fixture.jpg']);
 const handler=createOwnerMessageHandler({supabase:f.supabase,env,fetchImpl:f.fetchImpl,logger});
 // The production outbound QA allowlist contains real contacts. Use a synthetic
 // transport sink here, retaining real SQL owner-reply authorization/readback.
 const conversation=createConversationStore(f.supabase),outbound={async sendTypingIndicator(){},async sendServiceReply(input){
  assert.equal(input.audience,'owner');assert.equal(input.workspaceId,workspaceId);assert.equal(input.to,phone);
  const key='reply:'+input.messageId;
  await conversation.record({workspaceId,phone,audience:'owner',direction:'outbound',kind:'normal',body:input.body,status:'pending',key});
  const claim=await f.supabase.rpc('whatsapp_claim_owner_reply',{p_provider_message_id:input.messageId,p_sender_phone:phone,p_workspace_id:workspaceId});
  assert.equal(claim.error,null);if(claim.data!==true)return {status:'blocked'};
  graph.push({type:'text',text:{body:input.body}});
  await conversation.finish({workspaceId,key,status:'accepted',providerMessageId:'wamid.synthetic.'+graph.length});
  return {status:'accepted'};
 }};
 const runtime=createInboundRuntime({supabase:f.supabase,env,fetchImpl:f.fetchImpl,onOwnerMessage:handler,outbound,logger});
 // Webhook's real synchronous path runs first. Worker is deliberately separate
 // so assertions at HTTP 200 cannot be satisfied by worker-only routing.
 const webhook=createWhatsAppWebhookHandler({env,runtime,logger});
 async function post(id,text,{type='text',context}={}){
  const message={id,from:phone.slice(1),type,timestamp:String(Math.floor(Date.now()/1000)),
   ...(type==='button'?{button:{text,payload:text},context:{id:context}}:{text:{body:text}})};
  const rawBody=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID},messages:[message]}}]}]}));
  const response={code:null,setHeader(){},status(code){this.code=code;return this},json(){return this}};
  await webhook({method:'POST',rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}},response);
  return response.code;
 }
 async function snapshot(){return (await f.db.query("select jsonb_build_object('consents',(select jsonb_agg(to_jsonb(c) order by workspace_id) from whatsapp_consents c),'global',(select jsonb_agg(to_jsonb(s)) from whatsapp_global_suppressions s),'scoped',(select jsonb_agg(to_jsonb(s) order by workspace_id) from whatsapp_suppressions s),'invoice',(select to_jsonb(i) from invoices i where id=$1),'files',(select jsonb_agg(to_jsonb(f)) from invoice_files f),'payments',(select count(*) from payments),'reversals',(select count(*) from payment_reversals)) value",[invoiceId])).rows[0].value;}
 return {...f,graph,runtime,post,snapshot,workspaceId,oldWorkspace,ownerId,invoiceId};
 }catch(error){await f.close();throw error;}
}

test('signed owner cancel cancels one native payment proposal before any recipient opt-out, including old revoked owner history',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot();assert.equal(await f.post('owner-proposal','Record a USD 40 partial payment on invoice INV-SYNTHETIC-281. Leave USD 60 outstanding.'),200);
  assert.equal((await f.runtime.processPending()).completed,1,JSON.stringify({errors:f.errors,events:(await f.db.query('select * from whatsapp_inbound_events')).rows,graph:f.graph}));
  const pending=(await f.db.query("select * from whatsapp_pending_actions where action->>'type'='owner_invoice_payment' and consumed_at is null")).rows;
  assert.equal(pending.length,1);assert.deepEqual(pending[0].action.changes,{amount:40,currency:'USD'});
  assert.deepEqual(await f.snapshot(),before);
  assert.equal(await f.post('owner-cancel','cancel'),200);
  assert.deepEqual(await f.snapshot(),before,'No consent/ledger writes before Meta 200');
  assert.equal((await f.db.query("select stop_processed_at from whatsapp_inbound_events where provider_message_id='owner-cancel'")).rows[0].stop_processed_at,null);
  assert.equal((await f.runtime.processPending()).completed,1);
  assert.deepEqual(await f.snapshot(),before,'Canceled payment cannot alter invoice/files or old manual revocation');
  const canceled=(await f.db.query('select consumed_at from whatsapp_pending_actions where id=$1',[pending[0].id])).rows[0];assert.ok(canceled.consumed_at);
  const receipt=(await f.db.query("select result,workspace_id from whatsapp_owner_action_receipts where provider_message_id='owner-cancel'")).rows[0];
  assert.equal(receipt.workspace_id,f.workspaceId);assert.deepEqual(receipt.result,{ok:true,actionType:'canceled'});
  const replies=f.graph.filter(x=>x.type==='text');assert.match(replies.at(-1).text.body,/cancel/i);assert.doesNotMatch(replies.at(-1).text.body,/opted out/i);
  const count=f.graph.length;assert.equal(await f.post('owner-cancel','cancel'),200);assert.equal((await f.runtime.processPending()).claimed,0);assert.equal(f.graph.length,count);
  assert.equal(await f.post('stale-yes','yes'),200);await f.runtime.processPending();assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.db.query("select count(*)::int n from whatsapp_owner_action_receipts where provider_message_id='owner-cancel'")).rows[0].n,1);
  await f.db.query("update customers set metadata=metadata-'whatsapp_owner' where workspace_id=$1 and phone=$2",[f.workspaceId,phone]);
  assert.equal(await f.post('owner-cancel','cancel'),503,'A resumed owner job cannot become recipient opt-out after unbinding');
  assert.deepEqual(await f.snapshot(),before);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const text of ['STOP','cancel'])test(`signed recipient ${text} keeps synchronous global/scoped suppression and replay dedup`,async()=>{
 const f=await fixture();try{
  // A historical verified proof alone must not exempt an unbound recipient.
  await f.db.query('update customers set metadata=metadata-\'whatsapp_owner\' where workspace_id=$1 and phone=$2',[f.workspaceId,phone]);
  assert.equal(await f.post('recipient-optout',text),200);
  const after=await f.snapshot();assert.equal(after.global.length,1);assert.equal(after.scoped.length,2);
  assert.ok(after.consents.every(c=>c.revoked_at));assert.equal(after.payments,0);
  const event=(await f.db.query("select * from whatsapp_inbound_events where provider_message_id='recipient-optout'")).rows[0];assert.ok(event.stop_processed_at);
  const beforeReplay=await f.snapshot();assert.equal(await f.post('recipient-optout',text),200);assert.deepEqual(await f.snapshot(),beforeReplay);assert.equal(f.graph.length,0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('signed owner lookup outage is retryable before suppression; retry still cancels native proposal',async()=>{
 const f=await fixture();try{
  assert.equal(await f.post('outage-propose','Record a USD 40 partial payment on invoice INV-SYNTHETIC-281. Leave USD 60 outstanding.'),200);await f.runtime.processPending();
  const before=await f.snapshot();let unavailable=true;
  f.intercept(url=>{if(unavailable&&url.pathname==='/rest/v1/rpc/whatsapp_resolve_verified_owner')throw Error('synthetic owner lookup outage');});
  assert.equal(await f.post('outage-cancel','cancel'),503);assert.deepEqual(await f.snapshot(),before);
  unavailable=false;assert.equal(await f.post('outage-cancel','cancel'),200);await f.runtime.processPending();assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.db.query("select result->>'actionType' result from whatsapp_owner_action_receipts where provider_message_id='outage-cancel'")).rows[0].result,'canceled');
 }finally{await f.close();}
});

test('signed reminder STOP button still suppresses even a currently bound owner phone',async()=>{
 const f=await fixture();try{
  assert.equal(await f.post('reminder-stop','STOP',{type:'button',context:'wamid.synthetic.reminder'}),200);
  const after=await f.snapshot();assert.equal(after.global.length,1);assert.ok(after.consents.every(c=>c.revoked_at));assert.equal(after.payments,0);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
