import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';

const receipt={ok:true,completed:true,action:'invoice.updated',entityType:'invoice',record:{payment_information:'Pay by bank transfer'}};
test('persisted business payment instructions do not get mistaken for a recorded payment',()=>{
 for(const reply of ['Updated the payment instructions.','I updated the payment information.','Updated the payment info.'])assert.equal(ownerGroundingIssue(reply,[receipt]),null);
 assert.equal(ownerGroundingIssue('Updated the payment instructions.',[{...receipt,record:{notes:'Unrelated'}}]),'unverified_action_result');
 assert.equal(ownerGroundingIssue('Updated the payment instructions.',[{ok:false,completed:false,code:'STALE'}]),'unverified_action_result');
});
test('business payment instructions cannot authorize a payment, paid state or cash movement claim',()=>{
 for(const reply of ['Updated payment instructions and recorded a payment.','I recorded the payment.','I marked the invoice paid.','I marked the invoice unpaid.'])
  assert.equal(ownerGroundingIssue(reply,[receipt]),'unverified_action_result',reply);
});
