import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setup} from './r8-review-harness.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-derived-values.json',JSON.stringify(evidence,null,2)));
test('a deterministic DB balance reply retains its newly computed private aggregate before returning',async t=>{
 const f=await setup();try{
  for(const [i,total]of [1301,2473].entries())await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,metadata) values($1,$2,$3,$4,'INR','draft',$5)",[f.scope.workspaceId,f.scope.customerId,'R8-DERIVED-'+i,total,{invoice_direction:'receivable'}]);
  for(const audience of ['owner','customer'])await t.test(audience,async()=>{
   // Rebuild only source-row retention for each audience. An owner-only repair
   // must not teach the customer's test the computed value before it runs.
   await f.reset();await f.db.query('select app.retain_private_ledger_document(to_jsonb(i)) from invoices i where workspace_id=$1',[f.scope.workspaceId]);
   const before=await f.terms(),read=await f.turn(audience,'balance');assert.equal(read.wires.length,0);assert.match(JSON.stringify(read.result),/3774/);f.restart();
   const row={scope:f.scope,storedTotals:[1301,2473],aggregate:3774,before,read,terms:await f.terms(),...await f.turn(audience,'send 3774 today')};evidence.push(row);assert.equal(row.wires.length,0,JSON.stringify(row));
  });
 }finally{await f.close();}
});
