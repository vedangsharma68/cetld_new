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
