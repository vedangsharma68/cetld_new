import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const phone='+919871367051';

test('migration gates phone saves, isolates consent, and makes STOP idempotent',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      grant usage on schema public,auth to authenticated,service_role;
      grant usage on schema storage to authenticated;
      insert into auth.users(id) values ('${id(1)}'),('${id(2)}'),('${id(9)}');`);
    const core=(await readFile(new URL('../supabase/migrations/20260922090000_core_backend.sql',import.meta.url),'utf8'))
      .replace('create extension if not exists pgcrypto;',''); // PGlite has gen_random_uuid but not pgcrypto extension files.
    await db.exec(core);
    await db.exec(await readFile(new URL('../supabase/migrations/20260927100000_whatsapp_consent_and_suppression.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20260927130000_whatsapp_stop_claim_lock.sql',import.meta.url),'utf8'));
    await db.exec(`insert into public.workspaces(id,owner_id,name,slug) values ('${id(3)}','${id(1)}','Owner Studio','owner-studio');
      insert into public.workspace_members(workspace_id,user_id,role) values ('${id(3)}','${id(1)}','owner'),('${id(3)}','${id(2)}','admin');
      insert into public.workspace_settings(workspace_id,business_name) values ('${id(3)}','Owner Studio');
      set role authenticated; set request.jwt.claim.sub = '${id(1)}';`);
    await assert.rejects(db.query(`insert into public.customers(id,workspace_id,name,phone) values ('${id(4)}','${id(3)}','Client','${phone}')`),/attest before a client phone/);
    await db.exec(`set request.jwt.claim.sub = '${id(2)}'`);
    await assert.rejects(db.query(`update public.workspace_settings set whatsapp_owner_attested_at=now() where workspace_id='${id(3)}'`),/Only the workspace owner/);
    await db.exec(`set request.jwt.claim.sub = '${id(1)}'`);
    await db.query(`update public.workspace_settings set whatsapp_owner_attested_at=now(), whatsapp_owner_attested_by='${id(1)}' where workspace_id='${id(3)}'`);
    await db.query(`insert into public.customers(id,workspace_id,name,phone) values ('${id(4)}','${id(3)}','Client','${phone}')`);
    const consent=(await db.query(`select * from public.whatsapp_record_verbal_consent('${id(3)}','${id(4)}','${phone}')`)).rows[0];
    assert.equal(consent.phone,phone);
    await db.exec('reset role');
    await db.exec(`insert into public.workspaces(id,owner_id,name,slug) values ('${id(5)}','${id(9)}','Other Studio','other-studio');
      insert into public.workspace_members(workspace_id,user_id,role) values ('${id(5)}','${id(9)}','owner');
      insert into public.workspace_settings(workspace_id,business_name) values ('${id(5)}','Other Studio');
      insert into public.customers(id,workspace_id,name) values ('${id(6)}','${id(5)}','Other Client');
      insert into public.whatsapp_consents(workspace_id,phone,customer_id,consent_text_version,source)
      values ('${id(5)}','+15551234567','${id(6)}','invoice_updates_v1','verbal');
      set role authenticated; set request.jwt.claim.sub = '${id(1)}';`);
    assert.deepEqual((await db.query('select workspace_id from public.whatsapp_consents')).rows.map(row => row.workspace_id),[id(3)]);
    await assert.rejects(db.query(`update public.whatsapp_consents set consent_text_version='forged' where workspace_id='${id(3)}'`),/permission denied/);
    await assert.rejects(db.query(`delete from public.whatsapp_consents where workspace_id='${id(3)}'`),/permission denied/);
    await assert.rejects(db.query(`delete from public.workspace_settings where workspace_id='${id(3)}'`),/attestation cannot be deleted/);
    await db.exec(`set request.jwt.claim.sub = '${id(9)}'`);
    assert.deepEqual((await db.query('select workspace_id from public.whatsapp_consents')).rows.map(row => row.workspace_id),[id(5)]);
    await assert.rejects(db.query(`insert into public.whatsapp_consents(workspace_id,phone,customer_id,consent_text_version,source)
      values ('${id(3)}','${phone}','${id(4)}','invoice_updates_v1','verbal')`),/permission denied/);
    await db.exec(`set request.jwt.claim.sub = '${id(1)}'`);
    await assert.rejects(db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`),/permission denied/);
    await db.exec('reset role; set role service_role');
    const first=(await db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`)).rows[0];
    assert.deepEqual(first,{revoked:true,confirmation_due:true});
    const repeat=(await db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`)).rows[0];
    assert.deepEqual(repeat,{revoked:false,confirmation_due:true});
    const otherMessage=(await db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-other')`)).rows[0];
    assert.deepEqual(otherMessage,{revoked:false,confirmation_due:false});
    assert.equal((await db.query(`select count(*)::integer as count from public.whatsapp_suppressions where workspace_id='${id(3)}' and phone='${phone}'`)).rows[0].count,1);
    const unknown='+919999999999';
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-unknown') as claimed`)).rows[0].claimed,true);
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-unknown') as claimed`)).rows[0].claimed,true);
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-other') as claimed`)).rows[0].claimed,false);
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${phone}','wamid-known') as claimed`)).rows[0].claimed,false);
    assert.equal((await db.query(`select count(*)::integer as count from public.whatsapp_global_suppressions where phone='${phone}'`)).rows[0].count,1);
    await assert.rejects(db.query(`insert into public.whatsapp_consents(workspace_id,phone,customer_id,consent_text_version,source)
      values ('${id(3)}','${unknown}','${id(4)}','invoice_updates_v1','verbal')`),/globally suppressed/);
    const guardedFunctions = ['whatsapp_record_verbal_consent', 'whatsapp_revoke_phone', 'whatsapp_suppress_unknown_phone'];
    for (const name of guardedFunctions) {
      const definition = (await db.query(`select pg_get_functiondef(p.oid) as sql from pg_proc p where p.proname=$1`, [name])).rows[0].sql;
      assert.match(definition, /pg_advisory_xact_lock\s*\(/i, `${name} must serialize by phone`);
    }
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${id(9)}'`);
    assert.equal((await db.query('select * from public.whatsapp_suppressions')).rows.length,0);
    await assert.rejects(db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-forged')`),/permission denied/);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${id(1)}'`);
    await assert.rejects(db.query(`select * from public.whatsapp_record_verbal_consent('${id(3)}','${id(4)}','${phone}')`),/suppressed/);
  }finally{await db.close()}
});

test('inbound event payloads and claim RPCs are service-role only', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key);
      create table public.whatsapp_global_suppressions(phone text, source_message_id text);
      create table public.whatsapp_suppressions(phone text);
      grant usage on schema public to anon,authenticated,service_role;`);
    await db.exec(await readFile(new URL('../supabase/migrations/20260927110000_whatsapp_inbound_events.sql',import.meta.url),'utf8'));
    await db.exec(`insert into public.whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text)
      values ('wamid-private','1234567890','+919871367051','text','Private message');`);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from public.whatsapp_inbound_events'),/permission denied/);
    await assert.rejects(db.query('select * from public.whatsapp_claim_inbound_events(1)'),/permission denied/);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.whatsapp_inbound_events'),/permission denied/);
    await db.exec('set role service_role');
    assert.equal((await db.query('select count(*)::integer as n from public.whatsapp_inbound_events')).rows[0].n,1);
  } finally { await db.close(); }
});
