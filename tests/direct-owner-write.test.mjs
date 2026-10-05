import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectOwnerWriteAdapter} from '../automation/whatsapp/direct-owner-write.mjs';

const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entityId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const phone='+919871367051';
const updatedAt='2026-10-03T10:00:00.000Z';

function supabaseFixture({rpcValue,record,readError}={}){
  const calls=[];
  return {
    calls,
    client:{
      async rpc(name,args){calls.push({kind:'rpc',name,args});return {data:rpcValue,error:null};},
      from(table){
        const query={table,filters:[],select(columns){this.columns=columns;return this;},eq(column,value){this.filters.push([column,value]);return this;},
          async maybeSingle(){calls.push({kind:'read',table,filters:this.filters,columns:this.columns});return readError?{data:null,error:readError}:{data:typeof record==='function'?record(table,this.filters):record,error:null};}};
        return query;
      },
    },
  };
}

test('direct instruction is passed exactly and completion waits for scoped persisted read',async()=>{
  const record={id:entityId,workspace_id:workspaceId,invoice_number:'INV-100',total_amount:'42.50',status:'sent',deleted_at:null,updated_at:updatedAt};
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'invoice.updated',entityType:'invoice',entityId,updatedAt,record},record});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.direct.1',
    authorization:{kind:'instruction',quote:'Update invoice INV-100 to 42.50'},operation:'invoice.update',
    targetId:entityId,expectedUpdatedAt:updatedAt,payload:{total_amount:'42.50'}});
  assert.equal(result.completed,true);
  assert.equal(result.record.total_amount,'42.50');
  const rpc=fixture.calls.find(call=>call.kind==='rpc');
  assert.equal(rpc.name,'whatsapp_apply_direct_owner_write');
  assert.equal(rpc.args.p_authorization_quote,'Update invoice INV-100 to 42.50');
  assert.equal(rpc.args.p_provider_message_id,'wamid.direct.1');
  assert.equal(rpc.args.p_expected_updated_at,updatedAt);
  assert.deepEqual(rpc.args.p_payload,{total_amount:'42.50'});
  assert.deepEqual(fixture.calls.find(call=>call.kind==='read').filters,[['workspace_id',workspaceId],['id',entityId]]);
});

test('button decision passes the checked interaction and pending version without caller mutation data',async()=>{
  const pending={id:17,workspace_id:workspaceId,phone,action:{type:'owner_invoice_update'},consumed_at:'2026-10-03T10:01:00Z'};
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'pending.cancelled',entityType:'pending',entityId:'17'},record:pending});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.button.1',interactionId:'oab1.checked',
    authorization:{kind:'button',decision:'cancel',pendingId:17,pendingVersion:4},operation:'pending.decide'});
  assert.equal(result.completed,true);
  const rpc=fixture.calls.find(call=>call.kind==='rpc');
  assert.equal(rpc.args.p_interaction_id,'oab1.checked');
  assert.equal(rpc.args.p_button_decision,'cancel');
  assert.equal(rpc.args.p_pending_id,17);
  assert.equal(rpc.args.p_pending_version,4);
  assert.equal(rpc.args.p_payload && Object.keys(rpc.args.p_payload).length,0);
});

test('adapter refuses unconfirmed RPC writes and invalid cross-scope or unsigned button inputs',async()=>{
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'invoice.updated',entityType:'invoice',entityId,updatedAt},record:null});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const base={workspaceId,ownerId,phone,providerMessageId:'wamid.direct.2',authorization:{kind:'instruction',quote:'Update invoice INV-100'},
    operation:'invoice.update',targetId:entityId,expectedUpdatedAt:updatedAt,payload:{notes:'updated'}};
  assert.equal((await adapter.apply({...base,workspaceId:'invalid'})).code,'INVALID');
  assert.equal((await adapter.apply({...base,authorization:{kind:'button',decision:'confirm',pendingId:17,pendingVersion:1}})).code,'INVALID');
  assert.equal(fixture.calls.some(call=>call.kind==='rpc'),false);
});

test('invoice correction preserves the server terminal-state refusal without claiming completion',async()=>{
  const fixture=supabaseFixture({rpcValue:{ok:false,code:'TERMINAL'}});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client,invoiceCorrectionsEnabled:true});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.terminal',
    authorization:{kind:'instruction',quote:'Update the cancelled invoice notes'},operation:'invoice.update',
    targetId:entityId,expectedUpdatedAt:updatedAt,payload:{notes:'updated'}});
  assert.deepEqual(result,{ok:false,completed:false,code:'TERMINAL'});
  assert.equal(fixture.calls.filter(call=>call.kind==='rpc').length,1);
  assert.equal(fixture.calls.some(call=>call.kind==='read'),false);
});

test('adapter never claims success when scoped postwrite verification fails',async()=>{
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'invoice.updated',entityType:'invoice',entityId,updatedAt},record:null});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.direct.3',
    authorization:{kind:'instruction',quote:'Update invoice INV-100'},operation:'invoice.update',targetId:entityId,
    expectedUpdatedAt:updatedAt,payload:{notes:'updated'}});
  assert.equal(result.ok,false);
  assert.equal(result.code,'WRITE_UNCONFIRMED');
  assert.notEqual(result.completed,true);
});

test('a failed customer absence read is not treated as proof that a delete completed',async()=>{
  const snapshot={id:entityId,workspace_id:workspaceId,name:'Nova',created_at:updatedAt,updated_at:updatedAt};
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'customer.deleted',entityType:'customer',entityId,record:snapshot},
    readError:{message:'network unavailable'}});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.customer.delete',
    authorization:{kind:'instruction',quote:'Delete customer Nova'},operation:'customer.delete',targetId:entityId,
    expectedUpdatedAt:updatedAt,payload:{}});
  assert.equal(result.ok,false);
  assert.equal(result.code,'WRITE_UNCONFIRMED');
});

test('receipt replay does not claim the old invoice version after a later write',async()=>{
  const fixture=supabaseFixture({rpcValue:{ok:true,action:'invoice.updated',entityType:'invoice',entityId,updatedAt,replayed:true},
    record:{id:entityId,workspace_id:workspaceId,invoice_number:'INV-100',total_amount:'50.00',status:'sent',deleted_at:null,
      updated_at:'2026-10-03T10:05:00.000Z'}});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.apply({workspaceId,ownerId,phone,providerMessageId:'wamid.direct.replay',
    authorization:{kind:'instruction',quote:'Update invoice INV-100'},operation:'invoice.update',targetId:entityId,
    expectedUpdatedAt:updatedAt,payload:{notes:'first edit'}});
  assert.equal(result.ok,false);
  assert.equal(result.code,'WRITE_UNCONFIRMED');
});

test('invoice payment is complete only when the persisted record is fully paid',async()=>{
  const baseOutcome={ok:true,action:'invoice.paid',entityType:'invoice',entityId,updatedAt};
  const base={workspaceId,ownerId,phone,providerMessageId:'wamid.direct.payment',
    authorization:{kind:'instruction',quote:'Mark invoice INV-100 paid'},operation:'invoice.update',targetId:entityId,
    expectedUpdatedAt:updatedAt,payload:{status:'paid'}};
  const shortPaid=supabaseFixture({rpcValue:baseOutcome,record:{id:entityId,workspace_id:workspaceId,status:'paid',
    amount_paid:'24.99',total_amount:'25.00',updated_at:updatedAt}});
  const refused=await createDirectOwnerWriteAdapter({supabase:shortPaid.client}).apply(base);
  assert.equal(refused.code,'WRITE_UNCONFIRMED');
  assert.notEqual(refused.completed,true);
  const fullyPaid=supabaseFixture({rpcValue:baseOutcome,record:{id:entityId,workspace_id:workspaceId,status:'paid',
    amount_paid:'25.00',total_amount:'25.00',updated_at:updatedAt}});
  const completed=await createDirectOwnerWriteAdapter({supabase:fullyPaid.client}).apply({...base,providerMessageId:'wamid.direct.payment.ok'});
  assert.equal(completed.completed,true);
});

test('button retry can recover its scoped completed receipt after the pending row was consumed',async()=>{
  const pending={id:17,workspace_id:workspaceId,phone,action:{type:'owner_invoice_update'},consumed_at:'2026-10-03T10:01:00Z'};
  const record={id:entityId,workspace_id:workspaceId,invoice_number:'INV-100',total_amount:'50.00',status:'sent',deleted_at:null,updated_at:updatedAt};
  const fixture=supabaseFixture({record:table=>table==='whatsapp_direct_write_receipts'?{
    workspace_id:workspaceId,owner_id:ownerId,phone,provider_message_id:'wamid.replay.1',
    result:{ok:true,action:'invoice.updated',entityType:'invoice',entityId,updatedAt,operation:'pending.decide'},
  }:table==='invoices'?record:table==='whatsapp_pending_actions'?pending:null});
  const adapter=createDirectOwnerWriteAdapter({supabase:fixture.client});
  const result=await adapter.lookupCompleted({workspaceId,ownerId,phone,providerMessageId:'wamid.replay.1'});
  assert.equal(result.completed,true);
  assert.equal(result.action,'invoice.updated');
  assert.equal(result.record.invoice_number,'INV-100');
  assert.equal(fixture.calls.some(call=>call.kind==='rpc'),false);
  const receiptRead=fixture.calls.find(call=>call.table==='whatsapp_direct_write_receipts');
  assert.deepEqual(receiptRead.filters,[['workspace_id',workspaceId],['owner_id',ownerId],['phone',phone],['provider_message_id','wamid.replay.1']]);
});
