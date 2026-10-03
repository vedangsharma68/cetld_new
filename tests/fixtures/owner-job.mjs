import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {createInboundRuntime} from '../../automation/whatsapp/cloud-inbound.mjs';
import {createOwnerMessageHandler} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE,DEFAULT_NOW} from './owner-chat-battery.mjs';

// Virtual upstream latency keeps this production-loop check free and fast.
// Work finishing within a minute sends only typing and the actual answer.
export async function simulateHeavyOwnerJob({durationMs=45_000,advanceTime=()=>{}}={}){
  const db=createOwnerChatDatabase();let now=Date.now(),started=now,calls=0,completed=0;
  const rpc=db.supabase.rpc;
  db.supabase.rpc=async(name,args)=>name==='whatsapp_resolve_verified_owner'
    ?{data:args.p_phone===OWNER_CHAT_SCOPE.phone?[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,owner_id:OWNER_CHAT_SCOPE.ownerId,
      customer_id:OWNER_CHAT_SCOPE.customerId,business_name:'Northstar Studio'}]:[]}:rpc(name,args);
  const event={id:901,claim_token:'test-lease',attempts:1,provider_message_id:'wamid.heavy-owner',
    sender_phone:OWNER_CHAT_SCOPE.phone,message_text:"tell me about johns invoices",message_type:'text',received_at:new Date(now).toISOString()};
  const sent=[];const checkpoints=[];let claimed=false,typing=0;
  const handler=createOwnerMessageHandler({supabase:db.supabase,authorize:async()=>true,clock:()=>DEFAULT_NOW,
    logger:{info(){},warn(){},error(){}},providerFactory:()=>({async generate(request){
      calls++;
      if(!request.messages.some(turn=>turn.role==='tool')){
        now+=durationMs;advanceTime(durationMs,()=>sent);
        return {content:'',toolCalls:[{id:'heavy-read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({
          operation:'read',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'John Smith'}],limit:8})}}]};
      }
      return {content:'John Smith has invoice INV-001 for USD 450, status sent.'};
    }})});
  const runtime=createInboundRuntime({supabase:db.supabase,conversationStore:null,clock:()=>now,onOwnerMessage:handler,
    inbox:{async claim(){if(claimed)return [];claimed=true;return [event];},async checkpoint(_event,workspaceId,ownerId,value){
      assert.equal(workspaceId,OWNER_CHAT_SCOPE.workspaceId);assert.equal(ownerId,OWNER_CHAT_SCOPE.ownerId);checkpoints.push(structuredClone(value));
    },async yieldJob(){throw Error('45 second job fits the background slice');},async complete(){completed++;}},
    outbound:{async sendTypingIndicator(){typing++;},async sendServiceReply(input){sent.push({phase:input.phase||'answer',body:input.body,elapsedMs:now-started});return {status:'accepted'};}},
    logger:{info(){},warn(){},error(_event,fields){throw Error(JSON.stringify(fields));}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.ok(typing>=1);
  if(durationMs>=60_000)assert.ok(typing>=2,'typing refreshes while long work runs');
  const answers=sent.filter(item=>item.phase==='answer'),progress=sent.filter(item=>item.phase==='ack');
  assert.equal(answers.length,1);assert.equal(progress.length,durationMs>=60_000?1:0);
  if(progress.length)assert.ok(progress[0].elapsedMs>=60_000);
  assert.equal(answers[0].elapsedMs,durationMs);assert.match(answers[0].body,/John Smith.*INV-001/);
  assert.doesNotMatch(sent.map(item=>item.body).join(' '),/timeout|took too long/i);
  assert.equal(completed,1);assert.equal(calls,2);assert.ok(checkpoints.length>=3);
  db.assertScopedReads();
  return {progressMessages:progress.length,virtualCompletionMs:answers[0].elapsedMs,checkpoints:checkpoints.length};
}

export async function simulateLongOwnerJob(){
  mock.timers.enable({apis:['setTimeout','setInterval']});
  try{return await simulateHeavyOwnerJob({durationMs:65_000,advanceTime:(ms,messages)=>{
    mock.timers.tick(59_999);
    assert.equal(messages().filter(item=>item.phase==='ack').length,0,'no progress message before one minute');
    mock.timers.tick(ms-59_999);
  }});}
  finally{mock.timers.reset();}
}
