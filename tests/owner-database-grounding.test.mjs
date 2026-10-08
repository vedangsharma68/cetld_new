import test from 'node:test';
import assert from 'node:assert/strict';

test('verified payment history rejects a false absence claim even with a positive current paid balance',()=>{
  const result={ok:true,readOnly:true,operation:'read',table:'invoices',rows:[{invoice_number:'INV-1',amount_paid:20}],
    paymentHistory:{ok:true,readOnly:true,rows:[{invoice_number:'INV-1',amount:20,net_amount:20}]}};
  assert.equal(ownerGroundingIssue('There is no payment history.',[result]),'fresh_database_read_required');
});
import {ownerGroundingIssue,ownerEvidence} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';
import {requestedInvoiceDateChange} from '../automation/whatsapp/invoice-corrections.mjs';

test('date intent never promotes negated, historical, mixed or ambiguous date text into a correction',()=>{
 for(const message of ['Do not change the due date to 2026-10-20.','Show the due date 2026-10-20.','Change notes; keep due date 2026-10-20.',"Change notes to 'change due date to 2026-10-20'.",'Earlier the customer said change due date to 2026-10-20.',
  'Change due date 2026-10-20 and issue date 2026-10-08.','Change due date from 2026-10-15 to 2026-10-20.','Change due date to 2026-02-31.'])assert.equal(requestedInvoiceDateChange(message),null,message);
 assert.deepEqual(requestedInvoiceDateChange('Only change the due date of QA-1 to 2026-10-20. Do not change anything else.'),{field:'due_date',value:'2026-10-20',only:true});
});

test('invoice correction claims require the named audited field and its persisted date, including generic completion',()=>{
 const receipt={ok:true,completed:true,action:'invoice.updated',entityType:'invoice',record:{invoice_number:'QA-1',due_date:'2026-10-15',currency:'USD',total_amount:100},
  correction:{appliedFields:['total_amount','subtotal'],changedFields:[]}};
 const message='Only change the due date of QA-1 to 2026-10-20.';
 for(const reply of ['Done.','Updated the due date to 2026-10-20.','I successfully updated the due date.','Due date: 2026-10-20.','Due date: October 20, 2026.','I updated the invoice.'])
  assert.equal(ownerGroundingIssue(reply,[receipt],message),'unverified_invoice_correction',reply);
 const saved={...receipt,record:{...receipt.record,due_date:'2026-10-20'},correction:{appliedFields:['due_date'],changedFields:['due_date']}};
 assert.equal(ownerGroundingIssue('Updated the due date to 2026-10-20.',[saved],message),null);
 assert.equal(ownerGroundingIssue('Updated the due date to 2026-10-21.',[saved],message),'unverified_invoice_correction');
 assert.equal(ownerGroundingIssue('Due date: October 21, 2026.',[saved],message),'unverified_invoice_correction');
 assert.equal(ownerGroundingIssue('Updated the due date to 20 October 2026.',[saved],message),null);
 assert.equal(ownerGroundingIssue('I updated the due date and currency.',[saved],message),'unverified_invoice_correction');
 assert.equal(ownerGroundingIssue('I could not apply the due date change. Due date: 2026-10-15.',[receipt],message),null);
 assert.equal(ownerGroundingIssue('Updated the due date.',[{...saved,record:{...saved.record,invoice_number:'QA-2'}}],message),'unverified_invoice_correction');
 const amount={...receipt,record:{...receipt.record,total_amount:150},correction:{appliedFields:['total_amount'],changedFields:['total_amount']}};
 const oldRead={ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'QA-1',total_amount:100,currency:'USD'}]};
 assert.equal(ownerGroundingIssue('Updated the total to USD 100.',[oldRead,amount],'Change QA-1 total to USD 150.'),'unverified_invoice_correction');
 assert.equal(ownerGroundingIssue('Updated the total to USD 150.',[oldRead,amount],'Change QA-1 total to USD 150.'),null);
 assert.equal(ownerGroundingIssue('Updated the total to INR 150.',[amount]),'unverified_invoice_correction');
});

test('invoice absence needs a checked lookup and cannot contradict a current row',()=>{
  const reply="I couldn't find the invoice INV-2026-0002.",message='Show invoice INV-2026-0002';
  for(const result of [{ok:false,code:'INVALID',validationCode:'FILTER_SHAPE'},{ok:false,code:'UNAVAILABLE'}])
    assert.equal(ownerGroundingIssue(reply,[result],message),'fresh_database_read_required');
  const read={ok:true,operation:'read',table:'invoices',lookupInvoiceNumber:'INV-2026-0002',readOnly:true,rows:[],truncated:false};
  assert.equal(ownerGroundingIssue(reply,[read],message),null);
  assert.equal(ownerGroundingIssue(reply,[{...read,lookupInvoiceNumber:'INV-2026-0099'}],message),'fresh_database_read_required');
  assert.equal(ownerGroundingIssue(reply,[{...read,rows:[{invoice_number:'INV-2026-0002'}]}],message),'fresh_database_read_required');
  assert.equal(ownerGroundingIssue(reply,[{ok:false,operation:'read',table:'invoices',lookupInvoiceNumber:'INV-2026-0002',code:'NOT_FOUND'}],message),null);
  assert.equal(ownerGroundingIssue("I couldn't check that invoice right now.",[{ok:false,code:'UNAVAILABLE'}],message),null);
  assert.equal(ownerGroundingIssue("I couldn't find a due date on that invoice.",[{...read,rows:[{invoice_number:'INV-2026-0002'}]}],message),null);
});

test('a no-save review status is distinct from an unverified completed action',()=>{
  assert.equal(ownerGroundingIssue('Nothing was saved.',[{ok:true,outcome:'review_ready'}]),null);
  assert.equal(ownerGroundingIssue('No invoice was saved.',[{ok:true,outcome:'review_ready'}]),null);
  assert.equal(ownerGroundingIssue('No problem, I saved the invoice.',[]),'unverified_action_result');
  assert.equal(ownerGroundingIssue('Nothing was saved. I saved the invoice.',[]),'unverified_action_result');
  assert.equal(ownerGroundingIssue('Nothing was saved, I updated the invoice.',[]),'unverified_action_result');
});

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

test('explicit read-only invoice edit-options request recovers from an unsafe draft using the successful read and does not repeat AI or tools',async()=>{
  let calls=0,reads=0,writes=0;
  const response=await runOwnerAgent({message:'Show invoice INV-2026-0002 and its edit options. Do not change any data.',
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(_name,args){
      if(args.operation!=='read'){writes++;return {ok:false,code:'INVALID'};}reads++;
      return {ok:true,readOnly:true,rows:[{invoice_number:'INV-2026-0002',customer_name:'Synthetic Client',currency:'INR',total_amount:'1250.00',amount_paid:'0.00',status:'sent',due_date:'2026-10-12'}]};
    }},
    provider:{async generate(){calls++;return calls===1?{toolCalls:[{id:'read-invoice',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-0002'}]})}}]}:
      {content:'I updated invoice INV-2026-0002 and its edit options are ready.'};}}});
  assert.equal(response.readOnlyFallback,true);
  assert.match(response.answer,/Invoice INV-2026-0002/);
  assert.match(response.answer,/Customer: Synthetic Client/);
  assert.match(response.answer,/Total: INR 1250\.00/);
  assert.match(response.answer,/No changes were made\./);
  assert.doesNotMatch(response.answer,/updated invoice/i);
  assert.equal(calls,2);assert.equal(reads,1);assert.equal(writes,0);
  assert.equal(response.plannerFailure,undefined);
});

test('invoice edit-options fallback rejects conflicting snapshots of the same invoice',async()=>{
  let calls=0,reads=0;
  const response=await runOwnerAgent({message:'Show invoice INV-2026-0002 and its edit options. Do not change any data.',
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(){
      reads++;return {ok:true,readOnly:true,rows:[{invoice_number:'INV-2026-0002',total_amount:reads===1?100:200,amount_paid:0,currency:'USD'}]};
    }},provider:{async generate(){calls++;return calls<=2?{toolCalls:[{id:`read-${calls}`,type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',limit:calls})}}]}:
      {content:'I updated invoice INV-2026-0002.'};}}});
  assert.equal(reads,2);assert.notEqual(response.readOnlyFallback,true);assert.ok(response.plannerFailure);
});

test('invoice edit-options fallback does not cover a request that also asks to change data',async()=>{
  let calls=0;
  const response=await runOwnerAgent({message:'Show invoice INV-2026-0002 and its edit options. Do not change any data now; after showing it update the due date.',
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(){return {ok:true,readOnly:true,rows:[{invoice_number:'INV-2026-0002'}]};}},
    provider:{async generate(){calls++;return calls===1?{toolCalls:[{id:'read-invoice',type:'function',function:{name:'workspaceData',arguments:'{"operation":"read","table":"invoices"}'}}]}:
      {content:'I updated invoice INV-2026-0002.'};}}});
  assert.notEqual(response.readOnlyFallback,true);
  assert.ok(response.plannerFailure);
  assert.ok(calls>2);
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
