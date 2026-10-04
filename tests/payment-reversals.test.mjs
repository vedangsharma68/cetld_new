import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPaymentReversals,isMissingReversalStorage} from '../payment-reversals.mjs';
import {collectionsPulse} from '../collections-pulse.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {ownerReplySafetyIssue} from '../automation/whatsapp/owner-agent.mjs';

test('dashboard retains gross payment receipt and calculates net collections after reversal',()=>{
  const payment={id:'receipt',workspace_id:'own',invoice_id:'invoice',amount:'20.00',paid_at:'2026-10-04T10:00:00Z',reference:'Original transfer'};
  const reversal={workspace_id:'own',invoice_id:'invoice',payment_id:'receipt',amount:'20.00',recorded_at:'2026-10-04T11:00:00Z'};
  const rows=applyPaymentReversals([payment],[reversal],'own');assert.equal(rows[0].amount,'20.00');assert.equal(rows[0].reference,'Original transfer');assert.equal(rows[0].net_amount,0);
  const pulse=collectionsPulse([{id:'invoice',currency:'INR',amount_minor:5500,paid_minor:0,due_date:'2026-10-31'}],rows.map(p=>({...p,amount_minor:2000,net_amount_minor:0})),{today:'2026-10-04'});
  assert.equal(pulse[0].collectedThisMonth,0);assert.equal(pulse[0].outstanding,5500);
  assert.throws(()=>applyPaymentReversals([payment],[{...reversal,workspace_id:'foreign'}],'own'));
  assert.throws(()=>applyPaymentReversals([payment],[{...reversal,amount:19}],'own'));
  assert.throws(()=>applyPaymentReversals([payment],[reversal,reversal],'own'));
  assert.equal(isMissingReversalStorage({code:'42P01'}),true);assert.equal(isMissingReversalStorage({code:'42501'}),false);
});

test('reopening replies require consequential facts and cannot invent a reversal or refund',()=>{
  const requirement={requiredFacts:{financialReopening:true,invoiceNumber:'INV-1',currency:'INR',reversalAmount:20,balanceAfter:55}};
  const preview='Reopen INV-1 in INR, reversing 20 and restoring the balance to 55? Original payment receipts remain in history. No refund is sent. Reminders will be paused.';
  assert.equal(ownerReplySafetyIssue(preview,requirement),null);
  assert.equal(ownerReplySafetyIssue('Reopen INV-1, INR 20, balance 55?',requirement),'confirmation_payment_history');
  assert.equal(ownerGroundingIssue('I reopened INV-1.',[{ok:true,proposal:true,requiresConfirmation:true,invoiceNumber:'INV-1'}]),'unverified_action_result');
  const result={ok:true,completed:true,action:'invoice.reopened',invoiceNumber:'INV-1',cashRefund:false};
  assert.equal(ownerGroundingIssue('I reopened INV-1.',[result]),null);
  assert.equal(ownerGroundingIssue('I refunded the payment.',[result]),'unverified_refund');
  assert.equal(ownerGroundingIssue('No payment was refunded.',[result]),null);
});
