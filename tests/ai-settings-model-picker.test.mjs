import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {authorizeAIWorkspace} from '../ai/store.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {DEFAULT_FALLBACK_MODEL,DEFAULT_MODEL} from '../ai/provider.mjs';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U='11111111-1111-4111-8111-111111111111';
const primary='@cf/qwen/qwen3-30b-a3b-fp8';
const fallback='gemini-3.5-flash-lite';
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-test-key'};

test('authenticated settings store round-trips new saved model choices through a fake REST transport',async()=>{
  let saved=null;
  const request={headers:{authorization:'Bearer test-user-token'}};
  const fetchImpl=async(url,init)=>{
    if(url.includes('/auth/v1/user'))return Response.json({id:U});
    if(url.includes('/workspace_members?'))return Response.json([{workspace_id:A,user_id:U,role:'owner'}]);
    assert.match(new URL(url).pathname,/workspace_ai_settings$/);
    if(init.method==='POST')saved=JSON.parse(init.body);
    return Response.json(saved?[saved]:[]);
  };
  const store=await authorizeAIWorkspace(request,A,{env,fetchImpl});
  assert.deepEqual(await store.getSettings(),{workspace_id:A,primary_model:DEFAULT_MODEL,fallback_model:DEFAULT_FALLBACK_MODEL});
  await store.saveSettings({primary_model:primary,fallback_model:fallback});
  assert.deepEqual(await store.getSettings(),{workspace_id:A,primary_model:primary,fallback_model:fallback});
  assert.deepEqual(Object.keys(saved).sort(),['fallback_model','primary_model','workspace_id']);
});

test('authenticated settings store reports failed database reads safely',async()=>{
  const request={headers:{authorization:'Bearer test-user-token'}};
  const fetchImpl=async url=>{
    if(url.includes('/auth/v1/user'))return Response.json({id:U});
    if(url.includes('/workspace_members?'))return Response.json([{workspace_id:A,user_id:U,role:'owner'}]);
    throw new Error('transport offline');
  };
  const store=await authorizeAIWorkspace(request,A,{env,fetchImpl});
  await assert.rejects(store.getSettings(),error=>error.code==='DATABASE_UNAVAILABLE');
});

test('settings API verifies Cloudflare credentials and rejects duplicate saved choices',async()=>{
  const verified=[],saved=[];
  const store={role:'owner',saveSettings:async value=>{saved.push(value);return value;}};
  const handler=createAIHandler({env:{CLOUDFLARE_ACCOUNT_ID:'cf-account',CLOUDFLARE_API_TOKEN:'cf-token',GEMINI_API_KEY:'gemini-key'},
    authorize:async()=>store,verify:async(id,options)=>{verified.push({id,...options});return {id};}});
  const request={method:'PUT',query:{action:'settings'},body:{workspaceId:A,primary_model:primary,fallback_model:fallback}};
  const response=makeResponse();
  await handler(request,response);
  assert.equal(response.code,200);
  assert.deepEqual(saved,[{primary_model:primary,fallback_model:fallback}]);
  assert.deepEqual(verified.map(({id})=>id),[primary,fallback]);
  assert.ok(verified.every(({cfAccountId,cfApiToken})=>cfAccountId==='cf-account'&&cfApiToken==='cf-token'));

  const duplicate=makeResponse();
  await handler({...request,body:{...request.body,fallback_model:primary}},duplicate);
  assert.equal(duplicate.code,400);
  assert.equal(saved.length,1);
  assert.equal(verified.length,2);

  const unavailable=makeResponse();
  const failing=createAIHandler({env:{CLOUDFLARE_ACCOUNT_ID:'cf-account',CLOUDFLARE_API_TOKEN:'cf-token'},
    authorize:async()=>store,verify:async()=>{throw new Error('private Cloudflare response');}});
  await failing(request,unavailable);
  assert.equal(unavailable.code,503);
  assert.doesNotMatch(JSON.stringify(unavailable.data),/private Cloudflare response/);
  assert.equal(saved.length,1);
});

test('workspace model migration preserves existing saved IDs and constrains new choices without rewriting rows',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20261002060000_workspace_ai_model_choices.sql',import.meta.url),'utf8');
  const cloudflare=['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/openai/gpt-oss-20b','@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/zai-org/glm-4.7-flash'];
  const primaryCheck=sql.match(/add constraint workspace_ai_settings_primary_model_check([\s\S]*?)add constraint workspace_ai_settings_fallback_model_check/i)?.[1]||'';
  const fallbackCheck=sql.match(/add constraint workspace_ai_settings_fallback_model_check([\s\S]*?)add constraint workspace_ai_settings_models_different/i)?.[1]||'';
  for(const id of [...cloudflare,'gemini-3.5-flash','gemini-3.5-flash-lite','space-bunny-free'])
    assert.ok(primaryCheck.includes(`'${id}'`),`primary constraint should preserve or allow ${id}`);
  for(const id of [...cloudflare,'gemini-3.5-flash','gemini-3.5-flash-lite','space-bunny-free','longcat-2.5-preview-free'])
    assert.ok(fallbackCheck.includes(`'${id}'`),`fallback constraint should preserve or allow ${id}`);
  assert.match(sql,/fallback_model is null or fallback_model <> primary_model/i);
  assert.doesNotMatch(sql,/update\s+public\.workspace_ai_settings\s+set\s+/i);
  assert.doesNotMatch(sql,/alter column (?:primary_model|fallback_model) set default/i);
});

function makeResponse(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};}
