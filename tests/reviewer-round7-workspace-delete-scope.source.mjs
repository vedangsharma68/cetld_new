import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:net';import {randomUUID} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {createNativePostgresFixture} from '../tests/fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from '../tests/fixtures/offline-sql-network.mjs';
const out={};test.after(()=>writeFile('work/r7-workspace-delete-scope.json',JSON.stringify(out,null,2)));
test('authorized owner workspace deletion preserves its existing RLS contract and transaction atomicity',async()=>{
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const pg=await createNativePostgresFixture({port});let db,observer;
 const error=e=>({code:e.code,message:e.message,detail:e.detail,where:e.where});
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();observer=pg.getPgClient();await db.connect();await observer.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources([]))await db.query(sql);await db.query("set statement_timeout='5s'");
  const owner=randomUUID(),outsider=randomUUID();await db.query('insert into auth.users(id) values($1),($2)',[owner,outsider]);await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const workspace=(await db.query('select (create_workspace($1,$2)).id',['Independent scoped deletion',randomUUID()])).rows[0].id,customer=(await db.query("insert into customers(workspace_id,name) values($1,'Delete Scope Finch') returning id",[workspace])).rows[0].id;
  const invoice=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R7-DELETE-SCOPE',71927,'INR','draft') returning id",[workspace,customer])).rows[0].id;
  const tables=(await db.query("select c.table_schema,c.table_name from information_schema.columns c join information_schema.tables t using(table_schema,table_name) where c.column_name='workspace_id' and c.table_schema in ('public','app') and t.table_type='BASE TABLE' order by c.table_schema,c.table_name")).rows;
  const snapshot=async()=>{
   const rows={workspace:(await db.query('select to_jsonb(w) value from workspaces w where id=$1',[workspace])).rows};
   for(const r of tables){const name='"'+r.table_schema+'"."'+r.table_name+'"';rows[r.table_schema+'.'+r.table_name]=(await db.query('select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text),\'[]\'::jsonb) value from '+name+' v where workspace_id=$1',[workspace])).rows[0].value;}
   rows.captureState=(await db.query('select * from app.private_invoice_capture_state order by singleton')).rows;return rows;
  };
  out.setup={owner,outsider,workspace,customer,invoice,maintenancePerformed:false};out.before=await snapshot();
  out.roleDefinition=(await db.query("select rolname,rolsuper,rolbypassrls from pg_roles where rolname='authenticated'")).rows[0];assert.equal(out.roleDefinition.rolsuper,false);assert.equal(out.roleDefinition.rolbypassrls,false);
  out.authorization=(await db.query("select has_table_privilege('authenticated','workspaces','delete') delete_granted,relrowsecurity rls_enabled from pg_class where oid='workspaces'::regclass")).rows[0];out.deletePolicies=(await db.query("select policyname,roles,cmd,qual from pg_policies where schemaname='public' and tablename='workspaces' and cmd='DELETE'")).rows;
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);await db.query('set role authenticated');out.outsider=(await db.query('delete from workspaces where id=$1 returning id',[workspace])).rowCount;await db.query('reset role');assert.equal(out.outsider,0);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.query('begin;set local role authenticated');out.effectiveIdentity=(await db.query("select current_user,session_user,auth.uid() uid,current_setting('request.jwt.claim.role') jwt_role")).rows[0];assert.equal(out.effectiveIdentity.current_user,'authenticated');assert.equal(out.effectiveIdentity.uid,owner);
  try{const r=await db.query('delete from workspaces where id=$1 returning id',[workspace]);out.ownerDelete={ok:true,rowCount:r.rowCount};}catch(e){out.ownerDelete={ok:false,...error(e)};}
  out.backendAfterOperation=(await observer.query('select state,xact_start,backend_xid from pg_stat_activity where pid=$1',[db.processID])).rows[0];
  if(!out.ownerDelete.ok){try{await db.query('select 1');}catch(e){out.followupWithinTransaction=error(e);}assert.equal(out.followupWithinTransaction.code,'25P02');}
  await db.query('rollback');out.backendAfterRollback=(await observer.query('select state,xact_start,backend_xid from pg_stat_activity where pid=$1',[db.processID])).rows[0];out.afterRollback=await snapshot();out.snapshotUnchanged=JSON.stringify(out.before)===JSON.stringify(out.afterRollback);assert.equal(out.snapshotUnchanged,true);
  console.log(JSON.stringify({setup:out.setup,effectiveIdentity:out.effectiveIdentity,roleDefinition:out.roleDefinition,authorization:out.authorization,outsiderRowsDeleted:out.outsider,ownerDelete:out.ownerDelete,backendAfterOperation:out.backendAfterOperation,followupWithinTransaction:out.followupWithinTransaction,backendAfterRollback:out.backendAfterRollback,snapshotUnchanged:out.snapshotUnchanged}));
  assert.equal(out.ownerDelete.ok,true,'Authorized owner DELETE should succeed; '+JSON.stringify(out.ownerDelete));assert.equal(out.ownerDelete.rowCount,1);
 }finally{if(db)await db.query('rollback').catch(()=>{});if(observer)await observer.end().catch(()=>{});if(db)await db.end().catch(()=>{});await pg.stop();}
});
