import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

const filename='20261022100000_owner_phone_contact_recovery.sql';
const direct='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)';
const existing=['whatsapp_apply_direct_owner_write','whatsapp_workspace_data_decide','whatsapp_confirm_owner_create_settings','whatsapp_resolve_verified_owner','whatsapp_apply_owner_batch'];

test('owner contact migration installs as a non-superuser function owner without broader grants or leaked context',async()=>{
 const f=await createOfflineSqlNetwork({excludeMigrations:[filename]}),{db}=f;
 try{
  // Supabase's dashboard postgres owns these objects and bypasses RLS, but is
  // not a superuser. PGlite's bootstrap role must remain superuser, so use an
  // equivalent owner role rather than silently testing a privileged install.
  await db.exec(`create role contact_migration_editor nosuperuser bypassrls;
    grant usage,create on schema public,app to contact_migration_editor;
    grant usage on schema auth,storage to contact_migration_editor;
    grant all on all tables in schema public to contact_migration_editor;
    alter table public.customers owner to contact_migration_editor;
    alter table public.invoices owner to contact_migration_editor;
    do $owner$ declare r record; begin
      for r in select p.oid::regprocedure ident from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('whatsapp_apply_direct_owner_write','whatsapp_workspace_data_decide','whatsapp_confirm_owner_create_settings','whatsapp_resolve_verified_owner','whatsapp_apply_owner_batch') loop
        execute format('alter function %s owner to contact_migration_editor',r.ident);
      end loop;
    end $owner$;
    set session authorization contact_migration_editor;`);
  const role=async()=>(await db.query('select current_user,session_user,rolsuper,rolbypassrls,rolconfig from pg_roles where rolname=current_user')).rows[0];
  const editor=await role();assert.equal(editor.current_user,'contact_migration_editor');assert.equal(editor.rolsuper,false);assert.equal(editor.rolbypassrls,true);
  const routines=async()=>(await db.query(`select p.proname,p.proowner,p.proacl::text acl,p.prosecdef,p.provolatile,p.proconfig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by p.proname`,[existing])).rows;
  const before=await routines(),directSource=async()=>(await db.query('select prosrc from pg_proc where oid=$1::regprocedure',[direct])).rows[0].prosrc;
  const parameterPrivileges=async()=>(await db.query('select parname,paracl::text acl from pg_parameter_acl order by parname')).rows;
  const parametersBefore=await parameterPrivileges();
  const source=await directSource();
  const sql=await readFile(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8');
  try{await db.exec('begin;\n'+sql+'\ncommit;');}catch(error){await db.exec('rollback');throw error;}
  assert.deepEqual(await role(),editor);
  assert.deepEqual(await parameterPrivileges(),parametersBefore,'installation must not grant broader parameter privileges');
  assert.deepEqual(await routines(),before,'existing function ownership, privileges and execution settings must be retained');
  assert.equal(await directSource(),source,'payment capabilities pin the exact direct-write function source');
  assert.equal((await db.query("select to_regclass('public.whatsapp_owner_contact_recovery') value")).rows[0].value,'whatsapp_owner_contact_recovery');
  const appSettings=(await db.query(`select p.proname,configured.setting from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral unnest(p.proconfig) configured(setting) where n.nspname in ('public','app') and configured.setting like 'app.owner_contact_%'`)).rows;
  assert.deepEqual(appSettings,[],'custom settings in function configuration require privileges unavailable in the dashboard');
  const engines=(await db.query(`select p.oid,p.proname,p.proowner,p.prosecdef,p.proconfig,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
    has_function_privilege('anon',p.oid,'execute') anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
    has_function_privilege('service_role',p.oid,'execute') service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'
    and p.proname in ('owner_contact_workspace_data_decide','owner_contact_create_settings','owner_contact_batch') order by p.proname`)).rows;
  assert.equal(engines.length,3);
  for(const engine of engines){
   assert.equal(engine.prosecdef,true);assert.deepEqual(engine.proconfig,['search_path=""']);
   assert.equal(engine.public_execute,false);assert.equal(engine.anon_execute,false);assert.equal(engine.authenticated_execute,false);assert.equal(engine.service_execute,false);
  }
  const endpoints=(await db.query(`select p.proname,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
    has_function_privilege('anon',p.oid,'execute') anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
    has_function_privilege('service_role',p.oid,'execute') service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('whatsapp_owner_save_phone','whatsapp_apply_owner_contact_write')`)).rows;
  assert.equal(endpoints.length,2);
  for(const endpoint of endpoints){assert.equal(endpoint.public_execute,false);assert.equal(endpoint.anon_execute,false);assert.equal(endpoint.authenticated_execute,false);assert.equal(endpoint.service_execute,true);}
  const flags=async()=>(await db.query("select current_setting('app.owner_contact_write',true) write,current_setting('app.owner_contact_supplied',true) supplied")).rows[0];
  await db.exec("select set_config('app.owner_contact_write','caller-write',false),set_config('app.owner_contact_supplied','caller-supplied',false)");
  const prior=await flags();
  const rejected=[
   'select public.whatsapp_workspace_data_decide(null,null,null,null,null,null,null,null,null,null) value',
   'select public.whatsapp_confirm_owner_create_settings(null,null,null,null,null,null) value',
   'select public.whatsapp_apply_owner_batch(null,null,null,null,null,null) value',
   'select public.whatsapp_apply_owner_contact_write(null,null,null,null,null,null,null,null,null,null,null,null,null,null,\'{}\'::jsonb) value',
   'select public.whatsapp_owner_save_phone(null,null,null,null,null,null,null,null) value',
  ];
  for(const query of rejected){
   const value=(await db.query(query)).rows[0].value;
   assert.equal(value.ok,false,JSON.stringify(value));
   assert.deepEqual(await flags(),prior,'a rejected RPC must restore its caller context');
  }
  // An exception in an inner engine must also leave the caller's settings
  // intact once the failed statement is rolled back to its savepoint.
  const engine=(await db.query("select pg_get_functiondef(oid) definition,prosrc from pg_proc where oid='app.owner_contact_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure")).rows[0];
  assert.equal(engine.definition.split(engine.prosrc).length,2);
  await db.exec(engine.definition.replace(engine.prosrc,"begin raise exception using errcode='P0001',message='isolated contact engine failure'; end;"));
  await db.exec('begin;savepoint contact_failure');
  await assert.rejects(()=>db.query(rejected[0]),error=>error.code==='P0001'&&error.message==='isolated contact engine failure');
  await db.exec('rollback to savepoint contact_failure');
  assert.deepEqual(await flags(),prior);await db.exec('commit');
  await db.exec(engine.definition);
  assert.equal(await directSource(),source);assert.deepEqual(await role(),editor);
 }finally{await f.close();}
});
