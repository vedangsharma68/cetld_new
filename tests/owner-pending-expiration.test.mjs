import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW} from './fixtures/owner-chat-battery.mjs';
const logger={info(){},warn(){},error(){}};

test('verified turn expires stale pending metadata, reloads both snapshots and replays its reply without another model call',async()=>{
  const db=createOwnerChatDatabase(),before=structuredClone({invoices:db.tables.invoices,payments:db.tables.payments});
  const old={id:15,version:1,generation:1,workspace_id:scope.workspaceId,customer_id:scope.customerId,phone:scope.phone,created_at:'2026-10-02T07:00:00Z',consumed_at:null,
    action:{type:'owner_invoice_reopen',invoiceNumber:'INV-001',expiresAt:'2026-10-02T08:00:00Z',sourceMessageId:'earlier-preview'}};
  db.tables.whatsapp_pending_actions.push(old);
  let expirations=0,calls=0;const originalRpc=db.supabase.rpc;
  db.supabase.rpc=async(name,args)=>{
    if(name!=='whatsapp_expire_owner_pending')return originalRpc(name,args);
    expirations++;assert.equal(args.p_workspace_id,scope.workspaceId);assert.equal(args.p_owner_id,scope.ownerId);assert.equal(args.p_phone,scope.phone);
    assert.equal(args.p_message_id,'new-turn');assert.equal(args.p_user_message,'Review my pending action');
    old.consumed_at=DEFAULT_NOW.toISOString();return {data:{ok:true,expired:true,businessChangeApplied:false}};
  };
  const handler=createOwnerMessageHandler({supabase:db.supabase,authorize:async()=>true,env:{WHATSAPP_APP_SECRET:'isolated-expiration'},clock:()=>DEFAULT_NOW,logger,
    providerFactory:()=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
      fetchImpl:async(_url,init)=>{
        calls++;const wire=JSON.parse(init.body);
        const message=calls===1?{content:'',tool_calls:[{id:'pending',type:'function',function:{name:'workspaceData',arguments:'{"operation":"pending"}'}}]}:
          {content:'There is no pending change now.'};
        if(calls===2)assert(wire.messages.some(row=>row.role==='tool'&&JSON.parse(row.content).pending===false));
        return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message,finish_reason:'stop'}]})};
      }})});
  const input={...scope,messageId:'new-turn',message:'Review my pending action'};
  const result=await handler(input);assert.equal(result.plannerFailure,undefined,JSON.stringify(result));assert.equal(result.answer,'There is no pending change now.');
  assert.equal(expirations,1);assert.equal(calls,2);assert.equal(result.buttons?.length||0,0);
  assert.equal((await handler(input)).replayed,true);assert.equal(expirations,1);assert.equal(calls,2);
  assert.deepEqual({invoices:db.tables.invoices,payments:db.tables.payments},before);db.assertScopedReads();
});

test('an expired reopening read never advertises confirmation or active buttons',async()=>{
  const db=createOwnerChatDatabase();
  const tool=createWorkspaceDataTool({supabase:db.supabase,scope,authorize:async()=>true,clock:()=>DEFAULT_NOW,
    pendingAtStart:{id:15,version:1,action:{type:'owner_invoice_reopen',invoiceNumber:'INV-001',expiresAt:'2026-10-02T08:00:00Z'}}});
  const result=await tool.execute({operation:'pending'});assert.equal(result.pending,false);assert.equal(result.expired,true);assert.equal(result.requiresConfirmation,false);
  assert.equal(tool.getReplyRequirement(),null);assert.equal(db.rpcCalls.length,0);
});

test('pending rejection supports truthful existing-action guidance but cannot invent a newly prepared proposal',async()=>{
  const failure={ok:false,code:'PENDING',businessChangeApplied:false};
  assert.equal(ownerGroundingIssue('Please review the pending action.',[failure]),null);
  assert.equal(ownerGroundingIssue('I prepared a proposal. Please confirm the pending action.',[failure]),'unverified_proposal');
  assert.equal(ownerGroundingIssue('Please review the pending action.',[{ok:false,code:'INVALID'}]),'unverified_proposal');
  let calls=0;
  const response=await runOwnerAgent({message:'Mark invoice unpaid',tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
    async execute(){return failure;},getWriteAttempted:()=>true},provider:{async generate(){calls++;return calls===1?{toolCalls:[{id:'request',type:'function',function:{name:'workspaceData',arguments:'{"operation":"update","table":"invoices","values":{"status":"unpaid"}}'}}]}:{content:'I prepared a new proposal. Please confirm the pending action.'};}}});
  assert.match(response.answer,/requested business change was not applied/);assert.doesNotMatch(response.answer,/could not confirm whether/);
});
