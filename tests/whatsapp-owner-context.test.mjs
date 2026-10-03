import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOwnerBinding} from '../automation/whatsapp/owner-binding.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {CF_QWEN_MODEL} from '../ai/provider.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE,DEFAULT_NOW} from './fixtures/owner-chat-battery.mjs';

const phone='+919871367051';
const binding={workspace_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  customer_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',business_name:'Northstar'};

test('owner binding is resolved by one joined server RPC',async()=>{
  const calls=[];
  const supabase={async rpc(name,args){calls.push({name,args});return {data:[binding]};}};

  assert.deepEqual(await resolveOwnerBinding({supabase,phone}),{
    workspaceId:binding.workspace_id,ownerId:binding.owner_id,businessName:'Northstar',audience:'owner',customerId:binding.customer_id,
  });
  assert.deepEqual(calls,[{name:'whatsapp_resolve_verified_owner',args:{p_phone:phone}}]);
});

test('owner turn reuses one request-local authorization result across setup and agent work',async()=>{
  const workspaceId=binding.workspace_id;
  const reads=[];
  const supabase={from(table){
    reads.push(table);
    const query={select(){return query;},eq(){return query;},in(){return query;},order(){return query;},limit(){return query;},
      maybeSingle:async()=>({data:null}),then(resolve,reject){return Promise.resolve({data:[]}).then(resolve,reject);}};
    return query;
  },rpc:async()=>({data:{ok:false,code:'FEATURE_UNAVAILABLE'}})};
  let authorizationCalls=0;
  const handler=createOwnerMessageHandler({supabase,authorize:async()=>{authorizationCalls++;return true;},replyStore:null,
    pendingActionStoreFactory:()=>({loadPendingAction:async()=>null,loadPendingActionState:async()=>({generation:0,id:null,version:null})}),
    ownerStoreFactory:()=>({query:async()=>[]}),historyReader:async()=>[],logger:{error(){},info(){}},
    agentFactory:async()=>({answer:'Your workspace is ready.',model:CF_QWEN_MODEL}),
  });

  const result=await handler({workspaceId,ownerId:binding.owner_id,customerId:binding.customer_id,phone,message:'Hi',messageId:'turn-1'});
  assert.equal(result.answer,'Your workspace is ready.');
  assert.equal(authorizationCalls,1);
});

test('processing acknowledgements cannot crowd John out of the recent owner history',async()=>{
  const db=createOwnerChatDatabase();let sequence=0;
  for(const [index,message]of ['John Smith is my customer','What is his balance?','Thanks','What about John?'].entries()){
    const push=(body,direction,key)=>db.tables.whatsapp_messages.push({id:String(++sequence),workspace_id:OWNER_CHAT_SCOPE.workspaceId,
      audience:'owner',phone:OWNER_CHAT_SCOPE.phone,body,direction,status:direction==='inbound'?'received':'accepted',
      idempotency_key:key,created_at:new Date(DEFAULT_NOW.getTime()+sequence*1000).toISOString()});
    push(message,'inbound','inbound:turn-'+index);push("On it. I'll send the answer here when it's ready.",'outbound','ack:turn-'+index);
    if(index<3)push(index===0?'Got it. John Smith.':'I can help.','outbound','reply:turn-'+index);
  }
  const handler=createOwnerMessageHandler({supabase:db.supabase,authorize:async()=>true,replyStore:null,logger:{info(){},error(){}},
    agentFactory:async({history})=>{
      assert.ok(history.some(turn=>turn.content==='John Smith is my customer'));
      assert.ok(history.every(turn=>!turn.content.startsWith('On it.')));assert.ok(history.length<=8);
      return {answer:'John is still in context.'};
    }});
  assert.equal((await handler({...OWNER_CHAT_SCOPE,message:'What about John?',messageId:'turn-3'})).answer,'John is still in context.');
});
