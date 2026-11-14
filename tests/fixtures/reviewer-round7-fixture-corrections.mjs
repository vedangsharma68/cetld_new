import assert from 'node:assert/strict';

// Only fixture operations change. The supplied originals and all their
// assertions are preserved; the executable test copies stay ordinary files.
export const reviewerFixtureCorrections={
 'independent-regressions':[
  ["await f.db.query('delete from invoices where id=$1',[inv.id]);", "// Direct hard deletion is intentionally forbidden, even in this fixture.\n   // Keep the seed until f.close() tears down its isolated database.\n   await assert.rejects(f.db.query('delete from invoices where id=$1',[inv.id]),/invoice hard delete is disabled/);"],
 ],
 'native-concurrency':[
  ["p.then(r=>({ok:true,rowCount:r.rowCount})", "p.then(r=>({ok:true,rowCount:r.rowCount,returnedId:r.rows?.[0]?.id??null})"],
  ["select exists(select 1 from invoices where workspace_id=$1 and invoice_number='R7-CONCURRENT') yes\",[workspace]", "select exists(select 1 from invoices where workspace_id=$1 and customer_id=$2 and id=$3 and total_amount=717777 and metadata->>'source_invoice_number'='R7-CONCURRENT') yes\",[workspace,c,evidence.retentionInsert.returnedId]"],
 ],
};
export function correctReviewerFixture(name,original){
 assert.ok(Object.hasOwn(reviewerFixtureCorrections,name));let executable=original;
 for(const [before,after] of reviewerFixtureCorrections[name]){
  assert.equal(executable.split(before).length,2,'One exact fixture correction: '+name);
  executable=executable.replace(before,after);
 }
 let restored=executable;for(const [before,after] of [...reviewerFixtureCorrections[name]].reverse())restored=restored.replace(after,before);
 assert.equal(restored,original,'No unrelated source or assertion changes');return executable;
}
