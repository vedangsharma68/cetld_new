import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const migrationUrl=new URL('../supabase/migrations/20261002110000_whatsapp_invoice_review_fact_continuation.sql',import.meta.url);

test('incomplete review fact continuation remains scoped, CAS-locked, source-bound, and immutable',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.ok(sql.toLowerCase().includes('begin;'));
  assert.ok(sql.trimEnd().toLowerCase().endsWith('commit;'));
  assert.match(sql,/p_from_stage\s*=\s*'incomplete'\s+and\s+v_to_stage\s+in\s*\('incomplete','proposal','canceled'\)/i);
  assert.match(sql,/and p\.workspace_id\s*=\s*p_workspace_id and p\.customer_id\s*=\s*p_customer_id and p\.phone\s*=\s*p_phone[\s\S]*for update/i);
  assert.match(sql,/p\.consumed_at\s+is\s+null[\s\S]*p\.expires_at\s*>\s*pg_catalog\.clock_timestamp\(\)/i);
  assert.match(sql,/p_action\s*-\s*array\['stage','invoice','missingFields','ownerProvidedFacts','currencySource'\][\s\S]*v_current_action/i);
  assert.match(sql,/p_action->'invoice'\s*-\s*v_resolved_invoice_keys[\s\S]*v_current_action->'invoice'\s*-\s*v_resolved_invoice_keys/i);
  assert.match(sql,/p_action->'ownerProvidedFacts'\s*-\s*v_resolved_fields[\s\S]*v_current_action->'ownerProvidedFacts'/i);
  assert.match(sql,/m\.workspace_id\s*=\s*p_workspace_id and m\.phone\s*=\s*p_phone[\s\S]*m\.audience\s*=\s*'owner' and m\.direction\s*=\s*'inbound'[\s\S]*m\.created_at\s*>=\s*v_created_at/i);
  assert.match(sql,/set action\s*=\s*p_action, version\s*=\s*p\.version\s*\+\s*1/i);
  assert.match(sql,/v_current_action->>'currencySource' is null[\s\S]*p_action->>'currencySource' = 'photo'[\s\S]*not \(v_current_action->'missingFields' @>[\s\S]*is not true then[\s\S]*currency source is immutable/i);
  assert.match(sql,/revoke all on function public\.whatsapp_transition_invoice_review[\s\S]*grant execute on function public\.whatsapp_transition_invoice_review[\s\S]*to service_role/i);
});
