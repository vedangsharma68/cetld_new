import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createNativePostgresFixture} from '../tests/fixtures/native-postgres.mjs';
import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from '../tests/fixtures/offline-sql-network.mjs';
import {PRIVATE_UNICODE_FOLD} from '../ai/private-value-unicode.mjs';
import {normalizePrivateValue} from '../ai/private-value-matcher.mjs';
const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
const pg=await createNativePostgresFixture({port}),out={};let db,other;
try{
 await pg.initialise();await pg.start();db=pg.getPgClient();other=pg.getPgClient();await db.connect();await other.connect();
 await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources([]))await db.query(sql);await db.query("set statement_timeout='15s'");
 const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);
 const workspace=(await db.query('select (create_workspace($1,$2)).id',['Independent native cache audit',randomUUID()])).rows[0].id;
 const cases=[...Object.keys(PRIVATE_UNICODE_FOLD).map(ch=>'x'+ch+'y'),...Array.from({length:127},(_,i)=>'x'+String.fromCodePoint(i+1)+'y')];
 const mismatches=[];
 for(let start=0;start<cases.length;start+=300){const batch=cases.slice(start,start+300),actual=(await db.query('select app.private_invoice_normalize(v) normalized from unnest($1::text[]) with ordinality t(v,n) order by n',[batch])).rows;for(let i=0;i<batch.length;i++)if(actual[i].normalized!==normalizePrivateValue(batch[i]))mismatches.push({value:batch[i],sql:actual[i].normalized,js:normalizePrivateValue(batch[i])});}
 out.unicode={generatedMappingCount:Object.keys(PRIVATE_UNICODE_FOLD).length,individualContextualCases:cases.length,mismatches};assert.equal(mismatches.length,0);
 const input={total:61927,customerName:'Concurrent Cedar'};
 await db.query('begin');await db.query('select app.retain_private_invoice_terms($1,$2)',[workspace,input]);
 assert.equal((await other.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[workspace])).rows[0].n,0);
 await other.query("begin;set local lock_timeout='2s';set local statement_timeout='5s'");let done=false;const waiting=other.query('select app.retain_private_invoice_terms($1,$2)',[workspace,input]).then(v=>{done=true;return v;});waiting.catch(()=>{});await new Promise(r=>setTimeout(r,100));assert.equal(done,false);await db.query('commit');await waiting;await other.query('commit');out.concurrentCompletion='waited for aliases/COMMIT; uncommitted markers invisible';
 await db.query('begin');await db.query('select app.retain_private_invoice_terms($1,$2)',[workspace,{total:33311}]);await db.query('rollback');
 assert.equal((await db.query("select count(*)::int n from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:33311'",[workspace])).rows[0].n,0);
 await db.query('select app.retain_private_invoice_terms($1,$2)',[workspace,{total:33311}]);out.rollbackRetry='PASS';
 await db.query("delete from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:61927'",[workspace]);
 assert.equal((await db.query('select count(*)::int n from app.private_invoice_canonical_inputs where workspace_id=$1',[workspace])).rows[0].n,0);
 await db.query('select app.retain_private_invoice_terms($1,$2)',[workspace,input]);assert.equal((await db.query("select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:61927') yes",[workspace])).rows[0].yes,true);out.sequentialDeleteRebuild='PASS';
 // A privileged alias repair can delete after aliases were checked but before
 // completion is inserted. Pause exactly at that marker boundary, not by sleep.
 await db.query("insert into whatsapp_private_invoice_terms values($1,encode(sha256(convert_to('number:71927','UTF8')),'hex'),'number:71927')",[workspace]);
 await db.query("create function app.pause_review_cache_marker() returns trigger language plpgsql as $$begin if new.input_kind='number' and new.input_hash=sha256(convert_to('71927','UTF8')) then perform pg_advisory_xact_lock(671927);end if;return new;end $$;create trigger pause_review_cache_marker before insert on app.private_invoice_canonical_inputs for each row execute function app.pause_review_cache_marker()");
 await other.query('select pg_advisory_lock(671927)');
 const retaining=db.query("select app.retain_private_invoice_field($1,'71927','number')",[workspace]);retaining.catch(()=>{});
 for(let i=0;;i++){const blocked=(await other.query("select exists(select 1 from pg_locks where locktype='advisory' and objid=671927 and not granted) yes")).rows[0].yes;if(blocked)break;if(i>500)throw Error('Marker pause not reached');await new Promise(r=>setTimeout(r,10));}
 await other.query("set lock_timeout='1s'");await other.query("delete from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:71927'",[workspace]);await other.query('select pg_advisory_unlock(671927)');await retaining;
 await db.query("select app.retain_private_invoice_field($1,'71927','number')",[workspace]);
 out.privilegedDeleteRace={aliasExists:(await db.query("select exists(select 1 from whatsapp_private_invoice_terms where workspace_id=$1 and term='number:71927') yes",[workspace])).rows[0].yes,completionExists:(await db.query("select exists(select 1 from app.private_invoice_canonical_inputs where workspace_id=$1 and input_kind='number' and input_hash=sha256(convert_to('71927','UTF8'))) yes",[workspace])).rows[0].yes};
 console.log(JSON.stringify(out));
}finally{await writeFile('work/r6-native-cache-audit.json',JSON.stringify(out,null,2));if(other)await other.end().catch(()=>{});if(db)await db.end().catch(()=>{});await pg.stop();}
