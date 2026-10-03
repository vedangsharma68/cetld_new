import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';

const phone='+919871367051';
function ownerDatabase(){
  const rows={whatsapp_owner_verifications:[{workspace_id:'ws-owner',requested_by:'owner-1',verified_at:'2026-10-01',phone}],
    workspaces:[{id:'ws-owner',owner_id:'owner-1'}],workspace_members:[{workspace_id:'ws-owner',user_id:'owner-1',role:'owner'}],
    workspace_settings:[{workspace_id:'ws-owner',business_name:'Test Business',whatsapp_owner_phone:phone}],
    whatsapp_consents:[{workspace_id:'ws-owner',customer_id:'owner-customer',phone,revoked_at:null,consented_by:'owner-1'}],
    customers:[{id:'owner-customer',workspace_id:'ws-owner',phone,metadata:{whatsapp_owner:true}}]};
  return {from(table){const predicates=[];
    const result=()=>({data:(rows[table]||[]).filter(r=>predicates.every(f=>f(r)))});
    const q={select(){return q;},eq(k,v){predicates.push(r=>r[k]===v);return q;},
      not(k,op,v){predicates.push(r=>op==='is'?(r[k]??null)!==v:r[k]!==v);return q;},
      is(k,v){predicates.push(r=>(r[k]??null)===v);return q;},order(){return q;},limit(){return q;},
      maybeSingle:async()=>({data:result().data[0]||null}),then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}};return q;
  }};
}
for(const [description,replayId,status,expectedSends] of [
  ['an accepted reply to the same wamid closes the recovered event','wamid.current','accepted',0],
  ['a pending reply to the same wamid still gets its first delivery','wamid.current','pending',1],
  ['identical text under a new wamid receives the saved reply','wamid.previous','accepted',1],
])test(description,async()=>{
  const event={id:1,attempts:1,provider_message_id:'wamid.current',sender_phone:phone,message_text:'Which model?',message_type:'text',received_at:new Date().toISOString()};
  let sends=0,completed=0,deferred=0;
  const runtime=createInboundRuntime({supabase:ownerDatabase(),conversationStore:null,
    inbox:{claim:async()=>[event],complete:async()=>{completed++;},defer:async()=>{deferred++;}},
    outbound:{sendTypingIndicator:async()=>{},sendServiceReply:async({body})=>{assert.equal(body,'Saved model answer.');sends++;return {status:'accepted'};}},
    onOwnerMessage:async()=>({answer:'Saved model answer.',replayed:true,replayMessageId:replayId,replayDeliveryStatus:status}),logger:{error(){}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.equal(sends,expectedSends);assert.equal(completed,1);assert.equal(deferred,0);
});

for (const prior of [{error_code:'OWNER_REPLY_NOT_ACCEPTED'}, {reply_claimed_at:'2026-10-02T12:00:00Z'}, {attempts:2}])
test('stale previously attempted inbound event is dead-lettered without another model call: '+JSON.stringify(prior),async()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const event={id:2,attempts:1,provider_message_id:'wamid.stale',sender_phone:phone,message_text:'Which model?',
    message_type:'text',received_at:new Date(now-3_600_001).toISOString(),...prior};
  let state='pending',modelCalls=0,sends=0;const logs=[];
  const runtime=createInboundRuntime({supabase:ownerDatabase(),conversationStore:null,clock:()=>now,
    inbox:{claim:async()=>state==='pending'?[event]:[],deadLetter:async()=>{state='failed';},
      defer:async()=>{throw Error('stale events must never defer');},complete:async()=>{throw Error('must dead-letter');}},
    onOwnerMessage:async()=>{modelCalls++;return {answer:'Should not run'};},
    outbound:{sendServiceReply:async()=>{sends++;return {status:'accepted'};}},logger:{warn(label,fields){logs.push({label,fields});},error(){}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(await runtime.processPending(),{claimed:0,completed:0});
  assert.equal(state,'failed');assert.equal(modelCalls,0);assert.equal(sends,0);
  assert.equal(logs.length,1);assert.equal(logs[0].fields.code,'INBOUND_DEAD_LETTER');
});

test('first stale delivery failure is dead-lettered without recovery model calls or further retries',async()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const event={id:3,attempts:1,provider_message_id:'wamid.stale-first',sender_phone:phone,message_text:'Which model?',
    message_type:'text',received_at:new Date(now-3_600_001).toISOString()};
  let state='pending',modelCalls=0,sends=0,recoveryCalls=0;
  const handler=async()=>{modelCalls++;return {answer:'The saved model is Llama.'};};
  handler.createSafeFailureReply=async()=>{recoveryCalls++;return 'Recovery';};
  const runtime=createInboundRuntime({supabase:ownerDatabase(),conversationStore:null,clock:()=>now,
    inbox:{claim:async()=>state==='pending'?[event]:[],deadLetter:async()=>{state='failed';},
      defer:async()=>{throw Error('must not retry');},complete:async()=>{throw Error('must dead-letter');}},
    onOwnerMessage:handler,outbound:{sendTypingIndicator:async()=>{},sendServiceReply:async()=>{sends++;return {status:'failed'};}},
    logger:{warn(){},error(){}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.deepEqual(await runtime.processPending(),{claimed:0,completed:0});
  assert.equal(modelCalls,1);assert.equal(sends,1);assert.equal(recoveryCalls,0);
});
