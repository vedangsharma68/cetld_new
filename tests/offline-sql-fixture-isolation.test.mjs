import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';

test('release schema snapshots isolate data, schema edits and historical migration selections',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cetld-sql-isolation-')),previous=process.env.CETLD_SQL_FIXTURE_CACHE_DIR,instances=[];
 process.env.CETLD_SQL_FIXTURE_CACHE_DIR=directory;
 try{
  const first=await createOfflineSqlNetwork();instances.push(first);
  const source=async f=>(await f.db.query("select md5(prosrc) value from pg_proc where oid='public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure")).rows[0].value;
  const baseline=await source(first);
  await first.db.exec("create table public.fixture_mutation(id integer);insert into auth.users(id) values(gen_random_uuid());set request.jwt.claim.role='authenticated'");
  const second=await createOfflineSqlNetwork();instances.push(second);
  assert.equal(await source(second),baseline);
  assert.equal((await second.db.query('select count(*)::int n from auth.users')).rows[0].n,0);
  assert.equal((await second.db.query("select to_regclass('public.fixture_mutation') value")).rows[0].value,null);
  assert.equal((await second.db.query("select nullif(current_setting('request.jwt.claim.role',true),'') value")).rows[0].value,null);
  assert.equal((await readdir(directory)).filter(file=>file.endsWith('.tgz')).length,1);
  const historical=await createOfflineSqlNetwork({excludeMigrations:['20261022100000_owner_phone_contact_recovery.sql']});instances.push(historical);
  assert.equal((await historical.db.query("select to_regclass('public.whatsapp_owner_contact_recovery') value")).rows[0].value,null);
  assert.equal((await second.db.query("select to_regclass('public.whatsapp_owner_contact_recovery') value")).rows[0].value,'whatsapp_owner_contact_recovery');
  assert.equal((await readdir(directory)).filter(file=>file.endsWith('.tgz')).length,2);
 }finally{
  await Promise.all(instances.map(f=>f.close()));
  if(previous===undefined)delete process.env.CETLD_SQL_FIXTURE_CACHE_DIR;else process.env.CETLD_SQL_FIXTURE_CACHE_DIR=previous;
  await rm(directory,{recursive:true,force:true});
 }
});
