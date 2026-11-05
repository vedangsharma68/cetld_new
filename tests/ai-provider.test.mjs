import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIError, AIProvider, CF_BACKUP_MODEL, CF_PRIMARY_MODEL, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, GEMINI_FALLBACK_MODEL, OPENROUTER_FREE_MODEL,
  ZEN_MIMO_MODEL, ZEN_PRIMARY_MODEL,
  isFallbackModelId, isModelId, isPrimaryModelId, sanitizeModelSettings, verifyModel,
} from '../ai/provider.mjs';

function jsonResponse(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})}
function gemini(content='ok',{status=200,parts,finishReason='STOP'}={}){
  return jsonResponse(status>=400?{error:{message:'private upstream detail'}}:{candidates:[{content:{parts:parts||[{text:content}]},finishReason}],},status);
}
function openRouter(content='ok',{status=200,toolCalls=[]}={}){
  return jsonResponse(status>=400?{error:{message:'private upstream detail'}}:{choices:[{message:{content,tool_calls:toolCalls},finish_reason:'stop'}]},status);
}
function provider(fetchImpl,options={}){
  return new AIProvider({primaryModel:DEFAULT_MODEL,fallbackModel:ZEN_MIMO_MODEL,geminiApiKey:'gemini-test-secret',openRouterApiKey:'router-test-secret',zenApiKey:'zen-test-secret',fetchImpl,retryDelayMs:1,sleepImpl:async()=>{},...options});
}

test('configuration exposes Space Bunny with explicitly selectable MiMo and existing Gemini backup',()=>{
  assert.equal(DEFAULT_MODEL,ZEN_PRIMARY_MODEL);
  assert.equal(DEFAULT_FALLBACK_MODEL,null);
  assert.equal(DEFAULT_EXTRACTION_MODEL,'gemini-3.5-flash-lite');
  assert.equal(DEFAULT_EXTRACTION_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL);
  assert.equal(isPrimaryModelId(DEFAULT_MODEL),true);
  assert.equal(isPrimaryModelId(ZEN_PRIMARY_MODEL),true);
  assert.equal(isFallbackModelId(ZEN_PRIMARY_MODEL),false);
  assert.equal(isFallbackModelId(ZEN_MIMO_MODEL),true);
  assert.equal(isFallbackModelId(GEMINI_FALLBACK_MODEL),true);
  assert.equal(isModelId(DEFAULT_MODEL),true);
  assert.equal(isModelId(ZEN_PRIMARY_MODEL),true);
  assert.equal(isModelId(ZEN_MIMO_MODEL),true);
  assert.equal(isModelId('openai/gpt-4.1-mini'),false);
  assert.deepEqual(sanitizeModelSettings({primaryModel:ZEN_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL}),{primaryModel:ZEN_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL});
});

test('Cloudflare sends generation settings and normalizes text and function calls',async()=>{
  let sent;
  const calls=[{id:'cf-call',type:'function',function:{name:'getOverdueInvoices',arguments:'{"dueDateFrom":"2026-09-01"}'}}];
  const ai=provider(async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');sent=JSON.parse(init.body);return openRouter('Overdue count is two.',{toolCalls:calls});},
    {primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  const definition={type:'function',function:{name:'getOverdueInvoices',parameters:{type:'object',properties:{}}}};
  const result=await ai.generate({messages:[{role:'system',content:'Use tools.'},{role:'user',content:'Overdue?'}],tools:[definition],toolChoice:'required',maxTokens:64,temperature:0});
  assert.equal(sent.max_tokens,64);assert.equal(sent.temperature,0);assert.deepEqual(sent.tools,[definition]);
  assert.equal(sent.tool_choice,'required');assert.deepEqual(result.toolCalls,calls);assert.equal(result.content,'Overdue count is two.');
});

test('legacy Gemini image and PDF requests are rejected before any network call',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(ai.generate({messages:[{role:'user',content:[{type:'text',text:'Read private invoice'},
    {type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}},
    {type:'file',file:{filename:'invoice.pdf',file_data:'data:application/pdf;base64,JVBERi0xLjQ='}}]}]}),e=>e.code==='INVALID_MODEL');
  assert.equal(calls,0);
});

test('rejects malformed or oversized multimodal messages before contacting either provider',async()=>{
  let calls=0;
  const ai=provider(async()=>{calls++;return gemini('unused')},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  await assert.rejects(ai.generate({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,not-valid!'}}]}]}),error=>error.code==='INVALID_ARGUMENT');
  await assert.rejects(ai.generate({messages:[{role:'user',content:'x'.repeat(15*1024*1024+1)}]}),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(calls,0);
});

test('retries Space Bunny failures twice then uses the configured explicit MiMo fallback',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const model=JSON.parse(init.body).model;
    calls.push(model);
    return model===ZEN_PRIMARY_MODEL?openRouter('',{status:503}):openRouter('Recovered');
  });
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);
  assert.equal(result.content,'Recovered');
  assert.equal(result.model,ZEN_MIMO_MODEL);
  assert.equal(result.usedFallback,true);
});

test('OpenCode Zen request uses its chat-completions contract and keeps credentials out of the URL',async()=>{
  let captured;
  const ai=provider(async(url,init)=>{
    if(String(url).includes('generativelanguage'))return gemini('',{status:503});
    captured={url:String(url),init,body:JSON.parse(init.body)};
    return openRouter('Recovered');
  },{maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'Can you summarize this?'}],maxTokens:123});
  assert.equal(captured.url,'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization,'Bearer zen-test-secret');
  assert.equal(captured.body.model,ZEN_PRIMARY_MODEL);
  assert.equal(captured.body.max_tokens,123);
  assert.deepEqual(captured.body.messages,[{role:'user',content:'Can you summarize this?'}]);
  assert.equal(captured.url.includes('zen-test-secret'),false);
  assert.equal(result.content,'Recovered');
  assert.equal(result.usedFallback,false);
});

test('Zen fallback receives required Assistant tools and normalizes its function call',async()=>{
  const definition={type:'function',function:{name:'getOverdueInvoices',description:'List overdue invoices',parameters:{type:'object',properties:{},additionalProperties:false}}};
  const returned=[{id:'call-or-1',type:'function',function:{name:'getOverdueInvoices',arguments:'{"dueDateFrom":"2026-09-01"}'}}];
  let fallbackBody;
  const ai=provider(async(url,init)=>{
    if(String(url).includes('generativelanguage'))return gemini('',{status:503});
    fallbackBody=JSON.parse(init.body);
    return openRouter('',{toolCalls:returned});
  },{maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'List overdue invoices'}],tools:[definition],toolChoice:'required'});
  assert.equal(fallbackBody.model,ZEN_PRIMARY_MODEL);
  assert.deepEqual(fallbackBody.tools,[definition]);
  assert.equal(fallbackBody.tool_choice,'required');
  assert.deepEqual(result.toolCalls,returned);
  assert.equal(result.usedFallback,false);
});

test('Cloudflare fallback receives structured schema and its output is validated',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);calls.push(body);
    return body.model===CF_PRIMARY_MODEL?openRouter('',{status:503}):openRouter('{"invoiceNumber":"INV-1048","total":84600}');},
    {primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL,cfAccountId:'test',cfApiToken:'test',maxAttempts:1});
  const schema={type:'object',required:['invoiceNumber','total'],properties:{invoiceNumber:{type:'string'},total:{type:'number'}}};
  const result=await ai.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema,validate:v=>v});
  assert.deepEqual(calls.map(b=>b.model),[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);
  assert.deepEqual(calls[1].response_format.json_schema.schema,schema);assert.deepEqual(result.data,{invoiceNumber:'INV-1048',total:84600});assert.equal(result.usedFallback,true);
});

test('legacy Gemini primary is skipped in favour of its explicit non-Gemini fallback',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{assert.doesNotMatch(String(url),/google/);calls.push(JSON.parse(init.body).model);return openRouter('Recovered');},
    {primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:ZEN_MIMO_MODEL});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[ZEN_MIMO_MODEL]);assert.equal(result.model,ZEN_MIMO_MODEL);assert.equal(result.usedFallback,true);
});

test('network failures and abort timeouts can use the configured fallback',async()=>{
  const networkCalls=[];
  const network=provider(async(url,init)=>{
    const model=String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model;
    networkCalls.push(model);
    if(model===ZEN_PRIMARY_MODEL)throw Error('private transport detail');
    return openRouter('network recovered');
  },{maxAttempts:1});
  assert.equal((await network.generate({messages:[{role:'user',content:'Hi'}]})).content,'network recovered');
  assert.deepEqual(networkCalls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);

  const timeoutCalls=[];
  const timeout=provider((url,init)=>{
    const model=String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model;
    if(model===ZEN_PRIMARY_MODEL){
      timeoutCalls.push(model);
      return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));
    }
    timeoutCalls.push(model);return Promise.resolve(openRouter('timeout recovered'));
  },{timeoutMs:5,maxAttempts:1});
  assert.equal((await timeout.generate({messages:[{role:'user',content:'Hi'}]})).content,'timeout recovered');
  assert.deepEqual(timeoutCalls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);
});

test('provider timeout stays active while reading an upstream response body',async()=>{
  const ai=provider(async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('{"candidates":'));},
  }),{status:200}),{fallbackModel:null,timeoutMs:5,maxAttempts:1});
  const outcome=await Promise.race([
    ai.generate({messages:[{role:'user',content:'Hi'}]}).then(
      ()=>'resolved',
      error=>error.code,
    ),
    new Promise(resolve=>setTimeout(()=>resolve('still-pending'),40)),
  ]);
  assert.equal(outcome,'TIMEOUT','a body that never finishes must not outlive the provider deadline');
});

test('disabled Gemini extraction never activates an unselected provider',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL,requestPurpose:'extraction'});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Extract this invoice'}]}),e=>e.code==='INVALID_MODEL');assert.equal(calls,0);
});

test('oversized upstream responses are rejected with a safe bounded error',async()=>{
  const ai=provider(async()=>new Response('x'.repeat(4*1024*1024+1),{status:200}),{fallbackModel:null,maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='INVALID_RESPONSE'&&!/xxxx/.test(error.message));
});

test('quota exhaustion skips each same-leg retry and aggregates exhausted providers safely',async()=>{
  const calls=[],waits=[];
  const ai=provider(async (url,init)=>{
    calls.push(String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model);
    return jsonResponse({error:{code:'RESOURCE_EXHAUSTED',status:'RESOURCE_EXHAUSTED',message:'Quota exceeded for requests per day'}},429);
  },{sleepImpl:async ms=>waits.push(ms)});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>{
    assert.ok(error instanceof AIError);assert.equal(error.code,'RATE_LIMITED');assert.equal(error.status,429);
    assert.equal(error.providerReason,'quota_exceeded');assert.equal(error.quotaExhausted,true);
    assert.deepEqual(error.quotaProviders,['opencode-zen']);
    assert.match(error.message,/temporarily rate limited/);assert.doesNotMatch(error.message,/private upstream/);return true;
  });
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);
  assert.deepEqual(waits,[]);
});

test('a transient non-quota 429 can retry its current model leg',async()=>{
  let calls=0;
  const ai=provider(async()=>{
    calls++;
    return calls===1?jsonResponse({error:{message:'Too many requests'}},429):openRouter('Recovered on retry');
  },{fallbackModel:null});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.equal(calls,2);
  assert.equal(result.content,'Recovered on retry');
});

test('exhausted configured Zen models return a safe error without Gemini',async()=>{
  const calls=[];const ai=provider(async(url,init)=>{assert.doesNotMatch(String(url),/google/);const model=JSON.parse(init.body).model;calls.push(model);return openRouter('',{status:model===ZEN_PRIMARY_MODEL?429:503});},{maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),e=>['RATE_LIMITED','PROVIDER_UNAVAILABLE'].includes(e.code));assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);
});

test('missing Zen credentials do not activate Gemini credentials',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;},{zenApiKey:'',maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),e=>e.code==='API_KEY_MISSING');assert.equal(calls,0);
});

test('authentication failures advance once per selected leg and never activate Gemini',async()=>{
  const calls=[],logs=[];const ai=provider(async(url,init)=>{assert.doesNotMatch(String(url),/google/);const model=JSON.parse(init.body).model;calls.push(model);return openRouter('',{status:model===ZEN_PRIMARY_MODEL?401:403});},
    {logger:{warn:(message,details)=>logs.push({message,details}),info:(message,details)=>logs.push({message,details})}});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),e=>e.code==='AUTH_FAILED');
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);assert.equal(logs.length,2);
  assert.ok(logs.every(({details})=>details.provider==='opencode-zen'&&details.reason==='permission_denied'&&Number.isFinite(details.durationMs)));
});

test('provider diagnostics classify schema complexity without retaining adversarial error text',async()=>{
  const secret='Acme Customer owes INR 98,765; prompt=password hunter2';
  const logs=[];
  const ai=provider(async()=>jsonResponse({error:{code:400,message:`Response schema exceeds complexity limit. ${secret}`}},400),
    {primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test',maxAttempts:1,
      logger:{warn:(message,details)=>logs.push({message,details})}});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'private invoice'}]}),error=>{
    assert.equal(error.code,'PROVIDER_ERROR');
    assert.equal(error.providerReason,'schema_complexity');
    assert.doesNotMatch(JSON.stringify(error),/Acme|98,765|hunter2|private invoice/);
    return true;
  });
  assert.equal(logs.length,1);
  assert.deepEqual(Object.fromEntries(Object.entries(logs[0].details).filter(([key])=>key!=='durationMs')),
    {provider:'cloudflare',model:CF_PRIMARY_MODEL,status:400,reason:'schema_complexity'});
  assert.ok(logs.every(item=>Number.isFinite(item.details.durationMs)));
  assert.doesNotMatch(JSON.stringify(logs),/Acme|98,765|hunter2|private invoice/);
});

test('one deadline bounds multiple failing provider legs and expired work starts no fetch',async()=>{
  let now=0,calls=0;
  const originalNow=Date.now;
  Date.now=()=>now;
  try {
    const ai=provider(async()=>{calls++;now+=6;return openRouter('',{status:503});},{maxAttempts:1});
    await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}],deadlineAt:10}),error=>error.code==='TIMEOUT');
    assert.equal(calls,2);
    await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}],deadlineAt:now}),error=>error.code==='TIMEOUT');
    assert.equal(calls,2);
  } finally { Date.now=originalNow; }
});

test('all-leg authentication failure surfaces a safe AUTH_FAILED error without same-leg retries',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const model=String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model;
    calls.push(model);
    return model===GEMINI_FALLBACK_MODEL?gemini('',{status:401}):openRouter('',{status:403});
  },{logger:{warn(){}}});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='AUTH_FAILED'&&!/private upstream/.test(error.message));
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_MIMO_MODEL]);
});

test('null fallback disables fallback instead of silently adding OpenRouter',async()=>{
  const calls=[];
  const ai=provider(async url=>{calls.push(String(url));return gemini('',{status:503});},{fallbackModel:null,maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='PROVIDER_UNAVAILABLE');
  assert.equal(calls.length,1);assert.match(calls[0],/opencode\.ai/);
});

test('paid or reversed provider pairs are rejected before any upstream request',()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('unexpected request')};
  assert.throws(()=>provider(fetchImpl,{primaryModel:'openai/gpt-4.1-mini'}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{primaryModel:'openrouter/free'}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{primaryModel:'space-bunny-free',fallbackModel:'space-bunny-free'}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_MODEL}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{fallbackModel:'openai/gpt-4.1-mini'}),error=>error.code==='INVALID_MODEL');
  assert.equal(calls,0);
});

test('structured JSON uses Cloudflare schema configuration and returns validated data',async()=>{
  let sent;const ai=provider(async(url,init)=>{sent=JSON.parse(init.body);return openRouter('{"value":"clean","extra":"discard"}');},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  const schema={type:'object',properties:{value:{type:'string'}}};const result=await ai.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema,validate:v=>({value:v.value}),maxTokens:64});
  assert.deepEqual(sent.response_format.json_schema.schema,schema);assert.deepEqual(result.data,{value:'clean'});assert.equal(result.model,CF_PRIMARY_MODEL);assert.equal(result.usedFallback,false);
});

test('legacy JSON mode option cannot weaken Cloudflare validation or leak upstream',async()=>{
  const wires=[];const ai=provider(async(url,init)=>{wires.push(JSON.parse(init.body));return openRouter('{"value":"clean"}');},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  const input={messages:[{role:'user',content:'Return JSON data'}],name:'dynamic_plan',schema:{type:'object',properties:{value:{}}},geminiJsonMode:true,validate:v=>typeof v.value==='string'?{value:v.value}:undefined};
  assert.deepEqual((await ai.generateStructured(input)).data,{value:'clean'});assert.equal(Object.hasOwn(wires[0],'geminiJsonMode'),false);assert.deepEqual(wires[0].response_format.json_schema.schema,input.schema);
  for(const text of ['not JSON','{"value":123}']){const invalid=provider(async()=>openRouter(text),{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});await assert.rejects(invalid.generateStructured(input),e=>e.code==='INVALID_OUTPUT');}
});

test('Gemini planning option stays private on Cloudflare and preserves its strict schema',async()=>{
  let sent;
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return openRouter('{"value":"clean"}')},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'fixture',cfApiToken:'fixture'});
  const schema={type:'object',properties:{value:{type:'string'}}};
  await ai.generateStructured({messages:[{role:'user',content:'Return JSON'}],name:'sample',schema,geminiJsonMode:true,validate:value=>value});
  assert.equal(Object.hasOwn(sent,'geminiJsonMode'),false);assert.deepEqual(sent.response_format.json_schema.schema,schema);
});

test('quota-skipped Cloudflare planning stops without a Google request',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;assert.fail('No healthy enabled model');},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL,cfAccountId:'test',cfApiToken:'test',healthStore:{async getUnavailableUntil(){return Date.now()+60000;},async markUnavailable(){}}});
  await assert.rejects(ai.generateStructured({messages:[{role:'user',content:'Return JSON'}],name:'sample',schema:{type:'object'},validate:v=>v}),e=>['RATE_LIMITED','PROVIDER_UNAVAILABLE'].includes(e.code));assert.equal(calls,0);
});

test('malformed or oversized structured output is rejected when fallback is disabled',async()=>{
  let calls=0;
  const malformed=provider(async()=>{calls++;return openRouter('not json')},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  await assert.rejects(malformed.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object'},validate:value=>value}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(calls,1);
  const oversized=provider(async()=>{calls++;return openRouter('{"value":"x"}')},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  await assert.rejects(oversized.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object'},validate:()=>({value:'x'.repeat(256*1024+1)})}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(calls,2);
});

test('catalog verification rejects Gemini without a request and checks the explicit OpenRouter free catalog',async()=>{
  const requests=[];
  const fetchImpl=async(url,init)=>{
    requests.push({url:String(url),init});
    return String(url).includes('generativelanguage')
      ? jsonResponse({supportedGenerationMethods:['generateContent']})
      : jsonResponse({data:[{id:'openrouter/free'}]});
  };
  assert.deepEqual(await verifyModel(DEFAULT_MODEL,{fetchImpl,zenApiKey:'zen-key'}),{id:DEFAULT_MODEL,provider:'opencode-zen'});
  await assert.rejects(verifyModel(GEMINI_FALLBACK_MODEL,{fetchImpl,geminiApiKey:'gemini-key'}),e=>e.code==='INVALID_MODEL');
  assert.deepEqual(await verifyModel(OPENROUTER_FREE_MODEL,{fetchImpl,openRouterApiKey:'router-key'}),{id:OPENROUTER_FREE_MODEL,provider:'openrouter'});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://openrouter.ai/api/v1/models');assert.equal(requests[0].init.headers,undefined);
  let called=false;
  await assert.rejects(verifyModel('openai/gpt-4.1-mini',{fetchImpl:async()=>{called=true;}}),error=>error.code==='INVALID_MODEL');
  assert.equal(called,false);
});

test('verified picker catalog contains canonical Cloudflare and Gemini models for both roles',async()=>{
  const {VERIFIED_MODEL_CATALOG}=await import('../ai/provider.mjs');
  const expected=[
    [CF_PRIMARY_MODEL,'cloudflare'],
    [CF_BACKUP_MODEL,'cloudflare'],
    ['@cf/mistralai/mistral-small-3.1-24b-instruct','cloudflare'],
    ['@cf/openai/gpt-oss-20b','cloudflare'],
    ['@cf/qwen/qwen3-30b-a3b-fp8','cloudflare'],
    ['@cf/zai-org/glm-4.7-flash','cloudflare'],
    [GEMINI_FALLBACK_MODEL,'google'],
    [DEFAULT_EXTRACTION_MODEL,'google'],
  ];
  assert.ok(Array.isArray(VERIFIED_MODEL_CATALOG));
  for(const [id,providerName] of expected){
    const entry=VERIFIED_MODEL_CATALOG.find(item=>item.id===id);
    assert.ok(entry,`${id} must be visible in the shared picker catalog`);
    assert.equal(entry.provider,providerName);
    assert.deepEqual(entry.roles,['primary','fallback']);
    assert.equal(isModelId(id),true);
    assert.equal(isPrimaryModelId(id),true);
    assert.equal(isFallbackModelId(id),true);
  }
  assert.ok(Object.isFrozen(VERIFIED_MODEL_CATALOG));
});

test('model settings resolve same-model conflicts to a deterministic distinct fallback',()=>{
  assert.deepEqual(sanitizeModelSettings({primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_PRIMARY_MODEL}),
    {primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL});
  assert.deepEqual(sanitizeModelSettings({primaryModel:GEMINI_FALLBACK_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL}),
    {primaryModel:GEMINI_FALLBACK_MODEL,fallbackModel:DEFAULT_EXTRACTION_MODEL});
  assert.deepEqual(sanitizeModelSettings({primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_MODEL}),
    {primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL});
});

test('Cloudflare catalog verification uses the account model search endpoint and bearer token',async()=>{
  const model='@cf/openai/gpt-oss-20b';
  let request;
  const result=await verifyModel(model,{
    fetchImpl:async(url,init)=>{request={url:String(url),init};return jsonResponse({success:true,result:[{id:'opaque-catalog-id',name:model}]});},
    cfAccountId:'account-123',cfApiToken:'cf-test-secret',
  });
  assert.deepEqual(result,{id:model,provider:'cloudflare'});
  assert.match(request.url,/api\.cloudflare\.com\/client\/v4\/accounts\/account-123\/ai\/models\/search/);
  assert.match(request.url,/search=gpt-oss-20b/);
  assert.equal(request.init.method,'GET');
  assert.equal(request.init.headers.Authorization,'Bearer cf-test-secret');
  assert.equal(request.url.includes('cf-test-secret'),false);
  await assert.rejects(verifyModel(model,{fetchImpl:async()=>{throw Error('must not fetch');},cfAccountId:'account-123',cfApiToken:''}),error=>error.code==='API_KEY_MISSING');
});



test('removed Ollama model is not accepted by the verified model catalog',()=>{
  assert.equal(isModelId('gpt-oss:20b-cloud'),false);
});

test('disabled Gemini cannot send archived native signatures or tool results',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Private invoice'},{role:'assistant',content:'',googleParts:[{thoughtSignature:'private',functionCall:{name:'workspaceData',args:{}}}]},{role:'tool',name:'workspaceData',tool_call_id:'native',content:'{"invoice":"PRIVATE"}'}]}),e=>e.code==='INVALID_MODEL');assert.equal(calls,0);
});

test('disabled Gemini cannot send coalesced parallel calls',async()=>{
  let calls=0;const ai=provider(async()=>{calls++;},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Private invoice'},{role:'assistant',content:'',googleParts:[{thoughtSignature:'private',functionCall:{name:'workspaceData',args:{}}}]},{role:'tool',name:'workspaceData',tool_call_id:'native',content:'{"invoice":"PRIVATE"}'}]}),e=>e.code==='INVALID_MODEL');assert.equal(calls,0);
});

test('Google opaque parts stay private across other provider transports',async()=>{
 const messages=[{role:'user',content:'Read invoice'},{role:'assistant',content:'',googleParts:[{thoughtSignature:'private-google-signature',functionCall:{name:'workspaceData',args:{}}}],
  tool_calls:[{id:'native-1',type:'function',function:{name:'workspaceData',arguments:'{}'}}]},
  {role:'tool',name:'workspaceData',tool_call_id:'native-1',content:'{"ok":true}'}];
 for(const primaryModel of [ZEN_PRIMARY_MODEL,CF_PRIMARY_MODEL]){
  let body;const ai=provider(async(url,init)=>{if(String(url).includes('generativelanguage'))return gemini('',{status:503});body=JSON.parse(init.body);return openRouter('Read completed');},
   {primaryModel:primaryModel===OPENROUTER_FREE_MODEL?DEFAULT_EXTRACTION_MODEL:primaryModel,fallbackModel:primaryModel===OPENROUTER_FREE_MODEL?OPENROUTER_FREE_MODEL:null,maxAttempts:1,cfApiToken:'isolated',cfAccountId:'isolated'});
  await ai.generate({messages});
  assert.doesNotMatch(JSON.stringify(body),/private-google-signature|googleParts/);
  assert.deepEqual(body.messages,messages.map(({googleParts,...rest})=>rest));
 }
});

test('Cloudflare preserves actual tool history without fabricated native signatures',async()=>{
  let sent;const ai=provider(async(url,init)=>{sent=JSON.parse(init.body);return openRouter('Read completed');},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  const call={id:'foreign-1',type:'function',function:{name:'workspaceData',arguments:'{}'}};const messages=[{role:'user',content:'Read invoice'},{role:'assistant',content:'',tool_calls:[call]},{role:'tool',tool_call_id:call.id,name:'workspaceData',content:'{"ok":true}'}];
  await ai.generate({messages});assert.deepEqual(sent.messages,messages);assert.doesNotMatch(JSON.stringify(sent),/thoughtSignature|functionResponse|"functionCall"/);
});

test('Cloudflare cannot lend selected attachment success to archived unexecuted native calls',async()=>{
  let sent;const ai=provider(async(url,init)=>{sent=JSON.parse(init.body);return openRouter('Saved');},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'test',cfApiToken:'test'});
  const call={id:'selected',type:'function',function:{name:'workspaceData',arguments:'{"operation":"saveAttachment"}'}};
  await ai.generate({messages:[{role:'user',content:'Log invoice'},{role:'assistant',content:'',googleParts:[{functionCall:{id:'extra-update',name:'workspaceData',args:{total:999}}}],tool_calls:[call]},{role:'tool',tool_call_id:'selected',content:'{"ok":true,"completed":true}'}]});
  assert.deepEqual(sent.messages[1].tool_calls,[call]);assert.doesNotMatch(JSON.stringify(sent),/extra-update|googleParts|999/);
});
