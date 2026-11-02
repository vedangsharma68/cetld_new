#!/usr/bin/env node
// Additional native PostgreSQL proof; the normal gate also runs SQL-backed
// lock/atomicity tests via PGlite. This script uses no external service and
// refuses every non-local/non-disposable database target.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from '../tests/fixtures/offline-sql-network.mjs';
import {runPrivateInvoiceBackfill,privateBackfillBatchSQL} from './backfill-private-invoice-terms.mjs';
assert.ok(/^cetld_private_lock_test/.test(process.env.PGDATABASE||''),'PGDATABASE must be disposable cetld_private_lock_test*');
assert.ok((process.env.PGHOST||'').startsWith('/tmp/')||['localhost','127.0.0.1'].includes(process.env.PGHOST),'PGHOST must be local');
const args=['-X','-q','-A','-t','--set','ON_ERROR_STOP=1','--set','VERBOSITY=sqlstate'];
async function execute(sql){
 const child=spawn('psql',args,{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});child.stdin.end(sql);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Object.assign(new Error('PSQL_ERROR'),{state:error.match(/ERROR:\s*([0-9A-Z]{5})/)?.[1],detail:error.slice(-400)})));});return output.trim();
}
const json=async sql=>{const out=await execute(sql);return out===''?null:out==='t'?true:out==='f'?false:JSON.parse(out);};
function connection(){
 const child=spawn('psql',args,{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(error)));});done.catch(()=>{});
 return {async ready(sql,marker){child.stdin.write(sql+'\n\\echo '+marker+'\n');const until=Date.now()+7000;while(!output.includes(marker)){if(Date.now()>until)throw Error('Timed out waiting for local PostgreSQL marker');await new Promise(r=>setTimeout(r,10));}return output;},
  async end(commit=false){child.stdin.end((commit?'commit':'rollback')+';\n\\q\n');await done;}};
}
const migrationName='20261101120327_private_whatsapp_chat_memory.sql';
const migration=await readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
assert.equal(await json("select count(*)::int from pg_tables where schemaname in ('public','app')"),0,'Use a fresh disposable database');
const existingRoles=await json("select coalesce(json_agg(json_build_object('name',rolname,'super',rolsuper,'login',rolcanlogin,'bypass',rolbypassrls)),'[]'::json) from pg_roles where rolname in ('anon','authenticated','service_role')");
let bootstrap=OFFLINE_SQL_BOOTSTRAP;
for(const role of existingRoles){assert.equal(role.super,false);assert.equal(role.login,false);assert.equal(role.bypass,role.name==='service_role');bootstrap=bootstrap.replace(new RegExp('create role '+role.name+'(?: bypassrls)?;'),'');}
await execute(bootstrap);
for(const [,sql] of await offlineSqlMigrationSources([migrationName]))await execute(sql);
const owner=randomUUID(),ownerB=randomUUID();
await execute(`insert into auth.users(id) values('${owner}'),('${ownerB}');`);
async function workspace(id,label){return json(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${id}';select to_json((create_workspace('${label}','${randomUUID()}')).id);`);}
const workspaceA=await workspace(owner,'Lock A'),workspaceB=await workspace(ownerB,'Lock B');
const customerA=await json(`insert into customers(workspace_id,name,company_name) values('${workspaceA}','Before & Sons','Before Company') returning to_json(id);`);
const customerB=await json(`insert into customers(workspace_id,name) values('${workspaceB}','Other Customer') returning to_json(id);`);
await execute(`insert into invoices(id,workspace_id,customer_id,invoice_number,total_amount,currency,status) values
 ('10000000-0000-4000-8000-000000000001','${workspaceA}','${customerA}','R4-LOCK-A',1250,'INR','draft'),
 ('20000000-0000-4000-8000-000000000002','${workspaceB}','${customerB}','R4-LOCK-B',1100,'INR','draft');`);
const writer=connection();let ddlState;
try{
 await writer.ready('begin;lock table invoices in row exclusive mode;','R4_WRITER_HOLDS');
 const start=Date.now();await assert.rejects(execute(migration),error=>{ddlState=error.state;assert.equal(error.state,'55P03');return true;});
 assert.ok(Date.now()-start<4500,'DDL must time out, not wait through an unbounded write');
 assert.equal(await json("select to_json(to_regclass('public.whatsapp_private_invoice_terms'))"),null,'DDL timeout rolls back new objects');
}finally{await writer.end();}
await execute(migration);
assert.equal(await json('select count(*)::int from whatsapp_private_invoice_terms'),0,'No full backfill under DDL locks');
await execute(`update customers set name='After & Sons' where id='${customerA}';`);
assert.equal(await json(`select exists(select 1 from whatsapp_private_invoice_terms where workspace_id='${workspaceA}' and term='before & sons')`),true,'Concurrent customer update retains OLD before scanning');
// Finish the empty customer-history source through the actual batch protocol.
await json(privateBackfillBatchSQL(1));
const worker=connection();let sourceLocks;
try{
 const output=await worker.ready("begin;set local lock_timeout='250ms';set local statement_timeout='5s';select 'R4_PID='||pg_backend_pid();select app.backfill_private_invoice_terms(1);",'R4_BATCH_DONE');
 const pid=Number(output.match(/R4_PID=(\d+)/)?.[1]);assert.ok(pid);
 sourceLocks=await json(`select coalesce(json_agg(json_build_object('relation',c.relname,'mode',l.mode)),'[]'::json) from pg_locks l join pg_class c on c.oid=l.relation
  where l.pid=${pid} and l.granted and c.relname in ('invoices','customers','whatsapp_pending_actions','owner_assistant_turns','whatsapp_conversation_turns');`);
 assert.ok(sourceLocks.length);assert.ok(sourceLocks.every(lock=>lock.mode==='AccessShareLock'),JSON.stringify(sourceLocks));
 // While the batch transaction deliberately remains open, unrelated invoice
 // writes and reads on the SAME source relation must finish under a short cap.
 await execute(`set lock_timeout='750ms';set statement_timeout='2s';select count(*) from invoices;
  insert into invoices(id,workspace_id,customer_id,invoice_number,total_amount,currency,status)
   values('30000000-0000-4000-8000-000000000003','${workspaceB}','${customerB}','R4-CONCURRENT',2401,'INR','draft');`);
}finally{await worker.end(true);}
await runPrivateInvoiceBackfill({execute:json,batchSize:1});
assert.equal(await json(`select exists(select 1 from whatsapp_private_invoice_terms where workspace_id='${workspaceB}' and term='number:2401')`),true,'Concurrent insert behind/outside watermark retained by trigger');
// Force the real runner's pre-statement timeout, proving alias/cursor rollback.
await execute(`update whatsapp_private_invoice_backfill set complete=source<>'invoices',last_key=null,upper_key=null;
 delete from whatsapp_private_invoice_terms where workspace_id='${workspaceA}' and term='number:1250';
 create function app.r4_native_timeout() returns trigger language plpgsql as $$begin if new.term='number:1250' then perform pg_sleep(10);end if;return new;end $$;
 create trigger r4_timeout before insert on whatsapp_private_invoice_terms for each row execute function app.r4_native_timeout();`);
const before=await json("select to_json(b) from whatsapp_private_invoice_backfill b where source='invoices'");let batchState;
const start=Date.now();await assert.rejects(json(privateBackfillBatchSQL(1)),error=>{batchState=error.state;assert.equal(error.state,'57014');return true;});
assert.ok(Date.now()-start<9000,'Statement timeout must bound the batch');
assert.deepEqual(await json("select to_json(b) from whatsapp_private_invoice_backfill b where source='invoices'"),before);
assert.equal(await json(`select exists(select 1 from whatsapp_private_invoice_terms where workspace_id='${workspaceA}' and term='number:1250')`),false);
await execute('drop trigger r4_timeout on whatsapp_private_invoice_terms;');
await runPrivateInvoiceBackfill({execute:json,batchSize:1});
assert.equal(await json('select bool_and(complete) from whatsapp_private_invoice_backfill'),true);
console.log(JSON.stringify({proof:'PASS',migrationSHA256:createHash('sha256').update(migration).digest('hex'),ddlTimeoutSQLSTATE:ddlState,batchTimeoutSQLSTATE:batchState,sourceLocks,concurrentReadAndInvoiceInsert:'PASS',oldCustomerRetained:'PASS',atomicCursorAndAliasRollback:'PASS',resume:'PASS'}));
