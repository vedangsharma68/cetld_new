import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboundRuntime,parseMetaMessages} from '../automation/whatsapp/cloud-inbound.mjs';

const phone='+15551234567';
const reply="I couldn’t read that. Send text, a photo, or a PDF. Nothing was changed.";
const event=(extra={})=>({id:1,attempts:1,claim_token:'claim',provider_message_id:'wamid.empty',
  sender_phone:phone,message_type:'unsupported',message_text:'',received_at:new Date().toISOString(),...extra});
function fixture(incoming,{audience='owner',rejectedSends=0}={}){
  // A prior instruction and active approval must never supply intent to an empty turn.
  const business={invoices:[{id:'fixture-invoice',total:100,amount_paid:40,reminders_paused:true}],
    payments:[{id:'fixture-payment',amount:40}],pending:[{action:'record_payment',amount:60}],
    history:[{direction:'inbound',body:'Record another USD60 payment on fixture-invoice'}],receipts:[]};
  const before=structuredClone(business),reads=[],rpcCalls=[],sent=[],transcript=[],handled=[],completed=[],deferred=[];
  const rows={workspace_settings:[{workspace_id:'ws',business_name:'Fixture business'}],
    whatsapp_global_suppressions:[],whatsapp_suppressions:[],
    whatsapp_consents:audience==='unbound'?[]:[{workspace_id:'ws',customer_id:'customer',phone,
      source:'inbound_message',categories:['invoice_updates'],revoked_at:null}],
    customers:[{workspace_id:'ws',id:'customer',phone}]};
  const supabase={async rpc(name,args){
    rpcCalls.push(name);
    if(name==='whatsapp_resolve_verified_owner')return {data:audience==='owner'
      ?[{workspace_id:'ws',owner_id:'owner',customer_id:'customer',business_name:'Fixture business'}]:[]};
    assert.equal(name,'whatsapp_pause_customer_followups');return {data:true};
  },from(table){
    reads.push(table);
    assert.ok(Object.hasOwn(rows,table),`business/history read forbidden: ${table}`);
    const filters=[];
    const result=()=>rows[table].filter(row=>filters.every(filter=>filter(row)));
    const q={select(){return q;},eq(key,value){filters.push(row=>row[key]===value);return q;},
      is(key,value){filters.push(row=>(row[key]??null)===value);return q;},
      maybeSingle:async()=>({data:result()[0]||null}),then(resolve,reject){return Promise.resolve({data:result()}).then(resolve,reject);}};
    return q;
  }};
  let queued=true;
  const handler=async input=>{handled.push(input);return '';};
  handler.createSafeFailureReply=async()=>{assert.fail('empty content must not use model failure recovery');};
  const runtime=createInboundRuntime({supabase,env:{},logger:{error(){},warn(){}},
    inbox:{async claim(){if(!queued)return [];queued=false;return [incoming];},
      async complete(_event,error){completed.push(error||null);},async defer(){deferred.push(true);},
      async beginOwnerJob(){},async getMedia(){return {bytes:Buffer.from('fixture'),mimeType:'image/png'};}},
    conversationStore:{async record(input){transcript.push(input);}},
    outbound:{async sendTypingIndicator(){},async sendServiceReply(input){sent.push(input);
      return {status:sent.length<=rejectedSends?'unknown':'accepted'};}},
    onOwnerMessage:handler,onBoundMessage:handler});
  return {runtime,business,before,reads,rpcCalls,sent,transcript,handled,completed,deferred};
}

test('unsupported Meta type stays empty; the fixture does not infer missing webhook contents',()=>{
  const payload={object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',
    value:{metadata:{phone_number_id:'number'},messages:[{id:'wamid.empty',from:phone.slice(1),
      timestamp:'1791936000',type:'unsupported'}]}}]}]};
  const [parsed]=parseMetaMessages(payload,'number','waba');
  assert.equal(parsed.message_type,'unsupported');assert.equal(parsed.message_text,'');
  assert.equal(parsed.media_ref,undefined);assert.equal(parsed.media_id,undefined);
});

for(const audience of ['owner','customer'])for(const extra of [
  {},{message_type:'text',message_text:' \n\t '},{message_type:'image'},
  {message_type:'unsupported',media_ref:'unusable-reference'},
])test(`${audience} empty ${extra.message_type||'unsupported'} turn cannot reuse history or mutate business records`,async()=>{
  const f=fixture(event(extra),{audience});
  assert.deepEqual(await f.runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(f.handled,[]);assert.deepEqual(f.business,f.before);
  assert.deepEqual(f.rpcCalls,['whatsapp_resolve_verified_owner']);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].body,reply);
  assert.equal(f.sent[0].audience,audience);assert.equal(f.sent[0].workspaceId,'ws');
  assert.equal(f.transcript[0].audience,audience);assert.deepEqual(f.completed,[null]);
});

test('unbound unsupported turn keeps authorization routing and sends no scoped reply',async()=>{
  const f=fixture(event(),{audience:'unbound'});
  assert.deepEqual(await f.runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(f.sent,[]);assert.deepEqual(f.handled,[]);assert.deepEqual(f.transcript,[]);
  assert.deepEqual(f.business,f.before);
});

for(const attempts of [1,5])test(`owner empty turn recovery at attempt ${attempts} remains deterministic without model/history`,async()=>{
  const f=fixture(event({attempts}),{rejectedSends:attempts===1?1:0});
  // Existing recovery bookkeeping reports completions only for final attempts.
  assert.deepEqual(await f.runtime.processPending(),{claimed:1,completed:attempts===1?0:1});
  assert.deepEqual(f.completed,['PROCESSING_FAILED']);
  assert.ok(f.sent.length>0);assert.ok(f.sent.every(input=>input.body===reply&&input.audience==='owner'));
  assert.deepEqual(f.handled,[]);assert.deepEqual(f.business,f.before);
  assert.deepEqual(f.deferred,[]);
});

for(const audience of ['owner','customer'])for(const extra of [
  {message_type:'text',message_text:'Show fixture-invoice'},
  {message_type:'image',media_ref:'wamid.empty'},
  {message_type:'document',media_ref:'wamid.empty'},
  {message_type:'image',media_ref:'wamid.empty',media_error:'Download failed'},
  {message_type:'interactive',interaction_id:'oab1.fixture',message_text:''},
])test(`${audience} supported ${extra.message_type} ${extra.media_error?'failure':'content'} retains existing routing`,async()=>{
  const f=fixture(event(extra),{audience});
  assert.deepEqual(await f.runtime.processPending(),{claimed:1,completed:1});
  if(extra.media_error&&audience==='customer'){
    assert.deepEqual(f.handled,[]);assert.match(f.sent[0].body,/load that photo/);
  }else{
    assert.equal(f.handled.length,1);assert.equal(f.handled[0].message,extra.message_text||'');
    assert.equal(f.handled[0].ownerId,audience==='owner'?'owner':undefined);
    if(extra.media_ref&&!extra.media_error)assert.ok(f.handled[0].media);
    if(extra.media_error)assert.equal(f.handled[0].mediaError,'The attachment could not be loaded.');
    if(extra.interaction_id&&audience==='owner')assert.equal(f.handled[0].interactionId,extra.interaction_id);
  }
  assert.equal(f.rpcCalls.includes('whatsapp_pause_customer_followups'),audience==='customer');
});
