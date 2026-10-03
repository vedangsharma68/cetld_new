import assert from 'node:assert/strict';
import {createInboundRuntime} from '../../automation/whatsapp/cloud-inbound.mjs';
import {createOwnerMessageHandler} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE,DEFAULT_NOW} from './owner-chat-battery.mjs';

// Virtual upstream latency keeps this production-loop check free and fast.
// The worker's clock moves 45 seconds while the owner receives the ack at 0.
export async function simulateHeavyOwnerJob(){
  const db=createOwnerChatDatabase();let now=Date.now(),started=now,calls=0,completed=0;
  const rpc=db.supabase.rpc;
  db.supabase.rpc=async(name,args)=>name==='whatsapp_resolve_verified_owner'
    ?{data:args.p_phone===OWNER_CHAT_SCOPE.phone?[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,owner_id:OWNER_CHAT_SCOPE.ownerId,
      customer_id:OWNER_CHAT_SCOPE.customerId,business_name:'Northstar Studio'}]:[]}:rpc(name,args);
  const event={id:901,claim_token:'test-lease',attempts:1,provider_message_id:'wamid.heavy-owner',
    sender_phone:OWNER_CHAT_SCOPE.phone,message_text:"tell me about johns invoices",message_type:'text',received_at:new Date(now).toISOString()};
  const sent=[];const checkpoints=[];let claimed=false;
  const handler=createOwnerMessageHandler({supabase:db.supabase,authorize:async()=>true,clock:()=>DEFAULT_NOW,
    logger:{info(){},warn(){},error(){}},providerFactory:()=>({async generate(request){
      calls++;
      if(!request.messages.some(turn=>turn.role==='tool')){
        now+=45_000;
        return {content:'',toolCalls:[{id:'heavy-read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({
          operation:'read',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'John Smith'}],limit:8})}}]};
      }
      return {content:'John Smith has invoice INV-001 for USD 450, status sent.'};
    }})});
  const runtime=createInboundRuntime({supabase:db.supabase,conversationStore:null,clock:()=>now,onOwnerMessage:handler,
    inbox:{async claim(){if(claimed)return [];claimed=true;return [event];},async checkpoint(_event,workspaceId,ownerId,value){
      assert.equal(workspaceId,OWNER_CHAT_SCOPE.workspaceId);assert.equal(ownerId,OWNER_CHAT_SCOPE.ownerId);checkpoints.push(structuredClone(value));
    },async yieldJob(){throw Error('45 second job fits the background slice');},async complete(){completed++;}},
    outbound:{async sendTypingIndicator(){},async sendServiceReply(input){sent.push({phase:input.phase||'answer',body:input.body,elapsedMs:now-started});return {status:'accepted'};}},
    logger:{info(){},warn(){},error(_event,fields){throw Error(JSON.stringify(fields));}}});
  assert.deepEqual(await runtime.processPending(),{claimed:1,completed:1});
  assert.equal(sent.length,2);assert.equal(sent[0].phase,'ack');assert.equal(sent[0].elapsedMs,0);
  assert.equal(sent[1].phase,'answer');assert.equal(sent[1].elapsedMs,45_000);assert.match(sent[1].body,/John Smith.*INV-001/);
  assert.doesNotMatch(sent.map(item=>item.body).join(' '),/timeout|took too long/i);
  assert.equal(completed,1);assert.equal(calls,2);assert.ok(checkpoints.length>=3);
  db.assertScopedReads();
  return {ackElapsedMs:sent[0].elapsedMs,virtualCompletionMs:sent[1].elapsedMs,checkpoints:checkpoints.length};
}
