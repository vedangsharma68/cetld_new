import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerReplySafetyIssue,runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

// Faithful synthetic event248 shape; production diagnostics omit reply bodies.
const leakedRequirements='{"replyRequirements":{"attachmentReview":{"incomplete":true,"missingFields":["currency"]},"maxLength":1000}}';
const safeReview='No invoice was saved. Please confirm the currency for this invoice.';
const narration='We need to draft a concise final answer. Mention the missing currency and avoid claiming the invoice was saved.';
const requirement={attachmentReview:{incomplete:true,missingFields:['currency'],validationIssues:[],answer:safeReview},maxLength:1000};
const initialToolResults=[{name:'getPendingOwnerAction',args:{},result:{ok:true,pending:true,type:'invoice_review_draft',stage:'incomplete',missingFields:['currency']}}];

test('reply checks reject internal requirements and drafting around a valid invoice answer',()=>{
  for(const text of [leakedRequirements+'\n'+safeReview,safeReview+'\n'+leakedRequirements,'```json\n'+leakedRequirements+'\n```\n'+safeReview,
    'replyRequirements: '+leakedRequirements,safeReview+'\n{"requiredFacts":{"changeValues":[]}}'])
    assert.equal(ownerReplySafetyIssue(text,requirement),'internal_reply_requirements');
  for(const text of [narration+'\n'+safeReview,safeReview+'\n'+narration,'<think>I should mention the currency.</think>\n'+safeReview,
    'Analysis: The invoice is incomplete.\nFinal answer: '+safeReview,'Let me draft the final reply.\n'+safeReview,
    'Need to produce a final answer.\n'+safeReview])
    assert.equal(ownerReplySafetyIssue(text,requirement),'internal_drafting_narration');
});

test('ordinary uncertainty, owner next steps, and business requirements remain valid replies',()=>{
  for(const text of [safeReview,'I could not verify whether the payment was recorded. Please check your workspace before trying again.',
    'I need you to confirm the currency before this invoice can be saved. No invoice was saved.',
    'We should review the invoice amounts together before saving.',
    'The invoice requirements are a purchase order and tax details.',
    'The customer custom field is {"requirements":"Purchase order required"}.',
    'I will reply after the invoice status is available.'])
    assert.equal(ownerReplySafetyIssue(text),null,text);
});

function toolsForReview(executions){
  return {definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
    async execute(){executions.push('workspaceData');return {...initialToolResults[0].result,readOnly:true,operation:'pending'};},
    getReplyRequirement:()=>requirement};
}

test('event248 synthetic leaked working draft is repaired before any owner answer is returned',async()=>{
  const requests=[],executions=[],logs=[];
  const result=await runOwnerAgent({message:'Review the uploaded invoice.',tools:toolsForReview(executions),
    logger:{info:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},
    provider:{async generate(request){requests.push(request);
      if(requests.length===1)return {toolCalls:[{id:'pending-review',type:'function',function:{name:'workspaceData',arguments:'{"operation":"pending"}'}}]};
      return {content:requests.length===2?leakedRequirements+'\n'+narration+'\n'+safeReview:safeReview};}}});
  assert.equal(result.answer,safeReview);
  assert.equal(requests.length,3);
  assert.equal(requests[2].tools,undefined,'repair cannot execute a write or a new lookup');
  assert.match(requests[2].messages.at(-1).content,/only the owner-facing answer/i);
  assert.deepEqual(executions,['workspaceData']);
  assert.ok(result.agentDiagnostics.safetyRejects.includes('internal_reply_requirements'));
  assert.doesNotMatch(JSON.stringify(logs),/replyRequirements|missingFields|draft a concise/);
});

test('leaking tools-off drafts use the verified retained invoice-review fallback after bounded repair',async()=>{
  const requests=[],executions=[];
  const result=await runOwnerAgent({message:'Review the uploaded invoice.',tools:toolsForReview(executions),initialToolResults,
    provider:{async generate(request){requests.push(request);return {content:requests.length===1?'Analysis: Prepare the invoice reply.\n'+safeReview:leakedRequirements+'\n'+safeReview};}}});
  assert.equal(result.answer,safeReview);
  assert.equal(result.attachmentReviewFallback,true);
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>request.tools===undefined));
  assert.deepEqual(executions,[]);
  assert.deepEqual(result.agentDiagnostics.safetyRejects,['internal_drafting_narration','internal_reply_requirements']);
});

test('persistently leaking output without a grounded fallback fails closed',async()=>{
  let requests=0;
  const result=await runOwnerAgent({message:'Help with an invoice.',tools:{definitions:[],async execute(){throw Error('No tool should run');}},
    provider:{async generate(){requests++;return {content:leakedRequirements+'\nI cannot verify this invoice.'};}}});
  assert.equal(requests,3);
  assert.equal(result.answer,'I could not prepare a safe reply just now. Please try again shortly.');
  assert.equal(result.plannerFailure.code,'OWNER_REPLY_REPAIR_FAILED');
  assert.doesNotMatch(result.answer,/replyRequirements|draft|analysis/i);
});
