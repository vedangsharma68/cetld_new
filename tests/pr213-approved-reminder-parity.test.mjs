import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createServer} from 'node:net';import {readFile} from 'node:fs/promises';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';
const migration='20261120132445_dispatch_privacy_performance.sql';
const canonical=snapshot=>Object.fromEntries(Object.entries(snapshot).map(([key,values])=>[key,[...values].sort()]));
test('approved reminder provenance preserves main exact allowed and forbidden assignments independently of classification',async t=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const pg=await createNativePostgresFixture({port});let db;
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources([migration]))await db.query(sql);for(;;)if((await db.query('select app.backfill_private_invoice_terms(25) result')).rows[0].result.allComplete)break;
  const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[owner]);const workspace=(await db.query("select (create_workspace('Approved origin parity',$1)).id",[randomUUID()])).rows[0].id,phone='+12025550817';
  const recipient=(await db.query("insert into customers(workspace_id,name,phone) values($1,'Juniper Meadow',$2) returning id",[workspace,phone])).rows[0].id;
  await db.query("insert into customers(workspace_id,name) values($1,'Cedar Marsh')",[workspace]);
  const corpus=['Invoice: Alder Finch for 6847','Payment from Brook Rowan: 2749','I billed Cedar Marsh 3971'];
  const produced=[];
  for(const [i,source]of corpus.entries()){
   const keys=(await db.query('select distinct k from app.private_invoice_origin_aliases(app.private_invoice_normalize($1))k order by k',[source])).rows.map(r=>r.k);assert.ok(keys.some(k=>k.startsWith('party:')));produced.push({source,keys});
   // Both approved storage fields are authoritative review sources. Independent
   // customer identities remain independent witnesses, never review exemptions.
   const metadata=i%2?{approved_reminder_delivery:{body:source}}:{approved_reminder_text:source};
   await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,metadata) values($1,$2,$3,43,'INR','draft',$4)",[workspace,recipient,'APPROVED-'+i,metadata]);
  }
  // Auto-extracted party-name sibling fields are independent witnesses under
  // main's policy. Keep only the actual review-origin sources so they cannot
  // mask whether the approved field itself certifies its inferred parties.
  // The real Cedar customer above remains an independent witness in both paths.
  await db.query("delete from whatsapp_private_invoice_terms where workspace_id=$1 and term not like 'origin:%'",[workspace]);
  const snapshot=async()=>canonical((await db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[workspace,phone])).rows[0].value);
  const before=await snapshot();assert.ok(before.values.includes('party:alder'));assert.ok(before.values.includes('party:brook'));assert.ok(before.terms.includes('party:cedar'));assert.ok(!before.values.includes('party:cedar'));
  // Established review provenance must not be reclassified by a heuristic.
  await db.query("create or replace function app.private_invoice_has_origin(p_term text) returns boolean language sql immutable set search_path='' as $$select false$$");assert.deepEqual(await snapshot(),before);
  await db.query(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  for(const phase of ['cold','warm','replayed']){
   if(phase==='replayed')await db.query(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
   const after=await snapshot();assert.deepEqual(after,before,phase);
   for(const {source,keys}of produced)for(const key of keys){assert.equal(after.values.includes(key),before.values.includes(key),phase+'/allowed/'+source+'/'+key);assert.equal(after.terms.includes(key),before.terms.includes(key),phase+'/forbidden/'+source+'/'+key);}
   t.diagnostic(JSON.stringify({phase,produced:produced.map(({source,keys})=>({source,assignments:keys.map(key=>({key,allowed:after.values.includes(key),forbidden:after.terms.includes(key)}))}))}));
  }
 }finally{if(db){await db.query('rollback').catch(()=>{});await db.end().catch(()=>{});}await pg.stop();}
});
