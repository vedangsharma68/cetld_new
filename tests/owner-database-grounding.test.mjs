import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerGroundingIssue,ownerEvidence} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

test('button instructions require transport-backed choices, never model or history claims',()=>{
  const reply='Please tap the button to confirm the deletion of invoice INV-002.';
  assert.equal(ownerGroundingIssue(reply,[{ok:false,code:'INVALID'}],'INV-002'),'unverified_buttons');
  assert.equal(ownerGroundingIssue(reply,[{ok:true,pending:true,invoiceNumber:'INV-002'}]),'unverified_buttons');
  assert.equal(ownerGroundingIssue(reply,[{ok:true,pending:true,invoiceNumber:'INV-002'}],'',{buttonsAvailable:true}),null);
  assert.equal(ownerGroundingIssue('There are no buttons available. Please send the change again.',[]),null);
});

test('submission and pending-action claims require a real current proposal',()=>{
  for(const reply of ["I have submitted the request to delete John's duplicate invoice.",
    'Please confirm the pending action to complete the deletion.',
    'I created a proposal to delete the invoice.']){
    assert.equal(ownerGroundingIssue(reply,[{ok:false,code:'INVALID'}]),'unverified_proposal');
    assert.equal(ownerGroundingIssue(reply,[{ok:true,pending:true,actionType:'owner_invoice_delete_proposal'}]),null);
  }
});

test('failed tools cannot turn into fictional buttons in the full agent loop',async()=>{
  let calls=0;
  const result=await runOwnerAgent({message:'yeah, confirmed. Delete INV-002.',
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
      async execute(){return {ok:false,code:'INVALID'};}},
    provider:{async generate(){calls++;return calls===1?{toolCalls:[{id:'bad',type:'function',function:{name:'workspaceData',arguments:'{"operation":"confirm"}'}}]}:
      {content:'Please tap the button to confirm the deletion of invoice INV-002.'};}}});
  assert.doesNotMatch(result.answer,/tap the button/i);
  assert.equal(result.plannerFailure?.code,'OWNER_REPLY_REPAIR_FAILED');
});

test('a deletion claim requires a completed database result, not a proposal or failed confirmation',()=>{
  for(const results of [[],[{ok:true,proposal:true,invoiceNumber:'INV-002'}],[{ok:false,code:'PENDING'}]])
    assert.equal(ownerGroundingIssue('I have deleted INV-002.',results),'unverified_action_result');
  assert.equal(ownerGroundingIssue('INV-002 has now been deleted.',[{ok:true,completed:true,action:'deleted',record:{invoice_number:'INV-002',deleted_at:'2026-10-03'}}]),null);
});
test('old assistant claims are not database evidence and a read cannot prove a send',()=>{
  const results=ownerEvidence([{role:'assistant',content:'I deleted INV-002.'},{role:'tool',content:JSON.stringify({ok:true,readOnly:true,rows:[{invoice_number:'INV-002',total_amount:450,status:'sent'}]})}]);
  assert.equal(ownerGroundingIssue('I sent INV-002.',results),'unverified_action_result');
  assert.equal(ownerGroundingIssue('INV-002: USD 450, sent.',results),null);
  assert.equal(ownerGroundingIssue('INV-099: USD 40, draft.',results),'fresh_database_read_required');
});
test('a model that invents deletion after reset memory cannot send that claim',async()=>{
  const response=await runOwnerAgent({message:'reset memory',budgetMs:1500,
    tools:{definitions:[],async execute(){throw Error('no action authorized');}},
    provider:{async generate(){return {content:'I have deleted INV-002.'};}}});
  assert.doesNotMatch(response.answer,/I have deleted/);
  assert.equal(response.plannerFailure?.code,'OWNER_REPLY_REPAIR_FAILED');
});
test('an unsupported business answer gets a chance to read current database facts',async()=>{
  let calls=0,reads=0;
  const response=await runOwnerAgent({message:'show invoices',
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(){reads++;return {ok:true,readOnly:true,rows:[{invoice_number:'INV-002',total_amount:80,currency:'USD',status:'draft'}]};}},
    provider:{async generate(){calls++;return calls===1?{content:'INV-001 is USD 450.'}:calls===2?
      {toolCalls:[{id:'current-read',type:'function',function:{name:'workspaceData',arguments:'{"operation":"read","table":"invoices"}'}}]}:
      {content:'INV-002: USD 80, draft.'};}}});
  assert.equal(reads,1);assert.equal(response.answer,'INV-002: USD 80, draft.');
});

test('expired and stale RPC acknowledgements are not completion receipts',()=>{
  for(const actionType of ['owner_workspace_data_stale','owner_workspace_data_expired']){
    assert.equal(ownerGroundingIssue('Your change is complete.',[{ok:true,actionType}]),'unverified_action_result');
    assert.equal(ownerGroundingIssue('Done.',[{ok:true,actionType}]),'unverified_action_result');
  }
  assert.equal(ownerGroundingIssue('I have confirmed the deletion.',[]),'unverified_action_result');
});

test('completion claims require a matching action and target, not an unrelated successful write',()=>{
  const settings=[{ok:true,completed:true,action:'settings.updated'}];
  for(const reply of ['I updated the customer record.','I completed the customer update.','The invoice is marked as paid.'])
    assert.equal(ownerGroundingIssue(reply,settings),'unverified_action_result');
  assert.equal(ownerGroundingIssue('I completed the customer update.',[]),'unverified_action_result');
  assert.equal(ownerGroundingIssue('The invoice is marked as paid.',[]),'unverified_action_result');
  assert.equal(ownerGroundingIssue('I deleted INV-001.',[{ok:true,completed:true,action:'invoice.deleted',record:{invoice_number:'INV-002'}}]),'unverified_action_result');
  assert.equal(ownerGroundingIssue('I cancelled the deletion.',[{ok:true,completed:true,action:'cancelled'}]),null);
});

test('money claims require actual numeric evidence, including computed outstanding balances',()=>{
  assert.equal(ownerGroundingIssue('Your balance is ₹99,999.',[{ok:true,completed:true,action:'settings.updated'}]),'fresh_database_read_required');
  const rows=[{total_amount:150,amount_paid:20},{total_amount:200,amount_paid:50}];
  assert.equal(ownerGroundingIssue('The balance is USD 280.',[{ok:true,readOnly:true,rows}]),null);
  assert.equal(ownerGroundingIssue('The balance is USD 999.',[{ok:true,readOnly:true,rows}]),'fresh_database_read_required');
});

test('a completed initial receipt goes directly to a tools-off answer without another mutation',async()=>{
  let calls=0;
  const result=await runOwnerAgent({message:'Confirm',
    initialToolResults:[{name:'workspaceData',args:{operation:'confirm'},result:{ok:true,completed:true,action:'invoice.deleted',record:{invoice_number:'INV-002',deleted_at:'2026-10-03'}}}],
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(){throw Error('must not mutate twice');}},
    provider:{async generate(request){calls++;assert.equal(request.tools,undefined);return {content:'INV-002 has been deleted.'};}}});
  assert.equal(calls,1);assert.equal(result.answer,'INV-002 has been deleted.');
});
