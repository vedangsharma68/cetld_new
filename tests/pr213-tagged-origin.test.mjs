import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';import {readFile} from 'node:fs/promises';import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';
test('tagged provenance preserves the exact main canonical set independently of free-text classification',async()=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const pg=await createNativePostgresFixture({port});let db;
 try{await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources(['20261120132445_dispatch_privacy_performance.sql']))await db.query(sql);for(;;)if((await db.query('select app.backfill_private_invoice_terms(25) result')).rows[0].result.allComplete)break;
 const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[owner]);const workspace=(await db.query("select (create_workspace('Origin parity',$1)).id",[randomUUID()])).rows[0].id;
 const corpus=['Invoice #AB-6847\nBill to: Alder Finch\nTotal: 6847','Payment from Brook Rowan: 2749','I billed Cedar Marsh 3971 plus Daisy Willow 2863'];
 const expected=[];for(const source of corpus){
  const keys=(await db.query("select distinct k from app.private_invoice_origin_aliases($1)k where k ~ '^(number|number-run|date|date-range|party|party-native|party-latin|party-ref|identifier):' order by k",[source])).rows.map(r=>r.k);assert.ok(keys.length>0);expected.push({source,keys});
  await db.query("insert into whatsapp_private_invoice_terms(workspace_id,term_hash,term) values($1,md5($2),$2)",[workspace,'origin:'+source]);
 }
 // Retention expands newly inserted terms into sibling rows. Isolate the
 // explicitly tagged sources so those duplicate canonical rows cannot mask
 // a projection loss. Every exact-set assertion below remains unchanged.
 await db.query("delete from whatsapp_private_invoice_terms where workspace_id=$1 and term not like 'origin:%'",[workspace]);
 const snapshot=async()=>[...(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[null,'+12025550777'])).rows[0].value.terms].sort();const before=await snapshot();assert.ok(before.includes('number:6847'));assert.ok(before.some(k=>k.startsWith('party:')));assert.ok(before.some(k=>k.startsWith('identifier:')));
 // Explicit provenance is already established. A changing/free-text classifier
 // cannot erase it; main's tagged parser remains the exact output oracle.
 await db.query("create or replace function app.private_invoice_has_origin(p_term text) returns boolean language sql immutable set search_path='' as $$select false$$");assert.deepEqual(await snapshot(),before);
 await db.query(await readFile(new URL('../supabase/migrations/20261120132445_dispatch_privacy_performance.sql',import.meta.url),'utf8'));
 assert.deepEqual(await snapshot(),before);
 // Reproduce the reviewed, already-built index, then upgrade that populated
 // state. The grammar revision is deliberately unchanged throughout.
 await db.query(await readFile(new URL('./fixtures/pr213-performance-fc393ee.sql',import.meta.url),'utf8'));
 assert.notDeepEqual(await snapshot(),before);
 await db.query(await readFile(new URL('../supabase/migrations/20261120132445_dispatch_privacy_performance.sql',import.meta.url),'utf8'));
 assert.deepEqual(await snapshot(),before);
 for(const {source,keys}of expected){const actual=(await db.query('select distinct k from unnest(app.private_dispatch_projection($1,$2))k order by k',[workspace,'origin:'+source])).rows.map(r=>r.k);assert.deepEqual(actual,keys);}
 }finally{if(db){await db.query('rollback').catch(()=>{});await db.end().catch(()=>{});}await pg.stop();}
});
