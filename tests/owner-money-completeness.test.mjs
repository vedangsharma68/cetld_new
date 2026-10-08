import test from 'node:test';
import assert from 'node:assert/strict';
import {requestedInvoiceMoneyChange} from '../automation/whatsapp/invoice-corrections.mjs';

test('current explicit ISO money instructions bind the named fields and exact decimal value',()=>{
 for(const [message,expected] of [
  ['Set total to INR 6670',{currency:'INR',values:{total_amount:6670}}],
  ['Change subtotal to USD 100.25',{currency:'USD',values:{subtotal:100.25}}],
  ['Please update the total to 6,670.50 INR.',{currency:'INR',values:{total_amount:6670.5}}],
  ['The earlier amount was USD 100. Set both subtotal and total to INR 6670 and the due date to 2026-10-20.',{currency:'INR',values:{subtotal:6670,total_amount:6670}}],
  ['Set total to INR 6670 and tax to 0',{currency:'INR',values:{total_amount:6670,tax:0}}],
  ['Set subtotal 100 and total to INR 6670',{currency:'INR',values:{subtotal:100,total_amount:6670}}],
  ['Set subtotal to INR 6670 and total to 6670',{currency:'INR',values:{subtotal:6670,total_amount:6670}}],
  ['Set subtotal to INR 6670; set total to INR 6670',{currency:'INR',values:{subtotal:6670,total_amount:6670}}],
 ])assert.deepEqual(requestedInvoiceMoneyChange(message),expected,message);
});
test('quoted, negative, hypothetical, ambiguous and imprecise text cannot ground monetary constraints',()=>{
 for(const message of [
  'Could you set total to INR 6670?', 'Do not set total to INR 6670', 'Set total to INR 6670 if approved',
  'Previously set total to INR 6670', '"Set total to INR 6670"', 
  'Set total to JPY 100', 'Set total to ₹6670', 'Set notes to total INR 6670',
 ])assert.equal(requestedInvoiceMoneyChange(message),null,message);
});

test('ambiguous positive monetary commands remain a rejection constraint rather than disabling preflight',()=>{
 for(const message of ['Set total for 1 service to INR 6670','Set total for 2 units to USD 100','Set total to INR 6670 plus 100','Set total to INR 6670 or USD 100','Set total to INR 100 or INR 200','Set total to INR 6,67','Set total to INR 100.234','Set total to INR 100; set total to INR 200','Set subtotal to USD 100; set total to INR 6670','Set total to INR 6670 and tax','Set total to INR 6670 and total to 6600'])assert.deepEqual(requestedInvoiceMoneyChange(message),{ambiguous:true},message);
});
