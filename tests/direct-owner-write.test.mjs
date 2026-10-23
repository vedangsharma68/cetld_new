import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectOwnerWriteAdapter} from '../automation/whatsapp/direct-owner-write.mjs';

const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entityId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const phone='+919871367051';
const updatedAt='2026-10-03T10:00:00.000Z';

test('instruction identity omits only the parser-generated issue date and preserves supplied dates and amounts',async()=>{
  const keys=[];
  const quote='new invoice for Retry Customer, Rs 1,500, due 30 Oct';
  const client={async rpc(_name,args){keys.push(args.p_idempotency_key);return {data:{ok:false,code:'INVALID'}};},from(table){
    const q={select(){return q;},eq(){return q;},order(){return q;},async limit(){return {data:[],error:null};},
      async maybeSingle(){return {data:table==='whatsapp_inbound_events'?{provider_message_id:'current-event',sender_phone:phone,message_text:currentQuote,status:'processing'}:null,error:null};}};return q;
  }};
  let currentQuote=quote;
  const adapter=createDirectOwnerWriteAdapter({supabase:client});
  const apply=payload=>adapter.apply({workspaceId,ownerId,phone,providerMessageId:'current-event',
    authorization:{kind:'instruction',quote:currentQuote},operation:'invoice.create',deduplicateInvoiceInstruction:true,payload});
  const payload={customer_name:'Retry Customer',total_amount:1500,currency:'INR',issue_date:'2026-10-18',due_date:'2026-10-30'};
  await apply(payload);await apply({...payload,issue_date:'2026-10-19'});
  assert.equal(keys[0],keys[1]);
  await apply({...payload,total_amount:1510});assert.notEqual(keys[0],keys[2]);
  currentQuote='Create the invoice using the supplied issue date and details';
  await apply(payload);await apply({...payload,issue_date:'2026-10-19'});
  assert.notEqual(keys[3],keys[4],'an explicit issue date stays in the identity');
});

test('invoice creation checks scoped persisted evidence before reporting a duplicate',async()=>{
  const customerId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const payload={invoice_number:'QA-EDGE-002',customer_name:'QA_100%',customer_email:'QA@example.test'};
  for(const scenario of ['missing','canonical-deleted','source','foreign','ambiguous','read-error']){
    const calls=[];
    const supabase={rpc:async()=>({data:{ok:false,code:'INVOICE_EXISTS'}}),from(table){
      const filters=[];const query={select(){return query;},eq(key,value){filters.push([key,'eq',value]);return query;},
        ilike(key,value){filters.push([key,'ilike',value]);return query;},is(key,value){filters.push([key,'is',value]);return query;},
        async limit(){
          calls.push({table,filters:[...filters]});
          if(scenario==='read-error')return {error:{code:'unavailable'}};
          let data=[];
          if(table==='customers')data=[{id:customerId,workspace_id:workspaceId}];
          if(table==='customers'&&scenario==='ambiguous')data.push({id:entityId,workspace_id:workspaceId});
          if(table==='invoices'&&(scenario==='canonical-deleted'&&filters.some(([key])=>key==='invoice_number')
            ||scenario==='source'&&filters.some(([key])=>key==='metadata->>source_invoice_number')))
            data=[{id:entityId,workspace_id:workspaceId}];
          if(scenario==='foreign')data=[{id:entityId,workspace_id:ownerId}];
          return {data,error:null};
        }};return query;
    }};
    const result=await createDirectOwnerWriteAdapter({supabase}).apply({workspaceId,ownerId,phone,providerMessageId:'qa-conflict-'+scenario,
      authorization:{kind:'instruction',quote:'New invoice QA-EDGE-002 for QA_100%'},operation:'invoice.create',payload});
    assert.equal(result.code,['canonical-deleted','source'].includes(scenario)?'INVOICE_EXISTS':'DATABASE_UNAVAILABLE',scenario);
    assert.equal(result.completed,false);
    for(const call of calls)assert.ok(call.filters.some(([key,op,value])=>key==='workspace_id'&&op==='eq'&&value===workspaceId));
    if(scenario==='source'){
      assert.ok(calls.find(call=>call.table==='customers').filters.some(([key,op,value])=>key==='name'&&op==='ilike'&&value==='QA\\_100\\%'));
      for(const call of calls.filter(call=>call.filters.some(([key])=>key.startsWith('metadata->>')))){
        assert.ok(call.filters.some(([key,,value])=>key==='customer_id'&&value===customerId));
        assert.ok(call.filters.some(([key,,value])=>key==='deleted_at'&&value===null));
      }
    }
  }
});

test('exact unnumbered instruction replay still requires the current persisted inbound authorization',async()=>{
  const quote='new invoice for Retry Customer, Rs 1,500, due 30 Oct';
  for(const scenario of ['missing','wrong-id','wrong-phone','wrong-text','not-processing','done']){
    let receiptReads=0,rpcCalls=0;
    const event=scenario==='missing'?null:{provider_message_id:scenario==='wrong-id'?'another-event':'current-event',
      sender_phone:scenario==='wrong-phone'?'+919871367099':phone,message_text:scenario==='wrong-text'?'different instruction':quote,
      status:scenario==='done'?'done':scenario==='not-processing'?'queued':'processing'};
    const client={async rpc(){rpcCalls++;throw Error('An unverified event must not write');},from(table){
      if(table!=='whatsapp_inbound_events')receiptReads++;
      const q={select(){return q;},eq(){return q;},async maybeSingle(){return {data:event,error:null};}};return q;
    }};
    const result=await createDirectOwnerWriteAdapter({supabase:client}).apply({workspaceId,ownerId,phone,providerMessageId:'current-event',
      authorization:{kind:'instruction',quote},operation:'invoice.create',deduplicateInvoiceInstruction:true,
      payload:{customer_name:'Retry Customer',total_amount:1500,currency:'INR',issue_date:'2026-10-18',due_date:'2026-10-30'}});
    assert.equal(result.ok,false,scenario);assert.equal(result.code,scenario==='done'?'NO_PENDING_ACTION':'INVALID_AUTHORIZATION',scenario);
    assert.equal(rpcCalls,0);assert.equal(receiptReads,0,'No old receipt can authorize the current event');
  }
});

test('verified creation receipt exposes existing-invoice evidence without a write',async()=>{
  const quote='new invoice for Retry Customer, Rs 1,500, due 30 Oct';
  const payload={customer_name:'Retry Customer',total_amount:1500,currency:'INR',issue_date:'2026-10-18',due_date:'2026-10-30'};
  const receipt={workspace_id:workspaceId,owner_id:ownerId,phone,provider_message_id:'previous-event',
    request:{operation:'invoice.create',authorizationKind:'instruction',authorizationQuote:quote,payload},
    result:{ok:true,action:'invoice.created',entityType:'invoice',entityId,updatedAt}};
  const record={id:entityId,workspace_id:workspaceId,invoice_number:'INV-2026-6783',total_amount:'1500.00',currency:'INR',updated_at:updatedAt,deleted_at:null};
  let writes=0;
  const client={async rpc(){writes++;throw Error('Receipt verification must not write');},from(table){
    const q={select(){return q},eq(){return q},order(){return q},async limit(){return {data:[receipt],error:null}},
      async maybeSingle(){return {data:table==='invoices'?record:receipt,error:null}}};return q;
  }};
  const replay=await createDirectOwnerWriteAdapter({supabase:client}).lookupRepeatedInvoiceCreation({workspaceId,ownerId,phone,quote,payload});
  assert.equal(replay.ok,true);assert.equal(replay.replayed,true);assert.equal(replay.completed,true);
  assert.deepEqual(replay.existingInvoice,{invoiceNumber:'INV-2026-6783'});assert.equal(writes,0);
});

test('an exact prior invoice receipt cannot acknowledge a missing or deleted persisted invoice',async()=>{
  const quote='new invoice for Retry Customer, Rs 1,500, due 30 Oct';
  const payload={customer_name:'Retry Customer',total_amount:1500,currency:'INR',issue_date:'2026-10-18',due_date:'2026-10-30'};
  const receipt={workspace_id:workspaceId,owner_id:ownerId,phone,provider_message_id:'previous-event',
    request:{operation:'invoice.create',authorizationKind:'instruction',authorizationQuote:quote,payload},
    result:{ok:true,action:'invoice.created',entityType:'invoice',entityId,updatedAt}};
  for(const record of [null,{id:entityId,workspace_id:workspaceId,deleted_at:updatedAt,updated_at:updatedAt}]){
    const client={async rpc(){throw Error('Read-only verification does not write');},from(table){
      const q={select(){return q;},eq(){return q;},order(){return q;},async limit(){return {data:[receipt],error:null};},
        async maybeSingle(){return {data:table==='invoices'?record:receipt,error:null};}};return q;
    }};
    const result=await createDirectOwnerWriteAdapter({supabase:client}).lookupRepeatedInvoiceCreation({workspaceId,ownerId,phone,quote,payload});
    assert.equal(result.ok,false);assert.equal(result.code,'WRITE_UNCONFIRMED');
  }
});

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
