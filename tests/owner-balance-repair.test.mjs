import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

// Production shape: three unpaid INR invoices, nullable paid amount, and a
// same-day creation. Payment history is independently read, not inferred.
const rows=[1500,2500,750].map((total_amount,i)=>({invoice_number:`INV-2026-000${i+1}`,currency:'INR',total_amount,
  amount_paid:i===1?null:0,status:'draft',created_at:i===2?'2026-10-23T09:00:00Z':'2026-10-20T09:00:00Z'}));
const evidence=(overrides={})=>({ok:true,readOnly:true,operation:'read',table:'invoices',rows,truncated:false,
  paymentHistory:{ok:true,readOnly:true,rows:[],truncated:false},...overrides});

test('verified empty history permits truthful zero-payment replies; zero allocation alone cannot prove absence',()=>{
  for(const reply of ['There is no payment history.','No payments have been received.','These invoices have never been paid.']){
    assert.equal(ownerGroundingIssue(reply,[evidence()]),null,reply);
    assert.equal(ownerGroundingIssue(reply,[evidence({paymentHistory:undefined})]),'fresh_database_read_required');
    for(const history of [{ok:false},{ok:true,readOnly:true,rows:[],truncated:true},{ok:true,readOnly:true,rows:[{amount:1500,net_amount:0}],truncated:false}])
      assert.equal(ownerGroundingIssue(reply,[evidence({paymentHistory:history})]),'fresh_database_read_required');
  }
});

test('rupee and INR formatting variants match amounts and reject unsupported amounts',()=>{
  for(const amount of ['Rs 1,500.00','Rs. 1,500.00','INR 1500','1,500.00 INR','₹1,500.00'])
    assert.equal(ownerGroundingIssue(`Unissued draft balance: ${amount}.`,[evidence()]),null,amount);
  for(const amount of ['Rs 1,501.00','Rs. 1,501.00','INR 1501','1,501.00 INR','₹1,501.00'])
    assert.equal(ownerGroundingIssue(`Unissued draft balance: ${amount}.`,[evidence()]),'fresh_database_read_required',amount);
});

test('numeric identifiers and row counts cannot substantiate a money claim',()=>{
  const result=evidence({rows:[{invoice_number:'1501',currency:'INR',total_amount:1500,amount_paid:0}],rowCount:1501});
  assert.equal(ownerGroundingIssue('Outstanding: INR 1501.',[result]),'fresh_database_read_required');
  assert.equal(ownerGroundingIssue('Outstanding: USD 1500.',[result]),'fresh_database_read_required');
});

test('aggregate evidence is per currency and clamps each invoice balance before summing',()=>{
  const mixed=evidence({rows:[{currency:'INR',total_amount:1500,amount_paid:0},{currency:'USD',total_amount:2500,amount_paid:0},{currency:'INR',total_amount:750,amount_paid:null}]});
  assert.equal(ownerGroundingIssue('Outstanding: INR 2250.00; USD 2500.00.',[mixed]),null);
  for(const reply of ['Outstanding: INR 4750.00.','Outstanding: INR 2500.00.','Outstanding: USD 2250.00.'])
    assert.equal(ownerGroundingIssue(reply,[mixed]),'fresh_database_read_required',reply);
  const partial=evidence({rows:[{currency:'INR',total_amount:100,amount_paid:150},{currency:'INR',total_amount:100,amount_paid:10}]});
  assert.equal(ownerGroundingIssue('Outstanding: INR 90.00.',[partial]),null);
  assert.equal(ownerGroundingIssue('Outstanding: INR 40.00.',[partial]),'fresh_database_read_required');
});

test('three draft invoices are reported separately instead of the obsolete inclusive outstanding answer',async()=>{
  let calls=0,reads=0;
  const response=await runOwnerAgent({message:'what is my total outstanding?',clock:()=>new Date('2026-10-23T09:48:00Z'),
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],async execute(){reads++;return evidence();}},
    provider:{async generate(){calls++;return calls===1?{toolCalls:[{id:'read-outstanding',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices'})}}]}:
      {content:'Your total outstanding is INR 4,750.00. There is no payment history.'};}}});
  assert.equal(response.plannerFailure,undefined);assert.equal(response.answer,'Issued outstanding: none.\nUnissued drafts (not yet receivable): INR 4750.00.');
  assert.equal(calls,1);assert.equal(reads,1);
});
