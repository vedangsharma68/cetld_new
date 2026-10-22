import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWorkspaceRecord} from '../automation/whatsapp/workspace-records.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {runOwnerAgent,ownerAgentFailureReply} from '../automation/whatsapp/owner-agent.mjs';
import {ownerFailureGuidance} from '../automation/whatsapp/owner-failure-replies.mjs';
import {invoiceReadAnalysisReply} from '../automation/whatsapp/owner-invoice-read-analysis.mjs';

const scope={workspaceId:'11111111-1111-4111-8111-111111111111'};
const filter=name=>[{column:'name',operator:'eq',value:name}];
function customers(names,{error=null}={}) {
  const rows=names.map((name,i)=>typeof name==='string'?{id:String(i),workspace_id:scope.workspaceId,name}:name),calls=[];
  return {calls,from(table){
    assert.equal(table,'customers');const tests=[];let cap=Infinity;
    const q={select(){return q;},eq(key,value){tests.push(row=>row[key]===value);calls.push([key,value]);return q;},
      ilike(key,value){tests.push(row=>String(row[key]).toLowerCase().includes(String(value).replaceAll('%','').toLowerCase()));return q;},
      limit(n){cap=n;return q;},then(resolve,reject){return Promise.resolve({data:rows.filter(row=>tests.every(t=>t(row))).slice(0,cap),error}).then(resolve,reject);}};
    return q;
  }};
}
const resolve=(supabase,name)=>resolveWorkspaceRecord({supabase,scope,table:'customers',filters:filter(name),select:'id,name',operation:'update'});

test('customer typo suggestions cover transposition, insertion, deletion, substitution and concatenated names without selecting a record',async()=>{
  for(const typo of ['Jhon','Johhn','Jon','Jahn','JhonSmith']){
    const db=customers(['John Smith','Mary Johnson']);const result=await resolve(db,typo);
    assert.equal(result.code,'NAME_CONFIRMATION_REQUIRED',typo);assert.equal(result.ok,false);
    assert.deepEqual(result.suggestions,[{name:'John Smith'}]);assert.equal(result.row,undefined);
    assert.match(result.message,/Did you mean John Smith\?.*full name.*confirm/);
    assert.ok(db.calls.filter(([key])=>key==='workspace_id').every(([,value])=>value===scope.workspaceId));
  }
  const exact=await resolve(customers(['John','Joan']),'John');assert.equal(exact.ok,true);assert.equal(exact.row.name,'John');
  const partial=await resolve(customers(['John Smith','Mary Johnson']),'John');assert.equal(partial.ok,true);assert.equal(partial.row.name,'John Smith');
});

test('similar names require a choice; short, unrelated, owner and foreign names are not fuzzy targets',async()=>{
  const result=await resolve(customers(['John','Joan']),'Jonn');
  assert.equal(result.requiresNameConfirmation,true);assert.deepEqual(result.suggestions,[{name:'Joan'},{name:'John'}]);
  for(const name of ['Jo','Nobody'])assert.equal((await resolve(customers(['John Smith']),name)).code,'NOT_FOUND');
  const db=customers([{id:'owner',workspace_id:scope.workspaceId,name:'John',metadata:{whatsapp_owner:true}},
    {id:'foreign',workspace_id:'foreign-workspace',name:'Jhon Foreign'}]);
  assert.equal((await resolve(db,'Jhon')).code,'NOT_FOUND');
  assert.equal((await resolve(customers(Array.from({length:501},(_,i)=>`John ${i}`)),'Jhon')).code,'AMBIGUOUS');
  await assert.rejects(resolve(customers(['John'],{error:{code:'DATABASE_UNAVAILABLE'}}),'Jhon'),{code:'DATABASE_UNAVAILABLE'});
});

test('a suggestion ends the agent turn before queued calls can silently use the corrected name',async()=>{
  const db=customers(['John Smith']);let executions=0,providerCalls=0,writes=0;
  const tool=createWorkspaceDataTool({supabase:db,scope,authorize:async()=>true,confirmationMode:'direct',
    executeDirectOperation:async()=>{writes++;return {ok:true,completed:true};}});
  const request=name=>({operation:'update',table:'customers',filters:filter(name),values:{company_name:'New Company'}});
  const tools={definitions:[tool.definition],getWriteAttempted:tool.getWriteAttempted,
    async execute(name,args){executions++;return tool.execute(args);}};
  const result=await runOwnerAgent({tools,message:'Change Jhon company to New Company',provider:{async generate(){
    providerCalls++;return {toolCalls:[{id:'typo-update',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(request('Jhon'))}}]};
  }}});
  assert.match(result.answer,/Did you mean John Smith/);assert.equal(providerCalls,1);assert.equal(executions,1);assert.equal(writes,0);
  executions=0;
  const queued=await runOwnerAgent({message:'Show Jhon',tools:{definitions:[tool.definition],async execute(name,args){executions++;return resolve(db,args.filters[0].value);}},
    provider:{async generate(){return {toolCalls:['Jhon','John Smith'].map((name,i)=>({id:String(i),type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'customers',filters:filter(name)})}}))};}}});
  assert.match(queued.answer,/Did you mean John Smith/);assert.equal(executions,1);
});

test('name clarification also survives the normal customer approval path without staging a write',async()=>{
  let proposals=0;
  const db=customers(['John Smith']);db.rpc=async()=>{proposals++;throw Error('no proposal before name confirmation');};
  const tool=createWorkspaceDataTool({supabase:db,scope,authorize:async()=>true,messageId:'typo-customer',
    pending:{async loadPendingActionState(){return {generation:0};}}});
  const result=await tool.execute({operation:'update',table:'customers',filters:filter('Jhon'),values:{company_name:'New Company'}});
  assert.equal(result.code,'NAME_CONFIRMATION_REQUIRED');assert.equal(proposals,0);assert.equal(tool.getWriteAttempted(),false);
});

test('opaque failures become a human reason and next step, retaining specific and uncertain-write guidance',()=>{
  for(const [code,reason,next] of [['NOT_FOUND',/No matching record/,/Check the name/],['DENIED',/owner number.*verified/,/Verify it/],
    ['UNAVAILABLE',/temporarily unavailable/,/Try again/],['INVALID',/missing.*invalid/,/Check the details/]]){
    const reply=ownerFailureGuidance('Something went wrong.',{code,failed:true});assert.match(reply,reason);assert.match(reply,next);
  }
  assert.match(ownerFailureGuidance('The invoice was not saved because processing failed.'),/processing failed.*Try again/);
  assert.match(ownerFailureGuidance('I couldn’t verify the payment.',{writeAttempted:true}),/Check cetld before retrying/);
  const specific='The invoice changed since review. Check its balance before retrying.';
  assert.equal(ownerFailureGuidance(specific),specific);
  assert.equal(ownerFailureGuidance('Saved invoice INV-1.'),'Saved invoice INV-1.');
  assert.match(ownerFailureGuidance('Send it with the country code, like +919818685252.'),/phone number.*format.*Send it with the country code/);
  assert.match(ownerAgentFailureReply('OWNER_AI_QUOTA_EXHAUSTED',{quotaProviders:['cloudflare']}),/resets at 5:30am IST.*Try again after the quota resets/);
  for(const code of ['UNAVAILABLE','NOT_FOUND','INVALID','DENIED']){
    const reply=ownerFailureGuidance(`I could not complete that request (${code}).`,{code,failed:true});
    assert.doesNotMatch(reply,new RegExp(code));assert.match(reply,/Try|Check|Verify/);
  }
  for(const code of ['OWNER_AGENT_TOOL_FAILED','OWNER_AGENT_PROVIDER_FAILED','OWNER_LOOP_TIMEOUT','OWNER_REPLY_REPAIR_FAILED']){
    assert.match(ownerAgentFailureReply(code),/interrupted|usable reply|verify|safe reply|took too long/);
    assert.match(ownerAgentFailureReply(code),/Try|Check/);
    assert.match(ownerAgentFailureReply(code,{writeAttempted:true}),/check cetld|Check cetld|check your workspace/i);
  }
});

test('the agent hardens a model-written opaque error using the actual failure code',async()=>{
  const result=await runOwnerAgent({message:'Show John',tools:{definitions:[],async execute(){throw Error('no calls expected');}},
    initialToolResults:[{name:'workspaceData',args:{operation:'read',table:'customers'},result:{ok:false,code:'NOT_FOUND',readOnly:true}}],
    provider:{async generate(){return {content:'Something went wrong.'};}}});
  assert.match(result.answer,/No matching record.*Check the name/);
  assert.doesNotMatch(result.answer,/NOT_FOUND|Something went wrong/);
});

test('empty computed unpaid lists, including count requests, offer another useful list',()=>{
  for(const countOnly of [false,true]){
    const reply=invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',truncated:false,
      invoiceReadAnalysis:{kind:'unpaidInvoices',complete:true,readOnly:true,invoices:[],countOnly}});
    assert.match(reply,/No unpaid invoices.*all invoices/);
  }
});
