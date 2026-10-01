import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIError, AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
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
  assert.deepEqual(result.toolCalls,[{id:'gemini-call-0',type:'function',function:{name:'getOverdueInvoices',arguments:'{"dueDateFrom":"2026-09-01"}'}}]);
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
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,fallbackModel:DEFAULT_EXTRACTION_FALLBACK_MODEL});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Extract this invoice'}]}),error=>error.code==='PROVIDER_UNAVAILABLE');
  assert.deepEqual(calls,['gemini','gemini','openrouter','openrouter']);
});

test('oversized upstream responses are rejected with a safe bounded error',async()=>{
  const ai=provider(async()=>new Response('x'.repeat(4*1024*1024+1),{status:200}),{fallbackModel:null,maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='INVALID_RESPONSE'&&!/xxxx/.test(error.message));
});

test('bounded retries preserve explicit rate limits and hide upstream response bodies',async()=>{
  const calls=[],waits=[];
  const ai=provider(async url=>{calls.push(String(url).includes('generativelanguage')?'gemini':'openrouter');return gemini('',{status:429});},{sleepImpl:async ms=>waits.push(ms)});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>{
    assert.ok(error instanceof AIError);assert.equal(error.code,'RATE_LIMITED');assert.equal(error.status,429);
    assert.match(error.message,/temporarily rate limited/);assert.doesNotMatch(error.message,/private upstream/);return true;
  });
  assert.deepEqual(calls,['openrouter','openrouter','openrouter','openrouter','gemini','gemini']);
  assert.deepEqual(waits,[1,1,1]);
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
  assert.deepEqual(logs,[
    {message:'AI provider leg failed:',details:{provider:'opencode-zen',model:ZEN_PRIMARY_MODEL,status:401,reason:'permission_denied'}},
    {message:'AI provider leg failed:',details:{provider:'opencode-zen',model:ZEN_FALLBACK_MODEL,status:403,reason:'permission_denied'}},
    {message:'AI provider request served:',details:{provider:'google',model:GEMINI_FALLBACK_MODEL}},
  ]);
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
  assert.deepEqual(logs,[{message:'AI provider leg failed:',details:{provider:'google',model:DEFAULT_EXTRACTION_MODEL,status:400,reason:'schema_complexity'}}]);
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
  assert.throws(()=>provider(fetchImpl,{fallbackModel:'gemini-3.5-flash-lite'}),error=>error.code==='INVALID_MODEL');
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
