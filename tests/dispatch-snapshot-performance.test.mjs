import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';
const migration='20261120132445_dispatch_privacy_performance.sql';
const canonical=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,Array.isArray(v)?v.map(x=>typeof x==='object'?JSON.stringify(x):x).sort():v]));
test('native snapshot preserves admission sets, memo isolation and live data while bounding realistic cold/warm work',async t=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const pg=await createNativePostgresFixture({port});let db;
 try{
 await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources([migration]))await db.query(sql);
 await db.query("set statement_timeout='5s'");for(;;)if((await db.query('select app.backfill_private_invoice_terms(25) result')).rows[0].result.allComplete)break;
 const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[owner]);
 const ws=(await db.query('select (create_workspace($1,$2)).id',['Native dispatch performance',randomUUID()])).rows[0].id;
 const phone='+12025550171',c=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Juniper Meadow',$2) returning id",[ws,phone])).rows[0].id;
 const other=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Mark Harper','+12025550172') returning id",[ws])).rows[0].id;
 const foreign=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,due_date) values($1,$2,'FOREIGN',1250,'INR','draft','2027-10-31') returning id",[ws,other])).rows[0].id;
 await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) select $1,$2,'OWN-'||n,9000+n,'INR','draft' from generate_series(1,100)n",[ws,c]);
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[ws,'+12025550174'])).rows[0];
 await db.query("select set_config('request.jwt.claim.role','service_role',false)");await db.query('select whatsapp_verify_owner_code($1,$2)', ['+12025550174',verification.code]);
 await db.query("select set_config('request.jwt.claim.role','authenticated',false)");const foreignWorkspace=(await db.query('select (create_workspace($1,$2)).id',['Foreign private scope',randomUUID()])).rows[0].id;
 await db.query('select app.retain_private_invoice_terms($1,$2)',[foreignWorkspace,{total:833917,partyNames:['Foreign Willow']}]);
 const oldFn=(await db.query("select pg_get_functiondef('whatsapp_dispatch_privacy_snapshot(uuid,text)'::regprocedure) value")).rows[0].value;
 await db.query(oldFn.replace('public.whatsapp_dispatch_privacy_snapshot','app.snapshot_before_performance'));
 const termFn=(await db.query("select pg_get_functiondef('app.private_invoice_term_aliases(text)'::regprocedure) value")).rows[0].value;await db.query(termFn.replace('app.private_invoice_term_aliases','app.aliases_before_performance'));
 const before=(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value;
 await db.query(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
 await t.test('full snapshot sets agree with the old implementation for own, foreign, unbound and owner scopes',async()=>{
  assert.deepEqual(canonical((await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value),canonical(before));
  for(const recipient of ['+12025550172','+12025550173','+12025550174']){const row=(await db.query('select app.snapshot_before_performance($1,$2) old,whatsapp_dispatch_privacy_snapshot($1,$2) fresh',[ws,recipient])).rows[0];assert.deepEqual(canonical(row.fresh),canonical(row.old));}
  const snap=(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value;for(const key of ['number:1250','party:mark','date:2027-10-31','number:833917'])assert.ok(snap.terms.includes(key),key);assert.ok(!snap.terms.includes('number:9001'));
 });
 await t.test('unambiguous scalar and UUID fast paths retain the exact original alias sets',async()=>{
  const inputs=[...Array.from({length:180},(_,i)=>String(i)),...Array.from({length:60},()=>randomUUID()),'0000','00001250','1250','9007199254740991','0'.repeat(4000),'1'.repeat(4001),'31.10','10/8','2026-10-31','31 Oct 2026','1¼k','Invoice: amounts 1250,77','सवा हजार','김민수','अनु','Mark Harper'];
  const differences=(await db.query(`select v from unnest($1::text[]) v where array(select distinct k from app.aliases_before_performance(v)k order by k) is distinct from array(select distinct k from app.private_invoice_term_aliases(v)k order by k)`,[inputs])).rows;assert.deepEqual(differences,[]);const helperDifferences=(await db.query(`select v from unnest($1::text[]) v where array(select distinct k from unnest(app.private_dispatch_aliases($2,v,'generic',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),true))k order by k) is distinct from array(select distinct k from app.aliases_before_performance(v)k order by k)`,[inputs,ws])).rows;assert.deepEqual(helperDifferences,[]);
 });
 await t.test('origin projection shortcuts preserve exact aliases for declarations, ordinary text and encoded records',async()=>{
  const values=['Monthly design services.','101,102,103,104','1,250','31 Oct 2026','Invoice: amounts 1250,77','I billed Alder Finch 6847 plus Brook Rowan 2749','Payment from Alder Finch: 6847','I transferred INR 6847 to Alder Finch','Are invoices numbered sequentially?','My bills are confusing','रामजी से बात करो','김님에게도 연락해줘',JSON.stringify({notes:'Invoice: Alder Finch 6847',total:6847}),JSON.stringify(['1250','Invoice 6847']),...Array.from({length:25},(_,i)=>'Ordinary note '+i)];
  const differences=(await db.query(`select v from unnest($1::text[]) v where array(select distinct k from unnest(app.private_dispatch_aliases($2,v,'origin',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),true))k order by k) is distinct from array(select distinct k from app.private_invoice_origin_aliases(v)k order by k)`,[values,ws])).rows;assert.deepEqual(differences,[]);
 });
 await t.test('a realistic thousand-invoice workspace stays below the API budget with a cold memo',async()=>{
  // Ten customers, 100 invoices each; each statement keeps the original 5s write
  // limit. Clear only the pure memo to exercise a real cold dispatch afterwards.
  for(let n=1;n<=9;n++){const id=(await db.query('insert into customers(workspace_id,name) values($1,$2) returning id',[ws,'Customer Cedar '+n])).rows[0].id;await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,notes) select $1,$2,$3||'-'||n,9000+n,'INR','draft','Monthly design services.' from generate_series(1,100)n",[ws,id,'GROUP'+n]);}
  await db.query('truncate app.private_dispatch_alias_cache');await db.query("set statement_timeout='1s'");
  const timings=[];for(const phase of ['cold','warm']){const start=performance.now();const snapshot=(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value;const ms=performance.now()-start;timings.push({phase,ms});assert.ok(snapshot.terms.includes('number:1250'));assert.ok(ms<1000,JSON.stringify(timings));}
  t.diagnostic(JSON.stringify({invoices:1001,timings}));await db.query("set statement_timeout='5s'");
 });
 await t.test('memo does not cache ownership, private membership, readiness or the semantic revision',async()=>{
  await db.query("update invoices set total_amount=729123 where id=$1",[foreign]);assert.equal((await db.query("select total_amount::text amount from invoices where id=$1",[foreign])).rows[0].amount,'729123');let snap=(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value;assert.ok(snap.terms.includes('number:729123'),JSON.stringify({matching:snap.terms.filter(k=>k.includes('729')),allowed:snap.values.filter(k=>k.includes('729')),stored:(await db.query("select term from whatsapp_private_invoice_terms where term like '%729%'")).rows}));
  await db.query("update invoices set customer_id=$2 where id=$1",[foreign,c]);snap=(await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[ws,phone])).rows[0].value;assert.ok(!snap.terms.includes('number:729123'));assert.ok(snap.values.includes('number:729123'));
  await db.query("create or replace function app.private_invoice_canonical_revision() returns text language sql immutable set search_path='' as $$select repeat('f',64)$$");await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2)',[ws,phone]);assert.ok((await db.query('select count(distinct revision)::int n from app.private_dispatch_alias_cache')).rows[0].n>=2);
  for(const role of ['anon','authenticated','service_role'])for(const privilege of ['select','insert','update','delete'])assert.equal((await db.query("select has_table_privilege($1,'app.private_dispatch_alias_cache',$2) ok",[role,privilege])).rows[0].ok,false);
  await db.query('update whatsapp_private_invoice_backfill set complete=false');await assert.rejects(db.query('select whatsapp_dispatch_privacy_snapshot($1,$2)',[ws,phone]),{code:'55000'});
 });
 }finally{if(db)await db.end().catch(()=>{});await pg.stop();}
});
