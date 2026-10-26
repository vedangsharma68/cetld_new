import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const filename='20261026045045_quoted_owner_consent_source.sql';
const phone='public.whatsapp_owner_save_phone(uuid,uuid,text,uuid,uuid,text,text,text)';
const consent='public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text)';

test('quoted-source migration refuses body drift atomically, installs without superuser, and retains scoped ACLs',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[filename]}),{db}=f;
 try{
  const sql=await readFile(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8');
  const definition=(await db.query('select pg_get_functiondef($1::regprocedure) v',[consent])).rows[0].v;
  await db.exec(definition.replace('begin\n','begin\n -- unrelated fixture hotfix\n'));
  await assert.rejects(db.exec(sql),/predecessor body drifted/);await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='whatsapp_inbound_events' and column_name='reply_context_id'")).rows[0].n,0);
  await db.exec(definition);
  await db.exec(`create role quoted_migration_editor nosuperuser bypassrls;
   grant usage,create on schema public,app to quoted_migration_editor;
   grant usage on schema auth to quoted_migration_editor;
   grant all on all tables in schema public to quoted_migration_editor;
   alter table public.whatsapp_messages owner to quoted_migration_editor;
   alter table public.whatsapp_inbound_events owner to quoted_migration_editor;
   alter function ${phone} owner to quoted_migration_editor;
   alter function ${consent} owner to quoted_migration_editor;
   set session authorization quoted_migration_editor;`);
  const routineSnapshot=async()=>(await db.query('select proowner,proacl::text acl,prosecdef,proconfig from pg_proc where oid in ($1::regprocedure,$2::regprocedure) order by oid',[phone,consent])).rows;
  const before=await routineSnapshot();
  await db.exec(sql);assert.deepEqual(await routineSnapshot(),before);
  const role=(await db.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolbypassrls:true});
  const acl=(await db.query(`select p.proname,p.prosecdef,p.proconfig,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
    has_function_privilege('anon',p.oid,'execute') anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
    has_function_privilege('service_role',p.oid,'execute') service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app') and p.proname in ('whatsapp_owner_resolve_quote','owner_consent_parts') order by p.proname`)).rows;
  assert.equal(acl.length,2);
  for(const row of acl){
   assert.equal(row.public_execute,false);assert.equal(row.anon_execute,false);assert.equal(row.authenticated_execute,false);
   assert.equal(row.service_execute,row.proname==='whatsapp_owner_resolve_quote');assert.deepEqual(row.proconfig,['search_path=""']);
  }
  const rls=(await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('public.whatsapp_inbound_events'::regclass,'public.whatsapp_messages'::regclass)")).rows;
  for(const row of rls){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
  assert.equal((await db.query("select count(*)::int n from pg_constraint where conrelid='public.whatsapp_consents'::regclass and conname='whatsapp_consents_workspace_id_phone_key'")).rows[0].n,1);
  await db.exec('reset session authorization');
  await assert.rejects(db.exec(sql),/predecessor body drifted/);await db.exec('rollback');
 }finally{await f.close();}
});
