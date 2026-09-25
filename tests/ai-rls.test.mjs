import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('real Postgres RLS: settings persist, isolate tenants, restrict members, prevent tenant reassignment', async () => {
  const db = new PGlite();
  try {
    // Minimal Supabase-managed schemas; all application migrations run unchanged
    // except pgcrypto installation (gen_random_uuid is built into this Postgres).
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,storage to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;`);
    const migrationNames=(await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
    let legacyWorkspaceId;
    for (const name of migrationNames) {
      if (name === '20260925130000_gemini_primary_openrouter_fallback.sql') {
        const legacyOwner='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        await db.query('insert into auth.users(id) values ($1)',[legacyOwner]);
        await db.query("select set_config('request.jwt.claim.sub',$1,false)",[legacyOwner]);
        legacyWorkspaceId=(await db.query("select (public.create_workspace('Legacy','legacy-space')).id")).rows[0].id;
        await db.query("insert into workspace_ai_settings(workspace_id,primary_model,fallback_model) values ($1,'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free','openrouter/free')",[legacyWorkspaceId]);
      }
      const sql = await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
      await db.exec(sql.replace('create extension if not exists pgcrypto;', ''));
    }
    const migratedLegacy=(await db.query('select primary_model,fallback_model from workspace_ai_settings where workspace_id=$1',[legacyWorkspaceId])).rows[0];
    assert.deepEqual(migratedLegacy,{primary_model:'gemini-3.5-flash',fallback_model:'openrouter/free'});
    const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', member='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await db.exec(`insert into auth.users(id) values ('${a}'),('${b}'),('${member}'); set role authenticated;`);
    async function identity(id) { await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); }
    await identity(a);
    const wa=(await db.query("select (public.create_workspace('Alpha','alpha-space')).id")).rows[0].id;
    const wa2=(await db.query("select (public.create_workspace('Alpha two','alpha-space-two')).id")).rows[0].id;
    await db.query("insert into workspace_members(workspace_id,user_id,role) values ($1,$2,'member')",[wa,member]);
    await db.query('insert into workspace_ai_settings(workspace_id) values ($1)',[wa]);
    const initial=(await db.query('select primary_model,fallback_model from workspace_ai_settings')).rows[0];
    assert.deepEqual(initial,{primary_model:'gemini-3.5-flash',fallback_model:'openrouter/free'});
    await db.query("update workspace_ai_settings set fallback_model='openrouter/free' where workspace_id=$1",[wa]);
    assert.equal((await db.query('select fallback_model from workspace_ai_settings')).rows[0].fallback_model,'openrouter/free');
    await assert.rejects(db.query("update workspace_ai_settings set primary_model='openrouter/free' where workspace_id=$1",[wa]),/check constraint/);
    await assert.rejects(db.query("update workspace_ai_settings set fallback_model='gemini-3.5-flash' where workspace_id=$1",[wa]),/check constraint/);
    await assert.rejects(db.query('update workspace_ai_settings set workspace_id=$1 where workspace_id=$2',[wa2,wa]), /immutable/);
    await identity(b);
    const wb=(await db.query("select (public.create_workspace('Beta','beta-space')).id")).rows[0].id;
    assert.equal((await db.query('select * from workspace_ai_settings')).rows.length,0);
    await assert.rejects(db.query('insert into workspace_ai_settings(workspace_id) values ($1)',[wa]), /row-level security/);
    await db.query('insert into workspace_ai_settings(workspace_id) values ($1)',[wb]);
    await identity(member);
    assert.equal((await db.query('select * from workspace_ai_settings')).rows.length,1);
    assert.equal((await db.query("update workspace_ai_settings set primary_model='vendor/other' returning workspace_id")).rows.length,0);
    await assert.rejects(db.query('insert into workspace_ai_settings(workspace_id) values ($1)',[wa2]),/row-level security/);
    await identity(a);
    await assert.rejects(db.query("update workspace_ai_settings set primary_model='invalid'"),/check constraint/);
    await assert.rejects(db.query('update workspace_ai_settings set fallback_model=primary_model'),/check constraint/);
    const policies = await db.query("select policyname from pg_policies where tablename='workspace_ai_settings'");
    assert.equal(policies.rows.length,3);
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from workspace_ai_settings'), /permission denied/);
  } finally { await db.close(); }
});
