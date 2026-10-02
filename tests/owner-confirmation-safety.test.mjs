import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerSafetyTools as createOwnerAgentTools} from '../automation/whatsapp/owner-agent.mjs';

const scope={
  workspaceId:'00000000-0000-4000-8000-000000000002',
  ownerId:'00000000-0000-4000-8000-000000000001',
  customerId:'00000000-0000-4000-8000-000000000003',
  phone:'+919871367051',
};

function actionFor(type){
  if(type==='owner_invoice_create')return {type,sourceMessageId:'wamid.request-create',idempotencyKey:'wa_owner_creation_atomic_0001',
    expiresAt:'2026-10-02T08:10:00.000Z',invoice:{invoiceNumber:'INV-ATOMIC-1',clientName:'Studio Client',total:125,
      currency:'USD',dueDate:'2026-10-20',direction:'receivable',alreadyPaid:false,lineItems:[]}};
  return {type:'owner_settings_update',sourceMessageId:'wamid.request-settings',expectedUpdatedAt:'v1',
    expiresAt:'2026-10-02T08:10:00.000Z',request:{businessName:'New Studio',patch:{tone:'firm'}}};
}

function createHarness(options={}){
  const {type='owner_invoice_create',messageId='wamid.confirm',message='yes',rpcResult,withRpc=true}=options;
  const pendingAtStart=Object.hasOwn(options,'pendingAtStart')?options.pendingAtStart
    :{id:17,version:4,generation:9,action:actionFor(type),consumed_at:null};
  const pendingStateAction=Object.hasOwn(options,'pendingStateAction')?options.pendingStateAction:pendingAtStart?.action||null;
  const calls={rpc:[],consume:[],settingsRead:0,settingsWrite:0,invoiceWrite:0};
  const pending={
    async consumePendingAction(input){calls.consume.push(input);return {id:input.id};},
    async loadPendingActionState(){return {generation:9,id:pendingAtStart?.id??null,version:pendingAtStart?.version??null,action:pendingStateAction};},
  };
  const settingsStore={
    async read(){calls.settingsRead++;return {business_name:'Old Studio',follow_up_preferences:{tone:'gentle'},updated_at:'v1'};},
    async write(){calls.settingsWrite++;throw new Error('JS settings write must not run');},
  };
  const invoiceStoreFactory=()=>({
    async findAssistantInvoice(){calls.invoiceWrite++;throw new Error('JS invoice lookup must not run');},
    async createAssistantInvoice(){calls.invoiceWrite++;throw new Error('JS invoice write must not run');},
  });
  const supabase=withRpc?{async rpc(name,args){calls.rpc.push({name,args});return rpcResult||{data:{ok:true,actionType:type},error:null};}}:{};
  const tools=createOwnerAgentTools({supabase,scope,ownerStore:{query:async()=>[]},pending,pendingAtStart,
    lifecyclePending:null,invoiceStoreFactory,settingsStore,config:{},message,messageId,
    authorize:async()=>true,pendingStoreAvailable:true,clock:()=>new Date('2026-10-02T08:00:00.000Z'),logger:{error(){}}});
  return {tools,calls,pendingAtStart};
}

test('create and settings confirmation send the exact pending version to one atomic RPC without JS writes',async()=>{
  for(const type of ['owner_invoice_create','owner_settings_update']){
    const success=type==='owner_invoice_create'
      ?{ok:true,actionType:type,invoiceNumber:'INV-2026-0008',customerName:'Studio Client',total:125,currency:'USD',dueDate:'2026-10-20'}
      :{ok:true,actionType:type,businessName:'New Studio',changed:['businessName','tone']};
    const {tools,calls}=createHarness({type,rpcResult:{data:success,error:null}});
    const result=await tools.execute('confirmPendingOwnerChange',{});
    assert.equal(result.ok,true);
    assert.equal(calls.rpc.length,1);
    assert.equal(calls.rpc[0].name,'whatsapp_confirm_owner_create_settings');
    assert.deepEqual(calls.rpc[0].args,{
      p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
      p_action_id:17,p_version:4,p_confirmation_message_id:'wamid.confirm',
    });
    assert.equal(calls.consume.length,0,'the SQL transaction consumes the proposal and writes its receipt');
    assert.equal(calls.settingsRead,0);
    assert.equal(calls.settingsWrite,0);
    assert.equal(calls.invoiceWrite,0);
    if(type==='owner_invoice_create'){
      assert.equal(result.action,'invoice_created');
      assert.equal(result.invoiceNumber,'INV-2026-0008');
      assert.equal(result.customerName,'Studio Client');
      assert.equal(result.total,125);
    }else{
      assert.equal(result.action,'settings_updated');
      assert.equal(result.businessName,'New Studio');
      assert.deepEqual(result.changed,['businessName','tone']);
    }
  }
});

test('a database receipt replay remains a successful confirmation',async()=>{
  const {tools,calls}=createHarness({rpcResult:{data:{ok:true,actionType:'owner_invoice_create',invoiceNumber:'INV-2026-0011',
    customerName:'Studio Client',total:125,currency:'USD',dueDate:'2026-10-20',replayed:true},error:null}});
  const result=await tools.execute('confirmPendingOwnerChange',{});
  assert.equal(result.ok,true);
  assert.equal(result.replayed,true);
  assert.equal(result.invoiceNumber,'INV-2026-0011');
  assert.equal(calls.rpc.length,1);
  assert.equal(calls.consume.length,0);
  assert.equal(calls.invoiceWrite,0);
});

test('canceled, stale, expired, and invalid current confirmations fail closed with no client-side fallback',async()=>{
  const cases=[
    ['no_action','NO_PENDING_ACTION'],
    ['stale','STALE'],
    ['expired','EXPIRED'],
    ['invalid_confirmation','INVALID'],
    ['unbound','DENIED'],
    ['invoice_exists','INVOICE_EXISTS'],
    ['ambiguous_customer','AMBIGUOUS'],
  ];
  for(const [reason,code] of cases){
    const {tools,calls}=createHarness({type:'owner_settings_update',rpcResult:{data:{ok:false,reason},error:null}});
    const result=await tools.execute('confirmPendingOwnerChange',{});
    assert.equal(result.ok,false,reason);
    assert.equal(result.code,code,reason);
    assert.equal(calls.rpc.length,1,reason);
    assert.equal(calls.consume.length,0,reason);
    assert.equal(calls.settingsRead,0,reason);
    assert.equal(calls.settingsWrite,0,reason);
    assert.equal(calls.invoiceWrite,0,reason);
  }
});

test('a consumed create receipt is exposed and confirmed from the current inbound retry exactly once',async()=>{
  const consumed={id:17,version:4,generation:9,action:actionFor('owner_invoice_create'),consumed_at:'2026-10-02T08:00:01.000Z'};
  const receipt={ok:true,actionType:'owner_invoice_create',invoiceNumber:'INV-2026-0018',customerName:'Studio Client',
    total:125,currency:'USD',dueDate:'2026-10-20',replayed:true};
  const {tools,calls}=createHarness({pendingAtStart:consumed,pendingStateAction:null,
    messageId:'wamid.retry-confirm',rpcResult:{data:receipt,error:null}});

  const pendingResult=await tools.execute('getPendingOwnerAction',{});
  assert.equal(pendingResult.pending,false);
  assert.equal(pendingResult.completed,true);
  assert.equal(pendingResult.action,'invoice_created');
  assert.equal(pendingResult.invoiceNumber,'INV-2026-0018');

  const confirmation=await tools.execute('confirmPendingOwnerChange',{});
  assert.equal(confirmation.ok,true);
  assert.equal(confirmation.replayed,true);
  assert.equal(confirmation.invoiceNumber,'INV-2026-0018');
  assert.equal(calls.rpc.length,1,'the read and confirm tool share one receipt lookup');
  assert.equal(calls.rpc[0].name,'whatsapp_confirm_owner_create_settings');
  assert.deepEqual(calls.rpc[0].args,{
    p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
    p_action_id:null,p_version:null,p_confirmation_message_id:'wamid.retry-confirm',
  });
  assert.equal(calls.consume.length,0);
  assert.equal(calls.settingsWrite,0);
  assert.equal(calls.invoiceWrite,0);
});

test('a consumed proposal with no matching current-turn receipt remains no action',async()=>{
  const consumed={id:17,version:4,generation:9,action:actionFor('owner_settings_update'),consumed_at:'2026-10-02T08:00:01.000Z'};
  const {tools,calls}=createHarness({type:'owner_settings_update',pendingAtStart:consumed,pendingStateAction:null,
    messageId:'wamid.retry-no-receipt',rpcResult:{data:{ok:false,reason:'no_action'},error:null}});

  const pendingResult=await tools.execute('getPendingOwnerAction',{});
  assert.deepEqual(pendingResult,{pending:false});
  const confirmation=await tools.execute('confirmPendingOwnerChange',{});
  assert.equal(confirmation.ok,false);
  assert.equal(confirmation.code,'NO_PENDING_ACTION');
  assert.equal(calls.rpc.length,1,'a no-action lookup is cached for this inbound turn');
  assert.deepEqual(calls.rpc[0].args,{
    p_workspace_id:scope.workspaceId,p_owner_id:scope.ownerId,p_phone:scope.phone,
    p_action_id:null,p_version:null,p_confirmation_message_id:'wamid.retry-no-receipt',
  });
  assert.equal(calls.consume.length,0);
  assert.equal(calls.settingsWrite,0);
  assert.equal(calls.invoiceWrite,0);
});

test('same-message confirmation never reaches the RPC',async()=>{
  const {tools,calls,pendingAtStart}=createHarness({type:'owner_invoice_create',messageId:'wamid.request-create'});
  const result=await tools.execute('confirmPendingOwnerChange',{});
  assert.equal(result.ok,false);
  assert.equal(result.code,'INVALID');
  assert.equal(calls.rpc.length,0);
  assert.equal(calls.consume.length,0);
  assert.equal(pendingAtStart.action.sourceMessageId,'wamid.request-create');
});

test('an unavailable atomic RPC does not fall back to JavaScript invoice or settings writes',async()=>{
  for(const type of ['owner_invoice_create','owner_settings_update']){
    const {tools,calls}=createHarness({type,withRpc:false});
    const result=await tools.execute('confirmPendingOwnerChange',{});
    assert.equal(result.ok,false);
    assert.equal(result.code,'DATABASE_UNAVAILABLE');
    assert.equal(calls.rpc.length,0);
    assert.equal(calls.consume.length,0);
    assert.equal(calls.settingsRead,0);
    assert.equal(calls.settingsWrite,0);
    assert.equal(calls.invoiceWrite,0);
  }
});
