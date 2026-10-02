import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {CF_PRIMARY_MODEL, CF_BACKUP_MODEL, GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';

const scope = {workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'11111111-1111-4111-8111-111111111111',
  customerId:'22222222-2222-4222-8222-222222222222',phone:'+919871367051',messageId:'wamid.test',message:'Who owes the most?'};

function handlerFor(settings, capture, settingsError=null) {
  const supabase = {from(table) {
    assert.equal(table, 'workspace_ai_settings');
    const query = {select() { return query; },eq() { return query; },
      async maybeSingle() { return {data:settings,error:settingsError}; }};
    return query;
  }};
  let modelCalls=0;
  const handler=createOwnerMessageHandler({supabase, authorize:async()=>true,
    pendingActionStoreFactory:()=>({async loadPendingAction() { return null; }}),
    historyReader:async()=>[],
    providerFactory(options) { capture(options); return {async generate(request) {
      modelCalls++;assert.ok(request.tools.length>0,'every owner request receives the tool set');
      return {model:options.primaryModel,content:'The largest outstanding balance is 500.'};
    }}; },
    logger:{error(){}}});
  handler.modelCalls=()=>modelCalls;
  return handler;
}

test('owner bot uses the saved dashboard primary and fallback models', async()=>{
  let options;
  const handler=handlerFor({primary_model:'@cf/qwen/qwen3-30b-a3b-fp8',fallback_model:'gemini-3.5-flash-lite'},value=>options=value);
  assert.equal((await handler(scope)).answer,'The largest outstanding balance is 500.');
  assert.equal(handler.modelCalls(),1);
  assert.equal(options.primaryModel,'@cf/qwen/qwen3-30b-a3b-fp8');
  assert.equal(options.fallbackModel,'gemini-3.5-flash-lite');
});

test('owner bot keeps its existing Cloudflare and Gemini defaults when workspace settings are absent', async()=>{
  let options;
  const handler=handlerFor(null,value=>options=value);
  await handler(scope);
  assert.equal(handler.modelCalls(),1);
  assert.equal(options.primaryModel,CF_PRIMARY_MODEL);
  assert.equal(options.fallbackModel,GEMINI_FALLBACK_MODEL);
});

test('owner bot repairs a saved duplicate fallback to a distinct Cloudflare backup', async()=>{
  let options;
  const handler=handlerFor({primary_model:CF_PRIMARY_MODEL,fallback_model:CF_PRIMARY_MODEL},value=>options=value);
  await handler(scope);
  assert.equal(handler.modelCalls(),1);
  assert.equal(options.primaryModel,CF_PRIMARY_MODEL);
  assert.equal(options.fallbackModel,CF_BACKUP_MODEL);
});

test('an unreadable workspace-model setting still enters AI with the explicit owner defaults', async()=>{
  let options;
  const handler=handlerFor(null,value=>options=value,new Error('settings database unavailable'));
  const result=await handler(scope);
  assert.equal(result.answer,'The largest outstanding balance is 500.');
  assert.equal(handler.modelCalls(),1);
  assert.equal(options.primaryModel,CF_PRIMARY_MODEL);
  assert.equal(options.fallbackModel,GEMINI_FALLBACK_MODEL);
});
