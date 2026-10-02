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

test('a Cloudflare failure falls through to Gemini within the same call',async()=>{
 const p=make(async url=>String(url).includes('cloudflare')?{ok:false,status:429,headers:{get:()=>null},text:async()=>'{"errors":[{"message":"daily neuron cap"}]}'}:ok({candidates:[{content:{parts:[{text:'from gemini'}]},finishReason:'STOP'}]}));
 const r=await p.generate({messages:[{role:'user',content:'hi'}]});
 assert.equal(r.content,'from gemini');
 assert.equal(typeof cloudflareBreakerState().failures,'number');
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

test('Cloudflare 400 configuration errors fall back without retrying or opening the breaker',async()=>{
 const reset=make(async()=>ok({choices:[{finish_reason:'stop',message:{content:'reset'}}]}));
 await reset.generate({messages:[{role:'user',content:'reset breaker'}]});
 const cloudflareCalls=[];
 const p=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL,cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'g',maxAttempts:2,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{
  if(String(url).includes('cloudflare')){
   cloudflareCalls.push(JSON.parse(init.body).model);
   return failed(400,{error:{message:'unsupported tool schema'}});
  }
  return gemini('Gemini recovered');
 }});
 const result=await p.generate({messages:[{role:'user',content:'use configured tools'}],tools:[{type:'function',function:{name:'find_overdue',parameters:{type:'object',properties:{}}}}],toolChoice:'required'});
 assert.deepEqual(cloudflareCalls,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);
 assert.equal(result.model,GEMINI_FALLBACK_MODEL);
 assert.equal(result.usedFallback,true);
 assert.equal(cloudflareBreakerState().failures,0);
 assert.equal(cloudflareBreakerState().open,false);
});

test('a Cloudflare model tool rejection falls through to Gemini with the request intact',async()=>{
 const model='@cf/mistralai/mistral-small-3.1-24b-instruct';
 const calls=[];
 const tool={type:'function',function:{name:'find_overdue',parameters:{type:'object',properties:{customer:{type:'string'}}}}};
 const p=new AIProvider({primaryModel:model,fallbackModel:GEMINI_FALLBACK_MODEL,cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'g',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{
  if(String(url).includes('cloudflare')){
   calls.push(JSON.parse(init.body).model);
   return failed(400,{error:{message:'unsupported function tool schema'}});
  }
  const body=JSON.parse(init.body);calls.push(GEMINI_FALLBACK_MODEL);
  assert.deepEqual(body.tools[0].functionDeclarations.map(item=>item.name),['find_overdue']);
  return gemini('Gemini recovered');
 }});
 const result=await p.generate({messages:[{role:'user',content:'find overdue invoices'}],tools:[tool],toolChoice:'required'});
 assert.deepEqual(calls,[model,GEMINI_FALLBACK_MODEL]);
 assert.equal(result.model,GEMINI_FALLBACK_MODEL);
 assert.equal(result.usedFallback,true);
});

test('the default Cloudflare safety chain is Llama, Scout, Gemini Flash, then Lite',async()=>{
 const reset=make(async()=>ok({choices:[{finish_reason:'stop',message:{content:'reset'}}]}));
 await reset.generate({messages:[{role:'user',content:'reset breaker'}]});
 const calls=[];
 const p=make(async(url,init)=>{
  if(String(url).includes('cloudflare')){
   const model=JSON.parse(init.body).model;calls.push(model);return failed(503);
  }
  const model=String(url).includes(DEFAULT_EXTRACTION_MODEL)?DEFAULT_EXTRACTION_MODEL:GEMINI_FALLBACK_MODEL;
  calls.push(model);
  return model===GEMINI_FALLBACK_MODEL?failed(503):gemini('from Gemini Lite');
 });
 const result=await p.generate({messages:[{role:'user',content:'hello'}]});
 assert.deepEqual(calls,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL,GEMINI_FALLBACK_MODEL,DEFAULT_EXTRACTION_MODEL]);
 assert.equal(result.model,DEFAULT_EXTRACTION_MODEL);
});


test('an open Cloudflare circuit skips configured and primary Cloudflare legs',async()=>{
 const reset=make(async()=>ok({choices:[{finish_reason:'stop',message:{content:'reset'}}]}));
 await reset.generate({messages:[{role:'user',content:'reset breaker'}]});
 const firstCalls=[];
 const first=new AIProvider({primaryModel:CF_PRIMARY_MODEL,fallbackModel:'@cf/openai/gpt-oss-20b',cfAccountId:'acc',cfApiToken:'tok',geminiApiKey:'g',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(url,init)=>{
  if(String(url).includes('cloudflare')){firstCalls.push(JSON.parse(init.body).model);return failed(503);}
  firstCalls.push(GEMINI_FALLBACK_MODEL);return gemini('Gemini reached');
 }});
 await first.generate({messages:[{role:'user',content:'open breaker'}]});
 assert.deepEqual(firstCalls,[CF_PRIMARY_MODEL,'@cf/openai/gpt-oss-20b',CF_BACKUP_MODEL,GEMINI_FALLBACK_MODEL]);
 assert.equal(cloudflareBreakerState().open,true);

 let calls=0;
 const noFallback=new AIProvider({primaryModel:'@cf/mistralai/mistral-small-3.1-24b-instruct',fallbackModel:null,cfAccountId:'acc',cfApiToken:'tok',fetchImpl:async()=>{calls++;return ok({});},maxAttempts:1,logger:{warn(){},info(){}}});
 await assert.rejects(noFallback.generate({messages:[{role:'user',content:'skip open circuit'}]}),error=>error.code==='PROVIDER_UNAVAILABLE');
 assert.equal(calls,0);

 const secondCalls=[];
 const second=new AIProvider({primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:'@cf/openai/gpt-oss-20b',geminiApiKey:'g',cfAccountId:'acc',cfApiToken:'tok',maxAttempts:1,logger:{warn(){},info(){}},fetchImpl:async(url)=>{
  const model=String(url).includes(DEFAULT_EXTRACTION_MODEL)?DEFAULT_EXTRACTION_MODEL:GEMINI_FALLBACK_MODEL;
  secondCalls.push(model);
  return model===DEFAULT_EXTRACTION_MODEL?failed(503):gemini('Cloudflare fallback was skipped');
 }});
 const result=await second.generate({messages:[{role:'user',content:'use open circuit'}]});
 assert.deepEqual(secondCalls,[DEFAULT_EXTRACTION_MODEL,GEMINI_FALLBACK_MODEL]);
 assert.equal(result.model,GEMINI_FALLBACK_MODEL);
});
