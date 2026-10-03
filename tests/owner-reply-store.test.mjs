import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerReplyStore} from '../automation/whatsapp/owner-reply-store.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerActionButtons} from '../automation/whatsapp/owner-action-buttons.mjs';

const now=new Date('2026-10-02T18:00:00Z');
const scope={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',phone:'+919871367051',messageId:'wamid.new',message:'Which model?'};
const row=(overrides={})=>({workspace_id:scope.workspaceId,phone:scope.phone,audience:'owner',kind:'normal',direction:'outbound',status:'accepted',body:'Llama is your primary model.',idempotency_key:'reply:wamid.old',created_at:new Date(now.getTime()-30_000).toISOString(),...overrides});
function database(rows,pendingRows=[]) {
  const calls=[];
  return {calls,rows,pendingRows,from(table){
    const call={table,filters:[]};calls.push(call);let limit=100;
    const source=()=>table==='whatsapp_pending_actions'?pendingRows:rows;
    const q={select(){return q;},eq(k,v){call.filters.push(r=>r[k]===v);return q;},is(k,v){call.filters.push(r=>(r[k]??null)===v);return q;},neq(k,v){call.filters.push(r=>r[k]!==v);return q;},
      gte(k,v){call.filters.push(r=>r[k]>=v);return q;},order(){return q;},limit(v){limit=v;return q;},
      upsert(value){call.insert=value;if(!source().some(r=>r.workspace_id===value.workspace_id&&r.idempotency_key===value.idempotency_key))source().unshift(value);return q;},
      maybeSingle:async()=>({data:result()[0]||null}),then(resolve,reject){return Promise.resolve({data:result()}).then(resolve,reject);}};
    const result=()=>source().filter(r=>call.filters.every(f=>f(r))).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))).slice(0,limit);
    return q;
  }};
}
const inbound=(messageId,body,age=30_000)=>row({idempotency_key:`inbound:${messageId}`,provider_message_id:messageId,body,direction:'inbound',status:'received',created_at:new Date(now.getTime()-age).toISOString()});

test('same wamid returns the scoped durable reply regardless of text or elapsed time',async()=>{
  const db=database([row({idempotency_key:`reply:${scope.messageId}`,created_at:'2026-01-01T00:00:00Z'})]);
  const store=createOwnerReplyStore({supabase:db,clock:()=>now});
  assert.deepEqual(await store.find(scope),{answer:'Llama is your primary model.',replayMessageId:scope.messageId,replayDeliveryStatus:'accepted'});
  assert.equal(db.calls.length,1);
});
test('same owner text with a new message ID reads fresh state instead of replaying',async()=>{
  const db=database([inbound('wamid.old',scope.message),inbound(scope.messageId,scope.message,0),row()]);
  assert.equal(await createOwnerReplyStore({supabase:db,clock:()=>now}).find(scope),null);
});
test('resend lookup cannot reuse another workspace, phone or customer reply',async()=>{
  for(const change of [{workspace_id:'foreign'},{phone:'+919818685252'},{audience:'customer'}]){
    const db=database([row({idempotency_key:`reply:${scope.messageId}`,...change})]);
    assert.equal(await createOwnerReplyStore({supabase:db,clock:()=>now}).find(scope),null);
  }
});
test('old identical text and attachments do not reuse an unrelated reply',async()=>{
  const db=database([inbound('wamid.old',scope.message,120_001),row()]);
  const store=createOwnerReplyStore({supabase:db,clock:()=>now});
  assert.equal(await store.find(scope),null);
  assert.equal(await store.find({...scope,media:{mimeType:'image/png'}}),null);
});
test('an intervening new proposal prevents deduping its confirmation against an older yes',async()=>{
  const db=database([inbound('wamid.yes','yes',90_000),row({idempotency_key:'reply:wamid.yes',body:'First invoice changed.'}),
    inbound('wamid.proposal','Delete invoice 2',10_000),inbound(scope.messageId,'yes',0)]);
  assert.equal(await createOwnerReplyStore({supabase:db,clock:()=>now}).find({...scope,message:'yes'}),null);
});
test('saving a result uses the existing outbound intent and preserves the first canonical reply',async()=>{
  const db=database([row({idempotency_key:`reply:${scope.messageId}`})]);
  const result=await createOwnerReplyStore({supabase:db,clock:()=>now}).save(scope,{answer:'Later draft',servedModel:'llama'});
  assert.equal(result.answer,'Llama is your primary model.');
  assert.equal(result.servedModel,'llama');
  assert.equal(db.calls[0].insert.workspace_id,scope.workspaceId);
  assert.equal(db.calls[0].insert.callback_token.length,64);
});
test('same-wamid replay remints buttons from a stored pending id/version, never a raw button token',async()=>{
  const env={WHATSAPP_APP_SECRET:'reply-store-test-secret'};
  const action={type:'owner_invoice_delete_proposal',proposalId:'77777777-7777-4777-8777-777777777777',
    expectedUpdatedAt:'2026-10-02T10:00:00Z',expiresAt:new Date(now.getTime()+600_000).toISOString()};
  const pending={id:73,version:4,workspace_id:scope.workspaceId,phone:scope.phone,consumed_at:null,action};
  const expectedButtons=createOwnerActionButtons({scope:{workspaceId:scope.workspaceId,phone:scope.phone},action:pending,env,clock:()=>now,
    confirmTitle:'Delete',cancelTitle:'Keep invoice'});
  const db=database([],[pending]);
  const store=createOwnerReplyStore({supabase:db,clock:()=>now,env});
  await store.save(scope,{answer:'Delete this invoice?',buttons:expectedButtons,ownerActionRef:{pendingId:73,pendingVersion:4}});
  assert.deepEqual(db.rows[0].owner_action_ref,{pendingId:73,pendingVersion:4});
  assert.ok(!JSON.stringify(db.rows[0].owner_action_ref).includes(expectedButtons[0].id));
  const replay=await store.find(scope);
  assert.deepEqual(replay.buttons,expectedButtons);
  assert.equal(replay.answer,'Delete this invoice?');
});
test('same-wamid replay replaces an unusable button prompt and preserves accepted receipt status',async()=>{
  const env={WHATSAPP_APP_SECRET:'reply-store-test-secret'};
  const pending={id:73,version:5,workspace_id:scope.workspaceId,phone:scope.phone,consumed_at:null,
    action:{type:'owner_invoice_delete_proposal',expiresAt:new Date(now.getTime()+600_000).toISOString()}};
  const saved=row({idempotency_key:`reply:${scope.messageId}`,owner_action_ref:{pendingId:73,pendingVersion:4}});
  const replay=await createOwnerReplyStore({supabase:database([saved],[pending]),clock:()=>now,env}).find(scope);
  assert.equal(replay.answer,'I couldn’t restore those approval choices. Please send the change again and I’ll check the current details.');
  assert.deepEqual(replay.ownerActionFallback,{pendingId:73,pendingVersion:4});
  assert.equal(replay.replayDeliveryStatus,'accepted','replay delivery decisions still use the exact persisted receipt status');
  assert.equal(Object.hasOwn(replay,'buttons'),false);
});
test('saving a reply with a pending choice never returns tap instructions without reminted buttons',async()=>{
  const env={WHATSAPP_APP_SECRET:'reply-store-test-secret'};
  const pending={id:73,version:5,workspace_id:scope.workspaceId,phone:scope.phone,consumed_at:null,
    action:{type:'owner_invoice_update',proposalId:'77777777-7777-4777-8777-777777777777',
      expiresAt:new Date(now.getTime()+600_000).toISOString()}};
  const db=database([],[pending]);
  const store=createOwnerReplyStore({supabase:db,clock:()=>now,env});
  const result=await store.save(scope,{answer:'Tap Confirm to apply this update.',buttons:[{id:'old-token',title:'Confirm'}],
    ownerActionRef:{pendingId:73,pendingVersion:4}});
  assert.equal(result.answer,'I couldn’t restore those approval choices. Please send the change again and I’ll check the current details.');
  assert.deepEqual(result.ownerActionFallback,{pendingId:73,pendingVersion:4});
  assert.equal(result.replayDeliveryStatus,undefined);
  assert.equal(Object.hasOwn(result,'buttons'),false);
  assert.equal(db.rows[0].status,'pending');
  assert.deepEqual(db.rows[0].owner_action_ref,{pendingId:73,pendingVersion:4});
  assert.ok(!JSON.stringify(db.rows[0].owner_action_ref).includes('old-token'));
});
test('owner handler rechecks authorization before replay and never calls the model on an authorized resend',async()=>{
  let modelCalls=0,authCalls=0;
  const h=createOwnerMessageHandler({supabase:database([]),authorize:async()=>{authCalls++;return true;},
    replyStore:{find:async()=>({answer:'Stored reply.'}),save:async()=>{throw Error('Not needed');}},
    providerFactory:()=>{modelCalls++;throw Error('Should not create a model');},logger:{error(){}}});
  const result=await h(scope);
  assert.equal(result.answer,'Stored reply.');assert.equal(result.replayed,true);assert.equal(modelCalls,0);assert.equal(authCalls,1);
  let nextTurnAuthCalls=0;
  const denied=createOwnerMessageHandler({supabase:database([]),authorize:async()=>{nextTurnAuthCalls++;return false;},
    replyStore:{find:async()=>{throw Error('Do not read a denied reply');}},logger:{error(){}}});
  assert.equal(await denied(scope),'');
  assert.equal(nextTurnAuthCalls,1,'authorization is reloaded for each new request after revocation');
});
