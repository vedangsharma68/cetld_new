import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const migrationUrl=new URL('../supabase/migrations/20260929110000_workspace_invoice_number_inference.sql',import.meta.url);
const db=new PGlite();
const workspace=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const customer='20000000-0000-4000-8000-000000000001';

async function seed(workspaceId,numbers,{recentFirst=false}={}){
  for(const [index,number] of numbers.entries()) await db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,created_at)
     values ($1,$2,$3,$4)`,
    [workspaceId,customer,number,new Date(Date.UTC(2026,0,recentFirst?numbers.length-index:index+1)).toISOString()],
  );
}

async function generated(workspaceId,source='AUTO',metadata={}){
  return (await db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,metadata)
     values ($1,$2,$3,$4) returning invoice_number,metadata`,
    [workspaceId,customer,source,metadata],
  )).rows[0];
}

before(async()=>{
  await db.exec(`create table public.invoices(
      id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
      customer_id uuid not null, invoice_number text not null, issue_date date,
      metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      unique(workspace_id,invoice_number)
    );`);
  await seed(workspace(1),['1001','1002','1003']);
  await seed(workspace(2),['INV-003','INV-004','INV-005']);
  await seed(workspace(3),['INV-2025-0040','INV-2025-0041','INV-2025-0042']);
  // Six recent prefixed values narrowly outweigh six older integers under the
  // documented 4/2/1 recency buckets.
  await seed(workspace(4),['INV-015','INV-014','INV-013','INV-012','INV-011','INV-010','1006','1005','1004','1003','1002','1001'],{recentFirst:true});
  await seed(workspace(5),['1001','B-001']);
  await seed(workspace(7),['legacy-freeform']);
  await db.exec(await readFile(migrationUrl,'utf8'));
});

after(()=>db.close());

test('continues a dominant plain integer sequence',async()=>{
  assert.equal((await generated(workspace(1))).invoice_number,'1004');
});

test('continues a prefixed sequence and retains zero padding',async()=>{
  assert.equal((await generated(workspace(2))).invoice_number,'INV-006');
});

test('rolls an embedded year to the current year while incrementing its sequence',async()=>{
  const year=new Date().getUTCFullYear();
  assert.equal((await generated(workspace(3))).invoice_number,`INV-${year}-0043`);
});

test('recency weighting breaks a raw-count tie in favor of the recent convention',async()=>{
  assert.equal((await generated(workspace(4))).invoice_number,'INV-016');
});

test('an evenly mixed workspace falls back instead of guessing',async()=>{
  const year=new Date().getUTCFullYear();
  assert.equal((await generated(workspace(5))).invoice_number,`INV-${year}-0001`);
});

test('an empty workspace uses the fallback',async()=>{
  const year=new Date().getUTCFullYear();
  assert.equal((await generated(workspace(6))).invoice_number,`INV-${year}-0001`);
});

test('legacy values remain untouched and imported source numbers are preserved',async()=>{
  const created=await generated(workspace(7),'SOURCE-77');
  assert.equal((await db.query('select invoice_number from public.invoices where workspace_id=$1 order by created_at limit 1',[workspace(7)])).rows[0].invoice_number,'legacy-freeform');
  assert.equal(created.metadata.source_invoice_number,'SOURCE-77');
});

test('migration documents supported families, concurrency lock, and strict-majority fallback',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  for(const family of ['integer','prefix','year','date_compact','date_delimited']) assert.ok(sql.includes(`'${family}'`),family);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/chosen\.score \* 2 <= chosen\.total_weight/);
  assert.doesNotMatch(sql,/update\s+public\.invoices\s+set\s+invoice_number/i);
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(app,/Assigned automatically in your workspace’s usual format/);
  assert.match(app,/number:row\.invoice_number/);
  assert.match(app,/Existing invoice numbers stay unchanged\./);
});
