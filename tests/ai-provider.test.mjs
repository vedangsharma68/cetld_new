import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIError, AIProvider, CF_BACKUP_MODEL, CF_PRIMARY_MODEL, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, GEMINI_FALLBACK_MODEL, OPENROUTER_FREE_MODEL,
  ZEN_FALLBACK_MODEL, ZEN_PRIMARY_MODEL,
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
  return new AIProvider({primaryModel:DEFAULT_MODEL,fallbackModel:DEFAULT_FALLBACK_MODEL,geminiApiKey:'gemini-test-secret',openRouterApiKey:'router-test-secret',zenApiKey:'zen-test-secret',fetchImpl,retryDelayMs:1,sleepImpl:async()=>{},...options});
}

test('configuration exposes Space Bunny primary, LongCat fallback, and Gemini backup',()=>{
  assert.equal(DEFAULT_MODEL,ZEN_PRIMARY_MODEL);
  assert.equal(DEFAULT_FALLBACK_MODEL,ZEN_FALLBACK_MODEL);
  assert.equal(DEFAULT_EXTRACTION_MODEL,'gemini-3.5-flash-lite');
  assert.equal(DEFAULT_EXTRACTION_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL);
  assert.equal(isPrimaryModelId(DEFAULT_MODEL),true);
  assert.equal(isPrimaryModelId(ZEN_PRIMARY_MODEL),true);
  assert.equal(isFallbackModelId(ZEN_PRIMARY_MODEL),false);
  assert.equal(isFallbackModelId(ZEN_FALLBACK_MODEL),true);
  assert.equal(isFallbackModelId(GEMINI_FALLBACK_MODEL),true);
  assert.equal(isModelId(DEFAULT_MODEL),true);
  assert.equal(isModelId(ZEN_PRIMARY_MODEL),true);
  assert.equal(isModelId(ZEN_FALLBACK_MODEL),true);
  assert.equal(isModelId('openai/gpt-4.1-mini'),false);
  assert.deepEqual(sanitizeModelSettings({primaryModel:ZEN_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL}),{primaryModel:ZEN_PRIMARY_MODEL,fallbackModel:GEMINI_FALLBACK_MODEL});
});

test('Gemini extraction sends native generation settings and normalizes text and function calls',async()=>{
  let sentUrl,sent;
  const ai=provider(async(url,init)=>{
    sentUrl=String(url);sent=JSON.parse(init.body);
    return gemini('',{parts:[{text:'Overdue count is two.'},{functionCall:{name:'getOverdueInvoices',args:{dueDateFrom:'2026-09-01'}}}]});
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  const result=await ai.generate({messages:[{role:'system',content:'Use tools.'},{role:'user',content:'Overdue?'}],tools:[{type:'function',function:{name:'getOverdueInvoices',description:'List overdue',parameters:{type:'object',properties:{},additionalProperties:false}}}],toolChoice:'required',maxTokens:64,temperature:0});
  assert.match(sentUrl,/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent\?key=gemini-test-secret/);
  assert.deepEqual(sent.systemInstruction,{parts:[{text:'Use tools.'}]});
  assert.deepEqual(sent.contents,[{role:'user',parts:[{text:'Overdue?'}]}]);
  assert.equal(sent.generationConfig.maxOutputTokens,64);
  assert.equal(sent.generationConfig.temperature,0);
  assert.equal(sent.tools[0].functionDeclarations[0].name,'getOverdueInvoices');
  assert.deepEqual(sent.toolConfig,{functionCallingConfig:{mode:'ANY'}});
  assert.equal(result.content,'Overdue count is two.');
  assert.match(result.toolCalls[0].id,/^gemini-call-[a-f0-9-]+-0$/);
  assert.deepEqual(result.toolCalls[0].function,{name:'getOverdueInvoices',arguments:'{"dueDateFrom":"2026-09-01"}'});
  assert.equal(result.usedFallback,false);
});

test('Gemini image and PDF parts become bounded native inlineData payloads',async()=>{
  let sent;
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('ok')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await ai.generate({messages:[{role:'user',content:[
    {type:'text',text:'Read this invoice.'},
    {type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}},
    {type:'file',file:{filename:'invoice.pdf',file_data:'data:application/pdf;base64,JVBERi0xLjQ='}},
  ]}]});
  assert.deepEqual(sent.contents[0].parts,[
    {text:'Read this invoice.'},
    {inlineData:{mimeType:'image/png',data:'aGVsbG8='}},
    {inlineData:{mimeType:'application/pdf',data:'JVBERi0xLjQ='}},
  ]);
});

test('rejects malformed or oversized multimodal messages before contacting either provider',async()=>{
  let calls=0;
  const ai=provider(async()=>{calls++;return gemini('unused')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(ai.generate({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,not-valid!'}}]}]}),error=>error.code==='INVALID_ARGUMENT');
  await assert.rejects(ai.generate({messages:[{role:'user',content:'x'.repeat(15*1024*1024+1)}]}),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(calls,0);
});

test('retries Space Bunny failures twice then uses the configured LongCat fallback',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const model=JSON.parse(init.body).model;
    calls.push(model);
    return model===ZEN_PRIMARY_MODEL?openRouter('',{status:503}):openRouter('Recovered');
  });
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL]);
  assert.equal(result.content,'Recovered');
  assert.equal(result.model,ZEN_FALLBACK_MODEL);
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

test('Gemini Flash fallback receives structured extraction schema and its output is validated',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    calls.push(String(url));
    if(String(url).includes(DEFAULT_EXTRACTION_MODEL))return gemini('',{status:503});
    return gemini('{"invoiceNumber":"INV-1048","total":84600.00}');
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL,maxAttempts:1});
  const result=await ai.generateStructured({
    messages:[{role:'user',content:'Extract invoice number and total.'}], name:'invoice_extraction',
    schema:{type:'object',required:['invoiceNumber','total'],properties:{invoiceNumber:{type:'string'},total:{type:'number'}}},
    validate:value=>({invoiceNumber:value.invoiceNumber,total:value.total}),
  });
  assert.match(calls[0],/gemini-3.5-flash-lite/); assert.match(calls[1],/gemini-3.5-flash:/);
  assert.deepEqual(result.data,{invoiceNumber:'INV-1048',total:84600}); assert.equal(result.usedFallback,true);
});

test('Gemini Flash Lite chat retries its primary before using the configured fallback',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const model=String(url).includes('generativelanguage')
      ?decodeURIComponent(new URL(url).pathname.split('/models/')[1].split(':')[0])
      :JSON.parse(init.body).model;
    calls.push(model);
    return model===DEFAULT_EXTRACTION_MODEL?gemini('',{status:503}):openRouter('Recovered by the configured fallback');
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:ZEN_FALLBACK_MODEL});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[DEFAULT_EXTRACTION_MODEL,DEFAULT_EXTRACTION_MODEL,ZEN_FALLBACK_MODEL]);
  assert.equal(result.model,ZEN_FALLBACK_MODEL);
  assert.equal(result.usedFallback,true);
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
  assert.deepEqual(networkCalls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL]);

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
  assert.deepEqual(timeoutCalls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL]);
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

test('extraction tries Gemini Lite, Gemini Flash, then both Zen legs once',async()=>{
  const calls=[];
  const ai=provider(async url=>{
    calls.push(String(url).includes('generativelanguage')?'gemini':'openrouter');
    return calls.at(-1)==='gemini'?gemini('',{status:503}):openRouter('',{status:503});
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL,requestPurpose:'extraction'});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Extract this invoice'}]}),error=>error.code==='PROVIDER_UNAVAILABLE');
  assert.deepEqual(calls,['gemini','gemini','openrouter','openrouter']);
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
    assert.deepEqual(error.quotaProviders,['opencode-zen','google']);
    assert.match(error.message,/temporarily rate limited/);assert.doesNotMatch(error.message,/private upstream/);return true;
  });
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL]);
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

test('fails over in order from Space Bunny to LongCat to Gemini on 429 and 5xx',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const model=String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model;
    calls.push(model);
    if(model===ZEN_PRIMARY_MODEL)return openRouter('',{status:429});
    if(model===ZEN_FALLBACK_MODEL)return openRouter('',{status:503});
    return gemini('Gemini recovered');
  },{maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL]);
  assert.equal(result.model,GEMINI_FALLBACK_MODEL);
  assert.equal(result.content,'Gemini recovered');
});

test('missing Zen key skips both Zen legs and reaches the Gemini backup',async()=>{
  const calls=[];
  const ai=provider(async url=>{calls.push(String(url));return gemini('Gemini recovered');},{zenApiKey:'',maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.equal(result.model,GEMINI_FALLBACK_MODEL);
  assert.equal(calls.length,1);
  assert.match(calls[0],/generativelanguage/);
});

test('authentication failures advance once per leg from Space Bunny to LongCat to Gemini',async()=>{
  const calls=[],logs=[];
  const ai=provider(async(url,init)=>{
    const model=String(url).includes('generativelanguage')?GEMINI_FALLBACK_MODEL:JSON.parse(init.body).model;
    calls.push(model);
    if(model===ZEN_PRIMARY_MODEL)return openRouter('',{status:401});
    if(model===ZEN_FALLBACK_MODEL)return openRouter('',{status:403});
    return gemini('Gemini recovered');
  },{logger:{warn:(message,details)=>logs.push({message,details}),info:(message,details)=>logs.push({message,details})}});
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL]);
  assert.equal(result.model,GEMINI_FALLBACK_MODEL);
  assert.equal(result.content,'Gemini recovered');
  assert.deepEqual(logs.map(({message,details})=>({message,details:Object.fromEntries(Object.entries(details).filter(([key])=>key!=='durationMs'))})),[
    {message:'AI provider leg failed:',details:{provider:'opencode-zen',model:ZEN_PRIMARY_MODEL,status:401,reason:'permission_denied'}},
    {message:'AI provider leg failed:',details:{provider:'opencode-zen',model:ZEN_FALLBACK_MODEL,status:403,reason:'permission_denied'}},
    {message:'AI provider request served:',details:{provider:'google',model:GEMINI_FALLBACK_MODEL}},
  ]);
  assert.ok(logs.every(({details})=>Number.isFinite(details.durationMs)));
});

test('provider diagnostics classify schema complexity without retaining adversarial error text',async()=>{
  const secret='Acme Customer owes INR 98,765; prompt=password hunter2';
  const logs=[];
  const ai=provider(async()=>jsonResponse({error:{code:400,message:`Response schema exceeds complexity limit. ${secret}`}},400),
    {primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null,maxAttempts:1,
      logger:{warn:(message,details)=>logs.push({message,details})}});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'private invoice'}]}),error=>{
    assert.equal(error.code,'PROVIDER_ERROR');
    assert.equal(error.providerReason,'schema_complexity');
    assert.doesNotMatch(JSON.stringify(error),/Acme|98,765|hunter2|private invoice/);
    return true;
  });
  assert.equal(logs.length,1);
  assert.deepEqual(Object.fromEntries(Object.entries(logs[0].details).filter(([key])=>key!=='durationMs')),
    {provider:'google',model:DEFAULT_EXTRACTION_MODEL,status:400,reason:'schema_complexity'});
  assert.ok(Number.isFinite(logs[0].details.durationMs));
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
  assert.deepEqual(calls,[ZEN_PRIMARY_MODEL,ZEN_FALLBACK_MODEL,GEMINI_FALLBACK_MODEL]);
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
  assert.throws(()=>provider(fetchImpl,{primaryModel:ZEN_FALLBACK_MODEL}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_MODEL}),error=>error.code==='INVALID_MODEL');
  assert.throws(()=>provider(fetchImpl,{fallbackModel:'openai/gpt-4.1-mini'}),error=>error.code==='INVALID_MODEL');
  assert.equal(calls,0);
});

test('structured JSON uses Gemini schema configuration and returns validated data',async()=>{
  let sent;
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('{"value":"clean","extra":"discard"}')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  const result=await ai.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object',properties:{value:{type:'string'}}},validate:value=>({value:value.value}),maxTokens:64});
  assert.equal(sent.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(sent.generationConfig.responseJsonSchema,{type:'object',properties:{value:{type:'string'}}});
  assert.deepEqual(result.data,{value:'clean'});assert.equal(result.model,DEFAULT_EXTRACTION_MODEL);assert.equal(result.usedFallback,false);
});

test('opted-in Gemini planning JSON mode omits only the upstream schema and still rejects malformed output',async()=>{
  const wires=[];
  const ai=provider(async(_url,init)=>{wires.push(JSON.parse(init.body));return gemini('{"value":"clean"}')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  const input={messages:[{role:'user',content:'Return JSON data'}],name:'dynamic_plan',schema:{type:'object',properties:{value:{}}},geminiJsonMode:true,validate:value=>typeof value.value==='string'?{value:value.value}:undefined};
  assert.deepEqual((await ai.generateStructured(input)).data,{value:'clean'});
  assert.equal(wires[0].generationConfig.responseMimeType,'application/json');
  assert.equal(Object.hasOwn(wires[0].generationConfig,'responseJsonSchema'),false);
  assert.equal(Object.hasOwn(wires[0],'geminiJsonMode'),false);
  for(const text of ['not JSON','{"value":123}']){
    const invalid=provider(async()=>gemini(text),{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
    await assert.rejects(invalid.generateStructured(input),error=>error.code==='INVALID_OUTPUT');
  }
});

test('Gemini planning option stays private on Cloudflare and preserves its strict schema',async()=>{
  let sent;
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return openRouter('{"value":"clean"}')},{primaryModel:CF_PRIMARY_MODEL,fallbackModel:null,cfAccountId:'fixture',cfApiToken:'fixture'});
  const schema={type:'object',properties:{value:{type:'string'}}};
  await ai.generateStructured({messages:[{role:'user',content:'Return JSON'}],name:'sample',schema,geminiJsonMode:true,validate:value=>value});
  assert.equal(Object.hasOwn(sent,'geminiJsonMode'),false);assert.deepEqual(sent.response_format.json_schema.schema,schema);
});

test('quota-skipped Cloudflare planning falls back to Gemini JSON mode without an upstream schema',async()=>{
  let calls=0;
  const ai=provider(async(url,init)=>{calls++;assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');
    const body=JSON.parse(init.body);assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(Object.hasOwn(body.generationConfig,'responseJsonSchema'),false);
    return gemini('{"value":"clean"}');
  },{primaryModel:CF_PRIMARY_MODEL,fallbackModel:CF_BACKUP_MODEL,cfAccountId:'fixture',cfApiToken:'fixture',
    healthStore:{async getUnavailableUntil(identity){return identity.provider==='cloudflare'?Date.now()+60000:null;},async markUnavailable(){}}});
  const result=await ai.generateStructured({messages:[{role:'user',content:'Return JSON'}],name:'dynamic_plan',schema:{type:'object'},geminiJsonMode:true,validate:value=>value});
  assert.equal(calls,1);assert.equal(result.usedFallback,true);assert.equal(result.model,GEMINI_FALLBACK_MODEL);assert.deepEqual(result.data,{value:'clean'});
});

test('malformed or oversized structured output is rejected when fallback is disabled',async()=>{
  let calls=0;
  const malformed=provider(async()=>{calls++;return gemini('not json')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(malformed.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object'},validate:value=>value}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(calls,1);
  const oversized=provider(async()=>{calls++;return gemini('{"value":"x"}')},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
  await assert.rejects(oversized.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object'},validate:()=>({value:'x'.repeat(256*1024+1)})}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(calls,2);
});

test('catalog verification uses Gemini generation methods and the OpenRouter free catalog',async()=>{
  const requests=[];
  const fetchImpl=async(url,init)=>{
    requests.push({url:String(url),init});
    return String(url).includes('generativelanguage')
      ? jsonResponse({supportedGenerationMethods:['generateContent']})
      : jsonResponse({data:[{id:'openrouter/free'}]});
  };
  assert.deepEqual(await verifyModel(DEFAULT_MODEL,{fetchImpl,zenApiKey:'zen-key'}),{id:DEFAULT_MODEL,provider:'opencode-zen'});
  assert.deepEqual(await verifyModel(GEMINI_FALLBACK_MODEL,{fetchImpl,geminiApiKey:'gemini-key'}),{id:GEMINI_FALLBACK_MODEL,provider:'google'});
  assert.deepEqual(await verifyModel(OPENROUTER_FREE_MODEL,{fetchImpl,openRouterApiKey:'router-key'}),{id:OPENROUTER_FREE_MODEL,provider:'openrouter'});
  assert.match(requests[0].url,/models\/gemini-3\.5-flash\?key=gemini-key/);
  assert.equal(requests[0].init.headers,undefined);
  assert.equal(requests[1].url,'https://openrouter.ai/api/v1/models');
  assert.equal(requests[1].init.headers,undefined);
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

test('native Gemini preserves signed model parts and named function results with unique local call IDs',async()=>{
 const definition={type:'function',function:{name:'workspaceData',parameters:{type:'object',properties:{}}}};
 const parts=[{text:'private reasoning',thought:true},{functionCall:{name:'workspaceData',id:'google-original',args:{operation:'read'}},thoughtSignature:'c2lnbmF0dXJl'}];
 const sent=[];const ai=provider(async(_url,init)=>{sent.push(JSON.parse(init.body));return gemini('',{parts});},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
 const messages=[{role:'user',content:'Read invoice'}];
 const first=await ai.generate({messages,tools:[definition]});
 assert.equal(first.content,'');assert.deepEqual(first.googleParts,parts);
 const result={ok:true,operation:'read',table:'invoices',rows:[{invoice_number:'QA-1'}]};
 const second=await ai.generate({messages:[...messages,{role:'assistant',content:first.content,tool_calls:first.toolCalls,googleParts:first.googleParts},
  {role:'tool',name:'workspaceData',tool_call_id:first.toolCalls[0].id,content:JSON.stringify(result)}],tools:[definition]});
 assert.notEqual(first.toolCalls[0].id,second.toolCalls[0].id);
 assert.deepEqual(sent[1].contents[1],{role:'model',parts});
 assert.deepEqual(sent[1].contents[2],{role:'user',parts:[{functionResponse:{name:'workspaceData',id:'google-original',response:result}}]});
});

test('Gemini returns one verified coalesced result to the original parallel calls without forged signatures',async()=>{
 const parts=[{functionCall:{name:'workspaceData',args:{operation:'update',values:{due_date:'2026-10-20'}}},thoughtSignature:'c2ln'},
  {functionCall:{name:'workspaceData',args:{operation:'update',values:{issue_date:'2026-10-08'}}}}];
 let sent;const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('Done');},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
 const verified={ok:true,completed:true,operation:'batch',results:[{ok:true},{ok:true}]};
 await ai.generate({messages:[{role:'user',content:'Update dates'},{role:'assistant',content:'',googleParts:parts,googleBatchCoalesced:true,
  tool_calls:[{id:'batch',type:'function',function:{name:'workspaceData',arguments:'{"operations":[]}'}}]},
  {role:'tool',name:'workspaceData',tool_call_id:'batch',content:JSON.stringify(verified)}]});
 assert.deepEqual(sent.contents[1].parts,parts);
 assert.deepEqual(sent.contents[2].parts,parts.map(()=>({functionResponse:{name:'workspaceData',response:verified}})));
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

test('synthetic or cross-provider tool history becomes named context without fabricated native signatures',async()=>{
 let sent;const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('Read completed');},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
 const call={id:'foreign-1',type:'function',function:{name:'workspaceData',arguments:'{}'}};
 await ai.generate({messages:[{role:'user',content:'Read invoice'},{role:'assistant',content:'',tool_calls:[call]},
  {role:'tool',tool_call_id:call.id,name:'workspaceData',content:'{"ok":true}'}]});
 assert.deepEqual(JSON.parse(sent.contents[1].parts[0].text),{tool_calls:[call]});
 assert.deepEqual(JSON.parse(sent.contents[2].parts[0].text),{ok:true,toolName:'workspaceData',toolCallId:'foreign-1'});
 assert.doesNotMatch(JSON.stringify(sent),/thoughtSignature|functionResponse|"functionCall"/);
});

test('server-selected attachment call does not lend its success to unexecuted extra native calls',async()=>{
 const parts=[{functionCall:{id:'save-source',name:'workspaceData',args:{operation:'create'}}},
  {functionCall:{id:'extra-update',name:'workspaceData',args:{operation:'update',values:{total_amount:999}}}}];
 let sent;const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('Saved');},{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:null});
 await ai.generate({messages:[{role:'user',content:'Log this invoice'},{role:'assistant',content:'',googleParts:parts,
  tool_calls:[{id:'selected',type:'function',function:{name:'workspaceData',arguments:'{"operation":"saveAttachment"}'}}]},
  {role:'tool',name:'workspaceData',tool_call_id:'selected',content:'{"ok":true,"completed":true,"operation":"saveAttachment"}'}]});
 const replies=sent.contents[2].parts.map(p=>p.functionResponse);
 assert.equal(replies[0].id,'save-source');assert.equal(replies[0].response.completed,true);assert.equal(replies[0].response.operation,'saveAttachment');
 assert.equal(replies[1].id,'extra-update');assert.equal(replies[1].response.code,'NOT_EXECUTED');assert.equal(replies[1].response.ok,false);assert.equal(replies[1].response.completed,undefined);
});
