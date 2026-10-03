import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {SupabaseInboundInbox,createInboundRuntime} from '../automation/whatsapp/cloud-inbound.mjs';
import {simulateHeavyOwnerJob,simulateLongOwnerJob} from './fixtures/owner-job.mjs';

const call={id:'write-once',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}};
const definitions=[{type:'function',function:{name:'workspaceData',description:'Workspace data',parameters:{type:'object'}}}];
test('a job over a minute sends one progress message and its completed answer',simulateLongOwnerJob);

test('a simulated 45 second owner job sends typing and its answer without progress-message clutter',simulateHeavyOwnerJob);

test('a suspended final answer resumes completed tool results without another write',async()=>{
  let persisted=null,writes=0;
  const tools={definitions,async execute(){writes++;return {ok:true,writeAttempted:true,completed:true};}};
  const first=await runOwnerAgent({message:'yes',allowDeferred:true,budgetMs:100,onCheckpoint:async value=>{persisted=structuredClone(value);},tools,
    provider:{async generate(request){if(request.tools)return {toolCalls:[call]};return new Promise(()=>{});}}});
  assert.equal(first.deferred,true);assert.equal(first.plannerFailure,undefined);assert.equal(persisted.phase,'final');
  const resumed=await runOwnerAgent({message:'yes',allowDeferred:true,checkpoint:persisted,tools,
    provider:{async generate(request){assert.equal(request.tools,undefined);assert.ok(request.messages.some(turn=>turn.role==='tool'));return {content:'Your change is complete.'};}}});
  assert.equal(resumed.answer,'Your change is complete.');assert.equal(writes,1);
});

test('an interrupted write is never executed again after a worker restart',async()=>{
  let persisted=null,writes=0;
  const tools={definitions,async execute(){writes++;return new Promise(()=>{});}};
  const first=await runOwnerAgent({message:'yes',allowDeferred:true,budgetMs:100,onCheckpoint:async value=>{persisted=structuredClone(value);},tools,
    provider:{async generate(){return {toolCalls:[call]};}}});
  assert.equal(first.deferred,true);assert.equal(persisted.uncertainWrite,call.id);
  const resumed=await runOwnerAgent({message:'yes',allowDeferred:true,checkpoint:persisted,tools,
    provider:{async generate(request){assert.equal(request.tools,undefined);assert.match(JSON.stringify(request.messages),/WRITE_STATUS_UNCERTAIN/);return {content:'The change was interrupted. I cannot verify that it completed.'};}}});
  assert.equal(writes,1);assert.match(resumed.answer,/cannot verify/);assert.equal(resumed.plannerFailure,undefined);
});

test('resumed final validation preserves saved undo instructions over fresh tool defaults',async()=>{
  let calls=0;
  const result=await runOwnerAgent({allowDeferred:true,message:'yes',
    checkpoint:{version:1,phase:'final',transcript:[{role:'user',content:'yes'}],toolCache:[],
      replyRequirement:{maxLength:3790,confirmationAlternatives:['UNDO DELETE INV-001'],requiredFacts:{invoiceNumber:'INV-001'}}},
    tools:{definitions,getReplyRequirement:()=>({maxLength:3790}),async execute(){throw Error('final stage cannot run tools');}},
    provider:{async generate(request){calls++;assert.match(JSON.stringify(request.messages),/UNDO DELETE INV-001/);
      return {content:calls===1?'Deleted INV-001.':'Deleted INV-001. To undo, send UNDO DELETE INV-001.'};}}});
  assert.equal(calls,2);assert.match(result.answer,/UNDO DELETE INV-001/);assert.equal(result.plannerFailure,undefined);
});

test('checkpoint persistence requires the current processing lease',async()=>{
  const filters=[];
  const query={update(){return query;},eq(column,value){filters.push([column,value]);return query;},async select(){return {data:[]};}};
  const inbox=new SupabaseInboundInbox({from(){return query;}});
  await assert.rejects(inbox.checkpoint({id:9,claim_token:'expired'},'ws','owner',{version:1}),{code:'OWNER_JOB_LEASE_LOST'});
  assert.deepEqual(filters,[['id',9],['claim_token','expired'],['status','processing']]);
});

for(const marker of ['checkpoint','ack','started'])test('a revoked '+marker+' owner STOP cannot become a debtor opt-out or leak its checkpoint',async()=>{
  const event={id:10,attempts:1,provider_message_id:'wamid.revoked',sender_phone:'+919871367051',message_text:'STOP',
    received_at:new Date().toISOString(),owner_job_checkpoint:{version:1,transcript:[{role:'tool',content:'Private old workspace facts'}]},
    owner_job_workspace_id:'old-workspace',owner_job_owner_id:'old-owner'};
  if(marker!=='checkpoint')event.owner_job_checkpoint=null;
  if(marker==='ack')event.owner_ack_claimed_at=new Date().toISOString();
  let completed=false,claims=0;const sent=[];
  const runtime=createInboundRuntime({supabase:{async rpc(name){assert.equal(name,'whatsapp_resolve_verified_owner');return {data:[]};},
    from(){throw Error('revoked job cannot query a customer or its consent');}},conversationStore:null,
    inbox:{async claim(){return claims++?[]:[event];},async complete(){completed=true;}},
    onBoundMessage(){throw Error('revoked owner cannot enter debtor handler');},onOwnerMessage(){throw Error('revoked owner cannot enter model');},
    outbound:{async sendServiceReply(input){sent.push(input);return {status:'accepted'};}},logger:{error(){}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:0});assert.equal(completed,true);
  assert.equal(sent.length,1);assert.equal(sent[0].kind,'verification');assert.doesNotMatch(sent[0].body,/Private old/);
});
