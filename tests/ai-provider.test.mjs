import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIError, AIProvider, DEFAULT_EXTRACTION_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL,
  DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, OPENROUTER_FREE_MODEL,
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
  return new AIProvider({primaryModel:DEFAULT_MODEL,fallbackModel:DEFAULT_FALLBACK_MODEL,geminiApiKey:'gemini-test-secret',openRouterApiKey:'router-test-secret',fetchImpl,retryDelayMs:1,sleepImpl:async()=>{},...options});
}

test('configuration exposes Gemini primary and only the free OpenRouter fallback',()=>{
  assert.equal(DEFAULT_MODEL,'gemini-3.5-flash');
  assert.equal(DEFAULT_FALLBACK_MODEL,'openrouter/free');
  assert.equal(DEFAULT_EXTRACTION_MODEL,'gemini-3.5-flash-lite');
  assert.equal(DEFAULT_EXTRACTION_FALLBACK_MODEL,'openrouter/free');
  assert.equal(isPrimaryModelId(DEFAULT_MODEL),true);
  assert.equal(isPrimaryModelId(OPENROUTER_FREE_MODEL),false);
  assert.equal(isFallbackModelId(OPENROUTER_FREE_MODEL),true);
  assert.equal(isFallbackModelId(DEFAULT_MODEL),false);
  assert.equal(isModelId(DEFAULT_MODEL),true);
  assert.equal(isModelId(OPENROUTER_FREE_MODEL),true);
  assert.equal(isModelId('openai/gpt-4.1-mini'),false);
  assert.deepEqual(sanitizeModelSettings({primaryModel:'openrouter/free',fallbackModel:'gemini-3.5-flash'}),{primaryModel:DEFAULT_MODEL,fallbackModel:DEFAULT_FALLBACK_MODEL});
});

test('Gemini primary sends native generation settings and normalizes text and function calls',async()=>{
  let sentUrl,sent;
  const ai=provider(async(url,init)=>{
    sentUrl=String(url);sent=JSON.parse(init.body);
    return gemini('',{parts:[{text:'Overdue count is two.'},{functionCall:{name:'getOverdueInvoices',args:{dueDateFrom:'2026-09-01'}}}]});
  },{fallbackModel:null});
  const result=await ai.generate({messages:[{role:'system',content:'Use tools.'},{role:'user',content:'Overdue?'}],tools:[{type:'function',function:{name:'getOverdueInvoices',description:'List overdue',parameters:{type:'object',properties:{},additionalProperties:false}}}],toolChoice:'required',maxTokens:64,temperature:0});
  assert.match(sentUrl,/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash:generateContent\?key=gemini-test-secret/);
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
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('ok')},{fallbackModel:null});
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
  const ai=provider(async()=>{calls++;return gemini('unused')},{fallbackModel:null});
  await assert.rejects(ai.generate({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,not-valid!'}}]}]}),error=>error.code==='INVALID_ARGUMENT');
  await assert.rejects(ai.generate({messages:[{role:'user',content:'x'.repeat(15*1024*1024+1)}]}),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(calls,0);
});

test('retries Gemini failures twice then uses only the configured OpenRouter free fallback',async()=>{
  const calls=[];
  const ai=provider(async(url,init)=>{
    const target=String(url).includes('generativelanguage')?'gemini':'openrouter';
    calls.push(target);
    return target==='gemini'?gemini('',{status:503}):openRouter('Recovered');
  });
  const result=await ai.generate({messages:[{role:'user',content:'Hi'}]});
  assert.deepEqual(calls,['gemini','gemini','openrouter']);
  assert.equal(result.content,'Recovered');
  assert.equal(result.model,'openrouter/free');
  assert.equal(result.usedFallback,true);
});

test('OpenRouter fallback uses the free endpoint contract and keeps credentials out of the URL',async()=>{
  let captured;
  const ai=provider(async(url,init)=>{
    if(String(url).includes('generativelanguage'))return gemini('',{status:503});
    captured={url:String(url),init,body:JSON.parse(init.body)};
    return openRouter('Recovered');
  },{maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'Can you summarize this?'}],maxTokens:123});
  assert.equal(captured.url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization,'Bearer router-test-secret');
  assert.equal(captured.body.model,OPENROUTER_FREE_MODEL);
  assert.equal(captured.body.max_tokens,123);
  assert.deepEqual(captured.body.messages,[{role:'user',content:'Can you summarize this?'}]);
  assert.equal(captured.url.includes('router-test-secret'),false);
  assert.equal(result.content,'Recovered');
  assert.equal(result.usedFallback,true);
});

test('OpenRouter fallback receives required Assistant tools and normalizes its function call',async()=>{
  const definition={type:'function',function:{name:'getOverdueInvoices',description:'List overdue invoices',parameters:{type:'object',properties:{},additionalProperties:false}}};
  const returned=[{id:'call-or-1',type:'function',function:{name:'getOverdueInvoices',arguments:'{"dueDateFrom":"2026-09-01"}'}}];
  let fallbackBody;
  const ai=provider(async(url,init)=>{
    if(String(url).includes('generativelanguage'))return gemini('',{status:503});
    fallbackBody=JSON.parse(init.body);
    return openRouter('',{toolCalls:returned});
  },{maxAttempts:1});
  const result=await ai.generate({messages:[{role:'user',content:'List overdue invoices'}],tools:[definition],toolChoice:'required'});
  assert.equal(fallbackBody.model,OPENROUTER_FREE_MODEL);
  assert.deepEqual(fallbackBody.tools,[definition]);
  assert.equal(fallbackBody.tool_choice,'required');
  assert.deepEqual(result.toolCalls,returned);
  assert.equal(result.usedFallback,true);
});

test('OpenRouter fallback receives structured extraction schema and its output is validated',async()=>{
  let fallbackBody;
  const ai=provider(async(url,init)=>{
    if(String(url).includes('generativelanguage'))return gemini('',{status:503});
    fallbackBody=JSON.parse(init.body);
    return openRouter('{"invoiceNumber":"INV-1048","total":84600.00}');
  },{primaryModel:DEFAULT_EXTRACTION_MODEL,maxAttempts:1});
  const result=await ai.generateStructured({
    messages:[{role:'user',content:'Extract invoice number and total.'}],
    name:'invoice_extraction',
    schema:{type:'object',required:['invoiceNumber','total'],properties:{invoiceNumber:{type:'string'},total:{type:'number'}}},
    validate:value=>{
      if(typeof value.invoiceNumber!=='string'||!Number.isFinite(value.total)||value.total<0)throw new TypeError('invalid extracted invoice');
      return {invoiceNumber:value.invoiceNumber,total:value.total};
    },
  });
  assert.equal(fallbackBody.model,OPENROUTER_FREE_MODEL);
  assert.equal(fallbackBody.response_format.type,'json_schema');
  assert.equal(fallbackBody.response_format.json_schema.name,'invoice_extraction');
  assert.deepEqual(result.data,{invoiceNumber:'INV-1048',total:84600});
  assert.equal(result.usedFallback,true);
});

test('network failures and abort timeouts can use the one configured fallback',async()=>{
  const networkCalls=[];
  const network=provider(async url=>{
    if(String(url).includes('generativelanguage')){networkCalls.push('gemini');throw Error('private transport detail');}
    networkCalls.push('openrouter');return openRouter('network recovered');
  },{maxAttempts:1});
  assert.equal((await network.generate({messages:[{role:'user',content:'Hi'}]})).content,'network recovered');
  assert.deepEqual(networkCalls,['gemini','openrouter']);

  const timeoutCalls=[];
  const timeout=provider((url,init)=>{
    if(String(url).includes('generativelanguage')){
      timeoutCalls.push('gemini');
      return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));
    }
    timeoutCalls.push('openrouter');return Promise.resolve(openRouter('timeout recovered'));
  },{timeoutMs:5,maxAttempts:1});
  assert.equal((await timeout.generate({messages:[{role:'user',content:'Hi'}]})).content,'timeout recovered');
  assert.deepEqual(timeoutCalls,['gemini','openrouter']);
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
  assert.deepEqual(calls,['gemini','gemini','openrouter','openrouter']);
  assert.deepEqual(waits,[1,1]);
});

test('authentication errors do not fall back and provider bodies never escape',async()=>{
  let calls=0;
  const ai=provider(async()=>{calls++;return gemini('',{status:401});});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='AUTH_FAILED'&&!/private upstream/.test(error.message));
  assert.equal(calls,1);
});

test('null fallback disables fallback instead of silently adding OpenRouter',async()=>{
  const calls=[];
  const ai=provider(async url=>{calls.push(String(url));return gemini('',{status:503});},{fallbackModel:null,maxAttempts:1});
  await assert.rejects(ai.generate({messages:[{role:'user',content:'Hi'}]}),error=>error.code==='PROVIDER_UNAVAILABLE');
  assert.equal(calls.length,1);assert.match(calls[0],/generativelanguage/);
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
  const ai=provider(async(_url,init)=>{sent=JSON.parse(init.body);return gemini('{"value":"clean","extra":"discard"}')},{fallbackModel:null});
  const result=await ai.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object',properties:{value:{type:'string'}}},validate:value=>({value:value.value}),maxTokens:64});
  assert.equal(sent.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(sent.generationConfig.responseJsonSchema,{type:'object',properties:{value:{type:'string'}}});
  assert.deepEqual(result.data,{value:'clean'});assert.equal(result.model,DEFAULT_MODEL);assert.equal(result.usedFallback,false);
});

test('malformed or oversized structured output is rejected without retry or fallback',async()=>{
  let calls=0;
  const malformed=provider(async()=>{calls++;return gemini('not json')});
  await assert.rejects(malformed.generateStructured({messages:[{role:'user',content:'Return data'}],name:'sample',schema:{type:'object'},validate:value=>value}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(calls,1);
  const oversized=provider(async()=>{calls++;return gemini('{"value":"x"}')});
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
  assert.deepEqual(await verifyModel(DEFAULT_MODEL,{fetchImpl,geminiApiKey:'gemini-key'}),{id:DEFAULT_MODEL,provider:'google'});
  assert.deepEqual(await verifyModel(OPENROUTER_FREE_MODEL,{fetchImpl,openRouterApiKey:'router-key'}),{id:OPENROUTER_FREE_MODEL,provider:'openrouter'});
  assert.match(requests[0].url,/models\/gemini-3\.5-flash\?key=gemini-key/);
  assert.equal(requests[0].init.headers,undefined);
  assert.equal(requests[1].url,'https://openrouter.ai/api/v1/models');
  assert.equal(requests[1].init.headers,undefined);
  let called=false;
  await assert.rejects(verifyModel('openai/gpt-4.1-mini',{fetchImpl:async()=>{called=true;}}),error=>error.code==='INVALID_MODEL');
  assert.equal(called,false);
});
