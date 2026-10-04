import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {createOwnerChatDatabase,OWNER_CHAT_SCOPE as scope,DEFAULT_NOW,JOHN_INVOICE_ID} from './fixtures/owner-chat-battery.mjs';
const logger={info(){},warn(){},error(){}};

test('real provider coalesces two writes after a scoped read, verifies persisted children and recovers one aggregate receipt',async()=>{
  const db=createOwnerChatDatabase();db.tables.whatsapp_direct_write_receipts=[];
  const invoices=db.tables.invoices.filter(row=>row.workspace_id===scope.workspaceId).slice(0,2);
  assert.equal(invoices.length,2);const original=invoices.map(row=>row.invoice_number);
  let rpcCalls=0,generations=0,evidence=[];
  const originalRpc=db.supabase.rpc;
  db.supabase.rpc=async(name,args)=>{
    if(name!=='whatsapp_apply_owner_batch')return originalRpc(name,args);
    rpcCalls++;assert.equal(args.p_workspace_id,scope.workspaceId);assert.equal(args.p_owner_id,scope.ownerId);assert.equal(args.p_operations.length,2);
    const results=args.p_operations.map(operation=>{
      const row=db.tables.invoices.find(row=>row.workspace_id===scope.workspaceId&&row.id===operation.targetId);
      assert(row);assert.equal(row.updated_at,operation.expectedUpdatedAt);
      Object.assign(row,operation.payload,{updated_at:'2026-10-03T09:00:00.000Z'});
      return {ok:true,completed:true,action:'invoice.updated',entityType:'invoice',entityId:row.id,updatedAt:row.updated_at,record:structuredClone(row)};
    });
    const result={ok:true,completed:true,action:'batch.completed',entityType:'batch',entityId:scope.workspaceId,results};
    db.tables.whatsapp_direct_write_receipts.push({workspace_id:scope.workspaceId,owner_id:scope.ownerId,phone:scope.phone,provider_message_id:args.p_provider_message_id,result});
    return {data:result,error:null};
  };
  const tools=createOwnerWorkspaceTools({supabase:db.supabase,scope,ownerStore:{async query(){throw Error('Legacy read must not run');}},message:'Renumber both invoices like John',messageId:'isolated-batch',authorize:async()=>true,
    clock:()=>DEFAULT_NOW,botPreferences:{confirmationMode:'direct'},pendingStoreAvailable:false});
  const provider=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'isolated',cfApiToken:'isolated',maxAttempts:1,logger,
    fetchImpl:async(_url,init)=>{
      generations++;const wire=JSON.parse(init.body);evidence=wire.messages.filter(row=>row.role==='tool').map(row=>JSON.parse(row.content));let message;
      if(generations===1)message={content:'',tool_calls:[{id:'fresh',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices'})}}]};
      else if(generations===2){
        assert(wire.messages.some(row=>row.role==='tool'&&JSON.parse(row.content).rows?.length));
        message={content:'',tool_calls:invoices.map((row,index)=>({id:'rename-'+index,type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:original[index]}],values:{invoice_number:`INV-2026-000${index+3}`}})}}))};
      }else message={content:'Updated both invoices to INV-2026-0003 and INV-2026-0004.'};
      return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({choices:[{message,finish_reason:'stop'}]})};
    }});
  const result=await runOwnerAgent({provider,message:'Renumber both invoices like John',tools});
  assert.equal(result.plannerFailure,undefined,JSON.stringify({result,evidence,rpcCalls}));assert.match(result.answer,/Updated both/);assert.equal(rpcCalls,1);
  assert.deepEqual(invoices.map(row=>row.invoice_number),['INV-2026-0003','INV-2026-0004']);
  const replay=await tools.lookupCompleted();assert.equal(replay.completed,true);assert.equal(replay.results.length,2);assert.equal(rpcCalls,1);
  db.assertScopedReads();
});

test('ambiguous and unresolved batch targets fail before any write is marked or dispatched',async()=>{
  for(const query of ['missing invoice','John']){
    const db=createOwnerChatDatabase();db.tables.whatsapp_direct_write_receipts=[];let dispatches=0;
    if(query==='John')db.tables.invoices.push({...db.tables.invoices.find(row=>row.id===JOHN_INVOICE_ID),id:'ffffffff-ffff-4fff-8fff-fffffffffff9',invoice_number:'INV-AMBIGUOUS'});
    const tools=createOwnerWorkspaceTools({supabase:db.supabase,scope,ownerStore:{async query(){throw Error('Legacy read must not run');}},message:'Edit both',messageId:'batch-preflight',authorize:async()=>true,
      botPreferences:{confirmationMode:'direct'},directWriteAdapter:{async applyBatch(){dispatches++;throw Error('No dispatch allowed');}}});
    const result=await tools.execute('workspaceData',{operations:[{operation:'update',table:'invoices',filters:[{column:'customer_name',operator:'eq',value:query}],values:{notes:'test'}},
      {operation:'create',table:'business_records',values:{record_type:'qa_check',name:'Do not create'}}]});
    assert.equal(result.ok,false);assert.equal(dispatches,0);assert.equal(tools.getWriteAttempted(),false);db.assertScopedReads();
  }
});

test('completion and background claims require corresponding durable evidence',()=>{
  assert.equal(ownerGroundingIssue('I am still working on it and will message you.',[]),'unverified_background_job');
  assert.equal(ownerGroundingIssue('Updated both invoices.',[{ok:false,rolledBack:true}]),'unverified_action_result');
});



