import test from 'node:test';
import assert from 'node:assert/strict';
import {cents,payment,remaining,status,settleInvoice,canApprove,csvCell} from '../core.mjs';
const invoice={amount_minor:10000,paid_minor:2000,due_date:'2026-09-01',followup_state:'approved'};
test('money conversion is exact and rejects invalid input',()=>{assert.equal(cents('0.29'),29);assert.equal(cents('1234.56'),123456);for(const x of ['1.001','-3','Infinity','1e4','0'])assert.throws(()=>cents(x));});
test('partial payment keeps balance and full payment cancels follow-up',()=>{const partial=payment(invoice,3000);assert.equal(remaining(partial),5000);assert.equal(partial.followup_state,'approved');const full=payment(partial,5000);assert.equal(status(full),'Paid');assert.equal(full.followup_state,'cancelled');assert.equal(canApprove(full),false);assert.throws(()=>payment(full,1));});
test('already-paid settlement clears reminder scheduling for both invoice schemas',()=>{assert.deepEqual(settleInvoice({invoice:{amount_minor:1000,paid_minor:0,followup_state:'approved',next_follow_up_at:'2026-09-24T09:00:00Z'},alreadyPaid:true}),{amount_minor:1000,paid_minor:1000,followup_state:'cancelled',next_follow_up_at:null,status:'paid'});const row=settleInvoice({invoice:{total_amount:10,amount_paid:0,status:'draft',metadata:{followup_state:'approved'}},alreadyPaid:true});assert.equal(row.amount_paid,10);assert.equal(row.status,'paid');assert.equal(row.metadata.followup_state,'cancelled');assert.equal(row.metadata.next_follow_up_at,null);});
test('overpayments and malformed payment amounts are rejected',()=>{for(const x of [8001,0,-1,1.5,NaN])assert.throws(()=>payment(invoice,x));});
test('due dates use date-only comparison',()=>{assert.equal(status(invoice,'2026-09-01'),'Due today');assert.equal(status(invoice,'2026-09-02'),'Overdue');assert.equal(status(invoice,'2026-08-31'),'Open');});
test('CSV export quotes values and neutralizes spreadsheet formulas',()=>{assert.equal(csvCell('=IMPORTXML("x")'),'"\'=IMPORTXML(""x"")"');assert.equal(csvCell('A, B'),'"A, B"');});

