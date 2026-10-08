import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('unpaid stamp migration accepts only the approved installed source or its exact fixed body',async()=>{
 const f=await createOfflineSqlNetwork(),{db}=f;
 try{
  const migration=await readFile(new URL('../supabase/migrations/20261008025552_invoice_review_unpaid_stamp_resolution.sql',import.meta.url),'utf8');
  const routine=async()=>(await db.query("select proowner,proacl,prosecdef,proconfig,prosrc,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
  const fixed=await routine();
  await db.exec(migration);assert.deepEqual(await routine(),fixed,'reapplying the exact fixed body is idempotent');
  await db.exec(await readFile(new URL('../supabase/migrations/20261002110000_whatsapp_invoice_review_fact_continuation.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261007193000_invoice_review_json_expression_precedence.sql',import.meta.url),'utf8'));
  const approved=await routine();
  assert.notEqual(approved.prosrc,fixed.prosrc);
  await db.exec(migration);assert.deepEqual(await routine(),fixed,'the exact approved predecessor installs the fixed body without changing its security');
  const drifted=fixed.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\n  -- Unexpected installed drift');
  assert.notEqual(drifted,fixed.definition);await db.exec(drifted);
  const drift=await routine();
  await assert.rejects(db.exec(migration),/Unexpected invoice review source; no changes applied/);
  await db.exec('rollback');
  assert.deepEqual(await routine(),drift,'unknown installed source remains untouched');
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
