import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider,CF_BACKUP_MODEL,CF_PRIMARY_MODEL,DEFAULT_EXTRACTION_MODEL,GEMINI_FALLBACK_MODEL,cloudflareBreakerState} from '../ai/provider.mjs';

const ok=(body)=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
const failed=(status,body={error:{message:'private upstream detail'}})=>({ok:false,status,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
const gemini=(content='ok')=>ok({candidates:[{content:{parts:[{text:content}]},finishReason:'STOP'}]});
const make=fetchImpl=>new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:'gemini-3.5-flash',cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'g',fetchImpl,maxAttempts:1,retryDelayMs:0,logger:{warn(){},info(){},error(){}}});

test('Cloudflare serves the owner model call and returns tool calls',async()=>{
 const urls=[];
 const p=make(async url=>{urls.push(String(url));return ok({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'1',type:'function',function:{name:'find_invoices',arguments:'{"customer":"John"}'}}]}}]});});
 const r=await p.generate({messages:[{role:'user',content:'johns invoice'}],tools:[{type:'function',function:{name:'find_invoices',parameters:{type:'object',properties:{}}}}]});
 assert.match(urls[0],/api\.cloudflare\.com\/client\/v4\/accounts\/acc\/ai\/v1\/chat\/completions/);
 assert.equal(r.toolCalls[0].function.name,'find_invoices');
});

test('Cloudflare omits empty tools and tool_choice fields',async()=>{
 let body;
 const p=make(async(_url,init)=>{
  body=JSON.parse(init.body);
  return ok({choices:[{finish_reason:'stop',message:{content:'served without tools'}}]});
 });
 await p.generate({messages:[{role:'user',content:'hello'}],tools:[],toolChoice:'required'});
 assert.equal(Object.hasOwn(body,'tools'),false);
 assert.equal(Object.hasOwn(body,'tool_choice'),false);
});

test('Cloudflare exhaustion stops safely without a Gemini request',async()=>{
 const urls=[];const p=make(async url=>{urls.push(String(url));return failed(429,{errors:[{message:'daily neuron cap'}]});});
 await assert.rejects(p.generate({messages:[{role:'user',content:'hi'}]}),e=>e.code==='RATE_LIMITED');
 assert.equal(urls.length,2);assert.ok(urls.every(url=>new URL(url).hostname==='api.cloudflare.com'));assert.equal(typeof cloudflareBreakerState().failures,'number');
});

test('every requested Cloudflare model uses the Cloudflare chat completions transport',async()=>{
 const models=[CF_PRIMARY_MODEL,CF_BACKUP_MODEL,'@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/openai/gpt-oss-20b','@cf/qwen/qwen3-30b-a3b-fp8','@cf/zai-org/glm-4.7-flash'];
 for(const model of models){
  const requests=[];
  const p=new AIProvider({primaryModel:model,fallbackModel:null,cfAccountId:'acc',cfApiToken:'tok',fetchImpl:async(url,init)=>{
   requests.push({url:String(url),init,body:JSON.parse(init.body)});
   return ok({choices:[{finish_reason:'stop',message:{content:'served by Cloudflare'}}]});
  },maxAttempts:1,logger:{warn(){},info(){}}});
  const result=await p.generate({messages:[{role:'user',content:'hello'}]});
  assert.equal(requests.length,1,`${model} must be sent to Cloudflare`);
  assert.match(requests[0].url,/api\.cloudflare\.com\/client\/v4\/accounts\/acc\/ai\/v1\/chat\/completions/);
  assert.equal(requests[0].init.headers.Authorization,'Bearer tok');
  assert.equal(requests[0].body.model,model);
  assert.equal(requests[0].body.stream,false);
  assert.equal(result.model,model);
 }
});

test('a selected non-default Cloudflare fallback runs immediately after the primary',async()=>{
 const model='@cf/mistralai/mistral-small-3.1-24b-instruct';
 const calls=[];
 const p=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:model,cfAccountId:'acc',cfApiToken:'tok',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(_url,init)=>{
  const requested=JSON.parse(init.body).model;calls.push(requested);
  return requested===CF_PRIMARY_MODEL?failed(503):ok({choices:[{finish_reason:'stop',message:{content:'selected fallback'}}]});
 }});
 const result=await p.generate({messages:[{role:'user',content:'hello'}]});
 assert.deepEqual(calls,[CF_PRIMARY_MODEL,model]);
 assert.equal(result.model,model);
});

test('Cloudflare 400 configuration errors stop after enabled legs without opening the breaker',async()=>{
 await make(async()=>ok({choices:[{message:{content:'reset'}}]})).generate({messages:[{role:'user',content:'reset'}]});
 const calls=[];const p=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL,cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'legacy',maxAttempts:2,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).hostname,'api.cloudflare.com');calls.push(JSON.parse(init.body).model);return failed(400,{error:{message:'unsupported tool schema'}});
 }});
 await assert.rejects(p.generate({messages:[{role:'user',content:'use tools'}]}),e=>e.code==='PROVIDER_ERROR');
 assert.deepEqual(calls,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);assert.equal(cloudflareBreakerState().failures,0);assert.equal(cloudflareBreakerState().open,false);
});

test('Cloudflare tool rejection keeps the request intact on enabled Cloudflare legs only',async()=>{
 const model='@cf/mistralai/mistral-small-3.1-24b-instruct',calls=[];
 const tool={type:'function',function:{name:'find_overdue',parameters:{type:'object',properties:{customer:{type:'string'}}}}};
 const p=new AIProvider({primaryModel:model,fallbackModel:GEMINI_FALLBACK_MODEL,cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'legacy',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);calls.push(body.model);assert.deepEqual(body.tools,[tool]);assert.equal(body.tool_choice,'required');return failed(400,{error:{message:'unsupported tool schema'}});
 }});
 await assert.rejects(p.generate({messages:[{role:'user',content:'find overdue'}],tools:[tool],toolChoice:'required'}),e=>e.code==='PROVIDER_ERROR');assert.deepEqual(calls,[model,CF_BACKUP_MODEL]);
});

test('the Cloudflare safety chain contains only Llama and Scout',async()=>{
 await make(async()=>ok({choices:[{message:{content:'reset'}}]})).generate({messages:[{role:'user',content:'reset'}]});
 const calls=[];const p=make(async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');calls.push(JSON.parse(init.body).model);return failed(503);});
 await assert.rejects(p.generate({messages:[{role:'user',content:'hello'}]}),e=>e.code==='PROVIDER_UNAVAILABLE');assert.deepEqual(calls,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);
});

test('an open Cloudflare circuit skips all enabled legs without enabling a retired Google choice',async()=>{
 await make(async()=>ok({choices:[{message:{content:'reset'}}]})).generate({messages:[{role:'user',content:'reset'}]});
 const calls=[];const first=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:'@cf/openai/gpt-oss-20b',cfAccountId:'acc',cfApiToken:'tok',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');calls.push(JSON.parse(init.body).model);return failed(503);}});
 await assert.rejects(first.generate({messages:[{role:'user',content:'open breaker'}]}),e=>e.code==='PROVIDER_UNAVAILABLE');
 assert.deepEqual(calls,[CF_PRIMARY_MODEL,'@cf/openai/gpt-oss-20b',CF_BACKUP_MODEL]);assert.equal(cloudflareBreakerState().open,true);
 for(const primaryModel of ['@cf/mistralai/mistral-small-3.1-24b-instruct',DEFAULT_EXTRACTION_MODEL]){
  let fetches=0;const p=new AIProvider({primaryModel,fallbackModel:'@cf/openai/gpt-oss-20b',cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'legacy',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async()=>{fetches++;assert.fail('Open or retired model');}});
  await assert.rejects(p.generate({messages:[{role:'user',content:'hello'}]}),e=>e.code==='PROVIDER_UNAVAILABLE');assert.equal(fetches,0);
 }
});
