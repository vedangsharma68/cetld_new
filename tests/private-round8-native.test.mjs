import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';
import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';

test('native workspace lifecycle and maintenance preserve ownership, rollback, committed identity and API privileges',async t=>{
 await mkdir('work',{recursive:true});
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const pg=await createNativePostgresFixture({port}),clients=[],evidence={};
 try{
  await pg.initialise();await pg.start();
  for(let i=0;i<3;i++){const c=pg.getPgClient();await c.connect();clients.push(c);}
  const [db,maintenance,observer]=clients;
  await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql] of await offlineSqlMigrationSources([]))await db.query(sql);
  await db.query("set statement_timeout='5s'");await maintenance.query("set statement_timeout='5s'");await observer.query("set statement_timeout='5s'");
  const owner=randomUUID(),otherOwner=randomUUID();await db.query('insert into auth.users(id) values($1),($2)',[owner,otherOwner]);
  const workspace=async ownerId=>{await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[ownerId]);return (await db.query('select (create_workspace($1,$2)).id',['Native lifecycle proof',randomUUID()])).rows[0].id;};
  const a=await workspace(owner),b=await workspace(otherOwner);
  const customer=async w=>(await db.query("insert into customers(workspace_id,name) values($1,'Native Rowan Studio') returning id",[w])).rows[0].id;
  const ca=await customer(a),cb=await customer(b);
  const ia=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'LIFECYCLE-SOURCE',43917,'INR','draft') returning id",[a,ca])).rows[0].id;
  await t.test('owner deletion commits its cascades; outsider cannot delete; rollback restores private state',async()=>{
   await db.query('set role authenticated');assert.equal((await db.query('delete from workspaces where id=$1 returning id',[a])).rowCount,0);await db.query('reset role');
   await assert.rejects(db.query('delete from invoices where id=$1',[ia]),/invoice hard delete is disabled/);
   const before=(await db.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[a])).rows[0].n;
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   await db.query('begin;set local role authenticated');assert.equal((await db.query('delete from workspaces where id=$1 returning id',[a])).rowCount,1);await db.query('rollback');
   assert.equal((await db.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[a])).rows[0].n,before);
   assert.equal((await db.query('select exists(select 1 from invoices where id=$1) value',[ia])).rows[0].value,true);
   await db.query('begin;set local role authenticated');assert.equal((await db.query('delete from workspaces where id=$1 returning id',[a])).rowCount,1);await db.query('commit');
   for(const table of ['public.invoices','public.whatsapp_private_invoice_terms','app.private_invoice_canonical_inputs','app.private_invoice_capture_epochs'])assert.equal((await db.query('select count(*)::int n from '+table+' where workspace_id=$1',[a])).rows[0].n,0,table);
   assert.equal((await db.query('select exists(select 1 from workspaces where id=$1) value',[b])).rows[0].value,true);
   await db.query('select app.retain_private_invoice_terms($1,$2)',[a,{total:999777}]);
   assert.equal((await db.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[a])).rows[0].n,0);
   evidence.lifecycle={ownerCommit:true,outsiderRows:0,rollback:true,hardDeleteGuardPreserved:true,foreignWorkspacePreserved:true};
  });
  await t.test('privileged TRUNCATE and a writer commit the actual canonical row without a lock cycle',async()=>{
   for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,'whatsapp_private_invoice_terms','truncate') value",[role])).rows[0].value,false);
   await db.query("create function app.pause_r8_maintenance() returns trigger language plpgsql as $$begin perform pg_advisory_xact_lock(817002);return null;end $$;create trigger a_pause_r8_maintenance before truncate on whatsapp_private_invoice_terms for each statement execute function app.pause_r8_maintenance()");
   await observer.query('select pg_advisory_lock(817002)');
   const truncating=maintenance.query('truncate whatsapp_private_invoice_terms');truncating.catch(()=>{});
   for(let i=0;;i++){if((await observer.query("select exists(select 1 from pg_locks where locktype='advisory' and objid=817002 and not granted) value")).rows[0].value)break;assert.ok(i<500);await new Promise(resolve=>setTimeout(resolve,10));}
   const capturing=db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'CANONICAL-SOURCE-817',717777,'INR','draft') returning id,invoice_number",[b,cb]);capturing.catch(()=>{});
   for(let i=0;;i++){if((await observer.query("select exists(select 1 from pg_locks where relation='whatsapp_private_invoice_terms'::regclass and not granted) value")).rows[0].value)break;assert.ok(i<500);await new Promise(resolve=>setTimeout(resolve,10));}
   await observer.query('select pg_advisory_unlock(817002)');await truncating;const row=(await capturing).rows[0];
   const actual=(await observer.query("select id,workspace_id,customer_id,total_amount,metadata->>'source_invoice_number' source_number from invoices where id=$1 and workspace_id=$2",[row.id,b])).rows[0];
   assert.equal(actual.customer_id,cb);assert.equal(Number(actual.total_amount),717777);assert.equal(actual.source_number,'CANONICAL-SOURCE-817');
   assert.equal((await observer.query("select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:717777') value",[b])).rows[0].value,true);
   evidence.maintenance={truncateCommitted:true,writerCommitted:true,requestedSourceNumber:actual.source_number,canonicalNumber:row.invoice_number,apiTruncate:false};
  });
 }finally{
  for(const c of clients)await c.query('select pg_advisory_unlock_all()').catch(()=>{});
  for(const c of clients)await c.end().catch(()=>{});await pg.stop();
  await writeFile('work/r8-native-lifecycle.json',JSON.stringify(evidence,null,2));
 }
});
