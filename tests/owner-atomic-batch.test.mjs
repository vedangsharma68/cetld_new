import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_PRIMARY_MODEL} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {createDirectOwnerWriteAdapter} from '../automation/whatsapp/direct-owner-write.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
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

test('lost batch response recovers from persisted aggregate receipt without executing another write',async()=>{
  const db=createOwnerChatDatabase(),rows=db.tables.invoices.filter(row=>row.workspace_id===scope.workspaceId).slice(0,2);let calls=0;
  db.tables.whatsapp_direct_write_receipts=[];
  db.supabase.rpc=async()=>{
    calls++;
    const results=rows.map(row=>{row.notes='Persisted before connection interruption';return {ok:true,completed:true,action:'invoice.updated',entityType:'invoice',entityId:row.id,updatedAt:row.updated_at};});
    db.tables.whatsapp_direct_write_receipts.push({workspace_id:scope.workspaceId,owner_id:scope.ownerId,phone:scope.phone,provider_message_id:'interrupted-batch',result:{ok:true,completed:true,action:'batch.completed',entityType:'batch',entityId:scope.workspaceId,results}});
    throw Error('isolated post-commit connection interruption');
  };
  const adapter=createDirectOwnerWriteAdapter({supabase:db.supabase});
  const binding={workspaceId:scope.workspaceId,ownerId:scope.ownerId,phone:scope.phone,providerMessageId:'interrupted-batch'};
  const result=await adapter.applyBatch({...binding,authorization:{kind:'instruction',quote:'Update both notes'},operations:rows.map(row=>({operation:'invoice.update',targetId:row.id,expectedUpdatedAt:row.updated_at,payload:{notes:'Persisted before connection interruption'}}))});
  assert.equal(result.code,'WRITE_UNCONFIRMED');
  const recovered=await adapter.lookupCompleted(binding);assert.equal(recovered.completed,true);assert.equal(recovered.results.length,2);assert.equal(calls,1);db.assertScopedReads();
  rows[1].updated_at='2026-10-09T00:00:00Z';assert.equal((await adapter.lookupCompleted(binding)).code,'WRITE_UNCONFIRMED');
});

test('batch relative dates use the owner calendar and security identity/nested batches fail before dispatch',async()=>{
  const db=createOwnerChatDatabase();let captured=null;
  const tool=createWorkspaceDataTool({supabase:db.supabase,scope,authorize:async()=>true,confirmationMode:'direct',timezone:'Asia/Kolkata',clock:()=>new Date('2026-10-04T22:00:00Z'),
    async executeBatchOperation(params){captured=params;return {ok:false,code:'STALE',rolledBack:true};}});
  const child={operation:'update',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-001'}],values:{due_date:'tomorrow'}};
  await tool.execute({operations:[child,{...child,filters:[{column:'invoice_number',operator:'eq',value:'INV-003'}]}]});
  assert.equal(captured.operations[0].values.due_date,'2026-10-06');
  captured=null;assert.equal((await tool.execute({operations:[{...child,values:{owner_id:scope.ownerId}},child]})).ok,false);assert.equal(captured,null);
  assert.equal((await tool.execute({operations:[{operations:[child,child]},child]})).ok,false);assert.equal(captured,null);
});



