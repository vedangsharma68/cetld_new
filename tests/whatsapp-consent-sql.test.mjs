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
    await assert.rejects(db.query(`delete from public.workspace_settings where workspace_id='${id(3)}'`),/attestation cannot be deleted/);
    await db.exec(`set request.jwt.claim.sub = '${id(9)}'`);
    assert.equal((await db.query('select * from public.whatsapp_consents')).rows.length,0);
    await db.exec(`set request.jwt.claim.sub = '${id(1)}'`);
    await assert.rejects(db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`),/permission denied/);
    await db.exec('reset role; set role service_role');
    const first=(await db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`)).rows[0];
    assert.deepEqual(first,{revoked:true,confirmation_due:true});
    const repeat=(await db.query(`select * from public.whatsapp_revoke_phone('${id(3)}','${phone}','stop','wamid-test')`)).rows[0];
    assert.deepEqual(repeat,{revoked:false,confirmation_due:false});
    assert.equal((await db.query(`select count(*)::integer as count from public.whatsapp_suppressions where workspace_id='${id(3)}' and phone='${phone}'`)).rows[0].count,1);
    const unknown='+919999999999';
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-unknown') as claimed`)).rows[0].claimed,true);
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-unknown') as claimed`)).rows[0].claimed,false);
    assert.equal((await db.query(`select public.whatsapp_suppress_unknown_phone('${phone}','wamid-known') as claimed`)).rows[0].claimed,false);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${id(9)}'`);
    assert.equal((await db.query('select * from public.whatsapp_suppressions')).rows.length,0);
    await assert.rejects(db.query(`select public.whatsapp_suppress_unknown_phone('${unknown}','wamid-forged')`),/permission denied/);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${id(1)}'`);
    await assert.rejects(db.query(`select * from public.whatsapp_record_verbal_consent('${id(3)}','${id(4)}','${phone}')`),/suppressed/);
  }finally{await db.close()}
});
