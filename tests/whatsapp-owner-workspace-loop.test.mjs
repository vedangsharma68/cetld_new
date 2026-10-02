import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const toolDefinition=(name)=>({type:'function',function:{name,description:'Workspace data tool',parameters:{type:'object',properties:{description:{type:'string'}},required:['description'],additionalProperties:false}}});
const call=(name,args={},id='call-1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const tools=(names=['workspaceData'],execute=async()=>({ok:true,result:'done'}))=>({definitions:names.map(toolDefinition),execute});
const answer=(content='I can help with that.')=>({content,model:'@cf/qwen/qwen3-30b-a3b-fp8',toolCalls:[]});

test('unknown tools get a corrective result and the model recovers in the same loop',async()=>{
 let calls=0,executionCount=0;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[{id:'unknown-1',type:'function',function:{name:'lookUpInvoices',arguments:'not-json'}}]};
  const result=request.messages.find(item=>item.role==='tool'&&item.tool_call_id==='unknown-1');
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.content),{
   ok:false,code:'UNKNOWN_TOOL',message:'That tool does not exist. Use workspaceData with a description of what you need.',
  });
  return answer('I can help with your workspace.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>{executionCount++;return {ok:true};}),message:'Check something'});
 assert.equal(calls,2);
 assert.equal(executionCount,0);
 assert.match(result.answer,/help with your workspace/);
});

test('the system prompt stays short and describes workspaceData generically',async()=>{
 let systemPrompt='',context;
 const provider={async generate(request){
  const system=request.messages.filter(item=>item.role==='system');
  systemPrompt=system[0]?.content||'';
  context=JSON.parse(system[1]?.content||'{}');
  return answer('Hello.');
 }};
 await runOwnerAgent({provider,tools:tools(),message:'',clock:()=>new Date('2026-10-02T12:00:00Z'),
  attachmentDescriptor:{available:true,mimeType:'image/jpeg'},historyIssue:'HISTORY_UNAVAILABLE',settingsIssue:'MODEL_SETTINGS_UNAVAILABLE'});
 assert.ok(systemPrompt.length<350,`system prompt was ${systemPrompt.length} characters`);
 assert.match(systemPrompt,/verified owner/i);
 assert.match(systemPrompt,/workspaceData/);
 assert.doesNotMatch(systemPrompt,/invoice|payment|delete|undo|attachment|confirmation/i);
 assert.deepEqual(context,{currentDate:'2026-10-02',attachment:{available:true,mimeType:'image/jpeg'},historyAvailable:false,settingsAvailable:false,toolsAvailable:true});
 const unavailable=await runOwnerAgent({provider:{async generate(request){
  const missingContext=JSON.parse(request.messages.filter(item=>item.role==='system')[1].content);
  assert.deepEqual(missingContext.attachment,{available:false,errorCode:'ATTACHMENT_UNAVAILABLE'});
  return answer('Please resend the attachment.');
 }},tools:tools(),message:'',attachmentDescriptor:{available:false,errorCode:'ATTACHMENT_UNAVAILABLE'}});
 assert.match(unavailable.answer,/resend the attachment/i);
});

test('a hung provider is aborted at the injected whole-loop budget',async()=>{
 let providerSignal;
 const provider={generate(request){
  providerSignal=request.signal;
  return new Promise(resolve=>setTimeout(()=>resolve(answer('late answer')),60));
 }};
 const result=await runOwnerAgent({provider,tools:tools(),message:'Hello',budgetMs:10});
 assert.equal(providerSignal.aborted,true);
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/too long|stopped/i);
});

test('a hung workspaceData call is bounded and reports uncertain write status',async()=>{
 let toolSignal,writeAttempted=false;
 const provider={async generate(){return {content:'',toolCalls:[call('workspaceData',{description:'update workspace settings'})]};}};
 const ownerTools=tools(['workspaceData'],(_name,_args,options)=>{
  writeAttempted=true;
  toolSignal=options?.signal;
  return new Promise(resolve=>setTimeout(()=>resolve({ok:true}),60));
 });
 ownerTools.getWriteAttempted=()=>writeAttempted;
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Change settings',budgetMs:10});
 assert.equal(toolSignal.aborted,true);
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/may still be processing|could not confirm/i);
 assert.match(result.answer,/check your workspace/i);
 assert.match(result.answer,/^That took too long/i);
 assert.match(result.answer,/smaller request/i);
});

test('a timed-out definite workspace read keeps the timeout reason without a write warning',async()=>{
 const provider={async generate(){return {content:'',toolCalls:[call('workspaceData',{operation:'describe'})]};}};
 const ownerTools=tools(['workspaceData'],()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true}),60)));
 ownerTools.getWriteAttempted=()=>false;
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Describe settings',budgetMs:10});
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/too long/i);
 assert.match(result.answer,/smaller request/i);
 assert.doesNotMatch(result.answer,/could not confirm|check your workspace/i);
});

test('provider and tool failures return safe planner failures without leaking details',async()=>{
 const providerFailure=await runOwnerAgent({
  provider:{async generate(){throw Object.assign(new Error('private upstream secret'),{code:'PROVIDER_UNAVAILABLE'});}},
  tools:tools(),message:'Hello',
 });
 assert.equal(providerFailure.plannerFailure?.code,'OWNER_AGENT_PROVIDER_FAILED');
 assert.doesNotMatch(providerFailure.answer,/private upstream|PROVIDER_UNAVAILABLE/);

 const toolFailure=await runOwnerAgent({
  provider:{async generate(){return {content:'',toolCalls:[call('workspaceData',{description:'change a setting'})]};}},
  tools:tools(['workspaceData'],async()=>{throw new Error('private database detail');}),message:'Change a setting',
 });
 assert.equal(toolFailure.plannerFailure?.code,'OWNER_AGENT_TOOL_FAILED');
 assert.match(toolFailure.answer,/check your workspace/i);
 assert.doesNotMatch(toolFailure.answer,/private database detail/);
});

test('only one workspaceData call runs from a model tool batch',async()=>{
 let calls=0,executions=0;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[
   call('workspaceData',{description:'read current settings'},'data-1'),
   call('workspaceData',{description:'change current settings'},'data-2'),
  ]};
  const results=request.messages.filter(item=>item.role==='tool');
  assert.equal(results.length,2);
  for(const result of results){
   assert.equal(JSON.parse(result.content).code,'INVALID');
   assert.match(JSON.parse(result.content).message,/one workspaceData operation/i);
  }
  return answer('Please choose one workspace action at a time.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>{executions++;return {ok:true};}),message:'Read and change settings'});
 assert.equal(executions,0);
 assert.equal(calls,2);
 assert.match(result.answer,/choose one workspace action/);
});

test('the loop-limit repair request omits tool fields',async()=>{
 let calls=0;
 const provider={async generate(request){
  calls++;
  if(calls<=6)return {content:'',toolCalls:[call('workspaceData',{description:'read settings'},`data-${calls}`)]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  return answer('I completed the available checks.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(),message:'Check settings'});
 assert.equal(calls,7);
 assert.match(result.answer,/completed the available checks/);
});

test('the no-tools repair rejects an unexecuted tool call',async()=>{
 let calls=0,executions=0;
 const provider={async generate(){
  calls++;
  if(calls<=6)return {content:'',toolCalls:[call('workspaceData',{request:'Read current settings'},`read-${calls}`)]};
  return {content:'The workspace was updated.',toolCalls:[call('workspaceData',{request:'Update a setting'},'repair-write')]};
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>{executions++;return {ok:true};}),message:'Read settings'});
 assert.equal(executions,6);
 assert.equal(result.plannerFailure?.code,'OWNER_REPLY_REPAIR_FAILED');
 assert.doesNotMatch(result.answer,/workspace was updated/);
});
