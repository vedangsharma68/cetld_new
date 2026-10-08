import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {AIProvider,DEFAULT_MODEL,DEFAULT_FALLBACK_MODEL,ZEN_MIMO_MODEL,ZEN_MUSE_MODEL,CF_PRIMARY_MODEL,GEMINI_FALLBACK_MODEL,
  VERIFIED_MODEL_CATALOG,isModelId,isRetiredModelId,sanitizeModelSettings,verifyModel} from '../ai/provider.mjs';
import {zenResponsesRequest,zenResponsesResult} from '../ai/zen-responses.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
const retired='longcat-2.5-preview-free';
const logger={info(){},warn(){}};
const response=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const final=text=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]});
const nativeCall=(id,name='workspaceData')=>({type:'function_call',id:'fc_'+id,call_id:id,name,arguments:'{"operation":"read"}',status:'completed'});
const chatCall=id=>({id,type:'function',function:{name:'workspaceData',arguments:'{"operation":"read"}'}});
const tools=[{type:'function',function:{name:'workspaceData',description:'Scoped workspace tool',parameters:{type:'object',properties:{operation:{type:'string'}}}}}];
const ai=(model,fetchImpl,options={})=>new AIProvider({primaryModel:model,fallbackModel:null,zenApiKey:'isolated-zen',geminiApiKey:'isolated-google',
  cfAccountId:'isolated-account',cfApiToken:'isolated-cf',maxAttempts:1,logger,fetchImpl,...options});

test('new free choices expose documented vision without changing the default or selecting new recovery models',async()=>{
  assert.equal(DEFAULT_MODEL,'space-bunny-free');assert.equal(DEFAULT_FALLBACK_MODEL,null);
  assert.equal(isModelId(retired),false);assert.equal(isRetiredModelId(retired),true);
  for(const id of [ZEN_MIMO_MODEL,ZEN_MUSE_MODEL]){
    const entry=VERIFIED_MODEL_CATALOG.find(item=>item.id===id);assert.deepEqual(entry.roles,['primary','fallback']);
    assert.equal(entry.supportsVision,true);assert.equal(entry.visionVerification,'upstream-documented');
    assert.deepEqual(await verifyModel(id,{zenApiKey:'isolated',fetchImpl:()=>{throw Error('No model probe');}}),{id,provider:'opencode-zen'});
  }
  const calls=[];
  await assert.rejects(ai(DEFAULT_MODEL,async(_url,init)=>{calls.push(JSON.parse(init.body).model);return new Response('{}',{status:503});}).generate({messages:[{role:'user',content:'Hello'}]}));
  assert.deepEqual(calls,[DEFAULT_MODEL]);
});

test('retired raw selections survive sanitization and retired-only generation fails before fetch',async()=>{
  assert.deepEqual(sanitizeModelSettings({primaryModel:DEFAULT_MODEL,fallbackModel:retired}),{primaryModel:DEFAULT_MODEL,fallbackModel:retired});
  assert.deepEqual(sanitizeModelSettings({primaryModel:retired,fallbackModel:GEMINI_FALLBACK_MODEL}),{primaryModel:retired,fallbackModel:GEMINI_FALLBACK_MODEL});
  assert.deepEqual(sanitizeModelSettings({primaryModel:retired}),{primaryModel:retired,fallbackModel:null});
  assert.deepEqual(sanitizeModelSettings({primaryModel:retired,fallbackModel:'unknown'}),{primaryModel:retired,fallbackModel:null});
  let calls=0;
  await assert.rejects(ai(retired,()=>{calls++;throw Error('No retired model');}).generate({messages:[{role:'user',content:'Hello'}]}),error=>error.code==='INVALID_MODEL');
  assert.equal(calls,0);
  const valid=ai(retired,async url=>{calls++;assert.match(url,/gemini-3\.5-flash/);return response({candidates:[{content:{parts:[{text:'Existing selected backup'}]}}]});},{fallbackModel:GEMINI_FALLBACK_MODEL});
  assert.equal((await valid.generate({messages:[{role:'user',content:'Hello'}]})).content,'Existing selected backup');assert.equal(calls,1);
});

test('retired environment defaults cannot reintroduce retired catalog entries or activate a replacement',()=>{
  const script=`import {VERIFIED_MODEL_CATALOG,isModelId,sanitizeModelSettings,DEFAULT_MODEL,AIProvider} from './ai/provider.mjs';
    const provider=new AIProvider({fallbackModel:null,fetchImpl:()=>{throw Error('No retired request');}});
    let code;try{await provider.generate({messages:[{role:'user',content:'Hi'}]});}catch(error){code=error.code;}
    console.log(JSON.stringify({allowed:isModelId(DEFAULT_MODEL),retiredCatalog:VERIFIED_MODEL_CATALOG.some(item=>item.id===DEFAULT_MODEL),settings:sanitizeModelSettings({primaryModel:DEFAULT_MODEL}),code}));`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{ZEN_PRIMARY_MODEL:retired},encoding:'utf8'}));
  assert.deepEqual(result,{allowed:false,retiredCatalog:false,settings:{primaryModel:retired,fallbackModel:null},code:'INVALID_MODEL'});
});

test('Muse uses native typed Responses text, image and PDF with private bearer credentials and no server session',async()=>{
  let wire;
  const provider=ai(ZEN_MUSE_MODEL,async(url,init)=>{assert.equal(url,'https://opencode.ai/zen/v1/responses');assert.equal(init.headers.Authorization,'Bearer isolated-zen');
    assert(!url.includes('isolated-zen'));wire=JSON.parse(init.body);return response(final('Read document'));});
  assert.equal((await provider.generate({messages:[{role:'system',content:'Read carefully'},{role:'assistant',content:'Previous reply'},
    {role:'user',content:[{type:'text',text:'Read image and PDF'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}},
      {type:'file',file:{filename:'invoice.pdf',file_data:'data:application/pdf;base64,JVBERg=='}}]}],maxTokens:120,tools,toolChoice:'required'})).content,'Read document');
  assert.equal(wire.max_output_tokens,120);assert.equal(wire.max_tokens,undefined);assert.equal(wire.messages,undefined);
  assert.equal(wire.store,false);assert.equal(wire.previous_response_id,undefined);assert.deepEqual(wire.include,['reasoning.encrypted_content']);
  assert.equal(wire.input[1].content[0].type,'output_text');assert.equal(wire.input[2].content[1].type,'input_image');assert.equal(wire.input[2].content[2].type,'input_file');
  assert.equal(wire.tools[0].name,'workspaceData');assert.equal(wire.tools[0].function,undefined);assert.equal(wire.tool_choice,'auto');
});

test('Muse native opaque reasoning and commentary survive tool continuation without entering the answer',async()=>{
  const output=[{type:'reasoning',id:'rs_one',summary:[],encrypted_content:'opaque-private'},
    {type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Private tool preamble'}]},nativeCall('call_one')];
  let calls=0;
  const provider=ai(ZEN_MUSE_MODEL,async(_url,init)=>{
    const body=JSON.parse(init.body);calls++;
    if(calls===1)return response({status:'completed',output});
    assert.deepEqual(body.input.slice(1,4),output);assert.deepEqual(body.input.at(-1),{type:'function_call_output',call_id:'call_one',output:'{"ok":true}'});
    return response(final('Verified answer'));
  });
  const messages=[{role:'user',content:'Read workspace'}];
  const first=await provider.generate({messages,tools,toolChoice:'required'});assert.equal(first.content,'');assert.equal(first.toolCalls[0].id,'call_one');
  messages.push({role:'assistant',content:first.content,tool_calls:first.toolCalls,zenResponsesOutput:first.zenResponsesOutput,zenResponsesModel:first.zenResponsesModel},
    {role:'tool',tool_call_id:'call_one',content:'{"ok":true}'});
  assert.equal((await provider.generate({messages})).content,'Verified answer');assert.equal(calls,2);
});

test('Responses batch replay pairs every original call with aggregate evidence or explicit nonexecution',()=>{
  const original=[nativeCall('first'),nativeCall('second')];
  for(const coalesced of [true,false]){
    const request=zenResponsesRequest(ZEN_MUSE_MODEL,[{role:'assistant',content:'',tool_calls:[chatCall('first')],
      zenResponsesModel:ZEN_MUSE_MODEL,zenResponsesOutput:original,zenResponsesBatchCoalesced:coalesced},
      {role:'tool',tool_call_id:'first',content:'{"ok":true,"completed":true}'}]);
    const results=request.input.filter(item=>item.type==='function_call_output');assert.deepEqual(results.map(item=>item.call_id),['first','second']);
    assert.equal(JSON.parse(results[1].output).ok,coalesced);if(!coalesced)assert.equal(JSON.parse(results[1].output).code,'NOT_EXECUTED');
  }
});

test('synthetic Responses history gets bounded paired IDs and commentary phase; orphan tools fail closed',()=>{
  const id='cross-provider-id-'.repeat(8);
  const body=zenResponsesRequest(ZEN_MUSE_MODEL,[{role:'assistant',content:'Check now',tool_calls:[chatCall(id)]},{role:'tool',tool_call_id:id,content:'{}'}]);
  assert.equal(body.input[0].phase,'commentary');assert(body.input[1].call_id.length<=64);assert.equal(body.input[1].call_id,body.input[2].call_id);
  assert.throws(()=>zenResponsesRequest(ZEN_MUSE_MODEL,[{role:'tool',tool_call_id:'orphan',content:'{}'}]));
});

test('opaque metadata never leaks to other provider wires or across Muse model identity',async()=>{
  const message={role:'assistant',content:'Previous',zenResponsesModel:'other-model',zenResponsesOutput:[{type:'reasoning',encrypted_content:'do-not-leak'}],
    zenChatModel:ZEN_MIMO_MODEL,zenChatReasoningContent:'do-not-leak',zenChatToolCalls:[]};
  for(const model of [DEFAULT_MODEL,CF_PRIMARY_MODEL,GEMINI_FALLBACK_MODEL,ZEN_MUSE_MODEL]){
    await ai(model,async(_url,init)=>{assert(!init.body.includes('do-not-leak'));assert(!init.body.includes('zenResponses'));assert(!init.body.includes('zenChat'));
      return response(model===ZEN_MUSE_MODEL?final('Answer'):model===GEMINI_FALLBACK_MODEL?{candidates:[{content:{parts:[{text:'Answer'}]}}]}:{choices:[{message:{content:'Answer'}}]});
    }).generate({messages:[message,{role:'user',content:'Continue'}]});
  }
});

test('MiMo preserves image and native tool reasoning replay while keeping reasoning out of content',async()=>{
  let count=0;
  const native=[chatCall('one'),chatCall('two')];
  const provider=ai(ZEN_MIMO_MODEL,async(url,init)=>{
    assert.equal(url,'https://opencode.ai/zen/v1/chat/completions');const body=JSON.parse(init.body);count++;
    if(count===1){assert.equal(body.messages[0].content[0].type,'image_url');return response({choices:[{message:{content:'',reasoning_content:'private reasoning',tool_calls:native}}]});}
    const assistant=body.messages.find(message=>message.role==='assistant');assert.equal(assistant.reasoning_content,'private reasoning');assert.deepEqual(assistant.tool_calls,native);
    assert.deepEqual(body.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['one','two']);
    return response({choices:[{message:{content:'Verified answer',reasoning_content:'Never display this'}}]});
  });
  const messages=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}];
  const first=await provider.generate({messages,tools});assert.equal(first.content,'');
  messages.push({role:'assistant',content:'',tool_calls:[first.toolCalls[0]],zenChatModel:first.zenChatModel,zenChatReasoningContent:first.zenChatReasoningContent,
    zenChatToolCalls:first.zenChatToolCalls,zenChatBatchCoalesced:true},{role:'tool',tool_call_id:'one',content:'{"ok":true}'});
  assert.equal((await provider.generate({messages})).content,'Verified answer');
});

test('MiMo cross-provider tool history disables thinking instead of fabricating unavailable reasoning',async()=>{
  let wire;
  await ai(ZEN_MIMO_MODEL,async(_url,init)=>{wire=JSON.parse(init.body);return response({choices:[{message:{content:'Answer'}}]});}).generate({
    messages:[{role:'assistant',content:'',tool_calls:[chatCall('other-provider')]},{role:'tool',tool_call_id:'other-provider',content:'{}'}],maxTokens:90});
  assert.deepEqual(wire.thinking,{type:'disabled'});assert.equal(wire.max_completion_tokens,90);assert.equal(wire.max_tokens,undefined);
  assert.equal(wire.messages[0].reasoning_content,undefined);
});

test('Responses strict structured output translates schema and rejects truncated JSON',async()=>{
  const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};let wire;
  const provider=ai(ZEN_MUSE_MODEL,async(_url,init)=>{wire=JSON.parse(init.body);return response(final('{"value":"ok"}'));});
  assert.deepEqual((await provider.generateStructured({messages:[{role:'user',content:'JSON'}],schema,name:'sample',validate:value=>value,maxTokens:80})).data,{value:'ok'});
  assert.deepEqual(wire.text.format,{type:'json_schema',name:'sample',strict:true,schema});assert.equal(wire.response_format,undefined);
  const truncated=ai(ZEN_MUSE_MODEL,async()=>response({...final('{"value":"ok"}'),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}));
  await assert.rejects(truncated.generateStructured({messages:[{role:'user',content:'JSON'}],schema,name:'sample',validate:value=>value}),error=>error.code==='INVALID_OUTPUT');
});

test('invalid or partial Responses function calls and malformed image input never execute',async()=>{
  for(const body of [{status:'incomplete',output:[nativeCall('one')]},{status:'completed',output:[nativeCall('x'.repeat(65))]},
    {status:'completed',output:[{type:'reasoning',summary:[{text:'private'}]}]}])assert.throws(()=>zenResponsesResult(body,ZEN_MUSE_MODEL,false));
  let fetches=0;
  await assert.rejects(ai(ZEN_MUSE_MODEL,()=>{fetches++;}).generate({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,invalid!'}}]}]}),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(fetches,0);
});

for(const model of [ZEN_MUSE_MODEL,ZEN_MIMO_MODEL])test(`${model} owner checkpoint retains native parallel calls across coalescing and resume`,async()=>{
  const args=index=>JSON.stringify({operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'Customer '+index}],values:{company_name:'Updated company'}});
  const nativeCalls=[chatCall('checkpoint_one'),chatCall('checkpoint_two')].map((call,index)=>({...call,function:{...call.function,arguments:args(index)}}));
  const museOutput=[{type:'reasoning',summary:[],encrypted_content:'checkpoint-opaque'},
    {type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Internal preamble'}]},
    ...nativeCalls.map(call=>({...nativeCall(call.id),arguments:call.function.arguments}))];
  let requests=0,executions=0,saved=null;
  const provider=ai(model,async(_url,init)=>{
    requests++;const body=JSON.parse(init.body);
    if(requests===1)return response(model===ZEN_MUSE_MODEL?{status:'completed',output:museOutput}:
      {choices:[{message:{content:'',reasoning_content:'checkpoint-reasoning',tool_calls:nativeCalls}}]});
    if(model===ZEN_MUSE_MODEL){
      assert.deepEqual(body.input.filter(item=>item.type==='function_call').map(item=>item.call_id),['checkpoint_one','checkpoint_two']);
      assert.deepEqual(body.input.filter(item=>item.type==='function_call_output').map(item=>item.call_id),['checkpoint_one','checkpoint_two']);
      assert(body.input.some(item=>item.encrypted_content==='checkpoint-opaque'));
    }else{
      assert.deepEqual(body.messages.find(item=>item.tool_calls)?.tool_calls,nativeCalls);
      assert.equal(body.messages.find(item=>item.tool_calls)?.reasoning_content,'checkpoint-reasoning');
      assert.deepEqual(body.messages.filter(item=>item.role==='tool').map(item=>item.tool_call_id),['checkpoint_one','checkpoint_two']);
    }
    return response(model===ZEN_MUSE_MODEL?final('I could not complete those changes.'):{choices:[{message:{content:'I could not complete those changes.'}}]});
  });
  const toolset={definitions:tools,async execute(_name,argumentsObject){executions++;assert.equal(argumentsObject.operations.length,2);
    return {ok:false,code:'STALE',rolledBack:true};}};
  const input={provider,tools:toolset,message:'Update the company names for both customers.',allowDeferred:true,
    onCheckpoint:async checkpoint=>{saved=structuredClone(checkpoint);}};
  const first=await runOwnerAgent(input);assert(first.answer);assert.equal(executions,1);assert.equal(saved.pendingToolCalls.length,0);
  const assistant=saved.transcript.find(item=>item.tool_calls);
  assert.equal(assistant.tool_calls.length,1);
  assert.equal(model===ZEN_MUSE_MODEL?assistant.zenResponsesBatchCoalesced:assistant.zenChatBatchCoalesced,true);
  const requestsBefore=requests;
  const resumed=await runOwnerAgent({...input,checkpoint:structuredClone(saved),tools:{definitions:tools,async execute(){throw Error('Completed batch must not rerun');}}});
  assert(resumed.answer);assert.equal(executions,1);assert(requests>requestsBefore);
});
