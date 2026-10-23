import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeReceivables,receivableKind,receivablesAnswer,receivablesReadAnswer} from '../invoice/receivables.mjs';
import {collectionsPulse} from '../collections-pulse.mjs';
import {totals} from '../core.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';

import {receivablesLedger as ledger} from './fixtures/receivables.mjs';
const balances=groups=>Object.fromEntries(Object.entries(groups).map(([currency,row])=>[currency,row.outstandingAmount]));
const uiLedger=()=>ledger.map(row=>({...row,amount_minor:Math.round(Number(row.total_amount)*100),paid_minor:Math.round(Number(row.amount_paid)*100)}));
const expected='Issued outstanding: INR 1.00, USD 255.06.\nUnissued drafts (not yet receivable): AUD 4490.00, INR 20496.00, USD 545.02.';

test('mixed production-shaped ledger separates issued receivables from unissued drafts, without FX or terminal/deleted rows',()=>{
  const summary=summarizeReceivables(ledger);
  assert.deepEqual(balances(summary.currencies),{INR:'1.00',USD:'255.06'});
  assert.deepEqual(balances(summary.draftBalancesByCurrency),{AUD:'4490.00',INR:'20496.00',USD:'545.02'});
  assert.deepEqual(summary.unclassifiedBalancesByCurrency,{});
  assert.equal(receivablesAnswer(summary),expected);
  assert.deepEqual(summarizeReceivables(uiLedger()),summary,'major-unit server and minor-unit browser ledgers agree');
  assert.equal(receivableKind({...ledger[0],status:'draft',followup_state:'approved'}),'draft','reminder approval never issues an invoice');
});

test('all issued state aliases include only the unpaid remainder; overpaid and unknown rows cannot inflate issued receivables',()=>{
  for(const status of ['issued','sent','open','overdue','partially_paid','partially-paid']){
    assert.equal(summarizeReceivables([{...ledger[0],status}]).currencies.INR.outstandingAmount,'1.00',status);
  }
  assert.deepEqual(summarizeReceivables([{...ledger[0],amount_paid:'150.00'},{...ledger[0],status:'paid',amount_paid:'0.00'}]).currencies,{});
  assert.deepEqual(summarizeReceivables([{...ledger[0],status:'unknown'}]).currencies,{});
  assert.equal(receivablesAnswer(summarizeReceivables([])),'Issued outstanding: none.\nUnissued drafts (not yet receivable): none.');
});

test('Overview and Collections Pulse use the same split and drafts never become overdue or due soon',()=>{
  const invoices=uiLedger();
  const rows=collectionsPulse(invoices,[],{today:'2026-10-23'});
  assert.deepEqual(rows,[
    {currency:'AUD',outstanding:0,unissuedDrafts:449000,overdue:0,dueNext7Days:0,collectedThisMonth:0},
    {currency:'INR',outstanding:100,unissuedDrafts:2049600,overdue:100,dueNext7Days:0,collectedThisMonth:0},
    {currency:'USD',outstanding:25506,unissuedDrafts:54502,overdue:25506,dueNext7Days:0,collectedThisMonth:0},
  ]);
  assert.equal(totals(invoices,'INR').outstanding,100);
  assert.equal(totals(invoices,'INR').unissuedDrafts,2049600);
  assert.equal(totals(invoices,'USD').outstanding,25506);
});

test('grounding rejects draft-inclusive outstanding even when every amount appears in fresh database evidence',()=>{
  const read={ok:true,operation:'read',table:'invoices',readOnly:true,rows:ledger,truncated:false,offset:0};
  for(const reply of ['Outstanding: INR 20497.00, USD 800.08, AUD 4490.00.', 'Your outstanding balance is INR 20497.00.', 'Outstanding including drafts: INR 20497.00.'])
    assert.equal(ownerGroundingIssue(reply,[read]),'fresh_database_read_required');
  assert.equal(ownerGroundingIssue(expected,[read]),null);
  assert.equal(receivablesReadAnswer(read),expected);
  for(const overrides of [{truncated:true},{offset:50},{ok:false}])assert.equal(receivablesReadAnswer({...read,...overrides}),null);
});

test('currency-keyed aggregate evidence retains currency for multiple issued rows and a separate draft',()=>{
  const rows=[ledger[0],{...ledger[0],total_amount:'105.00'},ledger[2]];
  const summary=summarizeReceivables(rows);
  const read={ok:true,readOnly:true,operation:'read',table:'invoices',rows,truncated:false,balanceSummary:summary};
  assert.equal(summary.currencies.INR.outstandingAmount,'7.00');
  assert.equal(ownerGroundingIssue(receivablesAnswer(summary),[read]),null);
});

test('issued invoice detail totals and paid allocations are not confused with the outstanding remainder',()=>{
  const read={ok:true,readOnly:true,operation:'read',table:'invoices',truncated:false,rows:[ledger[1]]};
  assert.equal(ownerGroundingIssue('Total: USD 300.00; current paid balance: USD 44.94; issued outstanding: USD 255.06.',[read]),null);
  assert.equal(ownerGroundingIssue('USD 255.06 outstanding; USD 44.94 paid.',[read]),null);
  assert.equal(ownerGroundingIssue('Total: USD 300.00; current paid balance: USD 44.94; issued outstanding: USD 300.00.',[read]),'fresh_database_read_required');
});
