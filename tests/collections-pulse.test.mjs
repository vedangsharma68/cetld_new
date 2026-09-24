import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionsPulse} from '../collections-pulse.mjs';

const invoice=(id,currency,amount,paid,due,status='open')=>({id,currency,amount_minor:amount,paid_minor:paid,due_date:due,status});

test('calculates outstanding, overdue, seven-day due and calendar-month payments',()=>{
  const invoices=[
    invoice('late','INR',10000,2500,'2026-09-22'),
    invoice('today','INR',5000,0,'2026-09-23'),
    invoice('soon','INR',8000,1000,'2026-09-30'),
    invoice('later','INR',9000,0,'2026-10-01'),
  ];
  const payments=[
    {invoice_id:'late',amount_minor:2500,paid_at:'2026-09-01T10:00:00Z'},
    {invoice_id:'soon',amount_minor:1000,paid_at:'2026-08-31T20:00:00-04:00'},
  ];
  assert.deepEqual(collectionsPulse(invoices,payments,{today:'2026-09-23',defaultCurrency:'INR'}),[
    {currency:'INR',outstanding:28500,overdue:7500,dueNext7Days:12000,collectedThisMonth:3500},
  ]);
});

test('keeps currencies separate and derives payment currency from its invoice',()=>{
  const rows=collectionsPulse([
    invoice('inr','INR',12500,0,'2026-09-24'),invoice('usd','USD',9900,0,'2026-09-25'),
  ],[{invoice_id:'usd',amount_minor:1200,created_at:'2026-09-15T00:00:00Z'}],{today:'2026-09-23'});
  assert.deepEqual(rows,[
    {currency:'INR',outstanding:12500,overdue:0,dueNext7Days:12500,collectedThisMonth:0},
    {currency:'USD',outstanding:9900,overdue:0,dueNext7Days:9900,collectedThisMonth:1200},
  ]);
});

test('returns a zeroed default-currency card for an empty workspace',()=>{
  assert.deepEqual(collectionsPulse([],[],{today:'2026-09-23',defaultCurrency:'EUR'}),[
    {currency:'EUR',outstanding:0,overdue:0,dueNext7Days:0,collectedThisMonth:0},
  ]);
});

test('excludes cancelled balances and ignores payments outside the current month',()=>{
  const rows=collectionsPulse([invoice('void','INR',5000,0,'2026-09-22','cancelled')],[
    {invoice_id:'void',amount_minor:2000,paid_at:'2026-08-31T18:00:00Z'},
  ],{today:'2026-09-23'});
  assert.equal(rows[0].outstanding,0);
  assert.equal(rows[0].overdue,0);
  assert.equal(rows[0].collectedThisMonth,0);
});

test('uses the workspace timezone at a calendar-month boundary and skips unknown payment currencies',()=>{
  const rows=collectionsPulse([invoice('known','USD',1000,0,'2026-10-10')],[
    {invoice_id:'known',amount_minor:300,paid_at:'2026-09-30T20:30:00Z'},
    {invoice_id:'missing',amount_minor:900,paid_at:'2026-09-30T20:30:00Z'},
  ],{today:'2026-10-01',defaultCurrency:'INR',timeZone:'Asia/Kolkata'});
  assert.deepEqual(rows,[
    {currency:'USD',outstanding:1000,overdue:0,dueNext7Days:0,collectedThisMonth:300},
  ]);
});

