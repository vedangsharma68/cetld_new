import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';
import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';
import {privateBackfillBatchSQL,runPrivateInvoiceBackfill} from '../scripts/backfill-private-invoice-terms.mjs';
const migrationName='20261101120327_private_whatsapp_chat_memory.sql';
const port=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};

test('native PostgreSQL: realistic default ACLs, numeric watermarks, concurrent locks, rollback/resume and write latency',async()=>{
 const pg=await createNativePostgresFixture({port:await port()});
 let db,locker;const results={};
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();locker=pg.getPgClient();await locker.connect();
  const q=(sql,args)=>db.query(sql,args),one=async(sql,args)=>(await q(sql,args)).rows[0];
  results.version=(await one('select version()')).version;
  results.serverEncoding=(await one('show server_encoding')).server_encoding;assert.equal(results.serverEncoding,'UTF8');
  results.parentOSUid=process.getuid?.();results.postgresOSUid=pg.identity.uid;assert.ok(results.postgresOSUid>0,'Native postgres always runs unprivileged');
  await q(OFFLINE_SQL_BOOTSTRAP);
  for(const [,sql]of await offlineSqlMigrationSources([migrationName]))await q(sql);
  const owner=randomUUID();await q('insert into auth.users(id) values($1)',[owner]);
  await q(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
  const workspace=(await one('select (create_workspace($1,$2)).id',['Native proof',randomUUID()])).id;
  const workspaceB=(await one('select (create_workspace($1,$2)).id',['Native concurrency',randomUUID()])).id;
  const customerB=(await one("insert into customers(workspace_id,name) values($1,'Unrelated Customer') returning id",[workspaceB])).id;
  const customer=(await one("insert into customers(workspace_id,name) values($1,'Anurag Sharma') returning id",[workspace])).id;
  const seeded=(await q(`insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,metadata)
    select $1,$2,'R5-NATIVE-'||n,1250+n,'INR','draft',jsonb_build_object('description',repeat('native invoice details ',70)) from generate_series(1,59)n returning id`,[workspace,customer])).rows.map(r=>r.id);assert.equal(seeded.length,59);
  await q("insert into invoices(id,workspace_id,customer_id,invoice_number,total_amount,currency,status) values('00000000-0000-0000-0000-000000000000',$1,$2,'NIL-UUID-HISTORICAL',90909,'INR','draft')",[workspace,customer]);
  // Real bigint ID order, deliberately hostile to lexicographic MAX. All
  // historical sources must retain the upper row before declaring completion.
  const ids=[-10,-1,0,1,2,9,10,11,19,20,53,99,100,101,999,1000];
  for(const n of ids){
   await q(`insert into whatsapp_pending_actions(id,workspace_id,customer_id,phone,action,source,consumed_at,expires_at)
    values($1::bigint,$2,$3,'+919871367051',jsonb_build_object('type','invoice_review_draft','invoice',jsonb_build_object('total',45678+$1::bigint)),'whatsapp',now(),now()+interval '1 day')`,[n,workspace,customer]);
   await q(`insert into whatsapp_conversation_turns(id,workspace_id,customer_id,phone,role,content) values($1,$2,$3,'+919871367051','user',$4)`,[n,workspace,customer,`This invoice is from Historical Studio ${n}, ${70000+n}, due 12 Nov`]);
   await q(`insert into owner_assistant_turns(id,workspace_id,owner_id,event_key,channel,role,content) overriding system value values($1,$2,$3,$4,'whatsapp','user',$5)`,[n,workspace,owner,'native-'+n,`Here is the bill, Archived Studio ${n}, ${80000+n}, due 12 Nov`]);
  }
  const sql=await readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');results.migrationSHA256=createHash('sha256').update(sql).digest('hex');
  await locker.query('begin;lock table invoices in row exclusive mode');
  await assert.rejects(q(sql),e=>e.code==='55P03');await q('rollback');await locker.query('rollback');
  assert.equal((await one("select to_regclass('whatsapp_private_invoice_terms') x")).x,null);
  await q(sql);assert.equal((await one('select count(*)::int n from whatsapp_private_invoice_terms')).n,0);
  // No fixture-side grants/revocations after migration: these are effective
  // native ACLs under the production-style ALTER DEFAULT PRIVILEGES bootstrap.
  for(const table of ['whatsapp_private_invoice_terms','whatsapp_provider_memory','whatsapp_private_invoice_backfill']){
   for(const role of ['anon','authenticated'])for(const permission of ['select','insert','update','delete'])assert.equal((await one('select has_table_privilege($1,$2,$3) ok',[role,table,permission])).ok,false);
   assert.equal((await one("select has_table_privilege('service_role',$1,'update') ok",[table])).ok,false);
  }
  assert.equal((await one("select has_table_privilege('service_role','whatsapp_private_invoice_terms','delete') ok")).ok,false);
  for(const role of ['anon','authenticated'])assert.equal((await one("select has_sequence_privilege($1,'whatsapp_provider_memory_id_seq','usage') ok",[role])).ok,false);
  assert.equal((await one("select has_sequence_privilege('service_role','whatsapp_provider_memory_id_seq','update') ok")).ok,false);
  results.defaultACLs='PASS';
  const execute=async sql=>{const r=await q(sql);return (Array.isArray(r)?r:[r]).find(r=>r.rows?.[0]?.result)?.rows[0].result;};
  let preBatches=0;while(!(await one("select complete from whatsapp_private_invoice_backfill where source='customer_quotes'")).complete){await execute(privateBackfillBatchSQL(100));preBatches++;} // respect soft yield
  // Hold a completed batch transaction open and measure source-table locks.
  await q("begin;set local statement_timeout='5s';select app.backfill_private_invoice_terms(1)");
  const locks=(await q("select c.relname,l.mode from pg_locks l join pg_class c on c.oid=l.relation where l.pid=pg_backend_pid() and l.granted and c.relname in ('invoices','customers','owner_assistant_turns','whatsapp_conversation_turns','whatsapp_pending_actions')")).rows;
  assert.ok(locks.some(l=>l.relname==='invoices'));assert.ok(locks.some(l=>l.relname==='customers'));assert.ok(locks.every(l=>l.mode==='AccessShareLock'),JSON.stringify(locks));
  await locker.query("set lock_timeout='750ms';set statement_timeout='2s';select count(*) from invoices");await locker.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-CONCURRENT',77113,'INR','draft')",[workspaceB,customerB]);
  // Shared workspace aliases can serialize on the new unique term index. Prove
  // they finish after COMMIT rather than claiming AccessShare means no waits.
  await locker.query("set lock_timeout='2s'");const waiting=locker.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'R5-SAME-WORKSPACE',77114,'INR','draft')",[workspace,customer]);waiting.catch(()=>{});await new Promise(r=>setTimeout(r,100));await q('commit');await waiting;results.sourceLocks=locks;results.sameWorkspaceAliasWait='completes after batch COMMIT';
  let batches=preBatches+1;await runPrivateInvoiceBackfill({execute,batchSize:25,onBatch(){batches++;}});results.batches=batches;
  for(const source of ['reviews','owner_quotes','customer_quotes']){const job=await one('select * from whatsapp_private_invoice_backfill where source=$1',[source]);assert.equal(job.upper_key,'1000');assert.equal(job.last_key,'1000');assert.equal(job.complete,true);}
  for(const n of ids)for(const amount of [45678+n,70000+n,80000+n])assert.equal((await one('select exists(select 1 from whatsapp_private_invoice_terms where term=$1) ok',['number:'+amount])).ok,true,'Untouched historical ID '+n);
  assert.equal((await one("select exists(select 1 from whatsapp_private_invoice_terms where term='number:90909') ok")).ok,true);results.watermarks={ids,nilUUID:'PASS',allAliases:'PASS'};
  await q("update customers set name='After Native Name' where id=$1",[customer]);assert.equal((await one("select exists(select 1 from whatsapp_private_invoice_terms where term='party:anurag') ok")).ok,true);
  // New declarations are retained atomically at every SQL write sink, even
  // after completed cursors; they never gain ordinary-memory provenance.
  const origin='Invoice is from Willow Workshop, 8654, due 12 Nov';
  const inserted=await q("insert into whatsapp_provider_memory(workspace_id,owner_id,phone,audience,source_message_id,role,content,provenance) values($1,$2,'+919871367051','owner','native-private-origin','user',$3,'ordinary_chat_v1')",[workspace,owner,origin]);assert.equal(inserted.rowCount,0);
  await q("insert into owner_assistant_turns(id,workspace_id,owner_id,event_key,channel,role,content) overriding system value values(1001,$1,$2,'native-new-origin','whatsapp','user','Invoice is from Olive Desk, 6418, due 23 Sep 2027')",[workspace,owner]);
  await q("insert into whatsapp_conversation_turns(id,workspace_id,customer_id,phone,role,content) values(1001,$1,$2,'+919871367051','user','Receipt from Maple Craft, 5147, due 24 Sep 2027')",[workspace,customer]);
  await q('select app.retain_private_invoice_terms($1,$2)',[workspace,{notes:'Invoice is from Cedar Garden, 6961, due 25 Sep 2027'}]);
  for(const term of ['party:willow','party:workshop','number:8654','date:*-11-12','party:olive','number:6418','party:maple','number:5147','party:cedar','number:6961'])assert.equal((await one('select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term=$2) ok',[workspace,term])).ok,true,term);
  results.originWriteSinks='PASS; no ordinary-memory source row';
  await q("insert into invoices(id,workspace_id,customer_id,invoice_number,total_amount,currency,status) values('3e501620-8765-44cd-bb78-ac435fc5a790',$1,$2,'NATIVE-UUID-NOT-JSON',137,'INR','draft')",[workspace,customer]);results.scalarUUIDDecoding='PASS';
  // Representative multi-row writes, with the reviewer-imposed 5-second cap.
  await q("set statement_timeout='5s'");const start=performance.now();assert.equal((await q("update invoices set notes='updated local note' where id=any($1::uuid[])",[seeded])).rowCount,59);const elapsed=performance.now()-start;
  results.triggerWrites={rows:59,totalMs:Math.round(elapsed),meanMs:Math.round(elapsed/59),statementLimitMs:5000};assert.ok(elapsed<5000,JSON.stringify(results.triggerWrites));
  const timeoutTerm='number:'+(45678+Math.min(...ids));await q("update whatsapp_private_invoice_backfill set complete=source<>'reviews',last_key=null,upper_key=null");await q('delete from whatsapp_private_invoice_terms where term=$1',[timeoutTerm]);
  await q(`create function app.r5_timeout() returns trigger language plpgsql as $$begin if new.term='${timeoutTerm}' then perform pg_sleep(8);end if;return new;end $$;create trigger r5_timeout before insert on whatsapp_private_invoice_terms for each row execute function app.r5_timeout()`);
  const before=await one("select * from whatsapp_private_invoice_backfill where source='reviews'");await assert.rejects(execute(privateBackfillBatchSQL(1)),e=>e.code==='57014');await q('rollback');assert.deepEqual(await one("select * from whatsapp_private_invoice_backfill where source='reviews'"),before);assert.equal((await one('select exists(select 1 from whatsapp_private_invoice_terms where term=$1) ok',[timeoutTerm])).ok,false);
  await q('drop trigger r5_timeout on whatsapp_private_invoice_terms');await runPrivateInvoiceBackfill({execute,batchSize:25});results.timeoutRollbackResume='PASS';
  console.log('NATIVE_PRIVACY_PROOF '+JSON.stringify(results));
 }finally{await locker?.end().catch(()=>{});await db?.end().catch(()=>{});await pg.stop();}
});
