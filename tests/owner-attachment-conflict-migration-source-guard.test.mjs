import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('unpaid stamp migration accepts only the approved installed source or its exact fixed body',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:['20261008153500_owner_live_clarification_evidence.sql','20261008193550_invoice_review_inferred_currency_unpaid_correction.sql']}),{db}=f;
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
  const originalSql=await readFile(new URL('../supabase/migrations/20261002110000_whatsapp_invoice_review_fact_continuation.sql',import.meta.url),'utf8');
  await db.exec(originalSql.replaceAll('\n','\r\n'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261007193000_invoice_review_json_expression_precedence.sql',import.meta.url),'utf8'));
  const approvedCrlf=await routine();
  assert.equal(approvedCrlf.prosrc,approved.prosrc.replaceAll('\n','\r\n'),'the installed CRLF lineage contains exactly the approved source');
  assert.equal((await db.query('select md5($1::text) value',[approvedCrlf.prosrc])).rows[0].value,'be56f8a9d0344bea9c74b425846d015e');
  await db.exec(migration);assert.deepEqual(await routine(),fixed,'the exact CRLF predecessor installs the same fixed body and retains security');
  const crlfMigration=migration.replaceAll('\n','\r\n');
  await db.exec(crlfMigration);const fixedCrlf=await routine();
  assert.equal(fixedCrlf.prosrc,fixed.prosrc.replaceAll('\n','\r\n'));
  assert.equal((await db.query('select md5($1::text) value',[fixedCrlf.prosrc])).rows[0].value,'e037e6cdba625a819dd0293d0706140d');
  await db.exec(crlfMigration);assert.deepEqual(await routine(),fixedCrlf,'the exact CRLF forward body is idempotent');
  await db.exec(migration);assert.deepEqual(await routine(),fixed,'the LF forward body accepts only the exact known CRLF forward body');
  const mixed=fixed.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\r');
  await db.exec(mixed);const mixedSnapshot=await routine();
  await assert.rejects(db.exec(migration),/Unexpected invoice review source; no changes applied/);await db.exec('rollback');
  assert.deepEqual(await routine(),mixedSnapshot,'mixed line endings are not broadly normalized or silently accepted');
  await db.exec(fixed.definition);
  const drifted=fixed.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\n  -- Unexpected installed drift');
  assert.notEqual(drifted,fixed.definition);await db.exec(drifted);
  const drift=await routine();
  await assert.rejects(db.exec(migration),/Unexpected invoice review source; no changes applied/);
  await db.exec('rollback');
  assert.deepEqual(await routine(),drift,'unknown installed source remains untouched');
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
