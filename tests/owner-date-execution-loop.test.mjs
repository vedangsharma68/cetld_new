import test from 'node:test';
import assert from 'node:assert/strict';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

// Local provider/executor fixtures only. No contacts, credentials or sends.
const toolDefinition=name=>({type:'function',function:{name,description:'Workspace data tool',parameters:{type:'object'}}});
const call=(name,args={},id='call-1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const tools=(names=['workspaceData'],execute=async()=>({ok:true}))=>({definitions:names.map(toolDefinition),execute});
const answer=(content='No changes were made.')=>({content,toolCalls:[]});

test('current explicit date cached-read recovery is bounded and never repeats an attempted write',async()=>{
 for(const writeAttempted of [false,true]){
  let requests=0,executions=0;const flags=[];
  const result=await runOwnerAgent({message:'Only change invoice QA-1 due date to 2026-10-20.',
   tools:tools(['workspaceData'],async()=>{executions++;return {ok:true,readOnly:true,operation:'read',table:'invoices',rows:[],...(writeAttempted?{writeAttempted:true}:{})};}),
   provider:{async generate(request){requests++;flags.push(Boolean(request.tools));if(!request.tools)return answer('No changes were made.');
    return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'invoices'},'read-'+requests)]};}}});
  assert.equal(executions,1);assert.equal(requests,writeAttempted?2:4);assert.deepEqual(flags,writeAttempted?[true,false]:[true,true,true,false]);
  assert.match(result.answer,/No changes were made/);
 }
});

test('quoted, negated or historical date instructions do not extend cached read loops',async()=>{
 for(const message of ['Show invoice QA-1. Do not change due date to 2026-10-20.','He said "change due date to 2026-10-20". Show invoice QA-1.','Yesterday I changed due date to 2026-10-20. Show invoice QA-1.']){
  let requests=0,executions=0;const flags=[];
  await runOwnerAgent({message,tools:tools(['workspaceData'],async()=>{executions++;return {ok:true,readOnly:true,operation:'read',table:'invoices',rows:[]};}),
   provider:{async generate(request){requests++;flags.push(Boolean(request.tools));if(!request.tools)return answer('No changes were made.');
    return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'invoices'},'read-'+requests)]};}}});
  assert.equal(executions,1);assert.deepEqual(flags,[true,true,false]);
 }
});

test('current-date cached-read recovery and native history survive a checkpoint without granting another recovery',async()=>{
 let persisted,executions=0,requests=0;
 const message='Only change invoice QA-1 due date to 2026-10-20.';
 const toolset=tools(['workspaceData'],async()=>{executions++;return {ok:true,readOnly:true,operation:'read',table:'invoices',rows:[]};});
 const first=await runOwnerAgent({message,tools:toolset,allowDeferred:true,budgetMs:100,onCheckpoint:async value=>{persisted=structuredClone(value);},
  provider:{async generate(){requests++;if(requests===3)return new Promise(()=>{});
   return {content:'',toolCalls:[call('workspaceData',{operation:'read',table:'invoices'},'read-'+requests)],googleParts:[{functionCall:{name:'workspaceData',args:{operation:'read',table:'invoices'}},thoughtSignature:'c2ln'}]};}}});
 assert.equal(first.deferred,true);assert.equal(persisted.dateReadRecoveryUsed,true);assert.equal(persisted.phase,'work');
 assert.ok(persisted.transcript.some(m=>m.googleParts?.[0].thoughtSignature==='c2ln'));
 const flags=[];requests=0;
 await runOwnerAgent({message,tools:toolset,allowDeferred:true,checkpoint:persisted,
  provider:{async generate(request){flags.push(Boolean(request.tools));requests++;if(!request.tools)return answer('No changes were made.');return {toolCalls:[call('workspaceData',{operation:'read',table:'invoices'},'resume-'+requests)]};}}});
 assert.deepEqual(flags,[true,true,false]);assert.equal(executions,1);
});
