import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerReplySafetyIssue,runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

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
 let systemPrompt='',context,historyContents=[];
 const provider={async generate(request){
  const system=request.messages.filter(item=>item.role==='system');
  systemPrompt=system[0]?.content||'';
  context=JSON.parse(system[1]?.content||'{}');
  historyContents=request.messages.filter(item=>item.role==='user'||item.role==='assistant').map(item=>item.content);
  return answer('Hello.');
 }};
 const history=Array.from({length:12},(_,index)=>({role:index%2?'assistant':'user',content:`history-${index}`}));
 await runOwnerAgent({provider,tools:tools(),message:'',clock:()=>new Date('2026-10-02T12:00:00Z'),
  history,attachmentDescriptor:{available:true,mimeType:'image/jpeg'},historyIssue:'HISTORY_UNAVAILABLE',settingsIssue:'MODEL_SETTINGS_UNAVAILABLE'});
 assert.ok(systemPrompt.length<350,`system prompt was ${systemPrompt.length} characters`);
 assert.match(systemPrompt,/verified owner/i);
 assert.match(systemPrompt,/workspaceData/);
 assert.match(systemPrompt,/getAIProviderConfiguration/);
 assert.doesNotMatch(systemPrompt,/invoice|payment|delete|undo|attachment|confirmation/i);
 assert.deepEqual(historyContents.slice(0,8),history.slice(-8).map(turn=>turn.content));
 assert.equal(historyContents.at(-1),'');
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
  return new Promise(()=>{});
 }};
 const result=await runOwnerAgent({provider,tools:tools(),message:'Hello',budgetMs:500});
 assert.equal(providerSignal.aborted,true);
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/couldn't finish your owner chat reply/i);
 assert.match(result.answer,/nothing changed/i);
});

test('a hung workspaceData call is bounded and reports uncertain write status',async()=>{
 let toolSignal,writeAttempted=false;
 const provider={async generate(){return {content:'',toolCalls:[call('workspaceData',{operation:'update',table:'workspace_settings',values:{business_name:'Example'}})]};}};
 const ownerTools=tools(['workspaceData'],(_name,_args,options)=>{
  writeAttempted=true;
  toolSignal=options?.signal;
  return new Promise(()=>{});
 });
 ownerTools.getWriteAttempted=()=>writeAttempted;
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Change settings',budgetMs:500});
 assert.equal(toolSignal.aborted,true);
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/may still be processing|could not confirm/i);
 assert.match(result.answer,/check your workspace/i);
 assert.match(result.answer,/workspace settings/i);
 assert.match(result.answer,/trying it again/i);
 assert.equal(result.agentDiagnostics?.toolRounds,1);
});

test('a timed-out definite workspace read keeps the timeout reason without a write warning',async()=>{
 const provider={async generate(){return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings'})]};}};
 const ownerTools=tools(['workspaceData'],()=>new Promise(()=>{}));
 ownerTools.getWriteAttempted=()=>false;
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Describe settings',budgetMs:500});
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/tried to look up workspace settings/i);
 assert.match(result.answer,/nothing changed/i);
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
  provider:{async generate(){return {content:'',toolCalls:[call('workspaceData',{request:'change a setting'})]};}},
  tools:Object.assign(tools(['workspaceData'],async()=>{throw new Error('private database detail');}),{getWriteAttempted:()=>true}),message:'Change a setting',
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
  if(calls<=2)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings',offset:calls},`data-${calls}`)]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  return answer('I completed the available checks.');
 }};
 const ownerTools=tools(['workspaceData'],async()=>({ok:true,readOnly:true,operation:'read',rows:[]}));
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Check settings'});
 assert.equal(calls,3);
 assert.equal(result.agentDiagnostics?.toolRounds,2);
 assert.match(result.answer,/completed the available checks/);
});

test('the final no-tools request rejects an unexecuted tool call',async()=>{
 let calls=0,executions=0;
 const provider={async generate(){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('getAIProviderConfiguration',{},'config')]};
  return {content:'The workspace was updated.',toolCalls:[call('workspaceData',{request:'Update a setting'},'repair-write')]};
 }};
 const ownerTools=tools(['workspaceData','getAIProviderConfiguration'],async()=>{executions++;return {ok:true,readOnly:true};});
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Read settings'});
 assert.equal(executions,1);
 assert.equal(result.plannerFailure?.code,'OWNER_REPLY_REPAIR_FAILED');
 assert.doesNotMatch(result.answer,/workspace was updated/);
});

test('repeated tool name and canonical arguments reuse the cached result',async()=>{
 let calls=0,executions=0,cachedResult;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings',columns:['business_name']},'first')]};
  if(calls===2)return {content:'',toolCalls:[call('workspaceData',{columns:['business_name'],table:'workspace_settings',operation:'read'},'repeat')]};
  if(calls===3){
   cachedResult=JSON.parse(request.messages.find(item=>item.role==='tool'&&item.tool_call_id==='repeat').content);
   assert.equal(Object.hasOwn(request,'tools'),false);
   return answer('I found the settings.');
  }
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>{executions++;return {ok:true,readOnly:true,operation:'read',rows:[]};}),message:'Check settings'});
 assert.equal(executions,1);
 assert.equal(cachedResult.note,'You already have this result. Use it to answer without repeating the operation.');
 assert.equal(calls,3);
 assert.equal(result.agentDiagnostics?.cacheHits,1);
});

test('AI provider configuration gets one tool round then a no-tools final answer',async()=>{
 let calls=0,executionCount=0;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('getAIProviderConfiguration',{},'config')]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  assert.ok(request.messages.some(item=>item.role==='tool'&&item.tool_call_id==='config'));
  return answer('The model settings are configured.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData','getAIProviderConfiguration'],async()=>{executionCount++;return {ok:true,readOnly:true};}),message:'Which models are configured?'});
 assert.equal(calls,2);
 assert.equal(executionCount,1);
 assert.equal(result.agentDiagnostics?.toolRounds,1);
 assert.match(result.answer,/model settings are configured/i);
});

test('round logs contain only static tool names, status, and safety codes',async()=>{
 const entries=[];
 const provider={async generate(request){
  if(!request.messages.some(item=>item.role==='tool'))return {content:'',toolCalls:[call('secret_customer_123',{request:'private name and phone 5551234'},'unknown')]};
  return answer('I could not use that tool.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(),message:'private name and phone 5551234',logger:{info:(event,fields)=>entries.push({event,fields})}});
 const rounds=entries.filter(entry=>entry.event==='WhatsApp owner agent round');
 assert.equal(rounds.length,2);
 assert.ok(rounds.every(({fields})=>Number.isInteger(fields.round)&&Array.isArray(fields.toolNames)));
 assert.equal(rounds[0].fields.toolNames[0],'unknown');
 assert.equal(rounds[0].fields.outcome,'error');
 assert.deepEqual(rounds[0].fields.toolResults,[{toolName:'unknown',outcome:'error',code:'UNKNOWN_TOOL'}]);
 assert.ok(rounds[0].fields.safetyIssueCodes.includes('unknown_tool'));
 assert.ok(entries.filter(entry=>entry.event==='WhatsApp owner model call').every(entry=>entry.fields.durationMs>=0));
 assert.doesNotMatch(JSON.stringify(entries),/private name|5551234|secret_customer_123/);
 assert.equal(result.agentDiagnostics?.rounds,2);
 assert.deepEqual(result.agentDiagnostics?.safetyRejects,['unknown_tool']);
});

test('successful tool logs report only the sanitized status code',async()=>{
 const entries=[];
 let calls=0;
 const provider={async generate(){
  if(++calls===1)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'customers'},'customers')]};
  return answer('I found the customer record.');
 }};
 const result=await runOwnerAgent({provider,
  tools:tools(['workspaceData'],async()=>({ok:true,readOnly:true,operation:'read',table:'customers',rows:[{name:'Private Customer',phone:'5551234'}]})),
  message:'Read this customer',logger:{info:(event,fields)=>entries.push({event,fields})}});
 assert.deepEqual(entries.find(entry=>entry.event==='WhatsApp owner agent round').fields.toolResults,[{toolName:'workspaceData',outcome:'ok',code:'OK'}]);
 assert.ok(entries.find(entry=>entry.event==='WhatsApp owner tool call').fields.durationMs>=0);
 assert.doesNotMatch(JSON.stringify(entries),/Private Customer|5551234/);
 assert.equal(result.agentDiagnostics?.toolRounds,1);
});

test('read-only tool work stops after three rounds',async()=>{
 let calls=0,executions=0;
 const provider={async generate(request){
  calls++;
  if(calls<=3)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings',offset:calls},`read-${calls}`)]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  return answer('I could not load the settings.');
 }};
 const ownerTools=tools(['workspaceData'],async()=>{executions++;return {ok:false,code:'UNAVAILABLE'};});
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Check settings'});
 assert.equal(calls,4);
 assert.equal(executions,3);
 assert.equal(result.agentDiagnostics?.toolRounds,3);
 assert.match(result.answer,/could not load the settings/i);
});

test('final reply safety repair keeps output checks and never offers tools',async()=>{
 let calls=0;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('getAIProviderConfiguration',{},'config')]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  if(calls===2)return answer('The model settings are ready — and verified.');
  return answer('The model settings are ready and verified.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData','getAIProviderConfiguration'],async()=>({ok:true,readOnly:true})),message:'Which models are active?'});
 assert.equal(calls,3);
 assert.match(result.answer,/ready and verified/i);
 assert.ok(result.agentDiagnostics?.safetyRejects.includes('dash_style'));
});

test('a safe no-tool follow-up draft after a completed read is used directly',async()=>{
 let calls=0;
 const provider={async generate(){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings'},'read')]};
  return answer('I reviewed the settings.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>({ok:true,readOnly:true,operation:'read',table:'workspace_settings',rows:[]})),message:'Read settings',budgetMs:500});
 assert.equal(calls,2);
 assert.equal(result.plannerFailure,undefined);
 assert.match(result.answer,/reviewed the settings/i);
});

test('a work-phase timeout after a completed read uses the reserved no-tools final phase',async()=>{
 let calls=0,finalSignal;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings'},'read')]};
  if(calls===2)return new Promise(()=>{});
  finalSignal=request.signal;
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  assert.ok(request.messages.some(item=>item.role==='tool'&&item.tool_call_id==='read'));
  return answer('I looked up the workspace settings.');
 }};
 const result=await runOwnerAgent({provider,tools:tools(['workspaceData'],async()=>({ok:true,readOnly:true,operation:'read',table:'workspace_settings',rows:[]})),message:'Read settings',budgetMs:2000});
 assert.equal(calls,3);
 assert.equal(finalSignal?.aborted,false);
 assert.equal(result.plannerFailure,undefined);
 assert.match(result.answer,/looked up the workspace settings/i);
 assert.equal(result.agentDiagnostics?.toolRounds,1);
});

test('a read timeout after an earlier completed result is disclosed in the reserved final phase',async()=>{
 let calls=0,executions=0;
 const provider={async generate(request){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings'},'first-read')]};
  if(calls===2)return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'workspace_settings',offset:2},'slow-read')]};
  assert.equal(Object.hasOwn(request,'tools'),false);
  assert.equal(Object.hasOwn(request,'toolChoice'),false);
  const timedOutResult=request.messages.find(item=>item.role==='tool'&&item.tool_call_id==='slow-read');
  assert.equal(JSON.parse(timedOutResult.content).code,'UNAVAILABLE');
  return answer('The first lookup completed, but I could not verify the follow-up lookup.');
 }};
 const ownerTools=tools(['workspaceData'],async()=>{
  executions++;
  if(executions===1)return {ok:true,readOnly:true,operation:'read',table:'workspace_settings',rows:[]};
  return new Promise(()=>{});
 });
 const result=await runOwnerAgent({provider,tools:ownerTools,message:'Read settings',budgetMs:2000});
 assert.equal(calls,3);
 assert.equal(executions,2);
 assert.equal(result.plannerFailure,undefined);
 assert.match(result.answer,/could not verify the follow-up lookup/i);
 assert.equal(result.agentDiagnostics?.toolRounds,2);
});

test('a timed-out final answer after provider configuration names the completed lookup',async()=>{
 let calls=0;
 const provider={async generate(){
  calls++;
  if(calls===1)return {content:'',toolCalls:[call('getAIProviderConfiguration',{},'config')]};
  return new Promise(()=>{});
 }};
 const result=await runOwnerAgent({provider,
  tools:tools(['workspaceData','getAIProviderConfiguration'],async()=>({ok:true,readOnly:true,operation:'configuration'})),
  message:'Which provider is configured?',budgetMs:500});
 assert.equal(calls,2);
 assert.equal(result.plannerFailure?.code,'OWNER_LOOP_TIMEOUT');
 assert.match(result.answer,/looked up AI provider configuration/i);
 assert.match(result.answer,/couldn\'t finish the reply/i);
 assert.match(result.answer,/nothing changed/i);
});

test('reply safety checks flattened nested values with typed whole-token matching',()=>{
 const requirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true,requiredFacts:{changeValues:[
  {field:'follow_up_preferences',value:{tone:'professional',maxReminders:3,pauseOnReply:false,contactEnd:null}},
 ]}};
 assert.equal(ownerReplySafetyIssue(
  'Follow-up tone professional, a limit of three reminders, pause on reply off, and contact time cleared. Reply yes, or cancel.',
  requirement),null);
});

test('numeric changed values reject longer numbers but accept a sentence-ending period',()=>{
 const requirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true,requiredFacts:{changeValues:[{field:'maxReminders',value:3}]}};
 assert.equal(ownerReplySafetyIssue('The limit is 30 reminders. Reply yes, or cancel.',requirement),'confirmation_change_value');
 assert.equal(ownerReplySafetyIssue('The limit is 3. Reply yes, or cancel.',requirement),null);
});

test('reply safety does not match a changed name inside a longer word',()=>{
 const requirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true,requiredFacts:{changeValues:[{field:'business_name',value:'Ann'}]}};
 assert.equal(ownerReplySafetyIssue('The business name is Annual. Reply yes to confirm, or cancel.',requirement),'confirmation_change_value');
 assert.equal(ownerReplySafetyIssue('The business name is Ann. Reply yes to confirm, or cancel.',requirement),null);
});

test('confirmation requires a positive yes instruction while DELETE remains exact',()=>{
 const yesRequirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true};
 assert.equal(ownerReplySafetyIssue('Reply yes, or cancel.',yesRequirement),null);
 assert.equal(ownerReplySafetyIssue('Nothing was changed. Reply **yes**, or cancel.',yesRequirement),null);
 assert.equal(ownerReplySafetyIssue("Reply 'yes' to confirm, or cancel.",yesRequirement),null);
 assert.equal(ownerReplySafetyIssue('Do not reply yes to confirm; cancel if needed.',yesRequirement),'confirmation_instruction');
 assert.equal(ownerReplySafetyIssue("Don't reply 'yes'; cancel instead.",yesRequirement),'confirmation_instruction');

 const deleteRequirement={confirmationText:'DELETE INV-7',requiresCancel:true,requiresReplyCue:true};
 assert.equal(ownerReplySafetyIssue('Reply DELETE INV-7 to confirm, or cancel.',deleteRequirement),null);
 assert.equal(ownerReplySafetyIssue('Reply DELETE INV-8 to confirm, or cancel.',deleteRequirement),'confirmation_instruction');
 assert.equal(ownerReplySafetyIssue('Reply delete INV-7 to confirm, or cancel.',deleteRequirement),'confirmation_instruction');
});
