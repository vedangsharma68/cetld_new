import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
const filename='20261008153500_owner_live_clarification_evidence.sql';
test('live clarification migration is exact, idempotent, transactional and retains routine security',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[filename,'20261008193550_invoice_review_inferred_currency_unpaid_correction.sql','20261009031935_invoice_review_nonzero_inferred_currency_correction.sql']});try{
  const sql=await readFile(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8');
  const routines=async()=>(await f.db.query("select proname,prosrc,proowner,proacl::text acl,prosecdef,proconfig from pg_proc where proname in ('owner_payment_instruction','whatsapp_confirm_owner_invoice_action','whatsapp_transition_invoice_review','whatsapp_apply_direct_owner_write','whatsapp_owner_partial_payment_capability') order by proname")).rows;
  const before=await routines();await f.db.exec(sql);const after=await routines();
  for(const old of before){const current=after.find(row=>row.proname===old.proname);const {prosrc:ignored,...security}=old;const {prosrc:other,...newSecurity}=current;assert.deepEqual(newSecurity,security);}
  await f.db.exec(sql);assert.deepEqual(await routines(),after);
  assert.deepEqual((await f.db.query('select whatsapp_owner_partial_payment_capability() value')).rows[0].value,{ok:true,version:3});
  assert.equal((await f.db.query("select has_function_privilege('service_role','app.owner_payment_amount_mentioned(text)','execute') value")).rows[0].value,false);
  const original=(await f.db.query("select pg_get_functiondef('public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure) definition")).rows[0].definition;
  const end=original.lastIndexOf('$function$');await f.db.exec(original.slice(0,end)+'\n-- unexpected local source drift\n'+original.slice(end));const drift=await routines();
  await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner evidence source/);await f.db.exec('rollback');assert.deepEqual(await routines(),drift);
  await f.db.exec(original);const mixed=original.replace('v_unpaid_resolution boolean := false;','v_unpaid_resolution boolean := false;\r');await f.db.exec(mixed);const mixedState=await routines();
  await assert.rejects(()=>f.db.exec(sql),/Unexpected installed owner evidence line endings/);await f.db.exec('rollback');assert.deepEqual(await routines(),mixedState);
 }finally{await f.close();}
});
