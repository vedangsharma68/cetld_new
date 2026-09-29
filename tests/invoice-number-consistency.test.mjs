import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const migrationUrl=new URL('../supabase/migrations/20260929100000_consistent_invoice_numbers.sql',import.meta.url);

test('invoice-number migration assigns the workspace/year sequence and preserves source references',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.match(sql,/new\.invoice_number := 'INV-' \|\| number_year::text \|\| '-' \|\| lpad\(next_value::text, 4, '0'\)/);
  assert.match(sql,/public\.invoice_number_sequences\.last_value \+ 1/);
  assert.match(sql,/jsonb_build_object\('source_invoice_number', source_number\)/);
  assert.match(sql,/before insert on public\.invoices/);
  assert.doesNotMatch(sql,/update\s+public\.invoices\s+set\s+invoice_number/i);
});

test('existing invoice values remain searchable and are not normalized by application display code',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(app,/number:row\.invoice_number/);
  assert.match(app,/Existing invoice numbers stay unchanged\./);
  assert.match(app,/state\.search/);
  for(const value of ['INV-20260929-72FCD5','1001','INV-005','1223113']) assert.ok(app.includes('number:row.invoice_number'),value);
});
