import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseOwnerChat} from '../automation/whatsapp/owner-diagnostics.mjs';
import {createWhatsAppWebhookHandler} from '../automation/whatsapp/webhook.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE} from './fixtures/owner-chat-battery.mjs';

const quiet={info(){},warn(){},error(){}};
function database(){const db=createOwnerChatDatabase();const rpc=db.supabase.rpc;
  db.supabase.rpc=async(name,args)=>name==='whatsapp_resolve_verified_owner'?{data:args.p_phone===OWNER_CHAT_SCOPE.phone
    ?[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,owner_id:OWNER_CHAT_SCOPE.ownerId,customer_id:OWNER_CHAT_SCOPE.customerId,business_name:'Northstar Studio'}]:[]}:rpc(name,args);
  return db;
}
test('live diagnostic runs the owner data loop read-only and returns timings without invoice facts',async()=>{
  const db=database();
  const result=await diagnoseOwnerChat({supabase:db.supabase,env:{WHATSAPP_TEST_ALLOWLIST:OWNER_CHAT_SCOPE.phone},logger:quiet,
    providerFactory:()=>({async generate(request){
      if(!request.messages.some(turn=>turn.role==='tool'))return {toolCalls:[{id:'read',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:'John Smith'}]})}}]};
      return {content:'John Smith has invoice INV-001 for USD 450.'};
    }})});
  assert.equal(result.ok,true);assert.ok(result.invoiceRows>0);assert.ok(result.groundedInvoiceNumbers>0);
  assert.ok(result.modelDurationsMs.length===2);assert.equal(result.authorization.queryCount,0);
  assert.ok(result.contextReads.every(read=>read.queryCount===1));
  assert.doesNotMatch(JSON.stringify(result),/John Smith|INV-001|450|phone|ownerId|workspaceId/);
  db.assertScopedReads();
});
test('live diagnostic refuses model writes and natural-language planner requests before any mutation',async()=>{
  const db=database();let calls=0;
  const before=structuredClone(db.tables);
  const result=await diagnoseOwnerChat({supabase:db.supabase,env:{WHATSAPP_TEST_ALLOWLIST:OWNER_CHAT_SCOPE.phone},logger:quiet,
    providerFactory:()=>({async generate(request){calls++;
      if(calls===1)return {toolCalls:[{id:'write',type:'function',function:{name:'workspaceData',arguments:'{"operation":"delete","table":"invoices"}'}}]};
      if(calls===2)return {toolCalls:[{id:'planner',type:'function',function:{name:'workspaceData',arguments:'{"request":"change every invoice"}'}}]};
      return {content:'No changes were made.'};
    }})});
  assert.equal(result.ok,true);assert.deepEqual(db.tables,before);
  assert.ok(!db.rpcCalls.some(call=>/propose|confirm|delete/.test(call.name)&&!call.name.includes('pending_delete')));
});
test('diagnostic requests need cron authentication and cannot substitute arbitrary scenario text',async()=>{
  let calls=0;const handler=createWhatsAppWebhookHandler({env:{CRON_SECRET:'test-secret'},runtime:{async diagnoseOwnerChat(){calls++;return {ok:true};}}});
  const response=()=>({setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
  const denied=response();await handler({method:'GET',headers:{},url:'/api/whatsapp?process=1&diagnostic=meta'},denied);
  assert.equal(denied.statusCode,401);assert.equal(calls,0);
  const invalid=response();await handler({method:'GET',headers:{authorization:'Bearer test-secret'},url:'/api/whatsapp?process=1&diagnostic=delete-all'},invalid);
  assert.equal(invalid.statusCode,400);assert.equal(calls,0);
  const allowed=response();await handler({method:'GET',headers:{authorization:'Bearer test-secret'},url:'/api/whatsapp?process=1&diagnostic=meta'},allowed);
  assert.equal(allowed.statusCode,200);assert.equal(calls,1);
});
