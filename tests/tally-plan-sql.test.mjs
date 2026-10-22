import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
const customer=(name,extra={})=>({name,email:'',phone:'',guid:'',originalId:'',...extra});
const invoice=(name,number,extra={})=>({customer:name,number,guid:'',originalId:'',issueDate:'2026-10-01',dueDate:'2026-10-31',currency:'INR',total:'100',...extra});
async function fixture(){
 const f=await createOfflineSqlNetwork(),owner=randomUUID(),foreign=randomUUID();
 await f.db.query('insert into auth.users(id) values($1),($2)',[owner,foreign]);
 const identity=async id=>{await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[id]);await f.db.exec('set role authenticated')};
 await identity(owner);const ws=(await f.db.query('select (public.create_workspace($1,$2)).id',['Tally plan',randomUUID()])).rows[0].id;
 const preview=async(cs,is)=>(await f.db.query('select public.preview_tally($1,$2,$3) value',[ws,cs,is])).rows[0].value;
 const apply=async(cs,is,hash)=>(await f.db.query('select public.import_tally($1,$2,$3,$4) value',[ws,cs,is,hash])).rows[0].value;
 return {...f,owner,foreign,ws,identity,preview,apply};
}
test('read-only exact plan simulates duplicate rows and permits same source number for different customers',async()=>{
 const f=await fixture();try{
 const cs=[customer('Acme, Ltd'),customer('Beta'),customer('Acme, Ltd')],is=[invoice('Acme, Ltd','S-1'),invoice('Beta','S-1'),invoice('Acme, Ltd','S-1')];
 const plan=await f.preview(cs,is);assert.deepEqual(plan.counts,{customers:{created:2,skipped:1,failed:0},invoices:{created:2,skipped:1,failed:0}});
 assert.equal((await f.db.query('select count(*)::int n from customers where workspace_id=$1',[f.ws])).rows[0].n,0);
 assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,0);
 await f.db.exec('reset role');assert.equal((await f.db.query('select count(*)::int n from invoice_number_sequences where workspace_id=$1',[f.ws])).rows[0].n,0);await f.identity(f.owner);
 assert.deepEqual(await f.preview(cs,is),plan);
 const result=await f.apply(cs,is,plan.planHash);assert.deepEqual({customers:result.customers,invoices:result.invoices},plan.counts);
 const rows=(await f.db.query("select customer_id,invoice_number,metadata->>'source_invoice_number' source from invoices where workspace_id=$1",[f.ws])).rows;
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.invoice_number)).size,2);assert.ok(rows.every(r=>r.source==='S-1'));
 const retry=await f.preview(cs,is);assert.equal(retry.counts.customers.created,0);assert.equal(retry.counts.invoices.created,0);assert.equal(retry.counts.invoices.skipped,3);
 }finally{await f.close()}
});
test('stale confirmation and foreign owner are rejected before any import writes',async()=>{
 const f=await fixture();try{
 const cs=[customer('Acme')],is=[invoice('Acme','S-1')],plan=await f.preview(cs,is);
 await f.db.query("update workspace_settings set default_currency='USD' where workspace_id=$1",[f.ws]);
 await assert.rejects(f.apply(cs,is,plan.planHash),{code:'40001'});
 assert.equal((await f.db.query('select count(*)::int n from customers where workspace_id=$1',[f.ws])).rows[0].n,0);
 const updated=await f.preview(cs,is);assert.equal(updated.workspaceCurrency,'USD');assert.notEqual(updated.planHash,plan.planHash);
 await f.db.query("insert into customers(workspace_id,name) values($1,'Acme')",[f.ws]);await assert.rejects(f.apply(cs,is,updated.planHash),{code:'40001'});assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,0);
 await f.identity(f.foreign);await assert.rejects(f.preview(cs,is),{code:'42501'});await assert.rejects(f.apply(cs,is,updated.planHash),{code:'42501'});
 }finally{await f.close()}
});
test('GUID aliases resolve renamed ledgers, known email conflicts are previewed, currencies stay explicit',async()=>{
 const f=await fixture();try{
 await f.db.query("insert into customers(workspace_id,name,email,metadata) values($1,'Old name','used@example.test',$2)",[f.ws,{source:'tally',tally:{guid:'customer-guid'}}]);
 await f.db.query("insert into customers(workspace_id,name) values($1,'Renamed')",[f.ws]);
 const cs=[customer('Renamed',{guid:'customer-guid'}),customer('Conflicting',{email:'used@example.test'}),customer('Foreign')];
 const is=[invoice('Renamed','S-1',{currency:'USD'}),invoice('Conflicting','S-2'),invoice('Foreign','S-3',{currency:''}),invoice('Foreign','S-4',{currency:'JPY'})];
 const plan=await f.preview(cs,is);assert.deepEqual(plan.counts,{customers:{created:1,skipped:1,failed:1},invoices:{created:2,skipped:0,failed:2}});
 assert.equal(plan.customers[0].action,'skip');assert.match(plan.customers[1].reason,/Email/);assert.equal(plan.invoices[0].customerRef,plan.customers[0].customerRef);
 assert.equal(plan.invoices[0].currency,'USD');assert.equal(plan.invoices[2].currency,'INR');
 const result=await f.apply(cs,is,plan.planHash);assert.deepEqual({customers:result.customers,invoices:result.invoices},plan.counts);
 const rows=(await f.db.query('select currency from invoices where workspace_id=$1 order by currency',[f.ws])).rows;assert.deepEqual(rows.map(r=>r.currency),['INR','USD']);
 }finally{await f.close()}
});
test('re-import after an unexpected partial row failure skips successes and retries only the failed invoice',async()=>{
 const f=await fixture();try{
 await f.db.exec(`reset role;create function public.test_tally_failure() returns trigger language plpgsql as $$begin if new.metadata->>'source_invoice_number'='FAIL' then raise exception 'injected failure';end if;return new;end;$$;create trigger test_tally_failure before insert on public.invoices for each row execute function public.test_tally_failure();`);
 await f.identity(f.owner);
 const cs=[customer('Acme')],is=[invoice('Acme','OK'),invoice('Acme','FAIL')];const first=await f.preview(cs,is);
 assert.equal(first.counts.invoices.created,2);const applied=await f.apply(cs,is,first.planHash);assert.deepEqual(applied.invoices,{created:1,skipped:0,failed:1});
 await f.db.exec('reset role;drop trigger test_tally_failure on public.invoices;drop function public.test_tally_failure()');await f.identity(f.owner);
 const retry=await f.preview(cs,is);assert.deepEqual(retry.counts,{customers:{created:0,skipped:1,failed:0},invoices:{created:1,skipped:1,failed:0}});
 const result=await f.apply(cs,is,retry.planHash);assert.deepEqual({customers:result.customers,invoices:result.invoices},retry.counts);
 assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,2);
 }finally{await f.close()}
});
